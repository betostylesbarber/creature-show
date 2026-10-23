// Operator sound lab: the stream's real mixer and sound system with a stand-in for the show,
// so every category, layer and event can be auditioned and levelled on its own. Volumes and
// layer switches are saved to the show's sound settings (and reach open stream windows live).
import { AudioOut } from "/stream/audio.js";
import { initSound } from "/stream/sound/index.js";
import { CATEGORIES, DEFAULT_SETTINGS } from "/stream/sound/library.js";
import { KINDS } from "/stream/sound/voice.js";

const $ = (id) => document.getElementById(id);
const log = (text) => {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}\n${el.textContent}`.slice(0, 6000);
};

// A stand-in for the stream's event hub (public/stream/hub.js has the same shape).
const hub = {
  ctx: { preview: false },
  handlers: new Map(),
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.handlers.get(name)?.delete(fn);
  },
  emit(name, detail = {}) {
    for (const fn of this.handlers.get(name) || []) {
      try {
        fn(detail);
      } catch (e) {
        console.warn(name, e);
      }
    }
  },
};

const audio = new AudioOut({ muted: false });
const sound = initSound(hub, audio);
let settings = structuredClone(DEFAULT_SETTINGS);
const weather = { rain: 0.32, storm: 0, wind: 0.35 };

// --- Unlock (browsers start audio only after a click) ---------------------------------------
$("unlock").onclick = async () => {
  await audio.unlock();
  $("unlock").textContent = "Sound on";
  log("audio context running");
};

// --- Mix sliders and meters --------------------------------------------------------------------
const meters = {};
for (const c of CATEGORIES) {
  const row = document.createElement("div");
  row.className = "slider";
  row.innerHTML = `<span>${c}</span><input type="range" min="0" max="2" step="0.01" value="1" data-cat="${c}" /><span class="num" data-v="${c}">1.00</span><div class="meter"><i data-m="${c}"></i></div>`;
  $("sliders").appendChild(row);
  const an = audio.ctx.createAnalyser();
  an.fftSize = 2048;
  audio.buses[c].level.connect(an);
  meters[c] = { an, buf: new Float32Array(an.fftSize), el: row.querySelector(`[data-m="${c}"]`) };
}
$("sliders").addEventListener("input", (e) => {
  const c = e.target.dataset.cat;
  if (!c) return;
  settings.volumes[c] = Number(e.target.value);
  document.querySelector(`[data-v="${c}"]`).textContent = settings.volumes[c].toFixed(2);
  audio.setBus(c, { volume: settings.volumes[c] });
});
$("enabled").onchange = (e) => {
  settings.enabled = e.target.checked;
  for (const c of CATEGORIES) audio.setBus(c, { enabled: settings.enabled || c === "dialogue" || c === "music" });
};
$("save").onclick = async () => {
  const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sound: settings }) });
  log(r.ok ? "saved sound settings to the show" : `save failed (${r.status})`);
};
$("reset").onclick = () => {
  for (const c of CATEGORIES) {
    settings.volumes[c] = 1;
    document.querySelector(`[data-cat="${c}"]`).value = 1;
    document.querySelector(`[data-v="${c}"]`).textContent = "1.00";
    audio.setBus(c, { volume: 1 });
  }
};
fetch("/api/settings")
  .then((r) => r.json())
  .then((s) => {
    settings = { ...settings, ...(s.sound || {}), volumes: { ...settings.volumes, ...(s.sound?.volumes || {}) }, layers: { ...settings.layers, ...(s.sound?.layers || {}) } };
    for (const c of CATEGORIES) {
      document.querySelector(`[data-cat="${c}"]`).value = settings.volumes[c];
      document.querySelector(`[data-v="${c}"]`).textContent = settings.volumes[c].toFixed(2);
    }
    $("enabled").checked = settings.enabled !== false;
    renderLayers();
    if (s.voice) {
      $("voice").value = ["am_onyx", "am_puck", "am_michael", "bm_lewis"].includes(s.voice.id) ? s.voice.id : "am_onyx";
      $("pitch").value = s.voice.pitch;
    }
  })
  .catch(() => renderLayers());

// Master: approximate momentary loudness (K-weighting by two biquads) and sample peak.
const kShelf = audio.ctx.createBiquadFilter();
kShelf.type = "highshelf";
kShelf.frequency.value = 1680;
kShelf.gain.value = 4;
const kHp = audio.ctx.createBiquadFilter();
kHp.type = "highpass";
kHp.frequency.value = 38;
const split = audio.ctx.createChannelSplitter(2);
const masterAn = [audio.ctx.createAnalyser(), audio.ctx.createAnalyser()];
audio.post.connect(kShelf).connect(kHp).connect(split);
masterAn.forEach((a, i) => {
  a.fftSize = 16384; // ~0.34 s at 48 kHz
  split.connect(a, i);
});
const rawAn = audio.ctx.createAnalyser();
rawAn.fftSize = 2048;
audio.post.connect(rawAn);
const mbuf = new Float32Array(16384);
const rbuf = new Float32Array(2048);
let peakHold = -Infinity;
setInterval(() => {
  for (const m of Object.values(meters)) {
    m.an.getFloatTimeDomainData(m.buf);
    let s = 0;
    for (const v of m.buf) s += v * v;
    const db = 10 * Math.log10(s / m.buf.length + 1e-12);
    m.el.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  }
  let z = 0;
  for (const a of masterAn) {
    a.getFloatTimeDomainData(mbuf);
    let s = 0;
    for (const v of mbuf) s += v * v;
    z += s / mbuf.length;
  }
  rawAn.getFloatTimeDomainData(rbuf);
  let pk = 0;
  for (const v of rbuf) pk = Math.max(pk, Math.abs(v));
  peakHold = Math.max(peakHold - 0.5, 20 * Math.log10(pk + 1e-9));
  const st = sound?.stats?.() || {};
  $("loud").textContent = `master ≈ ${(-0.691 + 10 * Math.log10(z + 1e-12)).toFixed(1)} LUFS(M) · peak ${peakHold.toFixed(1)} dBFS · limiter ${st.limiterDb ?? 0} dB`;
  $("stats").textContent = `${audio.ctx.state} · ${st.decodedMB ?? 0} MB decoded · ${st.sounds ?? 0} sounds · ${st.voices ?? 0} voices · ${st.loops ?? 0} loops${st.active ? ` · event ${st.active}` : ""}`;
}, 120);

// --- Ambience ------------------------------------------------------------------------------------
const pushWeather = () => hub.emit("weather", { ...weather, storm: weather.rain > 0.6 ? 1 : 0 });
setInterval(pushWeather, 500);
$("ambStart").onclick = () => {
  sound.ambience.start();
  log("ambience started");
};
$("ambStop").onclick = () => sound.ambience.stop();
for (const id of ["rain", "wind"]) {
  $(id).oninput = (e) => {
    weather[id] = Number(e.target.value);
    $(`${id}V`).textContent = weather[id].toFixed(2);
  };
}
document.querySelectorAll("[data-weather]").forEach((b) => {
  b.onclick = () => {
    const w = { calm: [0.32, 0.35], gusty: [0.32, 0.6], storm: [1, 1.4] }[b.dataset.weather];
    [weather.rain, weather.wind] = w;
    $("rain").value = w[0];
    $("wind").value = w[1];
    $("rainV").textContent = w[0].toFixed(2);
    $("windV").textContent = w[1].toFixed(2);
  };
});
function renderLayers() {
  const box = $("layers");
  box.innerHTML = "";
  for (const [k, v] of Object.entries(settings.layers)) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${v ? "checked" : ""} data-layer="${k}" /> ${k}`;
    box.appendChild(l);
  }
}
$("layers").addEventListener("change", (e) => {
  const k = e.target.dataset.layer;
  if (!k) return;
  settings.layers[k] = e.target.checked;
  sound.ambience.setEnabled({ [k]: e.target.checked });
});

