import * as THREE from "three";

// Shared motion for both the built-in creature and the rigged model: walking between
// named spots, the idle/talking base pose, and the stunt library.
//
// A pose is a flat object of joint angles in the character's own frame (x = his left,
// y = up, z = forward), e.g. p["shoulderR.rz"]. "pelvis.py" is the hip height in metres.

const TAU = Math.PI * 2;
export const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
export const lerp = (a, b, t) => a + (b - a) * t;
const seg = (u, a, b) => ease((u - a) / (b - a));
const between = (u, a, b) => u > a && u < b;

export function angleTo(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Spots are either [x, y, z] (built-in room) or { at: [x, z], via: [[x, z], ...] } where
// `via` is the route from the main path to the spot, so walks avoid graves and walls.
function normalizeSpots(spots) {
  const out = {};
  for (const [name, s] of Object.entries(spots)) {
    out[name] = Array.isArray(s) ? { at: [s[0], s[2]], via: [] } : { at: s.at, via: s.via || [] };
  }
  return out;
}

export class Locomotion {
  constructor(root, spots, ground = () => 0, nav = null) {
    this.root = root;
    this.spots = normalizeSpots(spots);
    this.ground = ground;
    this.nav = nav;
    // Spots that landed inside a grave or wall move to the nearest place he can stand.
    if (nav) {
      for (const s of Object.values(this.spots)) {
        const p = nav.nearest(s.at[0], s.at[1]);
        s.at = [p.x, p.y];
      }
    }
    this.current = "center" in this.spots ? "center" : Object.keys(this.spots)[0];
    const start = this.spots[this.current].at;
    root.position.set(start[0], ground(start[0], start[1]), start[1]);
    this.route = [];
    this.moving = false;
    this.phase = 0;
    this.speed = 0.95; // a heavy, unhurried walk, m/s
    this.velocity = 0; // limited acceleration, so he never starts or stops dead
    this.stepLength = 0.72; // metres per step at full speed; the gait advances with distance
    this.stride = 1; // 0.35..1: shorter, quicker steps when slow, so planted feet don't slide
    this.walkWeight = 0; // how much of the walking gait is in the pose (blends in and out)
    this.yaw = 0; // 0 faces the camera
    this.faceYaw = null; // when set, where he turns to once he stops (a gift event's pumpkin, gate or lever)
  }

  remaining() {
    let d = 0;
    let from = new THREE.Vector2(this.root.position.x, this.root.position.z);
    for (const p of this.route) {
      d += from.distanceTo(p);
      from = p;
    }
    return d;
  }

  // The spot he is actually standing at, so an interrupted walk still plans the right route.
  nearest() {
    const { x, z } = this.root.position;
    let best = null;
    let bestDist = Infinity;
    for (const [name, s] of Object.entries(this.spots)) {
      const d = Math.hypot(s.at[0] - x, s.at[1] - z);
      if (d < bestDist) {
        best = name;
        bestDist = d;
      }
    }
    return { name: best, dist: bestDist };
  }

  walkTo(name) {
    const target = this.spots[name];
    if (!target) return false;
    const here = this.nearest();
    if (here.name === name && here.dist < 0.3) return false;
    // With a walkable-area grid he finds his own way around graves and fences.
    const { x, z } = this.root.position;
    const path = this.nav?.path(x, z, target.at[0], target.at[1]);
    if (path) {
      this.route = path.slice(1);
    } else if (this.nav) {
      // No way round the obstacles: stay put rather than walk through the scenery.
      console.warn(`No walkable route to ${name}`);
      return false;
    } else {
      const exit = here.dist < 0.6 ? this.spots[here.name].via.slice().reverse() : [];
      this.route = [...exit, ...target.via, target.at].map(([px, pz]) => new THREE.Vector2(px, pz));
    }
    this.current = name;
    this.pace = 1;
    return this.route.length > 0;
  }

  // Walks to an arbitrary point (e.g. somewhere with room for a stunt).
  // `pace` > 1 is a purposeful stride (a gift event): quicker steps of the same length.
  walkToPoint(x, z, pace = 1) {
    const { x: px, z: pz } = this.root.position;
    const path = this.nav?.path(px, pz, x, z);
    if (!path) return false;
    this.route = path.slice(1);
    this.pace = pace;
    return this.route.length > 0;
  }

  // Turns towards `target` yaw at a heavy pace; when standing still he takes small steps
  // while he turns instead of sliding round on the spot.
  turnTowards(target, dt, rate) {
    const turn = angleTo(this.yaw, target);
    const dyaw = Math.sign(turn) * Math.min(Math.abs(turn), dt * rate);
    this.yaw += dyaw;
    if (this.velocity < 0.15 && Math.abs(dyaw) > 1e-4) {
      this.phase += Math.abs(dyaw) * 2.2;
      this.stride = 0.35;
      this.inPlace = true; // marching round: feet lift and land, they don't swing
      return true;
    }
    return false;
  }

  // Returns true while still walking or turning back to the camera.
  update(dt) {
    const pos = this.root.position;
    let stepping = false;
    this.inPlace = false;
    if (this.route.length) {
      const next = this.route[0];
      const dx = next.x - pos.x;
      const dz = next.y - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        this.route.shift();
        stepping = this.velocity > 0.05;
      } else {
        const heading = Math.atan2(dx, dz);
        const turn = Math.abs(angleTo(this.yaw, heading));
        stepping = this.turnTowards(heading, dt, this.velocity > 0.3 ? 2.2 : 1.7);
        // Ease into the stop over the last metre, and slow right down for sharp corners.
        const brake = Math.min(1, this.remaining() / 1.1);
        const target = turn > 1.0 ? 0 : this.speed * (this.pace || 1) * brake * (1 - Math.min(0.55, turn * 0.55));
        const accel = target > this.velocity ? 1.1 : 1.8; // m/s per second
        this.velocity += Math.max(-accel * dt, Math.min(accel * dt, target - this.velocity));
        if (this.route.length === 1 && dist < 0.3) this.velocity = Math.max(this.velocity, 0.12); // arrive, don't stall
        const step = Math.min(dist, dt * this.velocity);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        if (step > 1e-4) {
          this.stride = Math.max(0.35, Math.min(1, this.velocity / this.speed));
          this.phase += (step / (this.stepLength * this.stride)) * Math.PI;
          this.inPlace = false;
          stepping = true;
        }
      }
      pos.y = lerp(pos.y, this.ground(pos.x, pos.z), Math.min(1, dt * 12));
    } else {
      this.velocity = 0;
      // Back to face the camera, stepping round (or towards what he came to look at).
      const rest = this.faceYaw ?? 0;
      if (Math.abs(angleTo(this.yaw, rest)) > 0.02) stepping = this.turnTowards(rest, dt, 1.6) || stepping;
    }
    // The gait fades in as he sets off and out as he settles, finishing on feet together.
    const wantWalk = stepping ? 1 : 0;
    this.walkWeight += (wantWalk - this.walkWeight) * Math.min(1, dt * (wantWalk ? 6 : 4));
    if (!stepping && this.walkWeight > 0.01) {
      const settle = Math.round(this.phase / Math.PI) * Math.PI;
      this.phase += (settle - this.phase) * Math.min(1, dt * 5);
    }
    this.moving = this.walkWeight > 0.02;
    return this.route.length > 0 || Math.abs(angleTo(this.yaw, this.faceYaw ?? 0)) > 0.02 || this.walkWeight > 0.05;
  }
}

