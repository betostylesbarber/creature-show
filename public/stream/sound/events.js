// Gift events, effects and interaction cues.
//
// The five Halloween gift events (public/stream/events.js) each have their own sound identity,
// and their complexity grows with the tier rather than their loudness:
//   bolt     Bolt Spark          close, intimate electricity at his neck          4 layers
//   pumpkin  Pumpkin Whisper     warm fire, a whisper from inside a pumpkin       6 layers
//   gate     Haunted Gate        bell, wind, iron, a spectral swell, bats         8 layers
//   lab      Laboratory Surge    relays, knife switch, coils, arcs, discharge     10 layers
//   grand    Grand Reanimation   bell, storm, apparatus, choir, aftermath         12 layers
// Variants: "galaxy" on lab (starlight: shimmer pad, twinkles, a crystal bloom) and "lion" on
// grand (a controlled spectral lion: growls building, a roar with weight in the low mids).
//
// Timing comes from the show, never from free-running timers: the event's beats (hub
// "signature": recognition, anticipation, development, climax, reaction, decay, end | cut) on
// the frame clock, and the stunt markers of his actual movements (twitch:spark, listen:listen,
// gate_react:creak, activate:lever ...). The climax beat waits for his animation, so the
// strongest sound lands on the picture. A variant runs its own beat sequence (the galaxy or the
// lion) after the base climax; both sequences are told apart by their order (see route()).
// "cut" and t:"skip" stop everything an event owns within 0.35 s and restore the ambience.
import { signatureName, ackLevel, AckGate, spatial } from "./rules.js";
import { toCamera } from "./ambience.js";

export const BEATS = ["recognition", "anticipation", "development", "climax", "reaction", "decay", "end"];

// Which of an event's two beat streams a beat belongs to: the variant layer's if it is running
// and expects exactly this beat next, otherwise the base event's. Pure, for the tests.
export function routeBeat(st, beat) {
  const next = (stream) => BEATS[stream.last == null ? 0 : BEATS.indexOf(stream.last) + 1];
  if (st.layer && !st.layer.done && next(st.layer) === beat) return "layer";
  if (beat === "recognition" && st.base.last != null && st.variant) {
    st.layer = { last: null, done: false };
    return "layer";
  }
  return "base";
}

export class EventSounds {
  constructor(engine, ambience, reactions, hub, { random = Math.random } = {}) {
    this.engine = engine;
    this.ambience = ambience;
    this.reactions = reactions;
    this.hub = hub;
    this.random = random;
    this.active = null;
    this.ackGate = new AckGate();
    this.enabled = true;
    this.serial = 0;
  }

  // --- Signature events ----------------------------------------------------------------------
  signature({ event, beat, variant, id }) {
    const sig = signatureName(event, variant);
    if (!sig || !this.enabled) return;
    if (beat === "cut") return this.finish(0.35);
    let st = this.active;
    if (st && (st.event !== sig.event || (id != null && st.id != null && id !== st.id))) {
      this.finish(0.5);
      st = null;
    }
    if (!st) {
      if (beat === "end") return;
      st = this.active = this.state(sig, id);
    }
    const stream = routeBeat(st, beat);
    const d = this.director(st);
    if (stream === "layer") {
      st.layer.last = beat;
      VARIANTS[st.variant]?.[beat]?.(d);
      if (beat === "end") {
        st.layer.done = true;
        for (const name of Object.keys(st.layers)) if (name.startsWith("v:")) d.stopLayer(name, 3);
      }
      return;
    }
    st.base.last = beat;
    if (beat === "end") return this.finish(2.5, true);
    SCORES[st.event]?.[beat]?.(d);
  }

  marker(stunt, marker) {
    const st = this.active;
    if (!st) return;
    st.markers.add(marker);
    SCORES[st.event]?.[`marker:${marker}`]?.(this.director(st));
  }

  state({ event, variant }, id) {
    const group = `sig:${event}:${++this.serial}`;
    this.ambience.eventActive = true;
    return { event, variant, id: id ?? null, group, layers: {}, timers: new Set(), markers: new Set(), base: { last: null }, layer: null, since: this.engine.now };
  }