// --- Details and thunder -------------------------------------------------------------------------
for (const [id, label] of [["amb.creak", "Fence creak"], ["amb.rattle", "Fence rattle"], ["amb.settle", "Crypt settling"], ["amb.branch", "Branches"], ["amb.crow", "Crow"], ["amb.owl", "Owl"], ["amb.batwings", "Bats"], ["amb.batsqueak", "Bat squeak"]]) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => sound.ambience.detail(id, hub.ctx, { far: [5, 9] }) || log(`${id}: on cooldown`);
  $("details").appendChild(b);
}
document.querySelectorAll("[data-thunder]").forEach((b) => (b.onclick = () => hub.emit("lightning", { delay: Number(b.dataset.thunder), strength: 0.5 })));

// --- Footsteps and foley ---------------------------------------------------------------------------
for (const surface of ["stone", "soil", "grass"]) {
  for (const [label, strength] of [["soft", 0.3], ["", 0.7], ["heavy", 1]]) {
    const b = document.createElement("button");
    b.textContent = `${surface}${label ? ` ${label}` : ""}`;
    b.onclick = () => hub.emit("step", { foot: "L", strength, surface, inPlace: false, speed: 1 });
    $("steps").appendChild(b);
  }
}
$("walk").onclick = () => {
  const surfaces = ["stone", "stone", "stone", "soil", "soil", "soil", "grass", "grass", "grass", "stone"];
  surfaces.forEach((surface, i) => setTimeout(() => hub.emit("step", { foot: i % 2 ? "R" : "L", strength: 0.75, surface, inPlace: false, speed: 1 }), i * 560));
};
$("turn").onclick = () => [0, 1, 2, 3].forEach((i) => setTimeout(() => hub.emit("step", { foot: i % 2 ? "R" : "L", strength: 0.4, surface: "stone", inPlace: true }), i * 380));
document.querySelectorAll("[data-impact]").forEach((b) => (b.onclick = () => hub.emit("impact", { strength: Number(b.dataset.impact) })));
$("flash").onclick = () => hub.emit("flash", {});
for (const name of ["nod", "wave", "bow", "flex", "jacks", "dance", "roar", "stomp", "kneel", "backflip", "pushups", "handstand", "spin", "look_around", "crack_neck", "look_hands", "stretch", "activate", "celebrate"]) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => {
    hub.emit("stunt", { name, marker: "start" });
    if (name === "celebrate") for (const [m, t] of [["notice", 0.2], ["prepare", 1.05], ["shift", 1.7], ["raise", 2.25], ["climax", 3.5], ["settle", 5], ["return", 6.3]]) setTimeout(() => hub.emit("stunt", { name, marker: m }), t * 1000);
    if (name === "activate") setTimeout(() => hub.emit("stunt", { name, marker: "lever" }), 1700);
  };
  $("stunts").appendChild(b);
}

