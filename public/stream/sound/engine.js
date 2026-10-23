// The sound engine: loads and decodes the library up front, then plays sounds through the
// mixer's buses with bounded voices, per-category limits, anti-repetition, cooldowns, smooth
// fades, groups that can be cancelled together, and crossfading loop layers for ambience.
// All timing is on the audio clock; the main thread only schedules a little ahead.
import { ShuffleBag, Cooldowns, VoiceLimiter } from "./rules.js";
import { LIBRARY, CATEGORY_LIMITS } from "./library.js";

const dbToGain = (db) => 10 ** (db / 20);

export class SoundEngine {
  constructor(audio, { base = "/assets/sounds/", random = Math.random } = {}) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.base = base;
    this.random = random;
    this.manifest = null;
    this.buffers = new Map(); // id -> AudioBuffer[]
    this.bags = new Map();
    this.cooldowns = new Cooldowns();
    this.limiter = new VoiceLimiter({ total: 48, limits: CATEGORY_LIMITS });
    this.voices = new Map(); // limiter id -> Voice
    this.loops = new Set();
    this.decodeCtx = new Map(); // rate -> OfflineAudioContext used for decoding at that rate
    this.bytes = 0;
    this.failed = [];
    this.loading = null;
    this.history = [];
    this.timer = setInterval(() => this.tick(), 250);
  }

  get now() {
    return this.ctx.currentTime;
  }

  get running() {
    return this.ctx.state === "running";
  }

  // --- Loading ---------------------------------------------------------------------------
  async loadManifest() {
    this.manifest ??= await (await fetch(`${this.base}manifest.json`, { cache: "no-cache" })).json();
    return this.manifest;
  }

  // Decodes every sound whose id passes `filter`, a few files at a time.
  async load(filter = () => true, { concurrency = 4 } = {}) {
    const manifest = await this.loadManifest();
    const jobs = [];
    for (const [id, s] of Object.entries(manifest.sounds)) if (filter(id) && !this.buffers.has(id)) jobs.push([id, s]);
    let next = 0;
    const work = async () => {
      while (next < jobs.length) {
        const [id, s] = jobs[next++];
        try {
          // the build stamp keeps a rebuilt library from being served from the browser cache
          const stamp = encodeURIComponent(manifest.generated || "");
          const list = await Promise.all(s.variants.map((v) => this.decode(`${this.base}${v.file}?v=${stamp}`, s.decodeRate)));
          this.buffers.set(id, list);
          for (const b of list) this.bytes += b.length * b.numberOfChannels * 4;
          this.bags.set(id, new ShuffleBag(list.length, { random: this.random }));
        } catch (error) {
          this.failed.push(id);
          console.warn(`sound ${id} failed to load`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, work));
  }

  async decode(url, rate) {
    const data = await (await fetch(url)).arrayBuffer();
    // Low-band sounds (wind, rumble, hum) decode at a lower rate to save memory; the
    // source node resamples on playback.
    if (rate && rate < this.ctx.sampleRate) {
      let dc = this.decodeCtx.get(rate);
      if (!dc) this.decodeCtx.set(rate, (dc = new OfflineAudioContext(1, 1, rate)));
      return dc.decodeAudioData(data);
    }
    return this.ctx.decodeAudioData(data);
  }

  unload(filter) {
    for (const id of [...this.buffers.keys()]) {
      if (!filter(id)) continue;
      for (const b of this.buffers.get(id)) this.bytes -= b.length * b.numberOfChannels * 4;
      this.buffers.delete(id);
      this.bags.delete(id);
    }
  }

  has(id) {
    return this.buffers.has(id);
  }

  duration(id, index = 0) {
    return this.buffers.get(id)?.[index]?.duration ?? 0;
  }

  // --- One-shots ---------------------------------------------------------------------------
  // play(id, { gainDb, rate, pan, lowpass, highpass, delay, at, offset, duration, fadeIn,
  //   fadeOut, send, group, priority, variant, bus, loop, cooldown, cooldownKey, onended })
  // -> Voice, or null when it was not allowed (context suspended, cooldown, voice limit).
  play(id, opts = {}) {
    const buffers = this.buffers.get(id);
    if (!buffers?.length || !this.running) return null;
    let def = LIBRARY[id];
    for (let parts = id.split("."); !def && parts.length > 1; ) def = LIBRARY[(parts = parts.slice(0, -1)).join(".")];
    def ||= {};
    const category = opts.category || def.category || def.bus || "fx";
    const now = this.now;
    const cd = opts.cooldown ?? def.cooldown;
    if (cd && !this.cooldowns.take(opts.cooldownKey || id, now, cd)) return null;
    const req = this.limiter.request(category, opts.priority ?? def.priority ?? 1, now);
    for (const victim of req.steal) this.voices.get(victim)?.stop(0.04);
    if (!req.ok) return null;
    const index = opts.variant ?? this.bags.get(id).next();
    const buffer = buffers[Math.min(index, buffers.length - 1)];
    const jitter = (range) => (range ? (this.random() * 2 - 1) * range : 0);
    const gainDb = (def.gainDb ?? 0) + (opts.gainDb ?? 0) + jitter(def.gainJitter);
    const rate = (opts.rate ?? 1) * (def.rate ?? 1) * 2 ** (jitter(def.pitchJitter ?? 0) / 12);
    const voice = new Voice(this, req.id, buffer, {
      bus: opts.bus || def.bus || "fx",
      gain: dbToGain(gainDb),
      rate,
      pan: opts.pan ?? def.pan ?? 0,
      lowpass: opts.lowpass ?? def.lowpass,
      highpass: opts.highpass ?? def.highpass,
      send: opts.send ?? def.send,
      at: opts.at ?? now + (opts.delay ?? 0),
      offset: opts.offset ?? 0,
      duration: opts.duration,
      // 3 ms: a decoded file's first sample is never quite zero (codec priming)
      fadeIn: opts.fadeIn ?? def.fadeIn ?? 0.003,
      fadeOut: opts.fadeOut,
      loop: opts.loop ?? false,
      group: opts.group ?? null,
      input: opts.input,
      onended: opts.onended,
    });
    this.voices.set(req.id, voice);
    // what played, for the repetition statistics of the capture tests (bounded)
    this.history.push([id, index, +voice.startAt.toFixed(2)]);
    if (this.history.length > 2000) this.history.splice(0, 500);
    return voice;
  }

  released(voice) {
    this.voices.delete(voice.id);
    this.limiter.release(voice.id);
  }

  stopGroup(group, fade = 0.25) {
    for (const v of this.voices.values()) if (v.group === group) v.stop(fade);
    for (const l of this.loops) if (l.group === group) l.stop(fade);
  }

  stopAll(fade = 0.2) {
    for (const v of [...this.voices.values()]) v.stop(fade);
    for (const l of [...this.loops]) l.stop(fade);
  }

  // --- Loop layers -------------------------------------------------------------------------
  layer(id, opts = {}) {
    // the mix level from library.js, plus any trim the caller asks for
    const def = LIBRARY[id] || {};
    const l = new LoopLayer(this, id, { bus: def.bus, ...opts, gainDb: (def.gainDb ?? 0) + (opts.gainDb ?? 0) });
    this.loops.add(l);
    return l;
  }

  tick() {
    if (!this.running) return;
    for (const l of this.loops) l.schedule();
  }

  stats() {
    return {
      decodedMB: +(this.bytes / 2 ** 20).toFixed(1),
      sounds: this.buffers.size,
      voices: this.voices.size,
      loops: [...this.loops].filter((l) => l.playing).length,
      failed: this.failed.length,
      limiterDb: +(this.audio.limiterReductionDb || 0).toFixed(1),
    };
  }
}

// One playing sound: source -> (filters) -> gain -> pan -> bus, plus an optional reverb send.
class Voice {
  constructor(engine, id, buffer, o) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.id = id;
    this.group = o.group;
    this.ended = false;
    const src = (this.src = ctx.createBufferSource());
    src.buffer = buffer;
    src.playbackRate.value = o.rate;
    src.loop = o.loop;
    let head = src;
    if (o.highpass) {
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = o.highpass;
      head = head.connect(f);
    }
    if (o.lowpass && o.lowpass < 19000) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = o.lowpass;
      head = head.connect(f);
      this.filter = f;
    }
    const g = (this.gain = ctx.createGain());
    const at = Math.max(ctx.currentTime, o.at);
    this.level = o.gain;
    if (o.fadeIn > 0) {
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(o.gain, at + o.fadeIn);
    } else g.gain.value = o.gain;
    head.connect(g);
    const p = (this.panner = ctx.createStereoPanner());
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    g.connect(p);
    p.connect(o.input || engine.audio.bus(o.bus));
    if (o.send != null && o.send > -60) {
      const s = (this.sendGain = ctx.createGain());
      s.gain.value = dbToGain(o.send);
      p.connect(s).connect(engine.audio.reverbIn);
    }
    const length = o.duration ?? (o.loop ? null : (buffer.duration - o.offset) / o.rate);
    src.onended = () => this.cleanup();
    src.start(at, o.offset, o.loop ? undefined : o.duration);
    if (o.fadeOut && length) {
      g.gain.setValueAtTime(o.gain, at + Math.max(0, length - o.fadeOut));
      g.gain.linearRampToValueAtTime(0, at + length);
    }
    this.startAt = at;
    this.onended = o.onended;
  }

  // Fade out (seconds) and stop; safe to call repeatedly.
  stop(fade = 0.05, at) {
    if (this.ended || this.stopping) return;
    this.stopping = true;
    const ctx = this.engine.ctx;
    const t = Math.max(ctx.currentTime, at ?? ctx.currentTime);
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(t > this.startAt ? g.value : 0, t);
    g.linearRampToValueAtTime(0, t + fade);
    try {
      this.src.stop(t + fade + 0.02);
    } catch {}
  }

  setGainDb(db, seconds = 0.1) {
    if (this.ended || this.stopping) return;
    const ctx = this.engine.ctx;
    const g = this.gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(dbToGain(db), ctx.currentTime + seconds);
  }

  cleanup() {
    if (this.ended) return;
    this.ended = true;
    try {
      this.src.disconnect();
      this.gain.disconnect();
      this.panner.disconnect();
      this.sendGain?.disconnect();
      this.filter?.disconnect();
    } catch {}
    this.engine.released(this);
    this.onended?.();
  }
}