// Body measurements the stunts scale to: hip height, pelvis-to-shoulder height and arm length.
export function makeStunts({ hip, shoulder, arm }) {
  const body = hip + shoulder;
  const pushTop = Math.acos(Math.min(0.95, arm / body));
  const pushLow = Math.acos(Math.min(0.95, (arm * 0.68) / body));
  const handstandHip = shoulder + arm + 0.04;
  const jump = hip * 0.8;

  return {
    nod: {
      duration: 1.4,
      pose(p, u) {
        p["head.rx"] += 0.3 * Math.sin(Math.PI * u * 2) * (1 - u);
      },
    },
    wave: {
      duration: 2.6,
      pose(p, u, t) {
        p["shoulderR.rz"] = -2.55;
        p["shoulderR.rx"] = -0.2;
        p["elbowR.rz"] = -0.35 + Math.sin(t * 11) * 0.45;
        p["head.rz"] = 0.12;
      },
    },
    bow: {
      duration: 2.8,
      pose(p, u) {
        const k = Math.sin(Math.PI * u);
        p["spine.rx"] = 0.95 * k;
        p["neck.rx"] = 0.3 * k;
        p["shoulderR.rx"] = -0.9 * k;
        p["elbowR.rz"] = 1.4 * k;
        p["shoulderL.rx"] = 0.5 * k;
      },
    },
    flex: {
      duration: 3,
      pose(p, u, t) {
        const pump = Math.sin(t * 5) * 0.12;
        p["shoulderL.rz"] = 1.45;
        p["shoulderR.rz"] = -1.45;
        p["elbowL.rz"] = 1.75 + pump;
        p["elbowR.rz"] = -1.75 - pump;
        p["chest.rx"] = -0.12;
        p["head.rx"] = -0.12;
      },
    },
    jacks: {
      duration: 4.2,
      pose(p, u, t) {
        const k = (1 - Math.cos(((u - 0.05) / 0.9) * TAU * 4)) / 2;
        const on = between(u, 0.05, 0.95) ? 1 : 0;
        p["shoulderL.rz"] = 0.1 + 2.6 * k * on;
        p["shoulderR.rz"] = -0.1 - 2.6 * k * on;
        p["hipL.rz"] = 0.32 * k * on;
        p["hipR.rz"] = -0.32 * k * on;
        p["pelvis.py"] = hip + Math.abs(Math.sin(((u - 0.05) / 0.9) * Math.PI * 8)) * 0.16 * on;
        p["head.rx"] = -0.05;
      },
      impacts: [0.2, 0.43, 0.67, 0.9].map((at) => ({ at, strength: 0.2 })),
    },
    dance: {
      duration: 6.5,
      pose(p, u, t) {
        const beat = t * 4.2;
        p["shoulderL.rx"] = p["shoulderR.rx"] = -1.45; // stiff, arms-out "monster" dance
        p["shoulderL.rz"] = 0.15 + Math.sin(beat) * 0.15;
        p["shoulderR.rz"] = -0.15 + Math.sin(beat) * 0.15;
        p["elbowL.rx"] = p["elbowR.rx"] = -0.25;
        p["pelvis.px"] = Math.sin(beat / 2) * 0.28;
        p["pelvis.rz"] = Math.sin(beat / 2) * 0.09;
        p["pelvis.py"] = hip - Math.abs(Math.sin(beat)) * 0.08;
        p["kneeL.rx"] = Math.max(0, Math.sin(beat)) * 0.55;
        p["kneeR.rx"] = Math.max(0, -Math.sin(beat)) * 0.55;
        p["hipL.rx"] = -Math.max(0, Math.sin(beat)) * 0.4;
        p["hipR.rx"] = -Math.max(0, -Math.sin(beat)) * 0.4;
        p["head.rz"] = Math.sin(beat) * 0.15;
        p["chest.ry"] = Math.sin(beat / 2) * 0.2;
      },
    },
    roar: {
      duration: 3.4,
      pose(p, u, t) {
        const k = seg(u, 0, 0.25) * (1 - seg(u, 0.8, 1));
        const shake = Math.sin(t * 40) * 0.03 * k;
        p["chest.rx"] = -0.35 * k;
        p["neck.rx"] = -0.25 * k;
        p["head.rx"] = -0.45 * k + shake;
        p["shoulderL.rz"] = 0.1 + 2.0 * k;
        p["shoulderR.rz"] = -0.1 - 2.0 * k;
        p["shoulderL.rx"] = p["shoulderR.rx"] = -0.4 * k;
        p["elbowL.rz"] = 0.6 * k;
        p["elbowR.rz"] = -0.6 * k;
        p["jaw.rx"] = 0.7 * k;
        p["pelvis.py"] = hip - 0.12 * k;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.3 * k;
        p["hipL.rz"] = 0.12 * k;
        p["hipR.rz"] = -0.12 * k;
      },
    },
    stomp: {
      duration: 2.2,
      pose(p, u) {
        const lift = seg(u, 0.05, 0.4) * (1 - seg(u, 0.45, 0.55));
        const squat = seg(u, 0.5, 0.58) * (1 - seg(u, 0.7, 1));
        p["hipR.rx"] = -1.5 * lift;
        p["kneeR.rx"] = 1.6 * lift;
        p["shoulderL.rz"] = 0.1 + 0.8 * lift;
        p["shoulderR.rz"] = -0.1 - 0.8 * lift;
        p["pelvis.py"] = hip - 0.25 * squat;
        p["kneeL.rx"] = p["kneeR.rx"] = Math.max(p["kneeR.rx"], 0.6 * squat);
        p["chest.rx"] = 0.25 * squat;
      },
      impacts: [{ at: 0.52, strength: 1 }],
    },
    kneel: {
      duration: 5,
      pose(p, u, t) {
        const k = seg(u, 0, 0.22) * (1 - seg(u, 0.8, 1));
        p["pelvis.py"] = hip - hip * 0.42 * k;
        p["hipL.rx"] = -1.45 * k;
        p["kneeL.rx"] = 1.5 * k;
        p["hipR.rx"] = 0.15 * k;
        p["kneeR.rx"] = 1.7 * k;
        p["ankleR.rx"] = 0.8 * k;
        p["spine.rx"] = 0.2 * k;
        p["head.rx"] = 0.45 * k;
        p["shoulderR.rx"] = -0.7 * k;
        p["elbowR.rx"] = -1.0 * k;
        p["chest.rx"] = 0.1 * k + Math.sin(t * 1.5) * 0.02;
      },
    },
    backflip: {
      duration: 2.2,
      facing: Math.PI / 2,
      pose(p, u) {
        const crouch = seg(u, 0, 0.18) * (1 - seg(u, 0.18, 0.26)) + seg(u, 0.74, 0.82) * (1 - seg(u, 0.84, 1));
        const a = Math.min(1, Math.max(0, (u - 0.2) / 0.56));
        const air = between(u, 0.2, 0.76);
        const tuck = air ? Math.sin(Math.PI * a) : 0;
        p["pelvis.py"] = hip - hip * 0.3 * crouch + (air ? 4 * jump * a * (1 - a) : 0);
        p["pelvis.rx"] = air ? -TAU * ease(a) : 0;
        p["hipL.rx"] = p["hipR.rx"] = -1.25 * crouch - 1.9 * tuck;
        p["kneeL.rx"] = p["kneeR.rx"] = 2.0 * crouch + 2.3 * tuck;
        p["ankleL.rx"] = p["ankleR.rx"] = -0.7 * crouch;
        p["spine.rx"] = 0.45 * crouch + 0.4 * tuck;
        p["shoulderL.rx"] = p["shoulderR.rx"] = 0.9 * crouch - 1.3 * tuck - (between(u, 0.16, 0.24) ? 2.2 : 0);
        p["elbowL.rx"] = p["elbowR.rx"] = -0.6 * tuck;
      },
      impacts: [{ at: 0.77, strength: 0.8 }],
    },
    pushups: {
      duration: 6.4,
      facing: Math.PI / 2,
      pose(p, u) {
        const down = seg(u, 0, 0.16) * (1 - seg(u, 0.86, 1));
        const rep = between(u, 0.18, 0.84) ? (1 - Math.cos(((u - 0.18) / 0.66) * TAU * 4)) / 2 : 0;
        const theta = lerp(pushTop, pushLow, rep);
        p["pelvis.rx"] = theta * down;
        p["pelvis.py"] = lerp(hip, hip * Math.cos(theta), down);
        p["shoulderL.rx"] = p["shoulderR.rx"] = (-theta - rep * 0.5) * down;
        p["elbowL.rx"] = p["elbowR.rx"] = rep * 1.1 * down;
        p["shoulderL.rz"] = 0.25 * down;
        p["shoulderR.rz"] = -0.25 * down;
        p["ankleL.rx"] = p["ankleR.rx"] = 0.9 * down;
        p["neck.rx"] = -0.55 * down;
        p["head.rx"] = -0.25 * down;
      },
    },
    handstand: {
      duration: 6.5,
      pose(p, u, t) {
        const up = seg(u, 0, 0.24);
        const downPhase = seg(u, 0.78, 1);
        const arms = seg(u, 0, 0.1) * (1 - seg(u, 0.9, 1));
        const hold = between(u, 0.24, 0.78) ? 1 : 0;
        p["pelvis.rx"] = Math.PI * up * (1 - downPhase) + hold * Math.sin(t * 2.3) * 0.06;
        p["pelvis.rz"] = hold * Math.sin(t * 3.1) * 0.05;
        p["pelvis.py"] = hip + (handstandHip - hip) * Math.sin((Math.PI / 2) * up * (1 - downPhase));
        p["shoulderL.rx"] = p["shoulderR.rx"] = -Math.PI * arms;
        p["shoulderL.rz"] = 0.18 * arms;
        p["shoulderR.rz"] = -0.18 * arms;
        p["hipL.rx"] = -0.25 * hold + Math.sin(t * 4) * 0.08 * hold;
        p["hipR.rx"] = 0.25 * hold - Math.sin(t * 4) * 0.08 * hold;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.4 * (1 - hold) * up;
        p["neck.rx"] = -0.4 * hold;
      },
      impacts: [{ at: 0.97, strength: 0.5 }],
    },
    spin: {
      duration: 2.4,
      pose(p, u) {
        p["spin"] = TAU * ease(u); // applied directly, not blended
        p["shoulderL.rz"] = 0.1 + 1.2 * Math.sin(Math.PI * u);
        p["shoulderR.rz"] = -0.1 - 1.2 * Math.sin(Math.PI * u);
      },
    },
    // Idle fidgets he does on his own between lines.
    look_around: {
      duration: 4,
      pose(p, u) {
        p["head.ry"] = Math.sin(u * Math.PI * 2) * 0.7 * Math.sin(u * Math.PI);
        p["neck.ry"] = p["head.ry"] * 0.4;
        p["chest.ry"] = p["head.ry"] * 0.25;
      },
    },
    crack_neck: {
      duration: 2.6,
      pose(p, u) {
        p["head.rz"] = (u < 0.5 ? 0.35 : -0.35) * Math.sin(((u % 0.5) / 0.5) * Math.PI);
        p["shoulderL.rx"] = p["shoulderR.rx"] = 0.1 * Math.sin(u * Math.PI);
      },
    },
    look_hands: {
      duration: 3.4,
      pose(p, u, t) {
        const k = Math.sin(u * Math.PI);
        p["shoulderR.rx"] = -1.0 * k;
        p["elbowR.rx"] = -1.5 * k;
        p["shoulderR.rz"] = 0.25 * k;
        p["head.rx"] = 0.45 * k;
        p["head.ry"] = -0.25 * k;
        p["fingers.curl"] = 0.55 - 0.45 * k + Math.sin(t * 6) * 0.15 * k;
      },
    },
    stretch: {
      duration: 3.6,
      pose(p, u) {
        const k = Math.sin(u * Math.PI);
        p["shoulderL.rz"] = 0.1 + 2.7 * k;
        p["shoulderR.rz"] = -0.1 - 2.7 * k;
        p["chest.rx"] = -0.2 * k;
        p["head.rx"] = -0.3 * k;
        p["jaw.rx"] = 0.35 * k; // a big yawn
      },
    },

    // The big-gift celebration, in the order a person really does it: he notices (looks up and
    // round), gathers himself (a small dip of the knees and a breath), shifts his weight, raises
    // both arms in a wide V a little in front of him, holds the climax with his chest up and
    // hands open, then settles and comes back to rest. The shoulders lift with the arms (the rig
    // raises the collarbones, see rigged.js) and the elbows stay soft. Markers name each moment
    // so gift effects and sounds can meet the climax exactly.
    celebrate: {
      duration: 7,
      markers: [
        { at: 0.03, name: "notice" },
        { at: 0.15, name: "prepare" },
        { at: 0.24, name: "shift" },
        { at: 0.32, name: "raise" },
        { at: 0.5, name: "climax" },
        { at: 0.72, name: "settle" },
        { at: 0.9, name: "return" },
      ],
      pose(p, u, t) {
        const notice = seg(u, 0.02, 0.14) * (1 - seg(u, 0.3, 0.42));
        const dip = seg(u, 0.14, 0.22) * (1 - seg(u, 0.24, 0.33));
        const shift = Math.sin(Math.PI * Math.max(0, Math.min(1, (u - 0.22) / 0.14)));
        const raise = seg(u, 0.3, 0.5) * (1 - seg(u, 0.72, 0.92));
        const hold = seg(u, 0.48, 0.54) * (1 - seg(u, 0.66, 0.74));
        const pulse = hold * Math.sin(t * 6.5) * 0.035;
        p["head.rx"] += -0.22 * notice - 0.28 * raise - pulse;
        p["head.ry"] += 0.14 * notice;
        p["chest.rx"] = (p["chest.rx"] || 0) - 0.06 * dip - 0.16 * raise;
        p["spine.rx"] = 0.08 + 0.06 * dip - 0.06 * raise;
        p["pelvis.py"] = hip - hip * 0.06 * dip + 0.025 * hold;
        p["pelvis.px"] = (p["pelvis.px"] || 0) + 0.055 * shift;
        p["pelvis.rz"] = (p["pelvis.rz"] || 0) + 0.03 * shift;
        p["kneeL.rx"] = 0.03 + 0.28 * dip + 0.12 * shift * (1 - raise);
        p["kneeR.rx"] = 0.03 + 0.28 * dip;
        // Arms: from hanging (rz 0.1) to a V at about 130 degrees, slightly forward.
        p["shoulderL.rz"] = 0.1 + 2.15 * raise + 0.05 * pulse;
        p["shoulderR.rz"] = -0.1 - 2.15 * raise - 0.05 * pulse;
        p["shoulderL.rx"] = p["shoulderR.rx"] = -0.28 * raise - 0.06 * dip;
        p["elbowL.rx"] = p["elbowR.rx"] = -0.18 - 0.12 * raise;
        p["elbowL.rz"] = 0.14 * raise;
        p["elbowR.rz"] = -0.14 * raise;
        p["fingers.curl"] = 0.55 - 0.42 * raise;
        p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, 0.22 * hold);
      },
    },

    // Looking something over: a slight lean, head tilted, one hand at his chin, then upright.
    inspect: {
      duration: 3.2,
      markers: [{ at: 0.4, name: "look" }],
      pose(p, u, t) {
        const k = seg(u, 0.05, 0.3) * (1 - seg(u, 0.75, 0.98));
        p["spine.rx"] = 0.08 + 0.2 * k;
        p["head.rx"] += 0.18 * k;
        p["head.rz"] += 0.12 * k * Math.sin(1 + t * 0.6);
        p["shoulderR.rx"] = -0.55 * k;
        p["elbowR.rx"] = -0.18 - 1.9 * k;
        p["fingers.curl"] = 0.55 + 0.15 * k;
      },
    },

    // A glance up at the sky (distant thunder, a bat): head and chest lift, then settle.
    glance_up: {
      duration: 2.2,
      pose(p, u) {
        const k = seg(u, 0.05, 0.25) * (1 - seg(u, 0.7, 1));
        p["head.rx"] += -0.42 * k;
        p["head.ry"] += 0.2 * k;
        p["chest.rx"] = (p["chest.rx"] || 0) - 0.06 * k;
      },
    },

    // Bolt Spark: a spark at his neck makes his shoulders jump; his hand goes to the bolt, he
    // tilts his head away from it, then relaxes with a small amused bounce.
    twitch: {
      duration: 2.8,
      markers: [{ at: 0.08, name: "spark" }, { at: 0.3, name: "climax" }, { at: 0.75, name: "settle" }],
      pose(p, u, t) {
        const jump = seg(u, 0.08, 0.16) * (1 - seg(u, 0.24, 0.45));
        const hand = seg(u, 0.22, 0.4) * (1 - seg(u, 0.62, 0.82));
        const laugh = seg(u, 0.62, 0.7) * (1 - seg(u, 0.88, 1)) * Math.max(0, Math.sin(t * 15));
        p["clavL.rz"] = 0.22 * jump;
        p["clavR.rz"] = -0.22 * jump;
        p["head.rz"] += -0.18 * jump + 0.1 * hand;
        p["head.rx"] += -0.06 * jump;
        p["shoulderL.rx"] = -0.5 * hand;
        p["shoulderL.rz"] = 0.1 + 0.62 * hand;
        p["elbowL.rx"] = -0.18 - 1.85 * hand;
        p["fingers.curl"] = 0.55 - 0.25 * hand;
        p["chest.rx"] = (p["chest.rx"] || 0) - 0.03 * laugh;
        p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, 0.12 * jump + 0.08 * laugh);
      },
    },

    // Pumpkin Whisper: he leans down to the pumpkin with a hand cupped behind his ear, listens,
    // jerks upright at what he hears, then recovers with a chuckle and a hand on his chest.
    listen: {
      duration: 4.7,
      markers: [{ at: 0.2, name: "listen" }, { at: 0.56, name: "climax" }, { at: 0.72, name: "reaction" }],
      pose(p, u, t) {
        const lean = seg(u, 0.02, 0.22) * (1 - seg(u, 0.54, 0.62));
        const ear = seg(u, 0.08, 0.24) * (1 - seg(u, 0.54, 0.64));
        const jolt = seg(u, 0.55, 0.6) * (1 - seg(u, 0.66, 0.8));
        const chuckle = seg(u, 0.66, 0.74) * (1 - seg(u, 0.9, 1));
        p["spine.rx"] = 0.08 + 0.42 * lean - 0.12 * jolt;
        p["chest.rx"] = (p["chest.rx"] || 0) + 0.12 * lean - 0.16 * jolt;
        p["pelvis.py"] = hip - 0.12 * lean * hip;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.03 + 0.38 * lean;
        p["head.rx"] += 0.22 * lean - 0.22 * jolt;
        p["head.rz"] += 0.16 * ear * (1 + 0.25 * Math.sin(t * 2.2));
        p["shoulderR.rz"] = -0.1 - 1.3 * ear - 0.35 * jolt;
        p["shoulderR.rx"] = -0.25 * ear;
        p["elbowR.rx"] = -0.18 - 2.2 * ear;
        p["shoulderL.rz"] = 0.1 + 0.35 * jolt;
        p["shoulderL.rx"] = -0.45 * chuckle;
        p["elbowL.rx"] = -0.18 - 1.3 * chuckle;
        p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, 0.25 * jolt + 0.1 * chuckle * Math.max(0, Math.sin(t * 14)));
      },
    },

    // Haunted Gate: he peers at the gate, it creaks, he recoils with his arms up in front of
    // him, then regains his dignity: arms down, lapels straightened, chin up.
    gate_react: {
      duration: 5.6,
      markers: [{ at: 0.16, name: "creak" }, { at: 0.46, name: "climax" }, { at: 0.7, name: "reaction" }],
      pose(p, u) {
        const peer = seg(u, 0.02, 0.18) * (1 - seg(u, 0.44, 0.5));
        const recoil = seg(u, 0.45, 0.5) * (1 - seg(u, 0.6, 0.72));
        const lapels = seg(u, 0.66, 0.76) * (1 - seg(u, 0.88, 0.98));
        p["chest.rx"] = (p["chest.rx"] || 0) + 0.1 * peer - 0.22 * recoil - 0.06 * lapels;
        p["neck.rx"] = (p["neck.rx"] || 0) + 0.14 * peer;
        p["spine.rx"] = 0.08 + 0.06 * peer - 0.16 * recoil;
        p["pelvis.py"] = hip - 0.06 * recoil * hip;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.03 + 0.25 * recoil;
        p["shoulderL.rx"] = p["shoulderR.rx"] = -0.85 * recoil - 0.42 * lapels;
        p["shoulderL.rz"] = 0.1 + 0.2 * recoil - 0.18 * lapels;
        p["shoulderR.rz"] = -0.1 - 0.2 * recoil + 0.18 * lapels;
        p["elbowL.rx"] = p["elbowR.rx"] = -0.18 - 1.25 * recoil - 1.35 * lapels;
        p["fingers.curl"] = 0.55 - 0.35 * recoil + 0.2 * lapels;
        p["head.rx"] += 0.04 * peer - 0.14 * recoil - 0.06 * lapels;
        p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, 0.28 * recoil);
      },
    },

    // Haunted Gate, with his back to the gate (the figure gathers behind him where the viewers can
    // see it and he can't): the creak freezes him, he looks back over his shoulder, then lurches
    // away from the gate towards the viewers with his arms up, and recovers by straightening his lapels.
    gate_turn: {
      duration: 5.4,
      markers: [{ at: 0.2, name: "creak" }, { at: 0.5, name: "climax" }, { at: 0.72, name: "reaction" }],
      pose(p, u, t) {
        const freeze = seg(u, 0.18, 0.24) * (1 - seg(u, 0.48, 0.52));
        const back = seg(u, 0.26, 0.42) * (1 - seg(u, 0.48, 0.53));
        const lurch = seg(u, 0.49, 0.54) * (1 - seg(u, 0.62, 0.74));
        const lapels = seg(u, 0.7, 0.8) * (1 - seg(u, 0.9, 0.99));
        p["spine.rx"] = 0.08 - 0.04 * freeze + 0.2 * lurch;
        p["chest.rx"] = (p["chest.rx"] || 0) + 0.1 * lurch - 0.06 * lapels;
        p["chest.ry"] = (p["chest.ry"] || 0) + 0.32 * back;
        p["head.ry"] += 0.95 * back;
        p["head.rx"] += -0.06 * freeze + 0.08 * back - 0.1 * lurch - 0.06 * lapels;
        p["pelvis.py"] = hip - 0.07 * lurch * hip;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.03 + 0.08 * freeze + 0.28 * lurch;
        p["shoulderL.rx"] = p["shoulderR.rx"] = -0.25 * freeze - 0.95 * lurch - 0.42 * lapels;
        p["shoulderL.rz"] = 0.1 + 0.08 * freeze + 0.25 * lurch - 0.18 * lapels;
        p["shoulderR.rz"] = -0.1 - 0.08 * freeze - 0.25 * lurch + 0.18 * lapels;
        p["elbowL.rx"] = p["elbowR.rx"] = -0.18 - 0.5 * freeze - 1.1 * lurch - 1.35 * lapels;
        p["fingers.curl"] = 0.55 - 0.4 * (freeze + lurch) * 0.5 + 0.2 * lapels;
        p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, 0.3 * lurch + 0.08 * back);
        p["head.rz"] += 0.03 * freeze * Math.sin(t * 40); // a shiver
      },
    },

    // Laboratory Surge: he reaches for the switch on the apparatus with his right hand, grips
    // it, throws it down leaning into the pull, lets go and looks up at the coils.
    activate: {
      duration: 4.4,
      markers: [{ at: 0.27, name: "grip" }, { at: 0.45, name: "lever" }, { at: 0.62, name: "release" }],
      pose(p, u) {
        const reach = seg(u, 0.02, 0.27);
        const pull = seg(u, 0.27, 0.45);
        const away = seg(u, 0.6, 0.9);
        const arm = reach * (1 - away);
        p["shoulderR.rx"] = (-0.8 + 0.5 * pull) * arm;
        p["shoulderR.rz"] = -0.1 - 0.12 * arm;
        p["elbowR.rx"] = -0.18 - (0.25 + 0.3 * pull) * arm;
        p["fingers.curl"] = 0.55 - 0.4 * reach * (1 - pull) + 0.35 * pull * (1 - seg(u, 0.58, 0.66));
        p["spine.rx"] = 0.08 + (0.2 + 0.1 * pull) * arm;
        p["pelvis.py"] = hip - 0.05 * pull * (1 - away) * hip;
        p["kneeL.rx"] = p["kneeR.rx"] = 0.03 + 0.15 * pull * (1 - away);
        p["head.rx"] += 0.12 * arm - 0.28 * seg(u, 0.55, 0.7) * (1 - seg(u, 0.92, 1));
        p["shoulderL.rz"] = 0.1 + 0.15 * away * (1 - seg(u, 0.92, 1));
      },
    },

    // The lightning-strike "reanimation": convulsions, then he rises with arms outstretched.
    reanimate: {
      duration: 6,
      pose(p, u, t) {
        const jolt = between(u, 0.05, 0.45) ? 1 : 0;
        const rise = seg(u, 0.45, 0.65) * (1 - seg(u, 0.88, 1));
        const r = (s) => Math.sin(t * s) * 0.25 * jolt;
        p["chest.rx"] = r(37) - 0.3 * rise;
        p["head.rx"] = r(29) - 0.5 * rise;
        p["head.rz"] = r(23);
        p["shoulderL.rz"] = 0.1 + Math.abs(r(31)) * 3 + 1.55 * rise;
        p["shoulderR.rz"] = -0.1 - Math.abs(r(27)) * 3 - 1.55 * rise;
        p["elbowL.rx"] = r(41) * 2;
        p["elbowR.rx"] = r(43) * 2;
        p["kneeL.rx"] = p["kneeR.rx"] = Math.abs(r(19)) * 1.2 + 0.15 * rise;
        p["pelvis.py"] = hip - Math.abs(r(19)) * 0.3 * hip;
        p["jaw.rx"] = 0.5 * rise + Math.abs(r(33));
      },
      flashes: [0.05, 0.2, 0.35],
      markers: [{ at: 0.05, name: "jolt" }, { at: 0.5, name: "climax" }],
    },
  };
}