// --- Nonverbal ---------------------------------------------------------------------------------------
for (const kind of KINDS) {
  const b = document.createElement("button");
  b.textContent = kind;
  b.onclick = () => sound.reactions.react(kind, { force: true }) || log(`${kind}: not loaded yet`);
  $("reactions").appendChild(b);
}
$("voiceApply").onclick = async () => {
  await sound.reactions.setVoice({ id: $("voice").value, pitch: Number($("pitch").value) });
  log(`nonverbal voice ${sound.reactions.voice} at pitch ${sound.reactions.pitch}`);
};

// --- Gift events: the beat and marker timelines of public/stream/events.js -------------------------
// [seconds, kind, ...] kind: beat name | "m" stunt marker | "start" stunt | "step" | "flash" | "light"
const TIMELINES = {
  bolt: [[0, "recognition"], [0, "anticipation"], [0.05, "start", "twitch"], [0.1, "development"], [0.6, "m", "twitch", "spark"], [1.4, "m", "twitch", "climax"], [1.4, "climax"], [2.3, "m", "twitch", "settle"], [2.3, "reaction"], [3.2, "decay"], [3.6, "end"]],
  pumpkin: [[0, "recognition"], [1, "anticipation"], ...walk(1.1, 3.0), [3.2, "start", "listen"], [3.2, "development"], [3.8, "m", "listen", "listen"], [5.3, "m", "listen", "climax"], [5.3, "climax"], [5.9, "m", "listen", "reaction"], [5.9, "reaction"], [7.6, "decay"], [8.1, "end"]],
  gate: [[0, "recognition"], [0.8, "anticipation"], ...walk(0.9, 3.3), [3.5, "start", "gate_react"], [3.5, "development"], [4.0, "m", "gate_react", "creak"], [5.4, "m", "gate_react", "climax"], [5.4, "climax"], [6.6, "m", "gate_react", "reaction"], [6.6, "reaction"], [8.0, "decay"], [8.6, "end"]],
  lab: [[0, "recognition"], [0.8, "anticipation"], ...walk(0.9, 3.3), [3.5, "start", "activate"], [3.5, "development"], [5.2, "m", "activate", "lever"], [7.9, "climax"], [8.7, "light", 0.8], [8.1, "reaction"], [10.5, "decay"], [11, "end"]],
  grand: [[0, "recognition"], [0.3, "light", 0.6], [1, "anticipation"], ...walk(1.1, 3.2), [3.5, "start", "reanimate"], [3.5, "development"], [3.8, "flash"], [3.8, "m", "reanimate", "jolt"], [4.3, "light", 0.5], [4.7, "flash"], [5.6, "flash"], [6.5, "m", "reanimate", "climax"], [6.5, "climax"], [7.1, "light", 0.6], [9.5, "reaction"], [9.55, "start", "celebrate"], [16.5, "decay"], [19, "end"]],
};
TIMELINES.labGalaxy = [...TIMELINES.lab.filter(([t, k]) => t < 8 || k === "light" || k === "reaction"), ...layer(7.95, 3.2), [18.7, "decay"], [19.2, "end"]].map((e) => [...e, "galaxy"]);
// the base event ends only after the lion has gone (events.js waits for its layers)
TIMELINES.grandLion = [...TIMELINES.grand.filter(([, k]) => k !== "end"), [21, "end"], ...layer(9.55, 3.45)].map((e) => [...e, "lion"]);
function walk(from, to) {
  const out = [];
  for (let t = from, i = 0; t < to; t += 0.56, i++) out.push([t, "step", i % 3 === 2 ? "soil" : "stone"]);
  return out;
}
function layer(at, climaxIn) {
  return [[at, "recognition"], [at + 0.7, "anticipation"], [at + 2.4, "development"], [at + climaxIn, "climax"], [at + climaxIn + 0.9, "reaction"], [at + climaxIn + 2.6, "decay"], [at + climaxIn + 7.5, "end"]];
}
let timers = [];
function runEvent(key) {
  cutEvent(false);
  const event = key.startsWith("lab") ? "lab" : key.startsWith("grand") ? "grand" : key;
  const id = `lab-${Date.now()}`;
  for (const entry of TIMELINES[key]) {
    const [t, kind, a, b] = entry;
    const variant = entry[entry.length - 1] === "galaxy" || entry[entry.length - 1] === "lion" ? entry[entry.length - 1] : null;
    timers.push(setTimeout(() => {
      if (kind === "m") hub.emit("stunt", { name: a, marker: b });
      else if (kind === "start") hub.emit("stunt", { name: a, marker: "start" });
      else if (kind === "step") hub.emit("step", { foot: "L", strength: 0.7, surface: a, inPlace: false, speed: 1 });
      else if (kind === "flash") hub.emit("flash", {});
      else if (kind === "light") hub.emit("lightning", { delay: a, strength: 0.04 });
      else hub.emit("signature", { event, beat: kind, variant, id });
    }, t * 1000));
  }
  log(`event ${key}`);
}
function cutEvent(announce = true) {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (announce) {
    hub.emit("signature", { event: sound.events.active?.event || "bolt", beat: "cut", variant: null });
    hub.emit("message", { t: "skip" });
    log("cut");
  }
}
for (const [key, label] of [["bolt", "Bolt Spark (30+)"], ["pumpkin", "Pumpkin Whisper (100+)"], ["gate", "Haunted Gate (500+)"], ["lab", "Laboratory Surge (1000+)"], ["labGalaxy", "Lab Surge · Galaxy"], ["grand", "Grand Reanimation (3000+)"], ["grandLion", "Grand · Lion"]]) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => runEvent(key);
  $("events").appendChild(b);
}
$("cut").onclick = () => cutEvent(true);
let giftN = 0;
const gift = (coins) => hub.emit("message", { t: "gift", user: { id: `lab${giftN}`, nick: "lab" }, gift: { name: "Rose", count: 1, coins }, total: coins, tier: "ack", msgId: `lab-${giftN++}` });
document.querySelectorAll("[data-ack]").forEach((b) => (b.onclick = () => gift(Number(b.dataset.ack))));
$("burst").onclick = () => [...Array(10)].forEach((_, i) => setTimeout(() => gift(1 + (i % 3) * 7), i * 200));

