// Everything the stream window plays goes through one mixer with a bus per kind of sound:
//
//   dialogue   his voice (a little chest, a presence lift for phone speakers, light saturation,
//              compression, a short night-air echo) and the reader's thin "spirit voice"
//   nonverbal  his hums, chuckles and breaths, through a copy of his voice chain so they sound
//              like the same man, plus his foley (footsteps, clothing, leather, bolts)
//   ambience   wind, trees, candles, fence creaks, wildlife, the apparatus' hum
//   weather    rain layers and thunder
//   fx         gift events and other cinematic sound
//   ui         restrained interaction cues
//   music      the operator's music tracks
//   reverb     one shared outdoor reverb, fed by sends from the other buses
//
// Every bus but dialogue ducks smoothly while anyone is speaking (attack ~0.15 s, release
// ~1.5 s, held for the whole line so it never pumps between words). The master runs into a
// true-peak look-ahead limiter (an AudioWorklet, ceiling -2 dBTP) with a compressor as
// fallback. It also measures his voice as it actually plays, to drive his mouth.

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// How far each bus drops while someone speaks (dB) and its default level.
export const BUSES = {
  dialogue: { duck: 0, level: 1 },
  nonverbal: { duck: -2, level: 1 },
  ambience: { duck: -6, level: 1.26 },
  weather: { duck: -6, level: 1.26 },
  fx: { duck: -8, level: 1 },
  ui: { duck: -3, level: 1 },
  music: { duck: -10, level: 1 },
  reverb: { duck: -5, level: 1 },
};

export class AudioOut {
  constructor({ muted }) {
    const ctx = (this.ctx = new AudioContext({ latencyHint: "playback" }));
    this.muted = Boolean(muted);

    // --- Master: bus sum -> master gain -> limiter -> speakers (and the recording tap)
    this.master = ctx.createGain();
    // 0.8 (was 0.92): his hot voice chain otherwise drove the limiter ~3 dB on syllable peaks;
    // now it stays a protective limiter (measured: SOUND.md) and speech sits near -14 LUFS.
    this.master.gain.value = muted ? 0 : 0.8;
    // Protective fallback until (or unless) the worklet limiter loads.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    this.limiter = limiter; // the node whose output is the finished mix
    this.post = ctx.createGain(); // after the limiter: speakers + recording tap
    this.post.gain.value = 0.82; // cancels the fallback compressor's automatic make-up gain (+1.7 dB)
    this.master.connect(limiter).connect(this.post);
    this.post.connect(ctx.destination);
    this.out = ctx.createGain(); // kept for compatibility: the dialogue bus input
    this.limiterReductionDb = 0;
    this.ready = this.installLimiter();

    // --- Buses
    this.buses = {};
    for (const [name, spec] of Object.entries(BUSES)) {
      const input = ctx.createGain();
      const duck = ctx.createGain();
      const level = ctx.createGain();
      level.gain.value = spec.level;
      input.connect(duck).connect(level).connect(this.master);
      this.buses[name] = { input, duck, level, spec, volume: 1, enabled: true };
    }
    this.out.connect(this.buses.dialogue.input);
    this.busEq();

    // --- Shared outdoor reverb (short, dark, a few early reflections off the gravestones)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.outdoorImpulse(1.4);
    this.reverbIn = ctx.createGain();
    this.reverbIn.connect(this.reverb).connect(this.buses.reverb.input);

    // Mouth analysis taps his dry voice, after playback starts, so the lips follow the sound.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);

    this.creatureIn = ctx.createGain();
    this.creatureIn.connect(this.analyser);
    this.creatureChain(this.creatureIn, this.out);
    // His nonverbal sounds: the same chain into the nonverbal bus (not the mouth analyser).
    this.nonverbalVoice = ctx.createGain();
    this.creatureChain(this.nonverbalVoice, this.buses.nonverbal.input);
    this.nonverbalVoice.connect(this.analyser); // his mouth moves with his hums and laughs too

    this.readerIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 240;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4500;
    const readerLevel = ctx.createGain();
    readerLevel.gain.value = 0.8;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.16;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.2;
    const echoLevel = ctx.createGain();
    echoLevel.gain.value = 0.26;
    this.readerIn.connect(hp).connect(lp).connect(readerLevel).connect(this.out);
    readerLevel.connect(delay).connect(feedback).connect(delay);
    delay.connect(echoLevel).connect(this.out);

    // Music (the operator's tracks) on its own bus; `bed` kept as the music bus' duck stage.
    this.bed = this.buses.music.duck;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.25;
    this.musicGain.connect(this.buses.music.input);
    this.ambience = this.buses.weather.input; // the built-in thunder plays on the weather bus
    this.music = new Audio();
    this.music.crossOrigin = "anonymous";
    ctx.createMediaElementSource(this.music).connect(this.musicGain);
    this.noise = this.brownNoise(6);

    this.sources = new Set();
    this.creatureSources = new Set();
    this.level = 0;
    this.bands = { low: 0, high: 0 };
    this.mouth = { open: 0, wide: 0, round: 0, teeth: 0 };
    this.fakeUntil = 0;
    this.cancelFake = null;
    this.ducked = false;
    this.speaking = false; // a voice clip is playing right now (not just a line in progress)
    this.onVoice = null; // (phase "start" | "end", voice) for the sound system
    this.thunderHandler = null; // the sound system plays recorded thunder when it is loaded
    this.musicVolume = 0.25;
  }

