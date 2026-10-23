import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, character } from "./config.js";
import { normalizeLayout } from "../public/stream/safe-areas.js";

const FILE = path.join(ROOT, "settings.json");

export const EFFECTS = ["sparks", "pumpkins", "bats", "lightning", "ghosts", "fireworks", "bloodmoon", "storm", "legend"];

// Presets for his voice on the Show settings tab: a Kokoro voice, how far it is pitched
// down, and how fast it is spoken before pitching (pitching down also slows it).
// Kept above ~0.9 so the words stay clear on phone speakers; "booming" is the deep option.
export const VOICE_PRESETS = {
  "deep giant": { id: "am_onyx", pitch: 0.93, speed: 1.04 },
  gravel: { id: "am_puck", pitch: 0.9, speed: 1.06 },
  "gentle giant": { id: "am_michael", pitch: 0.92, speed: 1.04 },
  "old world": { id: "bm_lewis", pitch: 0.95, speed: 1.03 },
  booming: { id: "am_onyx", pitch: 0.86, speed: 1.1 },
};

const DEFAULTS = {
  tiktokUsername: "",
  readComments: true,
  readerVoice: "varied", // "varied" (one per viewer), a Kokoro voice id, or "off"
  commandsEnabled: true,
  // The local AI shares the graphics card with the 3D scene, so the default is TikTok's own
  // 1080x1920 at 30 fps: measured on an RTX 3060, the AI writes about twice as fast as with
  // High at 60 fps, which is what makes quick replies possible.
  graphics: "medium", // low | medium | high | ultra
  fps: 30, // 30 | 60
  voice: { preset: "deep giant", ...VOICE_PRESETS["deep giant"] },
  // profile: a safe-area profile from public/stream/safe-areas.js ("standard", "busy", "compact" or
  // "custom", whose numbers are in `custom`). subtitleY, commentY and giftBannerY are the old
  // absolute positions, kept so older stream windows still load; the profile now places everything.
  layout: { profile: "standard", custom: null, subtitleY: 58, commentY: 13, giftBannerY: 30, showTopGifter: true },
  // Audience choices, environmental mysteries and free surprises (src/choices.js). Minutes are the
  // average gap; the show waits for a quiet moment and never starts one during a conversation.
  interaction: { choices: true, choiceMinutes: 7, mysteries: true, mysteryMinutes: 12, surprises: true, surpriseMinutes: 20 },
  music: { volume: 0.25, tracks: [] },
  // The verified gift value (coins, per single gift or completed combo) that starts each of the
  // five Halloween events in character.json "giftEvents"; each must be above the one before.
  eventThresholds: Object.fromEntries((character.giftEvents || []).map((e) => [e.id, e.minCoins])),
  // The sound design (public/stream/sound): category volumes (1 = as mixed, 0..2), all effect
  // sound on/off (his voice and the music stay), and ambience layers one by one.
  sound: {
    enabled: true,
    volumes: { dialogue: 1, nonverbal: 1, ambience: 1, weather: 1, fx: 1, ui: 1, music: 1 },
    layers: { wind: true, trees: true, rain: true, rainSurfaces: true, thunder: true, candles: true, creaks: true, wildlife: true, supernatural: true, lab: true },
  },
};

// Thresholds kept strictly increasing in the events' own order, whatever was typed.
function cleanThresholds(t = {}) {
  const out = {};
  let floor = 1;
  for (const e of character.giftEvents || []) {
    const v = Math.max(floor, Math.round(clamp(t[e.id], 1, 1_000_000, e.minCoins)));
    out[e.id] = v;
    floor = v + 1;
  }
  return out;
}

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);

function cleanSound(s = {}) {
  const d = DEFAULTS.sound;
  return {
    enabled: s?.enabled !== false,
    volumes: Object.fromEntries(Object.keys(d.volumes).map((k) => [k, clamp(s?.volumes?.[k], 0, 2, 1)])),
    layers: Object.fromEntries(Object.keys(d.layers).map((k) => [k, s?.layers?.[k] !== false])),
  };
}
// A partial patch ({ sound: { volumes: { fx: 0.8 } } }) keeps the other sound settings.
const mergeSound = (base = {}, patch = {}) => ({ ...base, ...patch, volumes: { ...base.volumes, ...patch.volumes }, layers: { ...base.layers, ...patch.layers } });