// A continuous layer (rain, wind, candles) made from one decoded recording: random segments of
// it, joined with equal-power crossfades on the audio clock, so the loop point never repeats
// in the same place and no seam is audible. `level` (0..1) is smoothed with setTargetAtTime.
// Tonal loops (`seamless`: hum, coil) play the whole buffer as a sample-exact loop instead.
class LoopLayer {
  constructor(engine, id, { bus = "ambience", gainDb = 0, pan = 0, segment = [7, 14], xfade = 2.5, rate = 1, lowpass = null, group = null, seamless = false, send = null } = {}) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.id = id;
    this.group = group;
    this.segment = segment;
    this.xfade = xfade;
    this.rate = rate;
    this.seamless = seamless;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.trim = ctx.createGain();
    this.trim.gain.value = dbToGain(gainDb);
    let head = this.out;
    if (lowpass) {
      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = lowpass;
      head = head.connect(this.filter);
    }
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = pan;
    head.connect(this.trim).connect(this.panner).connect(engine.audio.bus(bus));
    if (send != null) {
      this.sendGain = ctx.createGain();
      this.sendGain.gain.value = dbToGain(send);
      this.panner.connect(this.sendGain).connect(engine.audio.reverbIn);
    }
    this.playing = false;
    this.nextAt = 0;
    this.lastOffset = -1;
    this.sources = new Set();
    this.levelValue = 0;
  }

  start(level = 1, fade = 2) {
    this.playing = true;
    this.setLevel(level, fade);
    this.schedule();
    return this;
  }

  setLevel(level, seconds = 1) {
    const v = Math.max(0, level);
    if (Math.abs(v - this.levelValue) < 1e-4 && this.playing) return;
    this.levelValue = v;
    const now = this.engine.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(v, now, Math.max(0.01, seconds / 3));
  }

  setLowpass(freq, seconds = 0.5) {
    if (!this.filter) return;
    this.filter.frequency.setTargetAtTime(freq, this.engine.ctx.currentTime, seconds / 3);
  }

  schedule() {
    if (!this.playing) return;
    const ctx = this.engine.ctx;
    const buffers = this.engine.buffers.get(this.id);
    if (!buffers?.length) return;
    const now = ctx.currentTime;
    if (this.nextAt < now) this.nextAt = now + 0.05; // first start, or after a suspension
    while (this.nextAt < now + 4) {
      const buffer = buffers[this.engine.bags.get(this.id).next()];
      if (this.seamless) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = this.rate;
        src.connect(this.out);
        src.start(this.nextAt, this.engine.random() * buffer.duration);
        this.sources.add(src);
        this.nextAt = Infinity;
        return;
      }
      const [a, b] = this.segment;
      const x = Math.min(this.xfade, buffer.duration / 4);
      const len = Math.min(buffer.duration / this.rate - 0.05, a + this.engine.random() * (b - a));
      // a fresh place in the recording, away from where the last segment was
      let offset = 0;
      const span = buffer.duration - len * this.rate;
      for (let k = 0; k < 6; k++) {
        offset = this.engine.random() * Math.max(0, span);
        if (this.lastOffset < 0 || Math.abs(offset - this.lastOffset) > buffer.duration * 0.2) break;
      }
      this.lastOffset = offset;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.rate;
      const g = ctx.createGain();
      const at = this.nextAt;
      // equal-power crossfade curves
      const N = 64;
      const up = new Float32Array(N);
      const down = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        up[i] = Math.sin((i / (N - 1)) * Math.PI * 0.5);
        down[i] = Math.cos((i / (N - 1)) * Math.PI * 0.5);
      }
      g.gain.setValueAtTime(0, at);
      g.gain.setValueCurveAtTime(up, at, x);
      g.gain.setValueCurveAtTime(down, at + len - x, x);
      src.connect(g).connect(this.out);
      src.start(at, offset, len * this.rate);
      src.stop(at + len + 0.05);
      src.onended = () => {
        g.disconnect();
        this.sources.delete(src);
      };
      this.sources.add(src);
      this.nextAt = at + len - x;
    }
  }

  stop(fade = 1.5) {
    if (!this.playing) return;
    this.playing = false;
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + fade);
    for (const s of this.sources) {
      try {
        s.stop(now + fade + 0.05);
      } catch {}
    }
    this.sources.clear();
    this.nextAt = 0;
    this.levelValue = 0;
    if (this.group) this.engine.loops.delete(this);
  }
}
