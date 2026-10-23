import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Locomotion, Performer } from "./motion.js";

const TARGET_HEIGHT = 2.45; // eight feet, as in the novel

// The jaw bone takes this share of the pose's "jaw.rx"; past about 0.22 rad of real jaw
// rotation this face stretches at the corners.
const JAW_SHARE = 0.55;

// Pose joints -> bones of an Unreal/Epic-style skeleton, with each bone's share of the rotation.
const BONE_MAP = {
  pelvis: [["pelvis", 1]],
  spine: [["spine_01", 0.35], ["spine_02", 0.35], ["spine_03", 0.3]],
  chest: [["spine_04", 0.5], ["spine_05", 0.5]],
  neck: [["neck_01", 0.6], ["neck_02", 0.4]],
  head: [["head", 1]],
  jaw: [["C_jaw", JAW_SHARE]],
  clavL: [["clavicle_l", 1]],
  clavR: [["clavicle_r", 1]],
  shoulderL: [["upperarm_l", 1]],
  elbowL: [["lowerarm_l", 1]],
  shoulderR: [["upperarm_r", 1]],
  elbowR: [["lowerarm_r", 1]],
  hipL: [["thigh_l", 1]],
  kneeL: [["calf_l", 1]],
  ankleL: [["foot_l", 1]],
  hipR: [["thigh_r", 1]],
  kneeR: [["calf_r", 1]],
  ankleR: [["foot_r", 1]],
};

// The model is in an A-pose; these bones get re-aimed so "zero" means arms hanging at his sides.
const NEUTRAL = {
  upperarm_l: ["lowerarm_l", [0.13, -1, 0.04]],
  lowerarm_l: ["hand_l", [0.05, -1, 0.16]],
  upperarm_r: ["lowerarm_r", [-0.13, -1, 0.04]],
  lowerarm_r: ["hand_r", [-0.05, -1, 0.16]],
};

const COAT = /^dyn_jacket_.*_MSTR$|^dyn_jacket_bk_MSTR$/;
const EYES = ["L_eye", "R_eye"];
const FINGER = /^(index|middle|ring|pinky)_0([123])_([lr])$/;
const FINGER_SHARE = { 1: 0.55, 2: 0.95, 3: 0.7 };

// Facial bones moved by small offsets (in metres of the original model) to shape the mouth and brows.
const FACE = {
  cornerL: "L_lip_corner",
  cornerR: "R_lip_corner",
  upperMid: "C_lip_upper_mid",
  upperL: "L_lip_upper_outer",
  upperR: "R_lip_upper_outer",
  lowerMid: "C_lip_lower_mid",
  lowerL: "L_lip_lower_outer",
  lowerR: "R_lip_lower_outer",
  cheekL: "L_cheek_inner",
  cheekR: "R_cheek_inner",
  nose: "C_nose_bridge",
  browMid: "C_brow_mid",
  browL: "L_brow_mid",
  browR: "R_brow_mid",
  browOuterL: "L_brow_outer",
  browOuterR: "R_brow_outer",
};

// Each mood as a mix of four tested expressions (0..1). Amounts and ranges come from measuring
// this rig's face: beyond them the mouth corners stretch or triangles fold.
const MOODS = {
  warm: { smile: 0.25, sad: 0, anger: 0, surprise: 0 },
  amused: { smile: 0.5, sad: 0, anger: 0, surprise: 0.1 },
  delighted: { smile: 0.85, sad: 0, anger: 0, surprise: 0.3 },
  melancholy: { smile: 0, sad: 0.8, anger: 0, surprise: 0 },
  indignant: { smile: 0, sad: 0, anger: 0.7, surprise: 0 },
  thoughtful: { smile: 0.1, sad: 0.25, anger: 0, surprise: 0 },
};
const MM = 0.001;
const clampMM = (v, limit) => Math.max(-limit * MM, Math.min(limit * MM, v));

// A rigged character model driven by the shared poses in motion.js. Each joint angle is a
// rotation in the character's frame, converted into each bone's own rest frame:
//   local = inverse(parentRest) * jointRotation * boneRest
export class RiggedCreature {
  static async load(scene, spots, config, opts) {
    const gltf = await new GLTFLoader().loadAsync(config.model);
    return new RiggedCreature(scene, spots, config, gltf, opts);
  }

