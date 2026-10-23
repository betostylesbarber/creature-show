// The mix: how loud each sound plays against his voice, on which bus, with how much random
// variation, reverb send, voice limit and cooldown. The files themselves (variants, measured
// loudness) come from assets/sounds/manifest.json, built by scripts/sound/build.mjs, where
// one-shots are levelled to -20 LUFS (loudest 400 ms) and loops to -23 LUFS integrated, so the
// gains below are true mix decisions. Checked in context against captures (see SOUND.md).
//
// Fields: bus, category (voice limit group, defaults to bus), gainDb, gainJitter (± dB),
// pitchJitter (± semitones), send (reverb send dB), cooldown (s), priority (higher steals),
// lowpass / highpass (Hz).
export const LIBRARY = {
  // Ambience layers (levels are the layer's full level; ambience.js scales them)
  "amb.wind": { bus: "ambience", gainDb: -13 },
  "amb.air": { bus: "ambience", gainDb: -15 },
  "amb.trees": { bus: "ambience", gainDb: -14 },
  "amb.candle": { bus: "ambience", gainDb: -16 },
  "amb.fire": { bus: "ambience", gainDb: -14 },
  "amb.hum": { bus: "ambience", gainDb: -26 },
  "amb.coil": { bus: "fx", gainDb: -10 },
  "amb.spirit": { bus: "ambience", gainDb: -22 },
  "rain.far": { bus: "weather", gainDb: -11 },
  "rain.near": { bus: "weather", gainDb: -16 },
  "rain.leaves": { bus: "weather", gainDb: -17 },
  "rain.stone": { bus: "weather", gainDb: -17 },
  "rain.metal": { bus: "weather", gainDb: -20 },
  "rain.puddle": { bus: "weather", gainDb: -19 },
  "rain.heavy": { bus: "weather", gainDb: -9 },
  "rain.drips": { bus: "weather", gainDb: -18 },

  // Weather and ambience one-shots
  "thunder.far": { bus: "weather", category: "thunder", gainDb: -1, gainJitter: 2, pitchJitter: 1.5, send: -14, priority: 2 },
  "thunder.mid": { bus: "weather", category: "thunder", gainDb: 0, gainJitter: 1.5, pitchJitter: 1, send: -16, priority: 2 },
  "thunder.close": { bus: "weather", category: "thunder", gainDb: 3, gainJitter: 1, pitchJitter: 0.7, send: -18, priority: 3 },
  "amb.creak": { bus: "ambience", category: "detail", gainDb: -17, gainJitter: 2, pitchJitter: 1.5, send: -8, cooldown: 9 },
  "amb.rattle": { bus: "ambience", category: "detail", gainDb: -20, gainJitter: 2, pitchJitter: 1, send: -8, cooldown: 12 },
  "amb.settle": { bus: "ambience", category: "detail", gainDb: -19, gainJitter: 2, pitchJitter: 2, send: -6, cooldown: 14 },
  "amb.branch": { bus: "ambience", category: "detail", gainDb: -17, gainJitter: 2, pitchJitter: 1.5, send: -10, cooldown: 6 },
  "amb.crow": { bus: "ambience", category: "wildlife", gainDb: -15, gainJitter: 2, pitchJitter: 1, send: -6, cooldown: 40 },
  "amb.owl": { bus: "ambience", category: "wildlife", gainDb: -14, gainJitter: 2, pitchJitter: 0.5, send: -6, cooldown: 50 },
  "amb.batwings": { bus: "ambience", category: "wildlife", gainDb: -15, gainJitter: 2, pitchJitter: 1, send: -10, cooldown: 30 },
  "amb.batsqueak": { bus: "ambience", category: "wildlife", gainDb: -21, gainJitter: 3, pitchJitter: 1.5, send: -10 },

  // His foley
  "step.stone": { bus: "nonverbal", category: "steps", gainDb: -5, gainJitter: 1.5, pitchJitter: 0.6, send: -20 },
  "step.soil": { bus: "nonverbal", category: "steps", gainDb: -5, gainJitter: 1.5, pitchJitter: 0.6, send: -22 },
  "step.grass": { bus: "nonverbal", category: "steps", gainDb: -4, gainJitter: 1.5, pitchJitter: 0.6, send: -22 },
  "step.scuff": { bus: "nonverbal", category: "steps", gainDb: -10, gainJitter: 2, pitchJitter: 1 },
  "step.brush": { bus: "nonverbal", category: "steps", gainDb: -9, gainJitter: 2, pitchJitter: 1 },
  "step.weight": { bus: "nonverbal", category: "steps", gainDb: -9, gainJitter: 1.5, pitchJitter: 0.5 },
  "step.wet": { bus: "nonverbal", category: "steps", gainDb: -13, gainJitter: 2, pitchJitter: 1 },
  "cloth.move": { bus: "nonverbal", category: "cloth", gainDb: -4, gainJitter: 2, pitchJitter: 1 },
  "cloth.big": { bus: "nonverbal", category: "cloth", gainDb: -5, gainJitter: 1.5, pitchJitter: 1 },
  "leather": { bus: "nonverbal", category: "cloth", gainDb: -7, gainJitter: 2, pitchJitter: 1.5, cooldown: 2.5 },
  "hardware": { bus: "nonverbal", category: "cloth", gainDb: -9, gainJitter: 2, pitchJitter: 1.5, cooldown: 3 },
  "body.impact": { bus: "nonverbal", category: "impact", gainDb: -2, gainJitter: 1, pitchJitter: 0.5, send: -16 },
  "breath.in": { bus: "nonverbal", category: "breath", gainDb: -7, gainJitter: 1.5, pitchJitter: 0.4 },
  "breath.out": { bus: "nonverbal", category: "breath", gainDb: -7, gainJitter: 1.5, pitchJitter: 0.4 },
  "nv": { bus: "nonverbal", category: "vocal", gainDb: -1, gainJitter: 0.8, pitchJitter: 0.25, priority: 2 },

  // Electricity and the apparatus
  "elec.spark": { bus: "fx", category: "elec", gainDb: 2, gainJitter: 2, pitchJitter: 2, send: -16 },
  "elec.zap": { bus: "fx", category: "elec", gainDb: 0, gainJitter: 2, pitchJitter: 1.5, send: -14 },
  "elec.arc": { bus: "fx", category: "elec", gainDb: -2, gainJitter: 2, pitchJitter: 1.5, send: -12 },
  "elec.buzz": { bus: "fx", gainDb: -6 },
  "elec.crackle": { bus: "fx", gainDb: -8 },
  "elec.relay": { bus: "fx", category: "mech", gainDb: 0, gainJitter: 1.5, pitchJitter: 1, send: -14 },
  "elec.relays": { bus: "fx", category: "mech", gainDb: -5, gainJitter: 1, send: -14 },
  "elec.lever": { bus: "fx", category: "mech", gainDb: 3, gainJitter: 0.5, send: -12, priority: 3 },
  "lab.charge": { bus: "fx", category: "event", gainDb: 0, send: -16, priority: 3 },
  "lab.discharge": { bus: "fx", category: "event", gainDb: 4, send: -12, priority: 4 },
  "lab.tail": { bus: "fx", category: "event", gainDb: 0, send: -12, priority: 3 },
  "lab.powerdown": { bus: "fx", category: "event", gainDb: -1, priority: 3 },

  // Gift acknowledgments and signature events
  "ack.glint": { bus: "fx", category: "ack", gainDb: 0, gainJitter: 1, pitchJitter: 0.1, send: -14, priority: 1 },
  "ack.two": { bus: "fx", category: "ack", gainDb: 0, gainJitter: 1, send: -14, priority: 1 },
  "ack.three": { bus: "fx", category: "ack", gainDb: 0, gainJitter: 1, send: -16, priority: 1 },
  "bolt.tick": { bus: "fx", category: "event", gainDb: 3, gainJitter: 1.5, pitchJitter: 1, priority: 3 },
  "bolt.buzz": { bus: "fx", category: "event", gainDb: 1, pitchJitter: 0.5, priority: 3 },
  "bolt.snap": { bus: "fx", category: "event", gainDb: 4, gainJitter: 1, pitchJitter: 1, send: -14, priority: 3 },
  "fire.flick": { bus: "fx", category: "event", gainDb: 0, gainJitter: 1.5, pitchJitter: 1, priority: 2 },
  "pumpkin.ignite": { bus: "fx", category: "event", gainDb: 1, pitchJitter: 0.8, send: -14, priority: 3 },
  "pumpkin.whisper": { bus: "fx", category: "event", gainDb: 3, pitchJitter: 0.4, send: -10, priority: 3 },
  "pumpkin.magic": { bus: "fx", category: "event", gainDb: 2, send: -12, priority: 3 },
  "gate.toll": { bus: "fx", category: "event", gainDb: 1, priority: 3 },
  "gate.creak": { bus: "fx", category: "event", gainDb: 2, pitchJitter: 0.8, send: -10, priority: 3 },
  "gate.clank": { bus: "fx", category: "event", gainDb: 1, pitchJitter: 0.8, send: -10, priority: 3 },
  "gate.wind": { bus: "fx", category: "event", gainDb: 1, priority: 3 },
  "gate.spectral": { bus: "fx", category: "event", gainDb: 2, priority: 3 },
  "gate.bats": { bus: "fx", category: "event", gainDb: 1, pitchJitter: 0.5, send: -12, priority: 3 },
  "gal.pad": { bus: "fx", gainDb: -5 },
  "gal.twinkle": { bus: "fx", category: "twinkle", gainDb: 1, gainJitter: 3, pitchJitter: 0.05, send: -8 },
  "gal.rise": { bus: "fx", category: "event", gainDb: 1, priority: 3 },
  "gal.bloom": { bus: "fx", category: "event", gainDb: 2, priority: 4 },
  "grand.toll": { bus: "fx", category: "event", gainDb: 2, priority: 4 },
  "grand.choir": { bus: "fx", category: "event", gainDb: 0, priority: 3 },
  "grand.chimes": { bus: "fx", category: "event", gainDb: 1, priority: 2 },
  "lion.growl": { bus: "fx", category: "event", gainDb: 1, pitchJitter: 0.5, priority: 3 },
  "lion.roar": { bus: "fx", category: "event", gainDb: 2, pitchJitter: 0.3, priority: 4 },
  "fw.burst": { bus: "fx", category: "fireworks", gainDb: 0, gainJitter: 2, pitchJitter: 2, send: -10 },

  // Interface cues
  "ui.open": { bus: "ui", category: "ui", gainDb: -3, cooldown: 1 },
  "ui.close": { bus: "ui", category: "ui", gainDb: -4, cooldown: 1 },
  "ui.clue": { bus: "ui", category: "ui", gainDb: -3, cooldown: 2 },
  "ui.payoff": { bus: "ui", category: "ui", gainDb: -2, cooldown: 2 },
  "ui.surprise": { bus: "ui", category: "ui", gainDb: -3, cooldown: 2 },
  "ui.milestone": { bus: "ui", category: "ui", gainDb: -2, cooldown: 5 },
  "ui.carve": { bus: "ui", category: "ui", gainDb: -4, send: -12, cooldown: 3 },
};

// Voices per category (the global budget is 48).
export const CATEGORY_LIMITS = {
  steps: 6, cloth: 3, impact: 2, breath: 1, vocal: 1,
  detail: 2, wildlife: 2, thunder: 3,
  elec: 6, mech: 3, event: 12, ack: 2, twinkle: 6, fireworks: 4,
  ui: 2, fx: 8, ambience: 6, weather: 6, nonverbal: 4,
};

// Mixer categories the operator can set (sound settings) and their defaults.
export const CATEGORIES = ["dialogue", "nonverbal", "ambience", "weather", "fx", "ui", "music"];
export const DEFAULT_SETTINGS = {
  enabled: true,
  volumes: { dialogue: 1, nonverbal: 1, ambience: 1, weather: 1, fx: 1, ui: 1, music: 1 },
  layers: { wind: true, trees: true, rain: true, rainSurfaces: true, thunder: true, candles: true, creaks: true, wildlife: true, supernatural: true, lab: true },
};
