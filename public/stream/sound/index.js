// The show's sound design: ambience, weather, foley, nonverbal sounds, gift soundtracks and the
// mix. Wired to the show through the hub (see ../hub.js); main.js only calls initSound.
//
// Nothing here plays from history: sounds come only from live events as they happen (the
// server never replays old gifts; a reconnect only re-sends state, which makes no sound), and
// identical gift messages inside a few seconds play once. The panel's muted preview makes no
// sound at all.
import { SoundEngine } from "./engine.js";
import { Ambience } from "./ambience.js";
import { Foley } from "./foley.js";
import { Reactions } from "./voice.js";
import { EventSounds } from "./events.js";
import { Dedupe } from "./rules.js";
import { DEFAULT_SETTINGS, CATEGORIES } from "./library.js";

let started = false;

export function initSound(hub, audio, { base = "/assets/sounds/" } = {}) {
  if (started || hub.ctx?.preview || audio.muted) return null;
  started = true;
  const engine = new SoundEngine(audio, { base });
  const ambience = new Ambience(engine, hub);
  const reactions = new Reactions(engine, audio);
  const foley = new Foley(engine, hub, reactions);
  const events = new EventSounds(engine, ambience, reactions, hub);
  const dedupe = new Dedupe(4);
  const system = { engine, ambience, reactions, foley, events, settings: structuredClone(DEFAULT_SETTINGS), ready: false };

  // --- Settings: category volumes, on/off, ambience layers -----------------------------
  const applySettings = (s) => {
    const next = { ...DEFAULT_SETTINGS, ...(s || {}), volumes: { ...DEFAULT_SETTINGS.volumes, ...(s?.volumes || {}) }, layers: { ...DEFAULT_SETTINGS.layers, ...(s?.layers || {}) } };
    system.settings = next;
    for (const c of CATEGORIES) audio.setBus(c, { volume: next.volumes[c], enabled: next.enabled !== false || c === "dialogue" || c === "music" });
    ambience.setEnabled(next.layers);
  };
  const applyVoice = (v) => v && reactions.setVoice({ id: v.id, pitch: v.pitch }).catch((e) => console.warn("nonverbal voice set failed", e));

  // --- Loading: everything decoded before first use; the voice set for the current voice ---
  const load = async () => {
    const t0 = performance.now();
    const settings = await fetch("/api/settings").then((r) => r.json()).catch(() => ({}));
    applySettings(settings.sound);
    await engine.load((id) => !id.startsWith("nv."));
    await reactions.setVoice(settings.voice || {});
    audio.thunderHandler = (t) => ambience.thunder(t);
    system.ready = true;
    system.loadSeconds = +((performance.now() - t0) / 1000).toFixed(2);
    if (engine.running) ambience.start();
    console.info("sound ready", engine.stats());
  };
  system.loading = load().catch((e) => console.warn("sound system failed to load", e));

  // Autoplay and suspended contexts: start once the context runs; keep trying to resume it.
  audio.ctx.addEventListener("statechange", () => {
    if (audio.ctx.state === "running" && system.ready) ambience.start();
  });
  setInterval(() => {
    if (audio.ctx.state !== "running" && audio.ctx.state !== "closed") audio.ctx.resume().catch(() => {});
  }, 3000);

  // --- Show events ---------------------------------------------------------------------
  hub.on("weather", (w) => {
    ambience.setWeather(w);
    ambience.apply();
    foley.rain = w.rain;
  });
  hub.on("frame", () => {
    // ~10 Hz is plenty for the candles, the apparatus and the detail schedule
    const now = engine.now;
    if (now - (system.lastFrame || 0) < 0.1) return;
    system.lastFrame = now;
    ambience.update(hub.ctx, now);
  });
  hub.on("lightning", (t) => {
    if (!system.ready) return;
    ambience.thunder(t);
  });
  hub.on("step", (d) => system.ready && foley.step(d));
  hub.on("impact", (d) => system.ready && foley.impact(d));
  hub.on("flash", () => system.ready && foley.flash());
  hub.on("stunt", ({ name, marker }) => {
    if (!system.ready) return;
    foley.stunt(name, marker);
    events.marker(name, marker);
  });
  hub.on("signature", (d) => system.ready && events.signature(d));
  hub.on("effect", ({ name }) => system.ready && events.effect(name));
  hub.on("cue", ({ name }) => system.ready && events.cue(name));
  hub.on("speech", ({ phase }) => {
    reactions.policy.speech(phase, engine.now);
    ambience.speaking = phase === "start";
    if (phase === "start") reactions.silence();
  });
  hub.on("line", ({ phase }) => {
    reactions.policy.line(phase, engine.now);
    if (phase === "start") reactions.silence();
  });
  hub.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "settings":
        applySettings(msg.settings?.sound);
        applyVoice(msg.settings?.voice);
        break;
      case "gift":
        if (system.ready && dedupe.fresh(msg, engine.now)) {
          events.gift(msg);
          if (msg.newTop) events.carve();
        }
        break;
      case "milestone":
        if (system.ready && dedupe.fresh(msg, engine.now)) events.milestone(msg);
        break;
      case "skip":
        events.skip();
        reactions.silence();
        break;
      case "record":
        if (pcmTarget) pcmCapture(audio, msg).catch((e) => console.warn("pcm capture failed", e));
        break;
    }
  });

  // Debug and test hooks (operator tools, capture tests).
  const pcmTarget = new URLSearchParams(location.search).get("soundtap");
  system.stats = () => ({ ...engine.stats(), active: events.active?.event || null, context: audio.ctx.state, sampleRate: audio.ctx.sampleRate });
  system.pcmCapture = (msg) => pcmCapture(audio, msg);
  window.__sound = system;
  window.__soundHub = hub;
  return system;

  // Records the master and the dialogue / everything-else stems as float WAVs and posts them
  // to the test tool server named in ?soundtap=<port> (only when that parameter is present).
  async function pcmCapture(a, { name, seconds = 10 }) {
    const node = await a.pcmTap();
    const chunks = [];
    const done = new Promise((resolve) => {
      node.port.onmessage = (e) => {
        if (e.data.chunk) chunks.push(e.data.chunk);
        if (e.data.done) resolve();
      };
    });
    node.port.postMessage("start");
    await new Promise((r) => setTimeout(r, Math.min(120, seconds) * 1000));
    node.port.postMessage("stop");
    await done;
    const rate = a.ctx.sampleRate;
    const total = chunks.reduce((n, c) => n + c[0].length, 0);
    const stems = ["master", "dialogue", "bed"];
    for (let s = 0; s < 3; s++) {
      const wav = floatWav([0, 1].map((ch) => {
        const out = new Float32Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c[s * 2 + ch], o);
          o += c[0].length;
        }
        return out;
      }), rate);
      await fetch(`http://127.0.0.1:${pcmTarget}/save?p=${encodeURIComponent(`${name}_${stems[s]}.wav`)}`, { method: "POST", body: wav });
    }
  }
}

function floatWav(channels, rate) {
  const n = channels.length;
  const len = channels[0].length;
  const out = new DataView(new ArrayBuffer(44 + len * n * 4));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  out.setUint32(4, 36 + len * n * 4, true);
  w(8, "WAVE");
  w(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 3, true);
  out.setUint16(22, n, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * n * 4, true);
  out.setUint16(32, n * 4, true);
  out.setUint16(34, 32, true);
  w(36, "data");
  out.setUint32(40, len * n * 4, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < n; c++) {
    out.setFloat32(o, channels[c][i], true);
    o += 4;
  }
  return out.buffer;
}