// Beat gestures while he talks: a hand comes up on a stressed syllable, holds for a moment
// and settles back, so his hands follow the speech instead of looping. `e` is 0..1.
const BEATS = [
  (p, e) => {
    // open right palm
    p["shoulderR.rx"] -= 0.5 * e;
    p["shoulderR.rz"] -= 0.22 * e;
    p["elbowR.rx"] -= 0.75 * e;
  },
  (p, e) => {
    // open left palm
    p["shoulderL.rx"] -= 0.5 * e;
    p["shoulderL.rz"] += 0.22 * e;
    p["elbowL.rx"] -= 0.75 * e;
  },
  (p, e) => {
    // both hands open, explaining
    p["shoulderL.rx"] -= 0.42 * e;
    p["shoulderR.rx"] -= 0.42 * e;
    p["shoulderL.rz"] += 0.2 * e;
    p["shoulderR.rz"] -= 0.2 * e;
    p["elbowL.rx"] -= 0.7 * e;
    p["elbowR.rx"] -= 0.7 * e;
  },
  (p, e) => {
    // hand to his chest: "me"
    p["shoulderL.rx"] -= 0.45 * e;
    p["shoulderL.rz"] -= 0.12 * e;
    p["elbowL.rx"] -= 1.45 * e;
    p["head.rx"] += 0.05 * e;
  },
  (p, e) => {
    // emphatic forward beat
    p["shoulderR.rx"] -= 0.7 * e;
    p["elbowR.rx"] -= 0.35 * e;
    p["chest.rx"] += 0.04 * e;
  },
  (p, e) => {
    // a small shrug with both forearms out
    p["elbowL.rx"] -= 0.8 * e;
    p["elbowR.rx"] -= 0.8 * e;
    p["shoulderL.rz"] += 0.12 * e;
    p["shoulderR.rz"] -= 0.12 * e;
    p["head.rz"] += 0.08 * e;
  },
];