  // Phone-friendly separation: no rumble below what phones reproduce, rain and sparks kept off
  // the harsh top end, room for the voice in the presence region.
  busEq() {
    const ctx = this.ctx;
    const insert = (bus, list) => {
      const b = this.buses[bus];
      let node = b.input;
      b.input = ctx.createGain();
      let head = b.input;
      for (const [type, f, q = 0.707, g = 0] of list) {
        const flt = ctx.createBiquadFilter();
        flt.type = type;
        flt.frequency.value = f;
        flt.Q.value = q;
        flt.gain.value = g;
        head.connect(flt);
        head = flt;
      }
      head.connect(node);
    };
    insert("nonverbal", [["highpass", 45]]);
    insert("ambience", [["highpass", 60], ["highshelf", 9000, 0.707, -2]]);
    insert("weather", [["highpass", 45], ["peaking", 3200, 0.9, -2], ["highshelf", 8000, 0.707, -3]]);
    insert("fx", [["highpass", 45], ["peaking", 2800, 1, -1.5]]);
    insert("ui", [["highpass", 140]]);
    insert("reverb", [["highpass", 180], ["lowpass", 7000]]);
    // No bus compressor on the gift events: Chrome's DynamicsCompressor adds automatic make-up
    // gain (measured in Chrome: +5.8 dB for threshold -20 / knee 8 / ratio 2.5; the old master
    // "limiter" added +1.1 dB the same way), which made every event louder than mixed.
    // Event levels are set in library.js and checked against captures; the master limiter
    // only protects.
  }