// --- Cues -------------------------------------------------------------------------------------------
for (const name of ["choice-open", "choice-close", "mystery-clue", "mystery-payoff", "surprise"]) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => hub.emit("cue", { name });
  $("cues").appendChild(b);
}
for (const [label, fn] of [["milestone (likes)", () => hub.emit("message", { t: "milestone", kind: "likes", total: Date.now() })], ["top supporter carved", () => sound.events.carve()]]) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = fn;
  $("cues").appendChild(b);
}

// --- Speech check -------------------------------------------------------------------------------------
async function say(voice, file) {
  const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const duration = (bytes.length - 44) / 2 / new DataView(bytes.buffer).getUint32(24, true);
  audio.duck(true);
  hub.emit("line", { phase: "start" });
  hub.emit("speech", { phase: "start", role: voice === "reader" ? "reader" : "reply" });
  await audio.play({ wav: btoa(bin), duration }, { voice });
  hub.emit("speech", { phase: "end" });
  hub.emit("line", { phase: "end" });
  audio.duck(false);
}
$("sayCreature").onclick = () => say("creature", "/assets/sounds/test/speech_creature.wav");
$("sayReader").onclick = () => say("reader", "/assets/sounds/test/speech_reader.wav");
$("sayOver").onclick = () => {
  runEvent("grand");
  setTimeout(() => say("creature", "/assets/sounds/test/speech_creature.wav"), 6000);
};
window.lab = { hub, audio, sound, runEvent, cutEvent, gift, say, weather };