// Where one leg is in its step, from -1 (foot forward) to 1 (foot back). While the foot is on
// the ground (the first half) the hip sweeps back at a constant rate, so the foot stays planted
// while the body passes over it; in the air it swings forward again with an eased curve.
function legSweep(phase) {
  const x = (((phase - Math.PI / 2) % TAU) + TAU) % TAU;
  if (x < Math.PI) return -1 + (2 * x) / Math.PI;
  return 1 - 2 * ease((x - Math.PI) / Math.PI);
}

// The walking gait at a given stride (0.35..1): heel strike, push-off and a swinging knee,
// timed to the distance travelled. The hip swing is sized from his leg length so the planted
// foot travels back exactly as far as the body moves forward: no sliding.
function gait(phase, stride, hip, inPlace = false, { stepLength = hip * 0.53, leg = hip * 0.9 } = {}) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const g = {};
  const swing = inPlace ? 0.03 : Math.asin(Math.min(0.9, (stepLength * stride) / (2 * leg)));
  g["hipL.rx"] = swing * legSweep(phase);
  g["hipR.rx"] = swing * legSweep(phase + Math.PI);
  g["kneeL.rx"] = 0.06 + Math.max(0, c) * (0.45 + 0.3 * stride);
  g["kneeR.rx"] = 0.06 + Math.max(0, -c) * (0.45 + 0.3 * stride);
  g["ankleL.rx"] = -s * 0.2 * stride + Math.max(0, c) * 0.14;
  g["ankleR.rx"] = s * 0.2 * stride + Math.max(0, -c) * 0.14;
  g["shoulderL.rx"] = s * 0.24 * stride;
  g["shoulderR.rx"] = -s * 0.24 * stride;
  g["elbowL.rx"] = -0.3 - Math.max(0, -s) * 0.22 * stride;
  g["elbowR.rx"] = -0.3 - Math.max(0, s) * 0.22 * stride;
  g["pelvis.py"] = hip + Math.cos(phase * 2) * 0.026 * stride - 0.03;
  g["pelvis.px"] = 0;
  g["pelvis.ry"] = s * 0.08 * stride;
  g["pelvis.rz"] = c * 0.035 * stride;
  g["chest.ry"] = -s * 0.06 * stride;
  g["spine.rx"] = 0.14;
  g["head.rx"] = -0.05 - Math.cos(phase * 2) * 0.012;
  g["head.ry"] = 0;
  return g;
}

