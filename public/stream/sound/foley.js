// His physical presence: footsteps at every real heel strike (surface, strength, turning on
// the spot), clothing, leather and hardware with his movements, landings, bolt crackles, and
// the breaths and effort sounds of his stunts — all from the animation's own events: the
// "step" and "impact" events, and each stunt's start plus the moments of its timeline
// (mirrored from motion.js below, measured in seconds from the stunt's "start" marker).
import { stepPlan, spatial } from "./rules.js";
import { toCamera } from "./ambience.js";

// [seconds, action, gainDb?] per stunt. Actions: cloth, clothBig, leather, hardware, breathIn,
// breathOut, scuff, weight, and "nv:<kind>" for a vocal reaction (only if he is not speaking).
// Durations and poses: public/stream/motion.js makeStunts().
export const STUNT_FOLEY = {
  nod: [[0.15, "cloth", -8]],
  wave: [[0.2, "cloth", -2], [0.9, "cloth", -9], [2.2, "cloth", -6]],
  bow: [[0.25, "clothBig", -3], [0.9, "leather", -4], [1.6, "hardware", -6], [2.1, "cloth", -4]],
  flex: [[0.15, "clothBig", -2], [0.55, "leather", -2], [0.7, "nv:effort", -4], [1.6, "hardware", -5], [2.6, "cloth", -5]],
  jacks: [[0.25, "cloth", -4], [1.2, "cloth", -6], [2.2, "cloth", -6], [3.2, "cloth", -6], [3.9, "breathOut", -2]],
  dance: [[0.4, "cloth", -5], [1.15, "cloth", -7], [1.9, "scuff", -4], [2.6, "cloth", -6], [3.4, "scuff", -5], [4.2, "cloth", -6], [5.0, "scuff", -4], [5.8, "cloth", -6], [6.3, "nv:chuckle", -2]],
  roar: [[0.1, "clothBig", -2], [0.3, "breathIn", 0], [0.55, "nv:roar", 0], [1.2, "leather", -4], [2.9, "cloth", -5]],
  stomp: [[0.12, "cloth", -3], [0.85, "nv:effort", -2], [1.25, "hardware", -4]],
  kneel: [[0.2, "clothBig", -2], [0.8, "leather", -3], [1.1, "weight", -4], [1.3, "scuff", -6], [3.4, "breathOut", -3], [4.2, "clothBig", -4]],
  backflip: [[0.1, "cloth", -3], [0.35, "breathIn", -3], [0.42, "nv:effort", 0], [0.5, "clothBig", 0], [1.1, "clothBig", -4], [1.95, "breathOut", -1]],
  pushups: [[0.3, "clothBig", -3], [0.7, "weight", -6]],
  handstand: [[0.2, "breathIn", -2], [0.35, "nv:effort", -1], [0.5, "clothBig", -1], [2.2, "leather", -4], [4.4, "hardware", -6], [5.3, "clothBig", -3], [6.1, "breathOut", -2]],
  spin: [[0.15, "scuff", -3], [0.4, "clothBig", -2], [1.3, "clothBig", -5], [2.1, "scuff", -4]],
  look_around: [[0.7, "cloth", -10], [2.3, "cloth", -11]],
  crack_neck: [[0.55, "leather", -8], [1.85, "leather", -8]],
  look_hands: [[0.5, "cloth", -9], [1.3, "hardware", -10]],
  stretch: [[0.3, "clothBig", -4], [1.1, "leather", -5], [1.6, "nv:relieved", -3], [3.1, "cloth", -6]],
  activate: [[0.2, "clothBig", -2], [0.5, "leather", -3]],
  // His own outings (activities.js) and the Haunted Gate with his back to the gate.
  inspect: [[0.25, "cloth", -7], [1.2, "leather", -9], [2.6, "cloth", -8]],
  glance_up: [[0.15, "cloth", -10]],
  gate_turn: [[1.15, "breathIn", -4], [1.6, "cloth", -7], [2.75, "clothBig", -1], [2.8, "nv:surprised", -2], [3.95, "clothBig", -4], [4.6, "leather", -5], [5.1, "breathOut", -3]],
  // celebrate and reanimate follow their named markers instead (see MARKER_FOLEY)
  celebrate: [],
  reanimate: [[0.15, "clothBig", 0]],
};
// Push-ups: an exhale as each of the four reps pushes up (motion.js: reps between u 0.18-0.84).
for (let k = 0; k < 4; k++) STUNT_FOLEY.pushups.push([6.4 * (0.18 + (0.66 * (k + 0.72)) / 4), k === 3 ? "nv:effort" : "breathOut", k === 3 ? -2 : -4 - k]);
STUNT_FOLEY.pushups.push([6.2, "clothBig", -4]);