  async installLimiter() {
    try {
      await this.ctx.audioWorklet.addModule(new URL("./sound/worklets.js", import.meta.url));
      const tp = new AudioWorkletNode(this.ctx, "tp-limiter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      tp.port.onmessage = (e) => (this.limiterReductionDb = e.data.reductionDb);
      // Swap in place: master -> tp -> post. (No compressor after it: Chrome's
      // DynamicsCompressor adds make-up gain, which would push the peaks back up.)
      this.master.disconnect();
      this.limiter.disconnect();
      this.master.connect(tp).connect(this.post);
      this.post.gain.value = 1;
      this.limiter = tp;
      this.tpLimiter = tp;
      return true;
    } catch (error) {
      console.warn("True-peak limiter unavailable, using the compressor", error);
      return false;
    }
  }

  creatureChain(input, output) {
    const ctx = this.ctx;
    const mud = ctx.createBiquadFilter();
    mud.type = "highpass";
    mud.frequency.value = 75;
    const chest = ctx.createBiquadFilter();
    chest.type = "lowshelf";
    chest.frequency.value = 150;
    chest.gain.value = 1.5;
    const boxy = ctx.createBiquadFilter();
    boxy.type = "peaking";
    boxy.frequency.value = 380;
    boxy.Q.value = 1.1;
    boxy.gain.value = -2; // takes the muddiness out of the pitched-down voice
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2600;
    presence.Q.value = 0.9;
    presence.gain.value = 3.5;
    const gravel = ctx.createWaveShaper();
    gravel.curve = this.saturationCurve(1.1);
    gravel.oversample = "4x";
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.18;
    const level = ctx.createGain();
    level.gain.value = 1.25;
    input.connect(mud).connect(chest).connect(boxy).connect(presence).connect(gravel).connect(comp).connect(level).connect(output);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(1.6, 3.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.09;
    level.connect(reverb).connect(wet).connect(output);
    return level;
  }

  saturationCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(2, rate * seconds, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** decay;
    }
    return buffer;
  }

  // Night air among gravestones: a handful of early reflections, then a short diffuse tail
  // that darkens as it decays. Decorrelated left/right, mono-safe.
  outdoorImpulse(seconds) {
    const rate = this.ctx.sampleRate;
    const n = Math.round(rate * seconds);
    const buffer = this.ctx.createBuffer(2, n, rate);
    let seed = 1234;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.55 * Math.exp(-t * 5) + 0.06; // the tail loses its top end
        lp += k * (rnd() - lp);
        d[i] = lp * Math.exp(-t * 6.5) * (i < rate * 0.012 ? i / (rate * 0.012) : 1) * 0.9;
      }
      for (let e = 0; e < 7; e++) {
        const at = Math.round(rate * (0.011 + 0.006 * e + Math.abs(rnd()) * 0.03));
        if (at < n) d[at] += rnd() * 0.45 * Math.exp(-e * 0.25);
      }
    }
    return buffer;
  }

  brownNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * seconds, rate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    return buffer;
  }

  get running() {
    return this.ctx.state === "running";
  }

  unlock() {
    return this.ctx.resume().then(() => this.music.src && this.music.play().catch(() => {}));
  }

  // The finished mix (after the limiter), for recording the stream window.
  recordingTrack() {
    if (!this.tap) {
      this.tap = this.ctx.createMediaStreamDestination();
      this.post.connect(this.tap);
    }
    return this.tap.stream.getAudioTracks()[0];
  }

  // --- Buses ------------------------------------------------------------------------------
  bus(name) {
    return this.buses[name]?.input || this.buses.fx.input;
  }

  // Category volume (0..2, 1 = as mixed) and on/off, with a short ramp.
  setBus(name, { volume, enabled } = {}) {
    const b = this.buses[name];
    if (!b) return;
    if (volume != null) b.volume = Math.max(0, Math.min(2, Number(volume) || 0));
    if (enabled != null) b.enabled = Boolean(enabled);
    this.ramp(b.level.gain, b.spec.level * b.volume * (b.enabled ? 1 : 0), 0.15);
  }

  // --- Music and ambience -------------------------------------------------------------
  playMusic(src, volume) {
    this.musicVolume = volume;
    this.ramp(this.musicGain.gain, volume, 0.3);
    if (!src) return this.music.pause();
    if (!this.music.src.endsWith(src)) this.music.src = src;
    this.music.play().catch(() => {});
  }

  setMusicVolume(volume) {
    this.musicVolume = volume;
    this.ramp(this.musicGain.gain, volume, 0.3);
  }

  // Every bus but the dialogue drops under speech and comes back gently afterwards. Called for
  // a whole line (reader + reply), so the bed does not pump between sentences.
  duck(on) {
    if (on === this.ducked) return;
    this.ducked = on;
    const now = this.ctx.currentTime;
    for (const b of Object.values(this.buses)) {
      const target = on ? 10 ** (b.spec.duck / 20) : 1;
      b.duck.gain.cancelScheduledValues(now);
      b.duck.gain.setValueAtTime(b.duck.gain.value, now);
      b.duck.gain.setTargetAtTime(target, now, on ? 0.06 : 0.5);
    }
  }

  ramp(param, value, seconds) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  // Thunder after a lightning flash. The sound system plays recorded thunder (it handles the
  // hub's "lightning" event); this synthesized rumble is only the fallback without it.
  thunder({ delay = 3, strength = 0.5 } = {}) {
    if (!this.running || this.thunderHandler) return;
    const ctx = this.ctx;
    const at = ctx.currentTime + Math.min(8, delay);
    const close = delay < 2;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(close ? 2200 : 700, at);
    lp.frequency.exponentialRampToValueAtTime(160, at + 2.5);
    const gain = ctx.createGain();
    const peak = close ? 0.45 : 0.15 + strength * 0.3;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + (close ? 0.04 : 0.5));
    for (let i = 1; i <= 3; i++) gain.gain.exponentialRampToValueAtTime((peak * (0.5 + Math.random() * 0.4)) / i, at + 0.6 * i + Math.random() * 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 4.8);
    src.connect(lp).connect(gain).connect(this.ambience);
    src.start(at);
    src.stop(at + 5);
  }

  // --- Voice --------------------------------------------------------------------------
  // Resolves when the clip finishes (or is stopped). Without sound allowed, it waits out the duration.
  async play(clip, { voice = "creature" } = {}) {
    if (!clip) return;
    if (!this.running) return this.fake(clip.duration, voice === "creature");
    const bytes = Uint8Array.from(atob(clip.wav), (c) => c.charCodeAt(0));
    const buffer = await this.ctx.decodeAudioData(bytes.buffer);
    await new Promise((resolve) => {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(voice === "reader" ? this.readerIn : this.creatureIn);
      const creature = voice !== "reader";
      source.onended = () => {
        this.sources.delete(source);
        this.creatureSources.delete(source);
        this.speaking = this.sources.size > 0;
        if (!this.speaking) this.onVoice?.("end", voice);
        resolve();
      };
      this.sources.add(source);
      if (creature) this.creatureSources.add(source);
      this.speaking = true;
      this.onVoice?.("start", voice);
      source.start();
    });
  }

  fake(seconds, mouth) {
    if (mouth) this.fakeUntil = performance.now() + seconds * 1000;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      this.cancelFake = () => {
        clearTimeout(timer);
        this.fakeUntil = 0;
        resolve();
      };
    });
  }

  stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.cancelFake?.();
  }

  // Mouth shapes from the sound he is actually making:
  //  open  - loudness, gated so the mouth closes in pauses and between words
  //  wide  - strong second formant ("ee", "eh"): lips spread
  //  round - energy low in the spectrum without the second formant ("oo", "oh"): lips round
  //  teeth - hiss ("s", "f", "sh"): jaw nearly closed even though there is sound
  update(dt = 1 / 60) {
    let target = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    if (performance.now() < this.fakeUntil) {
      // No sound allowed yet: a plausible syllable rhythm so he still looks like he speaks.
      const s = performance.now() / 1000;
      const syllable = Math.max(0, Math.sin(s * 9.5) * 0.8 + Math.sin(s * 4.1) * 0.3);
      target = syllable * 0.7;
      low = 0.5 + 0.5 * Math.sin(s * 2.3);
      mid = 0.5 + 0.5 * Math.sin(s * 3.1 + 1);
      high = 0.2;
    } else {
      // His lines and his nonverbal sounds (hums, laughs) both reach this analyser; silence
      // stays under the gate below, so the mouth only moves when he makes a sound.
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (const s of this.samples) sum += s * s;
      const rms = Math.sqrt(sum / this.samples.length);
      target = clamp01((rms - 0.012) * 6); // the gate: quiet breaths and room tone keep it shut
      this.analyser.getFloatFrequencyData(this.spectrum);
      const hz = this.ctx.sampleRate / this.analyser.fftSize;
      const band = (a, b) => {
        let total = 0;
        const from = Math.floor(a / hz);
        const to = Math.floor(b / hz);
        for (let i = from; i < to; i++) total += 10 ** (this.spectrum[i] / 20);
        return total / (to - from);
      };
      low = band(250, 900);
      mid = band(1100, 2600);
      high = band(3500, 8000);
    }
    const total = low + mid + high + 1e-6;
    const teeth = clamp01((high / total - 0.25) * 2.5);
    const wide = clamp01((mid / total - 0.3) * 3);
    const round = clamp01((low / total - 0.55) * 3) * (1 - wide);
    // Fast opening, slightly slower closing, measured in time rather than frames.
    const attack = 1 - Math.exp(-dt / 0.03);
    const release = 1 - Math.exp(-dt / 0.07);
    const open = target * (1 - teeth * 0.65);
    this.mouth.open += (open - this.mouth.open) * (open > this.mouth.open ? attack : release);
    const shape = 1 - Math.exp(-dt / 0.06);
    this.mouth.wide += (wide * (target > 0 ? 1 : 0) - this.mouth.wide) * shape;
    this.mouth.round += (round * (target > 0 ? 1 : 0) - this.mouth.round) * shape;
    this.mouth.teeth += (teeth * (target > 0 ? 1 : 0) - this.mouth.teeth) * shape;
    this.level = this.mouth.open;
    this.bands.low = this.mouth.round;
    this.bands.high = this.mouth.wide;
  }

  // --- Debug capture: PCM of the master and of the dialogue / everything-else stems -------
  // (for objective checks of the mix; only used when the page asks for it)
  async pcmTap() {
    if (this.tapNode) return this.tapNode;
    await this.ready;
    const node = new AudioWorkletNode(this.ctx, "pcm-tap", { numberOfInputs: 3, numberOfOutputs: 1 });
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(this.ctx.destination); // keeps the tap pulled by the graph
    this.post.connect(node, 0, 0);
    this.buses.dialogue.level.connect(node, 0, 1);
    for (const [name, b] of Object.entries(this.buses)) if (name !== "dialogue") b.level.connect(node, 0, 2);
    this.tapNode = node;
    return node;
  }
}