// Breathing, weight shifts, walking, talking gestures and eye contact.
export function basePose(p, t, { talking, voiced = talking, mood, walk = 0, phase = 0, stride = 1, inPlace = false, stepLength, look, beat, weight = 0, mouth }, { hip, leg }) {
  // Standing: slow breathing, and his weight resting on one leg for a few seconds at a time.
  const breathe = Math.sin(t * 1.35);
  p["pelvis.py"] = hip + breathe * 0.004 - Math.abs(weight) * 0.012;
  p["pelvis.px"] = weight * 0.03;
  p["pelvis.rz"] = weight * 0.022;
  p["kneeL.rx"] = 0.03 + Math.max(0, -weight) * 0.13;
  p["kneeR.rx"] = 0.03 + Math.max(0, weight) * 0.13;
  p["spine.rx"] = 0.08;
  p["chest.rx"] = breathe * 0.02;
  p["chest.rz"] = -weight * 0.015;
  p["neck.rx"] = -0.06;
  p["head.ry"] = 0;
  p["head.rx"] = Math.sin(t * 0.53) * 0.02;
  p["head.rz"] = weight * 0.02;
  p["shoulderL.rz"] = 0.1;
  p["shoulderR.rz"] = -0.1;
  p["shoulderL.rx"] = p["shoulderR.rx"] = breathe * 0.012;
  p["elbowL.rx"] = p["elbowR.rx"] = -0.18;
  p["fingers.curl"] = 0.55;

  if (walk > 0.001) {
    const g = gait(phase, stride, hip, inPlace, { stepLength, leg: leg || hip * 0.9 });
    for (const [k, v] of Object.entries(g)) p[k] = lerp(p[k] ?? 0, v, walk);
  }

  // The jaw follows the voice (mouth.open is gated, so it shuts in pauses); 0.36 here is about
  // 0.2 rad at the jaw bone, as wide as this face opens cleanly. `voiced` also covers his hums
  // and laughs between lines (sound/voice.js), which don't count as talking.
  if (voiced) p["jaw.rx"] = Math.max(p["jaw.rx"] || 0, (mouth?.open ?? 0) * 0.36);

  if (talking && walk < 0.5) {
    const k = 1 - walk * 2;
    // Hands come up a little while he talks, ready to gesture.
    p["elbowL.rx"] = lerp(p["elbowL.rx"], -0.42, k);
    p["elbowR.rx"] = lerp(p["elbowR.rx"], -0.42, k);
    p["shoulderL.rx"] -= 0.08 * k;
    p["shoulderR.rx"] -= 0.08 * k;
    if (beat) BEATS[beat.type](p, beat.e * k);
    // Small head movement with the stress of the speech.
    p["head.rx"] += (mouth?.open || 0) * 0.05 - 0.02;
    p["fingers.curl"] = 0.4;
  }

  if (look && walk < 0.5) {
    p["head.ry"] += look.yaw * 0.65;
    p["neck.ry"] = look.yaw * 0.3;
    p["head.rx"] -= look.pitch * 0.7;
  }
  if (mood === "delighted") {
    p["chest.rx"] -= 0.04;
    p["head.rx"] -= 0.05;
  } else if (mood === "melancholy") {
    p["head.rx"] += 0.16;
    p["spine.rx"] += 0.08;
  } else if (mood === "indignant") {
    p["chest.rx"] -= 0.06;
    p["head.rx"] -= 0.06;
  } else if (mood === "thoughtful" && talking && walk < 0.5) {
    p["head.rz"] -= 0.07;
  }
}