function sanitize(s) {
  const layout = s.layout || {};
  const voice = s.voice || {};
  return {
    tiktokUsername: String(s.tiktokUsername || "").replace(/^@/, "").trim().slice(0, 40),
    readComments: s.readComments !== false,
    readerVoice: /^(varied|off|[ab][mf]_[a-z]+)$/.test(s.readerVoice) ? s.readerVoice : "varied",
    commandsEnabled: s.commandsEnabled !== false,
    graphics: ["low", "medium", "high", "ultra"].includes(s.graphics) ? s.graphics : "medium",
    fps: Number(s.fps) === 60 ? 60 : 30,
    voice: {
      preset: String(voice.preset || "custom"),
      id: /^[ab][mf]_[a-z]+$/.test(voice.id) ? voice.id : "am_onyx",
      pitch: clamp(voice.pitch, 0.6, 1.2, 0.93),
      speed: clamp(voice.speed, 0.7, 1.5, 1.04),
    },
    interaction: {
      choices: s.interaction?.choices !== false,
      choiceMinutes: clamp(s.interaction?.choiceMinutes, 2, 60, 7),
      mysteries: s.interaction?.mysteries !== false,
      mysteryMinutes: clamp(s.interaction?.mysteryMinutes, 3, 90, 12),
      surprises: s.interaction?.surprises !== false,
      surpriseMinutes: clamp(s.interaction?.surpriseMinutes, 5, 120, 20),
    },
    layout: {
      ...normalizeLayout(layout),
      subtitleY: clamp(layout.subtitleY, 20, 85, 58),
      commentY: clamp(layout.commentY, 10, 50, 13),
      giftBannerY: clamp(layout.giftBannerY, 15, 70, 30),
      showTopGifter: layout.showTopGifter !== false,
    },
    music: {
      volume: clamp(s.music?.volume, 0, 1, 0.25),
      tracks: (s.music?.tracks || []).filter((t) => typeof t === "string").slice(0, 10),
    },
    eventThresholds: cleanThresholds({ ...DEFAULTS.eventThresholds, ...s.eventThresholds }),
    sound: cleanSound(s.sound),
  };
}

// Show settings edited on the setup page; saved to settings.json and pushed to stream windows live.
export class Settings extends EventEmitter {
  constructor() {
    super();
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      // first run
    }
    // Tiers saved by the first version (one "effect" each) move to the new escalating defaults.
    // The thirteen coin tiers and the coin-funded meter were replaced by the five Halloween events.
    delete saved.giftTiers;
    delete saved.meterCoins;
    // A saved preset always uses the preset's current tuning.
    if (VOICE_PRESETS[saved.voice?.preset]) saved.voice = { ...VOICE_PRESETS[saved.voice.preset], preset: saved.voice.preset };
    this.value = sanitize({ ...DEFAULTS, ...saved, layout: { ...DEFAULTS.layout, ...saved.layout }, interaction: { ...DEFAULTS.interaction, ...saved.interaction }, music: { ...DEFAULTS.music, ...saved.music }, voice: { ...DEFAULTS.voice, ...saved.voice } });
  }

  get() {
    return this.value;
  }

  update(patch) {
    const v = this.value;
    if (patch.voice?.preset && VOICE_PRESETS[patch.voice.preset]) patch.voice = { ...VOICE_PRESETS[patch.voice.preset], preset: patch.voice.preset };
    if (patch.sound) patch = { ...patch, sound: mergeSound(v.sound, patch.sound) };
    this.value = sanitize({ ...v, ...patch, layout: { ...v.layout, ...patch.layout }, interaction: { ...v.interaction, ...patch.interaction }, music: { ...v.music, ...patch.music }, voice: { ...v.voice, ...patch.voice } });
    fs.writeFileSync(FILE, JSON.stringify(this.value, null, 2));
    this.emit("change", this.value);
    return this.value;
  }

  reset(key) {
    return this.update({ [key]: structuredClone(DEFAULTS[key]) });
  }
}