  // Ends the active event. Cut: everything fades out at once. Natural end: the loops fade and
  // the one-shots ring out.
  finish(fade = 0.35, natural = false) {
    const st = this.active;
    if (!st) return;
    this.active = null;
    for (const t of st.timers) clearTimeout(t);
    st.timers.clear();
    for (const l of Object.values(st.layers)) l.stop(natural ? fade : Math.min(fade, 0.4));
    if (!natural) this.engine.stopGroup(st.group, fade);
    this.ambience.eventActive = false;
    Object.assign(this.ambience.boost, { wind: 0, candles: 0, fire: 0, spirit: 0, drips: 0 });
    this.ambience.apply(natural ? 3 : 1);
    this.reactions?.policy && (this.reactions.lastEventEnd = this.engine.now);
  }

  director(st) {
    const self = this;
    const e = this.engine;
    const alive = () => self.active === st;
    const d = {
      st,
      play: (id, o = {}) => (alive() ? e.play(id, { group: st.group, ...o }) : null),
      layer(name, id, o = {}, level = 1, fade = 1) {
        if (!alive()) return null;
        st.layers[name]?.stop(0.3);
        const l = (st.layers[name] = e.layer(id, { group: st.group, ...o }));
        return l.start(level, fade);
      },
      fade(name, level, seconds = 1) {
        st.layers[name]?.setLevel(level, seconds);
      },
      stopLayer(name, fade = 1) {
        st.layers[name]?.stop(fade);
        delete st.layers[name];
      },
      // an event's reaction outranks idle ones (it is the "personal reaction" beat)
      react: (kind, o = {}) => (alive() ? self.reactions?.react(kind, { group: st.group, priority: true, ...o }) : null),
      // A random-interval repetition (arcs, twinkles) until stopped or the event ends.
      every(name, [min, max], fn, { limit = Infinity } = {}) {
        let n = 0;
        (st.stopped ??= new Set()).delete(name);
        const run = () => {
          if (!alive() || st.stopped.has(name) || n++ >= limit) return;
          fn(n);
          const t = setTimeout(run, (min + self.random() * (max - min)) * 1000);
          st.timers.add(t);
        };
        run();
      },
      stop(name) {
        (st.stopped ??= new Set()).add(name);
      },
      after(seconds, fn) {
        const t = setTimeout(() => alive() && fn(), seconds * 1000);
        st.timers.add(t);
      },
      // Do `fn` once: on the stunt marker if it comes, else after `seconds` (fallback).
      once(key, seconds, fn) {
        if (st.markers.has(`done:${key}`)) return;
        const run = () => {
          if (!alive() || st.markers.has(`done:${key}`)) return;
          st.markers.add(`done:${key}`);
          fn();
        };
        if (seconds == null) run();
        else d.after(seconds, run);
      },
      boost(values, seconds = 1.5) {
        if (!alive()) return;
        Object.assign(self.ambience.boost, values);
        self.ambience.apply(seconds);
      },
      hold: (s) => self.ambience.hold(s),
      pan: (which) => self.pan(which),
      random: self.random,
    };
    return d;
  }