// Queues stunts and walks by priority, blends every change of state, and reports impacts.
const FIDGETS = ["look_around", "crack_neck", "look_hands", "stretch"];
// gift > command > the AI's own choice > idle fidget. A higher priority interrupts a lower
// one that is a walk or a fidget; stunts in progress finish unless the system needs him.
export const PRIORITY = { fidget: 0, ai: 1, command: 2, gift: 3, system: 4 };
const CROSSFADE = 0.35;
// How far (m) each big stunt swings his body out from where he stands. Before one starts he
// steps to the nearest spot with that much room, so flips and push-ups never go through graves.
const STUNT_REACH = { backflip: 1.25, pushups: 1.7, handstand: 1.35, dance: 0.8, spin: 0.9, jacks: 0.8, reanimate: 0.8, roar: 0.6, stomp: 0.6, kneel: 0.7, bow: 0.7, celebrate: 0.8 };

export class Performer {
  constructor(locomotion, dims, { onImpact, onFlash, onMarker, onStep } = {}) {
    this.locomotion = locomotion;
    // A full-speed step equals how far the planted foot travels under a 0.3 rad leg swing
    // (2 x leg x sin 0.3, leg ~0.9 x hip height), so the foot stays put while the body passes.
    locomotion.stepLength = dims.hip * 0.53;
    this.dims = dims;
    this.stunts = makeStunts(dims);
    this.queue = [];
    this.current = null;
    this.facing = 0;
    this.spin = 0;
    this.onImpact = onImpact;
    this.onFlash = onFlash;
    // (stuntName, marker) for "start", each named moment of a stunt, and "end" (or "cut" when
    // it is interrupted), so effects and sounds can follow his real timing.
    this.onMarker = onMarker;
    this.onStep = onStep; // (foot "L" | "R", strength 0..1, inPlace) at each heel strike
    this.nextFidget = 14;
    this.look = { yaw: 0, pitch: 0 };
    this.lastPose = {};
    this.fade = null;
    this.weight = 0;
    this.weightTarget = 0.6;
    this.nextWeight = 6;
    this.beat = null;
    this.beatAt = -10;
    this.lastBeatType = -1;
    this.lastOpen = 0;
  }