  constructor(scene, spots, config, gltf, { ground, nav, onImpact, onFlash, onMarker, onStep } = {}) {
    this.root = new THREE.Group();
    const model = gltf.scene;
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const scale = typeof config.modelScale === "number" ? config.modelScale : TARGET_HEIGHT / (size.y || 1);
    model.scale.setScalar(scale);
    this.root.add(model);
    model.updateMatrixWorld(true);
    model.position.y = -new THREE.Box3().setFromObject(model).min.y; // feet on the ground
    model.updateMatrixWorld(true);

    this.bones = {};
    const materials = new Set();
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // bind-pose bounds don't cover flips and handstands
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
      if (o.isBone) this.bones[o.name] = o;
    });
    // The model's normal maps are DirectX-style (green points down); flip green once per
    // material (some are shared between meshes) so creases and stitches aren't lit inside out.
    for (const m of materials) {
      if (m.normalMap && config.modelNormalFlipY !== false) m.normalScale.y *= -1;
      if (m.aoMap && config.modelAoIntensity !== undefined) m.aoMapIntensity = config.modelAoIntensity;
    }
    // The static IK hand bones still pull a few wrist vertices; let them ride with the hands.
    for (const s of ["l", "r"]) {
      const ik = this.bones[`ik_hand_${s}`];
      const hand = this.bones[`hand_${s}`];
      if (ik && hand && ik.parent !== hand) hand.attach(ik);
    }

    // Rest orientations and positions, measured before the root is placed in the scene.
    const restQ = new Map();
    const restP = new Map();
    const worldQ = (o) => {
      if (!restQ.has(o)) restQ.set(o, o.getWorldQuaternion(new THREE.Quaternion()));
      return restQ.get(o);
    };
    const pos = (name) => {
      const b = this.bones[name];
      if (!restP.has(b)) restP.set(b, b.getWorldPosition(new THREE.Vector3()));
      return restP.get(b);
    };

    // Calibrated rest orientation (W' = C * W); bones without their own correction inherit the parent's.
    const correction = new Map();
    const corrected = (o) => {
      if (!o?.isBone) return o ? worldQ(o) : new THREE.Quaternion();
      return correction.get(o).clone().multiply(worldQ(o));
    };
    const walk = (o, inherited) => {
      let c = inherited;
      const neutral = o.isBone && NEUTRAL[o.name];
      if (neutral && this.bones[neutral[0]]) {
        const dir = pos(neutral[0]).clone().sub(pos(o.name)).normalize();
        c = new THREE.Quaternion().setFromUnitVectors(dir, new THREE.Vector3(...neutral[1]).normalize());
      }
      if (o.isBone) correction.set(o, c);
      for (const child of o.children) walk(child, c);
    };
    walk(model, new THREE.Quaternion());

    const drive = (bone, joint, weight) => ({
      bone,
      joint,
      weight,
      parentInv: corrected(bone.parent).clone().invert(),
      rest: corrected(bone),
    });
    this.driven = [];
    for (const [joint, list] of Object.entries(BONE_MAP)) {
      for (const [name, weight] of list) if (this.bones[name]) this.driven.push(drive(this.bones[name], joint, weight));
    }
    this.coat = Object.values(this.bones).filter((b) => COAT.test(b.name)).map((b, i) => ({ ...drive(b, "coat", 1), i }));
    // Eyelids close by turning about the eyeball's centre (their parent eye bone), not about
    // their own pivot at the front of the eye: the upper lid comes down, the lower one a little up.
    this.lids = ["L", "R"]
      .flatMap((s) => [[`${s}_eye_lid_upper_mid`, 1], [`${s}_eye_lid_lower_mid`, -0.24]])
      .filter(([n]) => this.bones[n])
      .map(([n, k]) => ({ ...drive(this.bones[n], "lid", 1), k, upper: k > 0, restPos: this.bones[n].position.clone(), parentRest: corrected(this.bones[n].parent) }));
    this.eyes = EYES.map((n) => this.bones[n]).filter(Boolean).map((b) => drive(b, "eye", 1));

    // Fingers curl around the line across the knuckles of each hand.
    this.fingers = [];
    for (const side of ["l", "r"]) {
      const a = this.bones[`index_01_${side}`];
      const b = this.bones[`pinky_01_${side}`];
      if (!a || !b) continue;
      const axis = pos(b.name).clone().sub(pos(a.name)).normalize();
      for (const bone of Object.values(this.bones)) {
        const m = FINGER.exec(bone.name);
        if (m && m[3] === side) this.fingers.push({ ...drive(bone, "finger", FINGER_SHARE[m[2]]), axis, sign: side === "l" ? 1 : -1 });
      }
    }

    // Offsets for the lips and brows, converted from model space into each bone's parent space.
    this.face = {};
    for (const [key, name] of Object.entries(FACE)) {
      const bone = this.bones[name];
      if (!bone) continue;
      const toLocal = new THREE.Matrix3().setFromMatrix4(bone.parent.matrixWorld).invert().multiplyScalar(scale);
      this.face[key] = { bone, rest: bone.position.clone(), toLocal };
    }
    this.browLift = 0;

    const pelvis = this.bones.pelvis;
    this.pelvisRest = pos("pelvis").clone();
    this.pelvisParentInv = pelvis.parent.matrixWorld.clone().invert();
    const hip = this.pelvisRest.y;
    const shoulder = pos("upperarm_l").y - hip;
    const arm = pos("upperarm_l").distanceTo(pos("lowerarm_l")) + pos("lowerarm_l").distanceTo(pos("hand_l")) + 0.12 * (TARGET_HEIGHT / 1.8);
    // Hip joint to ankle, so the walk can size its leg swing to the step length.
    const leg = pos("thigh_l").distanceTo(pos("calf_l")) + pos("calf_l").distanceTo(pos("foot_l"));
    this.dims = { hip, shoulder, arm, leg };

    scene.add(this.root);
    this.locomotion = new Locomotion(this.root, spots, ground, nav);
    this.performer = new Performer(this.locomotion, this.dims, { onImpact, onFlash, onMarker, onStep });
    this.nextBlink = 2;
    this.blink = 0;
    this.nextSaccade = 1;
    this.saccade = { yaw: 0, pitch: 0 };
    this.gaze = { yaw: 0, pitch: 0 };
    this.mood = { ...MOODS.warm, squint: 0 };
    this.press = 0;
    this.prevOpen = 0;
    this.euler = new THREE.Euler();
    this.q = new THREE.Quaternion();
  }

  perform(action, options) {
    this.performer.perform(action, options);
  }

  clear() {
    this.performer.clear();
  }

  get current() {
    return this.performer.current;
  }

  apply(d, rx, ry, rz) {
    this.q.setFromEuler(this.euler.set(rx * d.weight, ry * d.weight, rz * d.weight, "XYZ"));
    d.bone.quaternion.copy(d.parentInv).multiply(this.q).multiply(d.rest);
  }

  update(dt, t, speech) {
    const p = this.performer.pose(dt, t, speech);
    // Past shoulder height a real arm is raised partly by the shoulder girdle: the collarbone
    // takes a share of the lift, so the shoulder keeps its shape instead of folding into the neck.
    for (const [side, sign] of [["L", 1], ["R", -1]]) {
      const lift = Math.max(0, sign * (p[`shoulder${side}.rz`] || 0) - 1.25) * 0.32;
      if (!lift) continue;
      p[`clav${side}.rz`] = (p[`clav${side}.rz`] || 0) + sign * lift;
      p[`shoulder${side}.rz`] -= sign * lift;
    }
    for (const d of this.driven) this.apply(d, p[`${d.joint}.rx`] || 0, p[`${d.joint}.ry`] || 0, p[`${d.joint}.rz`] || 0);

    // Hips carry jumps, crouches and handstands; convert the offset into the pelvis parent's space.
    const target = this.pelvisRest.clone().add(new THREE.Vector3(p["pelvis.px"] || 0, p["pelvis.py"] - this.dims.hip, p["pelvis.pz"] || 0));
    this.bones.pelvis.position.copy(target.applyMatrix4(this.pelvisParentInv));

    // Coat tails hang against the body's rotation and swing a little as he moves.
    const swing = this.locomotion.moving ? Math.sin(this.locomotion.phase) * 0.12 : 0;
    for (const c of this.coat) {
      this.apply(c, -(p["pelvis.rx"] || 0) * 0.7 + Math.sin(t * 1.7 + c.i) * 0.03 + swing * 0.5, 0, -(p["pelvis.rz"] || 0) * 0.7 + swing * 0.3);
    }

    // Natural blinks: every 2-6 s, sometimes a double blink, and always with a big gaze shift.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink = 1;
      this.nextBlink = Math.random() < 0.18 ? 0.28 : 2 + Math.random() * 4;
    }
    this.blink = Math.max(0, this.blink - dt / 0.16);
    // Heavier upper lids when sad or cross, wider when surprised; a smile lifts the lower lids.
    const m = this.mood;
    const heavy = Math.max(-0.1, 0.02 + 0.08 * m.sad + 0.12 * m.anger - 0.12 * m.surprise);
    m.squint = 0.06 * m.smile;
    const blink = Math.sin(Math.min(1, this.blink) * Math.PI) * 0.5;
    for (const l of this.lids) {
      const angle = l.upper ? Math.min(0.5, blink + heavy) : blink * l.k - this.mood.squint;
      this.apply(l, angle, 0, 0);
      const turn = l.parentInv.clone().multiply(this.q).multiply(l.parentRest); // same rotation in the eye's frame
      l.bone.position.copy(l.restPos).applyQuaternion(turn); // pivot = eyeball centre
    }

    // Eyes follow the camera a little further than the head does, with small saccades: quick
    // jumps to a nearby point and a hold, like real eyes, never a smooth drift.
    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) {
      const range = speech.talking ? 0.04 : 0.09;
      const yaw = (Math.random() - 0.5) * 2 * range;
      if (Math.abs(yaw - this.saccade.yaw) > 0.08) this.nextBlink = Math.min(this.nextBlink, 0.02);
      this.saccade = { yaw, pitch: (Math.random() - 0.5) * range };
      this.nextSaccade = 0.4 + Math.random() * (speech.talking ? 1.6 : 2.4);
    }
    const sk = Math.min(1, dt / 0.04);
    this.gaze.yaw += (this.saccade.yaw - this.gaze.yaw) * sk;
    this.gaze.pitch += (this.saccade.pitch - this.gaze.pitch) * sk;
    const look = this.performer.look;
    for (const e of this.eyes) this.apply(e, -look.pitch * 0.4 + this.gaze.pitch, look.yaw * 0.45 + this.gaze.yaw, 0);

    // Relaxed, half-curled hands.
    const curl = p["fingers.curl"] ?? 0.55;
    for (const f of this.fingers) {
      this.q.setFromAxisAngle(f.axis, curl * f.weight * f.sign);
      f.bone.quaternion.copy(f.parentInv).multiply(this.q).multiply(f.rest);
    }

    this.shapeFace(speech, dt, (p["jaw.rx"] || 0) * JAW_SHARE);
    this.root.rotation.y = this.performer.yaw;
  }

  // Visemes from the sound he is making (see AudioOut.update), using shapes measured on this
  // rig (offsets in mm): the jaw opens with loudness and shuts in every pause, with the lower
  // lip lifting to cover the gums; "ee" spreads the corners (E), "oo/oh" rounds and pushes the
  // lips forward (oh), hiss keeps the teeth together with the lips parted (SS), and a sharp drop
  // after an open syllable presses the lips shut for a moment (M/B/P). His mood mixes in a
  // smile, a sad or cross face, or surprise, easing from one to the next.
  shapeFace({ talking, voiced = talking, mouth = { open: 0, wide: 0, round: 0, teeth: 0 }, level = 0, mood = "warm" }, dt, jawRad = 0) {
    const f = this.face;
    const v = new THREE.Vector3();
    const offset = (part, x, y, z) => {
      if (!part) return;
      part.bone.position.copy(part.rest).add(v.set(x, y, z).applyMatrix3(part.toLocal));
    };
    const target = MOODS[mood] || MOODS.warm;
    const k = Math.min(1, dt * 2.5);
    for (const key of ["smile", "sad", "anger", "surprise"]) this.mood[key] += (target[key] - this.mood[key]) * k;
    const { smile, sad, anger, surprise } = this.mood;

    const on = voiced ? 1 : 0;
    const open = mouth.open * on;
    const wide = mouth.wide * on;
    const round = mouth.round * on;
    const teeth = mouth.teeth * on;
    if (talking && this.prevOpen > 0.35 && open < 0.08) this.press = 1;
    this.press = Math.max(0, this.press - dt / 0.09);
    this.prevOpen = open;
    const pp = this.press;

    // Mouth corners [out, up, forward] in mm, then clamped to the rig's safe range.
    const cx = 7 * wide - 8 * round + 4 * teeth - pp + 6 * smile * (1 - round) + sad - 10 * jawRad;
    const cy = 1.5 * wide + teeth + 6 * smile * (1 - round) - 5 * sad - anger - 35 * jawRad;
    const cz = -1.5 * wide + 4 * round - 3 * smile * (1 - round);
    const corner = [clampMM(cx * MM, 11), clampMM(cy * MM, 6), clampMM(cz * MM, 11)];
    offset(f.cornerL, corner[0], corner[1], corner[2]);
    offset(f.cornerR, -corner[0], corner[1], corner[2]);
    // Upper lip: lifts with the voice and for hiss, forward for "oo", down for M/B/P.
    const uy = clampMM((3 * open + 1.5 * wide + round + 2.5 * teeth - pp) * MM, 8);
    const uz = clampMM((5 * round + 0.5 * pp) * MM, 8);
    offset(f.upperMid, 0, uy, uz);
    offset(f.upperL, 0, uy * 0.8, uz * 0.8);
    offset(f.upperR, 0, uy * 0.8, uz * 0.8);
    // Lower lip rides on the jaw; it lifts with the opening (30 mm per radian) to cover the gums.
    const ly = clampMM((3 * wide + 3 * round - teeth + 2 * pp) * MM + 0.03 * jawRad, 8);
    const lz = clampMM((5 * round + 0.5 * pp) * MM, 8);
    offset(f.lowerMid, 0, ly, lz);
    offset(f.lowerL, 0, ly * 0.8, lz * 0.8);
    offset(f.lowerR, 0, ly * 0.8, lz * 0.8);
    offset(f.cheekL, 0, clampMM((4 * smile + 0.6 * wide) * MM, 4), smile * MM);
    offset(f.cheekR, 0, clampMM((4 * smile + 0.6 * wide) * MM, 4), smile * MM);
    offset(f.nose, 0, 1.5 * anger * MM, 0);

    // Brows hold the mood and lift on stressed words.
    this.browLift = Math.max(this.browLift * Math.exp(-dt * 4), talking && (mouth.open || level) > 0.6 ? 1 : 0);
    const lift = 2.5 * this.browLift + 5 * surprise;
    const inner = clampMM((4 * sad - 5 * anger + lift) * MM, 6);
    const outer = clampMM((-sad + anger + lift) * MM, 6);
    offset(f.browMid, 0, inner, 0);
    offset(f.browL, 0, inner, 0);
    offset(f.browR, 0, inner, 0);
    offset(f.browOuterL, 0, outer, 0);
    offset(f.browOuterR, 0, outer, 0);
  }

  get headPosition() {
    return this.bones.head.getWorldPosition(new THREE.Vector3());
  }

  // World positions of the two bolts on the sides of his neck, for spark effects.
  neckBolts() {
    const neck = (this.bones.neck_02 || this.bones.neck_01 || this.bones.head).getWorldPosition(new THREE.Vector3());
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion).multiplyScalar(0.12);
    return [neck.clone().add(side), neck.clone().sub(side)];
  }
}