  // Where things are, as a subtle pan for the camera.
  pan(which) {
    const ctx = this.hub.ctx;
    let at = null;
    const g = ctx?.spots?.gate?.at;
    if (which === "gate" && g) at = { x: g[0], y: 1.5, z: g[1] };
    if ((which === "coilL" || which === "coilR") && g) at = { x: g[0] + (which === "coilL" ? -1.4 : 1.4), y: 2, z: (ctx.environment?.groundBox?.min.z ?? -5) - 0.55 };
    if (which === "lever" && ctx?.apparatus?.position) at = ctx.apparatus.position;
    if (which === "pumpkin") {
      const me = ctx?.avatar?.root?.position;
      let best = null;
      let bd = Infinity;
      for (const p of ctx?.environment?.pumpkins || []) {
        const dd = me ? (p.position.x - me.x) ** 2 + (p.position.z - me.z) ** 2 : 0;
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      at = best?.position || null;
    }
    if (!at) return which === "coilL" ? -0.3 : which === "coilR" ? 0.3 : 0;
    const local = toCamera(ctx?.camera, at, ctx?.THREE);
    return local ? spatial(local, { maxPan: 0.55 }).pan : 0;
  }

  // --- Gifts below the first event: a brief, varied acknowledgment -------------------------
  gift(msg) {
    if (!this.enabled || msg.event || msg.signature) return;
    const decision = this.ackGate.decide(this.engine.now);
    if (!decision) return;
    const level = decision === "soft" ? 0 : ackLevel(msg.total ?? msg.gift?.coins);
    const id = ["ack.glint", "ack.two", "ack.three"][level];
    const talking = this.reactions?.policy.lineActive || this.reactions?.policy.speaking;
    this.engine.play(id, { gainDb: (decision === "soft" ? -5 : this.active ? -5 : 0) + (talking ? -6 : 0), pan: (this.random() - 0.5) * 0.3 });
    this.engine.play("elec.spark", { delay: 0.05, gainDb: -10 }); // the little spark at his neck
  }

  // --- The show's gift effects, where main.js still emits them --------------------------------
  effect(name) {
    if (!this.enabled) return;
    const e = this.engine;
    const during = Boolean(this.active); // an event's score already carries the moment
    switch (name) {
      case "sparks":
        if (!during) e.play("bolt.snap", { gainDb: -5 });
        break;
      case "pumpkins":
        if (!during) e.play("pumpkin.ignite", { gainDb: -5, pan: this.pan("pumpkin") });
        break;
      case "bats":
        if (!during) e.play("gate.bats", { gainDb: -4, pan: -0.35 });
        break;
      case "lightning":
        e.play("elec.zap", { gainDb: during ? -8 : -3, pan: (this.random() - 0.5) * 0.4 });
        break;
      case "ghosts":
        if (!during) e.play("gate.spectral", { gainDb: -5 });
        break;
      case "fireworks":
        // seven bursts 0.38 s apart, about 12 m behind the cemetery (spooky.js launch())
        for (let i = 0; i < 7; i++) e.play("fw.burst", { delay: i * 0.38 + 0.035, gainDb: -6 + (this.random() - 0.5) * 3, pan: (this.random() - 0.5) * 0.9, lowpass: 7000 });
        break;
      case "bloodmoon":
        if (!during) {
          e.play("grand.toll", { gainDb: -6 });
          e.play("grand.choir", { delay: 0.6, gainDb: -8 });
        }
        break;
      case "storm":
        if (!during) e.play("gate.wind", { gainDb: -2 });
        break;
      case "legend":
        if (!during) {
          e.play("grand.toll", { gainDb: -4 });
          e.play("grand.choir", { delay: 1.2, gainDb: -6 });
        }
        break;
    }
  }

  // --- Interaction cues (from the audience-choice module) -------------------------------------
  cue(name) {
    if (!this.enabled) return;
    const e = this.engine;
    switch (name) {
      case "choice-open":
        e.play("ui.open");
        break;
      case "choice-close":
        e.play("ui.close");
        break;
      case "mystery-clue":
        e.play("ui.clue");
        this.reactions?.react("curious", { delay: 1.3 });
        break;
      case "mystery-payoff":
        e.play("ui.payoff");
        this.reactions?.react("delight", { delay: 1.1 });
        break;
      case "surprise":
        e.play("ui.surprise");
        break;
    }
  }

  // A completed community milestone (likes: the harvest moon): a warm cue, and the candles'
  // crackle follows their light as they burn bright.
  milestone() {
    this.engine.play("ui.milestone");
    this.ambience.boost.candles = 0.5;
    this.ambience.boost.fire = 0.8;
    setTimeout(() => {
      this.ambience.boost.candles = 0;
      this.ambience.boost.fire = 0;
    }, 20000);
  }

  carve() {
    this.engine.play("ui.carve", { pan: -0.25, gainDb: -2 });
  }

  // "Unstick" from the operator: every event sound stops.
  skip() {
    this.finish(0.3);
    this.engine.stopGroup("flash", 0.2);
  }
}

// --- Scores (base events) ------------------------------------------------------------------------
const arcs = (d, gap, gain = -4) => {
  let side = 0;
  d.every("arcs", gap, () => d.play("elec.arc", { pan: d.pan(side++ % 2 ? "coilR" : "coilL"), gainDb: gain + d.random() * 2 }));
};

const SCORES = {
  // Bolt Spark (3-4 s): static at his neck, a short rising buzz, sparks between the bolts, the
  // snap as his shoulders jump and the candles flicker, his chuckle.
  bolt: {
    recognition(d) {
      d.hold(5);
      d.play("bolt.tick", { gainDb: -2 });
      d.play("bolt.tick", { delay: 0.13, gainDb: -6, rate: 1.12 });
    },
    development(d) {
      d.play("bolt.buzz", { gainDb: -1 });
      d.once("spark", 1.2, () => SCORES.bolt.spark(d));
    },
    "marker:spark": (d) => d.once("spark", null, () => SCORES.bolt.spark(d)),
    spark(d) {
      d.play("elec.spark", { gainDb: -2 });
      d.play("elec.spark", { delay: 0.12, gainDb: -5 });
      d.play("elec.zap", { delay: 0.05, gainDb: -9 });
    },
    climax(d) {
      d.play("bolt.snap");
      d.play("hardware", { delay: 0.1, gainDb: -3 }); // the shoulder twitch
      d.play("fire.flick", { delay: 0.04, gainDb: -4, pan: -0.25 });
      d.play("fire.flick", { delay: 0.3, gainDb: -8, pan: 0.3 });
    },
    reaction(d) {
      d.react("chuckle", { delay: 0.1 });
    },
    decay(d) {
      d.play("elec.spark", { delay: 0.15, gainDb: -12 });
    },
  },

  // Pumpkin Whisper (5-7 s): the lantern flares with a soft "fwoomp" and crackles, he leans in,
  // a whisper rises from inside it, a pop of warm magic, his surprised "oh!".
  pumpkin: {
    recognition(d) {
      d.hold(9);
      d.play("pumpkin.ignite", { gainDb: -6, pan: d.pan("pumpkin") });
      d.layer("fire", "amb.fire", { bus: "fx", gainDb: 2, pan: d.pan("pumpkin"), segment: [5, 8], xfade: 1.5 }, 0.7, 0.8);
    },
    anticipation(d) {
      d.boost({ fire: 0.3 });
    },
    development(d) {
      d.fade("fire", 1.1, 1.5);
      d.play("gal.twinkle", { delay: 0.3, gainDb: -10, pan: d.pan("pumpkin") });
      d.once("listen", 2.5, () => SCORES.pumpkin.whisper(d));
    },
    "marker:listen": (d) => d.once("listen", null, () => SCORES.pumpkin.whisper(d)),
    whisper(d) {
      d.play("pumpkin.whisper", { pan: d.pan("pumpkin") * 0.7, fadeIn: 0.25 });
    },
    climax(d) {
      d.play("pumpkin.magic", { pan: d.pan("pumpkin") * 0.5 });
      d.play("pumpkin.ignite", { gainDb: -3, pan: d.pan("pumpkin") });
      d.fade("fire", 1.6, 0.25);
    },
    reaction(d) {
      d.react("surprised", { delay: 0.05 });
      d.fade("fire", 0.8, 1.5);
    },
    decay(d) {
      d.fade("fire", 0, 2.5);
      d.boost({ fire: 0 }, 3);
    },
  },

  // Haunted Gate (8-10 s): a far bell and a crow, the wind rising as he walks over, the iron
  // gate's long creak, a spectral swell as the figure gathers, a clank and bats as it lunges,
  // his startled breath, then a dignified "hmm".
  gate: {
    recognition(d) {
      d.hold(12);
      d.play("gate.toll", { pan: d.pan("gate") * 0.5 });
      d.play("amb.crow", { delay: 1.1, gainDb: -6, pan: d.pan("gate") - 0.3, lowpass: 7000 });
    },
    anticipation(d) {
      d.play("gate.wind", { pan: -0.2 });
      d.boost({ wind: 0.5 }, 2);
    },
    development(d) {
      d.boost({ spirit: 0.8 }, 3);
      d.once("creak", 2.0, () => SCORES.gate.creak(d));
    },
    "marker:creak": (d) => d.once("creak", null, () => SCORES.gate.creak(d)),
    creak(d) {
      d.play("gate.creak", { pan: d.pan("gate") });
      // the figure gathers over ~1.2 s: the swell is entered so its peak meets the lunge
      d.play("gate.spectral", { delay: 0.2, offset: 1.6, gainDb: -2 });
    },
    "marker:startle"(d) {
      d.play("gate.clank", { pan: d.pan("gate") });
    },
    climax(d) {
      d.play("gate.clank", { pan: d.pan("gate"), gainDb: -1 });
      d.play("gate.bats", { delay: 0.05, pan: d.pan("gate") * 0.5 });
      d.play("breath.in", { delay: 0.08, gainDb: -2 });
      d.play("amb.batsqueak", { delay: 0.5, gainDb: -6, pan: 0.3 });
      d.play("amb.batsqueak", { delay: 1.1, gainDb: -8, pan: -0.25 });
    },
    reaction(d) {
      d.react("thoughtful", { delay: 0.35 });
    },
    decay(d) {
      d.play("gate.creak", { delay: 0.5, gainDb: -11, pan: d.pan("gate") });
      d.boost({ wind: 0, spirit: 0 }, 4);
    },
  },

  // Laboratory Surge (10-13 s): a relay wakes the apparatus and its hum, he throws the knife
  // switch, the power is drawn (the candles sag), energy crawls along the cables, the coils
  // charge with arcs leaping between them, the discharge into his bolts, a falling tail.
  lab: {
    recognition(d) {
      d.hold(14);
      d.play("elec.relay", { pan: d.pan("lever"), gainDb: -4 });
      d.layer("coil", "amb.coil", { bus: "fx", gainDb: -6, segment: [6, 9], xfade: 2.5 }, 0.6, 1.5);
    },
    anticipation(d) {
      d.fade("coil", 0.9, 3);
    },
    development(d) {
      d.once("lever", 4.5, () => SCORES.lab.lever(d));
    },
    "marker:lever": (d) => d.once("lever", null, () => SCORES.lab.lever(d)),
    lever(d) {
      {
        d.play("elec.lever", { pan: d.pan("lever") });
        d.play("lab.powerdown", { delay: 0.05 });
        d.play("elec.relays", { delay: 0.15, pan: d.pan("coilR"), gainDb: -2 });
        // energy crawling along the cables (1.1 s), then the coils charge (1.6 s)
        d.every("crawl", [0.09, 0.14], (n) => d.play("elec.spark", { gainDb: -6 - n * 0.3, pan: d.pan("lever") * (1 - n / 10) }), { limit: 10 });
        d.layer("buzz", "elec.buzz", { bus: "fx", gainDb: -6, segment: [5, 8], xfade: 1.2 }, 1, 0.8);
        d.layer("crackle", "elec.crackle", { bus: "fx", gainDb: -8, segment: [4, 7], xfade: 1 }, 1, 1.5);
        d.fade("coil", 1.5, 1);
        d.after(1.0, () => {
          d.st.charge = d.play("lab.charge", { variant: 0, gainDb: -2, fadeIn: 0.2 });
          arcs(d, [0.2, 0.45], -5);
        });
      }
    },
    climax(d) {
      d.stop("arcs");
      d.stop("crawl");
      d.st.charge?.stop(0.04);
      d.stopLayer("buzz", 0.08);
      d.play("lab.discharge");
      d.play("body.impact", { delay: 0.04, gainDb: -9 });
      d.fade("crackle", 1.4, 0.1);
      d.after(0.55, () => d.play("lab.tail", { gainDb: -1 }));
    },
    reaction(d) {
      d.react("delight", { delay: 0.25 });
      d.fade("crackle", 0.4, 2);
    },
    decay(d) {
      d.fade("crackle", 0, 3);
      d.fade("coil", 0, 4);
    },
  },

  // The Grand Reanimation (14-18 s): a deep bell, the storm wind, the apparatus waking, a long
  // charge under spectral voices with arcs and rolling thunder, the full discharge as he rises,
  // his gasp, then a beautiful aftermath of chimes and dripping rain.
  grand: {
    recognition(d) {
      d.hold(20);
      d.play("grand.toll");
      d.play("elec.relay", { delay: 0.7, pan: d.pan("coilL"), gainDb: -4 });
      d.layer("coil", "amb.coil", { bus: "fx", gainDb: -5, segment: [6, 9], xfade: 2.5 }, 0.5, 2);
    },
    anticipation(d) {
      d.play("gate.wind", { gainDb: -3 });
      d.boost({ wind: 0.7 }, 3);
      d.fade("coil", 1, 3);
      d.play("elec.relays", { delay: 0.6, pan: d.pan("coilR"), gainDb: -4 });
    },
    // (the build-up stays well under the climax: measured, it had peaked at its own start)
    development(d) {
      d.play("lab.powerdown", { gainDb: -4 });
      d.st.charge = d.play("lab.charge", { variant: 1, delay: 0.1, gainDb: -5, fadeIn: 0.6 });
      // the choir's swell peaks 5 s in; entered 2 s in, it peaks with the rise
      d.play("grand.choir", { offset: 2, gainDb: -6 });
      d.layer("crackle", "elec.crackle", { bus: "fx", gainDb: -8, segment: [4, 7], xfade: 1 }, 1, 2);
      d.layer("buzz", "elec.buzz", { bus: "fx", gainDb: -8, segment: [5, 8], xfade: 1.2 }, 1, 2.5);
      d.boost({ spirit: 1 }, 3);
      arcs(d, [0.4, 0.9], -8);
      d.every("rumble", [3, 5], () => d.play("thunder.far", { gainDb: -10 }), { limit: 3 });
    },
    climax(d) {
      d.stop("arcs");
      d.stop("rumble");
      d.st.charge?.stop(0.04);
      d.stopLayer("buzz", 0.08);
      d.play("lab.discharge", { gainDb: 1 });
      d.play("grand.toll", { delay: 0.12, gainDb: -6 });
      d.play("body.impact", { delay: 0.04, gainDb: -7 });
      d.fade("crackle", 1.3, 0.1);
      d.after(0.6, () => d.play("lab.tail"));
    },
    reaction(d) {
      d.react("surprised", { delay: 0.1 });
      d.play("grand.chimes", { delay: 0.8 });
      d.fade("crackle", 0.3, 3);
      d.fade("coil", 0.3, 4);
      d.boost({ wind: 0, spirit: 0.4, drips: 0.6 }, 5);
    },
    decay(d) {
      d.fade("crackle", 0, 3);
      d.fade("coil", 0, 4);
      d.play("grand.chimes", { delay: 0.3, gainDb: -6 });
      d.after(6, () => d.boost({ drips: 0, spirit: 0 }, 6));
    },
  },
};

// --- Variant layers: their own beat sequence, after the base climax -------------------------------
const VARIANTS = {
  // Galaxy: the night opens up; climax ~3.2 s after its recognition (signatures.js timings).
  galaxy: {
    recognition(d) {
      d.play("gal.twinkle", { delay: 0.1, gainDb: -4, pan: -0.3 });
      d.play("gal.twinkle", { delay: 0.35, gainDb: -6, pan: 0.35 });
    },
    anticipation(d) {
      d.layer("v:pad", "gal.pad", { bus: "fx", gainDb: -3, segment: [6, 10], xfade: 2.5 }, 1, 2.5);
      d.play("gal.rise", { offset: 1.4, gainDb: -3 }); // its peak meets the climax
      d.every("twinkle", [0.2, 0.55], () => d.play("gal.twinkle", { pan: (d.random() - 0.5) * 1.1, gainDb: -7 - d.random() * 6 }));
    },
    climax(d) {
      d.stop("twinkle");
      d.play("gal.bloom", { delay: 0.02 });
      d.fade("v:pad", 1.5, 0.3);
    },
    reaction(d) {
      d.react("delight", { delay: 0.2 });
    },
    decay(d) {
      d.fade("v:pad", 0, 5);
      d.every("tail", [0.5, 1.2], (n) => d.play("gal.twinkle", { pan: (d.random() - 0.5) * 1.1, gainDb: -12 - n * 1.5 }), { limit: 6 });
    },
  },
  // Lion: a golden spirit rises and roars with him (synced to his celebrate climax).
  lion: {
    recognition(d) {
      d.play("lion.growl", { delay: 0.2, gainDb: -8, variant: 0 });
    },
    development(d) {
      d.play("lion.growl", { delay: 0.1, gainDb: -3, variant: 1 });
    },
    climax(d) {
      d.play("lion.roar", { delay: 0.04, gainDb: -1 });
      d.play("pumpkin.ignite", { delay: 0.1, gainDb: -7 }); // the candles blaze
    },
    reaction(d) {
      d.react("chuckle", { delay: 0.5, force: true }); // impressed by his roaring friend
    },
    decay(d) {
      d.play("grand.chimes", { delay: 0.2, gainDb: -8 });
    },
  },
};