  // Where the camera is, relative to the way he is facing, so he can meet its eye.
  lookAt(camera, dt) {
    const root = this.locomotion.root.position;
    let yaw = 0;
    let pitch = 0;
    if (camera && (!this.current || this.current.type === "walk")) {
      const dx = camera.x - root.x;
      const dz = camera.z - root.z;
      const dy = camera.y - (root.y + this.dims.hip + this.dims.shoulder + 0.35);
      yaw = Math.max(-0.75, Math.min(0.75, angleTo(this.yaw, Math.atan2(dx, dz))));
      pitch = Math.max(-0.35, Math.min(0.35, Math.atan2(dy, Math.hypot(dx, dz))));
    }
    const k = Math.min(1, dt * 3);
    this.look.yaw = lerp(this.look.yaw, yaw, k);
    this.look.pitch = lerp(this.look.pitch, pitch, k);
    return this.look;
  }

  perform(action, { priority = PRIORITY.ai } = {}) {
    let item;
    if (action.startsWith("walk_")) item = { type: "walk", spot: action.slice(5), name: action, priority };
    else if (this.stunts[action]) item = { type: "stunt", name: action, priority };
    else return;
    if (this.queue.some((q) => q.name === item.name)) return; // already coming up
    if (this.queue.length >= 5) {
      const lowest = this.queue.reduce((a, b) => (b.priority < a.priority ? b : a));
      if (lowest.priority >= priority) return;
      this.queue.splice(this.queue.indexOf(lowest), 1);
    }
    const at = this.queue.findIndex((q) => q.priority < priority);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, item);
    const cur = this.current;
    if (cur && priority > cur.priority && (cur.type === "walk" || cur.priority === PRIORITY.fidget || priority === PRIORITY.system)) this.interrupt();
  }

  // Walks to a point (a gift event's standing place), ahead of anything of lower priority.
  walkToPoint(x, z, { priority = PRIORITY.gift, name = "event_walk", pace = 1 } = {}) {
    this.queue = this.queue.filter((q) => q.name !== name);
    const at = this.queue.findIndex((q) => q.priority < priority);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, { type: "walk", point: [x, z], name, priority, pace, roomChecked: true });
    const cur = this.current;
    if (cur && priority > cur.priority && (cur.type === "walk" || cur.priority === PRIORITY.fidget)) this.interrupt();
  }

  // Stops what he is doing; the crossfade carries the pose smoothly into whatever is next.
  interrupt() {
    this.startFade();
    if (this.current?.type === "walk") this.locomotion.route = [];
    if (this.current?.type === "stunt") this.onMarker?.(this.current.name, "cut");
    this.current = null;
  }

  clear() {
    this.startFade();
    if (this.current?.type === "stunt") this.onMarker?.(this.current.name, "cut");
    this.queue = [];
    this.current = null;
    this.locomotion.route = [];
  }

  startFade() {
    this.fade = { from: { ...this.lastPose }, t: 0 };
  }

  get busy() {
    return Boolean(this.current);
  }

  // The next thing to do. Walks wait while he is talking, so his face stays to the camera.
  takeNext(talking) {
    const i = this.queue.findIndex((q) => !(talking && q.type === "walk" && q.priority < PRIORITY.gift));
    return i < 0 ? null : this.queue.splice(i, 1)[0];
  }

  pose(dt, t, speech) {
    const loco = this.locomotion;
    // Left alone for a while, he fidgets (never while talking or straight after a stunt).
    if (!this.current && !this.queue.length && !speech.talking) {
      this.nextFidget -= dt;
      if (this.nextFidget <= 0) {
        this.queue.push({ type: "stunt", name: FIDGETS[Math.floor(Math.random() * FIDGETS.length)], priority: PRIORITY.fidget });
        this.nextFidget = 16 + Math.random() * 14;
      }
    } else if (this.current || speech.talking) this.nextFidget = Math.max(this.nextFidget, 8);
    if (this.current?.priority === PRIORITY.fidget && speech.talking) this.interrupt();

    if (!this.current) {
      const next = this.takeNext(speech.talking);
      if (next) {
        const reach = next.type === "stunt" && STUNT_REACH[next.name];
        const { x, z } = loco.root.position;
        if (reach && loco.nav && !next.roomChecked && !loco.nav.clearAround(x, z, reach)) {
          // Not enough room here: walk to the nearest open spot first, then do the stunt.
          const room = loco.nav.roomFor(x, z, reach);
          this.queue.unshift({ ...next, roomChecked: true });
          if (room) this.queue.unshift({ type: "walk", point: [room.x, room.y], name: "make_room", priority: next.priority });
          this.nextFidget = Math.max(this.nextFidget, 6);
        } else {
          this.startFade();
          this.current = { ...next, elapsed: 0, fired: new Set() };
          if (this.current.type === "stunt") this.onMarker?.(this.current.name, "start");
          if (this.current.type === "walk") {
            const ok = this.current.point ? loco.walkToPoint(...this.current.point, this.current.pace) : loco.walkTo(this.current.spot);
            if (!ok) this.current = null;
          }
        }
      }
    }

    // Weight shifts from leg to leg every few seconds while he stands.
    if ((this.nextWeight -= dt) <= 0) {
      this.weightTarget = (this.weightTarget > 0 ? -1 : 1) * (0.4 + Math.random() * 0.6);
      this.nextWeight = 5 + Math.random() * 7;
    }
    const standing = loco.walkWeight < 0.1 && !this.current;
    this.weight += ((standing ? this.weightTarget : 0) - this.weight) * Math.min(1, dt * 0.9);

    // Beat gestures start on stressed syllables, never the same one twice in a row.
    const open = speech.mouth?.open ?? speech.level ?? 0;
    if (speech.talking && !this.current && open > 0.5 && this.lastOpen <= 0.5 && t - this.beatAt > 0.9 && Math.random() < 0.55) {
      let type;
      do type = Math.floor(Math.random() * BEATS.length);
      while (type === this.lastBeatType);
      this.lastBeatType = type;
      this.beatAt = t;
      this.beat = { type, e: 0, dur: 0.9 + Math.random() * 0.5 };
    }
    this.lastOpen = open;
    if (this.beat) {
      const u = (t - this.beatAt) / this.beat.dur;
      if (u >= 1 || !speech.talking) this.beat = null;
      else this.beat.e = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8;
    }

    const p = {};
    const look = this.lookAt(speech.camera, dt);
    basePose(p, t, { ...speech, walk: loco.walkWeight, phase: loco.phase, stride: loco.stride, inPlace: loco.inPlace, stepLength: loco.stepLength, look, beat: this.beat, weight: this.weight }, this.dims);

    let facingTarget = 0;
    this.spin = 0;
    const cur = this.current;
    if (cur?.type === "walk") {
      if (!loco.update(dt)) this.current = null;
    } else if (cur?.type === "stunt") {
      loco.update(dt); // finishes any step or turn in progress
      const stunt = this.stunts[cur.name];
      cur.elapsed += dt;
      const e = cur.elapsed;
      const u = Math.min(1, e / stunt.duration);
      const w = Math.max(0, Math.min(1, e / 0.3, (stunt.duration - e) / 0.4));
      const s = { ...p };
      stunt.pose(s, u, t);
      for (const k of new Set([...Object.keys(p), ...Object.keys(s)])) {
        if (k !== "spin") p[k] = lerp(p[k] || 0, s[k] ?? 0, w);
      }
      this.spin = s.spin || 0;
      facingTarget = (stunt.facing || 0) * Math.max(0, Math.min(1, e / 0.35, (stunt.duration - e) / 0.45));
      for (const hit of stunt.impacts || []) {
        if (u >= hit.at && !cur.fired.has(hit)) {
          cur.fired.add(hit);
          this.onImpact?.(hit.strength);
        }
      }
      for (const at of stunt.flashes || []) {
        if (u >= at && !cur.fired.has(at)) {
          cur.fired.add(at);
          this.onFlash?.();
        }
      }
      for (const m of stunt.markers || []) {
        if (u >= m.at && !cur.fired.has(m)) {
          cur.fired.add(m);
          this.onMarker?.(cur.name, m.name);
        }
      }
      if (u >= 1) {
        this.current = null;
        this.startFade();
        this.onMarker?.(cur.name, "end");
      }
    } else {
      loco.update(dt);
    }
    this.facing = lerp(this.facing, facingTarget, Math.min(1, dt * 8));

    // Foot contacts: a heel strikes each time a leg's stance begins (see legSweep: the left at
    // phase pi/2, the right half a cycle later), so footsteps can be heard exactly as they land.
    const ph = loco.phase;
    if (this.prevPhase !== undefined && loco.walkWeight > 0.3) {
      for (const [foot, at] of [["L", Math.PI / 2], ["R", -Math.PI / 2]]) {
        if (Math.floor((ph - at) / TAU) !== Math.floor((this.prevPhase - at) / TAU)) this.onStep?.(foot, Math.min(1, loco.stride * loco.walkWeight), loco.inPlace);
      }
    }
    this.prevPhase = ph;

    // Crossfade from the pose he was in when the state changed.
    if (this.fade) {
      this.fade.t += dt;
      const k = ease(this.fade.t / CROSSFADE);
      if (k >= 1) this.fade = null;
      else for (const key of new Set([...Object.keys(p), ...Object.keys(this.fade.from)])) if (key !== "spin") p[key] = lerp(this.fade.from[key] ?? p[key] ?? 0, p[key] ?? 0, k);
    }
    this.lastPose = p;
    return p;
  }

  get yaw() {
    return this.locomotion.yaw + this.facing + this.spin;
  }
}