export const MARKER_FOLEY = {
  "celebrate:prepare": [[0, "breathIn", -2]],
  "celebrate:shift": [[0, "cloth", -3]],
  "celebrate:raise": [[0, "clothBig", 0], [0.35, "leather", -3]],
  "celebrate:settle": [[0, "cloth", -3]],
  "celebrate:return": [[0, "breathOut", -4], [0.2, "hardware", -7]],
  "reanimate:jolt": [[0, "nv:effort", -2]],
  "activate:lever": [[0, "clothBig", -1], [0.05, "nv:effort", -3]],
  "gate:startle": [[0, "breathIn", 1], [0.1, "clothBig", -2]],
  "pumpkin:listen": [[0, "cloth", -6]],
};

export class Foley {
  constructor(engine, hub, reactions, { random = Math.random } = {}) {
    this.engine = engine;
    this.hub = hub;
    this.reactions = reactions;
    this.random = random;
    this.rain = 0.32;
    this.stepCount = 0;
    this.lastStepAt = -Infinity;
    this.enabled = true;
  }

  local(position) {
    const ctx = this.hub.ctx;
    const p = position ? toCamera(ctx?.camera, position, ctx?.THREE) : null;
    return p || { x: 0, y: 0, z: -3.5 };
  }

  step(detail) {
    if (!this.enabled) return;
    const now = this.engine.now;
    if (now - this.lastStepAt < 0.12) return; // both feet reported in one frame: one step
    this.lastStepAt = now;
    const plan = stepPlan(detail, { rain: this.rain });
    const sp = spatial(this.local(detail.position), { maxPan: 0.35, ref: 4 });
    const base = { pan: sp.pan, lowpass: sp.lowpass, rate: plan.rate };
    const g = sp.gainDb;
    this.engine.play(`step.${plan.surface}`, { ...base, gainDb: plan.heelDb + g });
    // the sole rolling through: a scuff on stone, a grass brush, a wet press in soil
    const roll = plan.surface === "stone" ? "step.scuff" : plan.surface === "grass" ? "step.brush" : "step.wet";
    if (detail.inPlace || this.random() < 0.55) this.engine.play(roll, { ...base, delay: 0.035 + this.random() * 0.05, gainDb: plan.scuffDb + g });
    if (!detail.inPlace) this.engine.play("step.weight", { pan: sp.pan, gainDb: plan.weightDb + g, rate: 0.95 + this.random() * 0.08 });
    if (plan.wet) this.engine.play("step.wet", { ...base, delay: 0.01, gainDb: -8 + g });
    // his coat swings with every other stride
    if (!detail.inPlace && this.stepCount++ % 2 === 0 && this.random() < 0.7) this.engine.play("cloth.move", { pan: sp.pan, delay: 0.06, gainDb: -10 + 4 * (detail.strength || 0) + g });
  }

  impact({ strength = 0.5 } = {}) {
    if (!this.enabled) return;
    const s = Math.max(0, Math.min(1, strength));
    const sp = spatial(this.local(this.hub.ctx?.avatar?.root?.position), { maxPan: 0.35, ref: 4 });
    this.engine.play("body.impact", { pan: sp.pan, gainDb: -12 + 12 * s + sp.gainDb, rate: 1.05 - 0.1 * s });
    if (s > 0.45) this.engine.play("step.soil", { pan: sp.pan, delay: 0.015, gainDb: -6 + sp.gainDb });
    if (s > 0.7) this.engine.play("hardware", { pan: sp.pan, delay: 0.05, gainDb: -6 });
  }

  // The lightning really strikes him (reanimation): bolts crackle at his neck.
  flash() {
    this.engine.play("elec.zap", { gainDb: -5, group: "flash" });
    this.engine.play("elec.spark", { delay: 0.08, gainDb: -6 });
  }

  // A stunt started: schedule its timeline on the audio clock (cancelled if it is cut).
  stunt(name, marker) {
    if (!this.enabled) return;
    const group = `stunt:${name}`;
    if (marker === "cut" || marker === "end") {
      if (marker === "cut") this.engine.stopGroup(group, 0.15);
      return;
    }
    const list = marker === "start" ? STUNT_FOLEY[name] ?? [[0.1, "cloth", -4]] : MARKER_FOLEY[`${name}:${marker}`];
    if (!list) return;
    for (const [at, action, gainDb = 0] of list) this.action(action, { delay: at, gainDb, group });
  }

  action(action, { delay = 0, gainDb = 0, group = null } = {}) {
    if (action.startsWith("nv:")) return this.reactions?.react(action.slice(3), { delay, gainDb, group });
    const id = { cloth: "cloth.move", clothBig: "cloth.big", leather: "leather", hardware: "hardware", breathIn: "breath.in", breathOut: "breath.out", scuff: "step.scuff", weight: "step.weight" }[action];
    if (!id) return null;
    // breaths are his too: never over his speech
    if ((action === "breathIn" || action === "breathOut") && this.reactions && !this.reactions.policy.allowed("effort", this.engine.now + delay)) return null;
    const sp = spatial(this.local(this.hub.ctx?.avatar?.root?.position), { maxPan: 0.3, ref: 4 });
    return this.engine.play(id, { delay, gainDb: gainDb + sp.gainDb, pan: sp.pan, group });
  }
}
