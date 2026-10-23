import * as THREE from "three";
import { PRIORITY } from "./motion.js";
import { mist } from "./mist.js";
import { motes, additive, RING_FRAGMENT, Galaxy, Lion } from "./signatures.js";

// The five Halloween gift events. Each is staged in a real place of the cemetery (the pumpkins,
// the gate, the Doctor's apparatus by the gate, the courtyard), runs on the frame clock, waits
// for his actual animation moments (markers) for its climax, owns everything it changes and
// restores all of it when it ends, is cancelled or fails:
//   his position and animation, the camera, lights and exposure, fog, rain and wind, temporary
//   props and particles, the speech gate, and the hub cues the sound system follows.
// Beats, emitted as hub "signature" { event, beat, variant }: recognition (an immediate visual
// acknowledgment), anticipation (preparation and intent), development (the reveal building),
// climax, reaction (his personal reaction; speech is allowed again), decay (recovery), end; or cut.

const CANCEL = Symbol("cancelled");
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

// A tall, hooded spectral figure for the haunted gate: soft, cold, see-through.
// Painted as mist rather than a cut-out: a blurred hooded shape whose robe dissolves downwards
// into streaks, brighter at the edges of the hood like light through vapour, a void for a face
// with two faint points of light, and no hard outline anywhere.
function silhouetteTexture() {
  const W = 256;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const shape = new Path2D();
  shape.moveTo(128, 40);
  shape.bezierCurveTo(190, 38, 204, 130, 194, 182);
  shape.bezierCurveTo(226, 290, 236, 400, 222, 500);
  shape.lineTo(34, 500);
  shape.bezierCurveTo(20, 400, 30, 290, 62, 182);
  shape.bezierCurveTo(52, 130, 66, 38, 128, 40);
  // The body: several blurred passes, so the edge is a falloff, not a line.
  for (const [blur, alpha] of [[26, 0.35], [12, 0.4], [5, 0.35]]) {
    g.filter = `blur(${blur}px)`;
    g.fillStyle = `rgba(150,180,230,${alpha})`;
    g.fill(shape);
  }
  g.filter = "none";
  // Vapour streaks down the robe.
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 70; i++) {
    const x = 30 + Math.random() * 196;
    const y = 220 + Math.random() * 200;
    const len = 60 + Math.random() * 200;
    const grad = g.createLinearGradient(0, y, 0, y + len);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${0.25 + Math.random() * 0.35})`);
    g.fillStyle = grad;
    g.fillRect(x, y, 3 + Math.random() * 9, len);
  }
  // Fading out towards the ground.
  const fade = g.createLinearGradient(0, 300, 0, H);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = fade;
  g.fillRect(0, 300, W, H - 300);
  // The void of the hood.
  g.filter = "blur(10px)";
  g.fillStyle = "rgba(0,0,0,0.92)";
  g.beginPath();
  g.ellipse(128, 128, 34, 46, 0, 0, Math.PI * 2);
  g.fill();
  g.filter = "none";
  g.globalCompositeOperation = "lighter";
  // Light caught at the rim of the hood.
  g.filter = "blur(6px)";
  g.strokeStyle = "rgba(200,225,255,0.5)";
  g.lineWidth = 8;
  g.beginPath();
  g.ellipse(128, 132, 46, 58, 0, Math.PI * 1.05, Math.PI * 1.95);
  g.stroke();
  // Two faint points of light in the dark.
  for (const x of [114, 142]) {
    const eye = g.createRadialGradient(x, 126, 0, x, 126, 9);
    eye.addColorStop(0, "rgba(230,250,255,0.95)");
    eye.addColorStop(1, "rgba(150,200,255,0)");
    g.fillStyle = eye;
    g.fillRect(x - 10, 116, 20, 20);
  }
  g.filter = "none";
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The switch box of the apparatus, on a post inside the fence by the gate, wired under the fence
// to the coils. It is staged like a console: he stands behind it, between the box and the fence,
// facing the viewers with the coils behind him, and throws its lever during the Laboratory Surge.
export function buildApparatus(scene, { gate, fenceZ, ground, surfaceAt = null, coils, nav, center = [0.5, 0.6], path = null }) {
  // Placed off the path on free ground, where he can stand behind it and reach the lever
  // (checked before the box is put there).
  const free = (x, z) => !nav || nav.walkable(x, z);
  const reachable = (x, z) => free(x, z) && (!nav || !!nav.path(center[0], center[1], x, z));
  const offPath = (x) => !path || x < path.min - 0.25 || x > path.max + 0.25;
  // Nothing standing there already (no grave, post or wall under the box), and nothing tall
  // around it or around him (the hanging skeleton, a headstone) to crowd the shot.
  const empty = (x, z) => !surfaceAt || surfaceAt(x, z) - ground(x, z) < 0.12;
  const clear = (x, z, r) => empty(x, z) && [...Array(8).keys()].every((i) => empty(x + Math.sin((i * Math.PI) / 4) * r, z + Math.cos((i * Math.PI) / 4) * r));
  const coilX = (coils?.coils || []).map((c) => c.top.x);
  let spot = null;
  let best = Infinity;
  for (let dx = -3.2; dx <= 3.2; dx += 0.2) {
    for (let dz = 1.1; dz <= 2.3; dz += 0.15) {
      const x = gate.x + dx;
      const z = fenceZ + dz;
      if (!offPath(x) || !clear(x, z, 0.45)) continue;
      // The handle is on the back of the box (the side facing the fence); he stands behind it
      // where his right hand meets it.
      const stand = leverStand(x + 0.04, z - 0.11, reachable);
      if (!stand || !clear(stand.x, stand.z, 0.4)) continue;
      // In front of a coil (so it stands behind him in the shot), close to the fence.
      const score = (coilX.length ? Math.min(...coilX.map((cx) => Math.abs(cx - x))) : Math.abs(dx)) + (dz - 1.1) * 0.8;
      if (score < best) {
        best = score;
        spot = { x, z, stand };
      }
    }
  }
  if (!spot) return null;
  return makeApparatus(scene, { spot, fenceZ, ground, coils, nav });
}

// Where he stands to throw the lever at (hx, hz): facing it (and the camera beyond it), his
// right shoulder in line with the handle and his arm's reach (with a slight lean) from it.
function leverStand(hx, hz, reachable) {
  for (const turn of [0, 0.3, -0.3, 0.55, -0.55]) {
    const yaw = turn;
    for (const reach of [0.8, 0.88, 0.96]) {
      const x = hx - Math.sin(yaw) * reach + Math.cos(yaw) * 0.26;
      const z = hz - Math.cos(yaw) * reach - Math.sin(yaw) * 0.26;
      if (reachable(x, z)) return { x, z, yaw };
    }
  }
  return null;
}

// Painted surfaces for the apparatus, so it reads as an old laboratory instrument and not a
// grey box: pitted iron with rust runs and rivets, tarnished brass, and gauge faces.
function paint(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function speckle(g, w, h, n, colors, size = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[i % colors.length];
    g.globalAlpha = 0.15 + Math.random() * 0.35;
    const s = size * (0.5 + Math.random());
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  g.globalAlpha = 1;
}
const ironMap = () =>
  paint(256, 256, (g, w, h) => {
    g.fillStyle = "#2b2825";
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, 2600, ["#1c1a18", "#3b3631", "#4a3a2c"]);
    // Rust running down from the seams and rivets.
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h * 0.5;
      const grad = g.createLinearGradient(0, y, 0, y + 40 + Math.random() * 120);
      grad.addColorStop(0, "rgba(120,62,30,0.55)");
      grad.addColorStop(1, "rgba(90,45,20,0)");
      g.fillStyle = grad;
      g.fillRect(x, y, 2 + Math.random() * 6, 160);
    }
    // A seam and rivets round the edge.
    g.strokeStyle = "rgba(10,9,8,0.8)";
    g.lineWidth = 3;
    g.strokeRect(10, 10, w - 20, h - 20);
    for (let i = 0; i < 8; i++) {
      for (const [rx, ry] of [[20 + (i * (w - 40)) / 7, 20], [20 + (i * (w - 40)) / 7, h - 20], [20, 20 + (i * (h - 40)) / 7], [w - 20, 20 + (i * (h - 40)) / 7]]) {
        const r = g.createRadialGradient(rx - 1.5, ry - 1.5, 0.5, rx, ry, 5);
        r.addColorStop(0, "#77706a");
        r.addColorStop(1, "#1a1816");
        g.fillStyle = r;
        g.beginPath();
        g.arc(rx, ry, 4.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
const brassMap = () =>
  paint(256, 256, (g, w, h) => {
    const base = g.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, "#a8834a");
    base.addColorStop(0.5, "#8c6a38");
    base.addColorStop(1, "#a07c44");
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, 1800, ["#5d4a2a", "#c9a66a", "#4e6a52"], 3); // tarnish and verdigris
    g.strokeStyle = "rgba(60,44,20,0.7)";
    g.lineWidth = 4;
    g.strokeRect(6, 6, w - 12, h - 12);
  });
const gaugeMap = () =>
  paint(128, 128, (g, w) => {
    const c = w / 2;
    const face = g.createRadialGradient(c, c, 4, c, c, c);
    face.addColorStop(0, "#efe6cf");
    face.addColorStop(0.85, "#cfc2a0");
    face.addColorStop(1, "#6b5530");
    g.fillStyle = face;
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#2a2218";
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * (0.75 + (i / 10) * 1.5);
      g.lineWidth = i % 5 ? 1.5 : 3;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (c - 10), c + Math.sin(a) * (c - 10));
      g.lineTo(c + Math.cos(a) * (c - (i % 5 ? 18 : 24)), c + Math.sin(a) * (c - (i % 5 ? 18 : 24)));
      g.stroke();
    }
    // The danger end of the scale.
    g.strokeStyle = "rgba(160,30,20,0.85)";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(c, c, c - 14, Math.PI * 1.85, Math.PI * 2.25);
    g.stroke();
  });

function makeApparatus(scene, { spot, fenceZ, ground, coils, nav }) {
  const iron = new THREE.MeshStandardMaterial({ map: ironMap(), metalness: 0.75, roughness: 0.62 });
  const brass = new THREE.MeshStandardMaterial({ map: brassMap(), metalness: 0.9, roughness: 0.38 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
  const porcelain = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.25 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x334433, emissive: 0x66ff99, emissiveIntensity: 0, roughness: 0.2 });
  const dial = new THREE.MeshStandardMaterial({ map: gaugeMap(), roughness: 0.4, emissive: 0xffe2a0, emissiveIntensity: 0 });
  for (const m of [iron, brass, porcelain, glass, dial]) m.userData.wet = true;
  const { x, z } = spot;
  const y = ground(x, z);
  const group = new THREE.Group();
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.95, 0.1), iron);
  post.position.y = 0.475;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.48, 0.18), iron);
  box.position.set(0, 1.06, 0);
  // Local +z is his side (the lever); local -z faces the viewers (the gauges).
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.38, 0.02), brass);
  plate.position.set(0, 1.06, 0.095);
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 0.02), brass);
  front.position.set(0, 1.06, -0.095);
  // Two gauges on the viewers' side, whose needles climb as the coils charge.
  const needles = [];
  const faces = [];
  // One large dial and a small one, off-centre (two equal dials side by side read as eyes).
  for (const [gx, gy, r] of [[0.045, 1.13, 0.085], [-0.115, 1.2, 0.042]]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.01, r + 0.01, 0.02, 28), brass);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(gx, gy, -0.108);
    const face = new THREE.Mesh(new THREE.CircleGeometry(r, 28), dial);
    face.position.set(gx, gy, -0.12);
    face.rotation.y = Math.PI;
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.006, r * 0.85, 0.003), rubber);
    needle.geometry.translate(0, r * 0.38, 0);
    needle.position.set(gx, gy, -0.123);
    needles.push(needle);
    faces.push(face);
    group.add(rim, face, needle);
  }
  // A row of knife switches and knobs under the dials.
  for (let i = 0; i < 4; i++) {
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.025, 10), i % 2 ? porcelain : rubber);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(-0.12 + i * 0.065, 0.95, -0.115);
    group.add(knob);
  }
  // Porcelain insulators on top, where the cables leave the box.
  for (const ix of [-0.12, 0.12]) {
    const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.07, 12), porcelain);
    ins.position.set(ix, 1.335, 0.02);
    group.add(ins);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.032, 14, 10), glass);
  lamp.position.set(0.13, 1.25, -0.11); // a pilot lamp in the top corner
  const cage = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.005, 6, 16), brass);
  cage.position.copy(lamp.position);
  // The lever turns about a pin on his side of the box; raised, it stands up over the top.
  const pivot = new THREE.Group();
  pivot.position.set(-0.04, 1.06, 0.12);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.42, 8), brass);
  arm.position.y = 0.21;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.13, 10), rubber);
  handle.rotation.z = Math.PI / 2;
  handle.position.y = 0.42;
  pivot.add(arm, handle);
  group.add(post, box, plate, front, lamp, cage, pivot);
  group.traverse((m) => {
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  group.position.set(x, y, z);
  group.rotation.y = Math.PI; // its face and lever towards the fence, where he stands
  scene.add(group);
  // The cable from the box down the post, along the ground beside where he stands, under the
  // fence to each coil.
  const cables = [];
  for (const c of coils?.coils || []) {
    const side = Math.sign(c.top.x - x) || 1;
    const top = new THREE.Vector3(x + side * 0.065, y + 0.85, z);
    const pts = [top, new THREE.Vector3(x + side * 0.07, y + 0.06, z), new THREE.Vector3(x + side * 0.55, ground(x + side * 0.55, z - 0.4) + 0.03, z - 0.4), new THREE.Vector3(x + (c.top.x - x) * 0.5, ground(x, fenceZ) + 0.04, fenceZ - 0.15), new THREE.Vector3(c.top.x, ground(c.top.x, c.top.z) + 0.05, c.top.z + 0.1)];
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.018, 6, false), rubber);
    tube.castShadow = false;
    tube.receiveShadow = true;
    scene.add(tube);
    cables.push(curve);
  }
  nav?.block(x, z, 0.2);
  const UP = -0.6;
  const DOWN = 1.7;
  let angle = UP;
  const apparatus = {
    group,
    cables,
    lamp: glass,
    position: new THREE.Vector3(x, y, z),
    stand: spot.stand, // where he stands to throw the lever (checked when the box was placed)
    handleWorld: () => handle.getWorldPosition(new THREE.Vector3()),
    setLever(k) {
      angle = UP + (DOWN - UP) * clamp01(k);
      pivot.rotation.x = angle;
    },
    get lever() {
      return (angle - UP) / (DOWN - UP);
    },
    // 0..1: the gauges climb (with a nervous tremble near the top) and their faces light up.
    setCharge(k) {
      needles.forEach((n, i) => (n.rotation.z = 2.3 - 3.5 * clamp01(k) * (i ? 0.94 : 1) - (k > 0.6 ? Math.random() * 0.12 : 0)));
      dial.emissiveIntensity = 0.5 * clamp01(k);
    },
  };
  apparatus.setLever(0);
  apparatus.setCharge(0);
  return apparatus;
}

// Where each event takes place, worked out from the map: a standing place he can walk to from
// the middle of the cemetery, which way he faces there, and what he looks at.
export function eventLocations({ environment, spots, ground, nav, apparatus, gate, fenceZ }) {
  // The middle of the cemetery, moved to the nearest place he can stand (like his own spots).
  const raw = spots.center?.at || [0.5, 0.6];
  const c2 = nav ? nav.nearest(raw[0], raw[1]) : { x: raw[0], y: raw[1] };
  const center = v3(c2.x, ground(c2.x, c2.y), c2.y);
  const reachable = (x, z) => nav ? nav.walkable(x, z) && !!nav.path(center.x, center.z, x, z) : true;
  const standNear = (target, radius, preferYaw) => {
    // Candidate places around the target, preferring the side facing the camera (+z).
    let best = null;
    for (const r of [radius, radius + 0.25, radius - 0.15, radius + 0.5]) {
      for (let i = 0; i < 16; i++) {
        const a = preferYaw + ((i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI) / 8;
        const x = target.x + Math.sin(a) * r;
        const z = target.z + Math.cos(a) * r;
        if (reachable(x, z)) {
          best = v3(x, ground(x, z), z);
          break;
        }
      }
      if (best) break;
    }
    return best && { stand: best, yaw: yawTo(best, target), target };
  };
  const out = { center: { stand: center, yaw: 0, target: center.clone().add(v3(0, 0, 2)) } };
  // The pumpkin display: a glowing jack-o'-lantern near the pumpkin patch. They all sit along the
  // fences, so facing one squarely would put his back to every camera that fits inside: he stands
  // beside it instead, turned partly towards the courtyard, and leans his ear to it, where a camera
  // in front of him still has room.
  const patch = spots.pumpkins?.at;
  const lights = environment?.pumpkins || [];
  const gb = environment?.groundBox;
  const inside = (x, z) => !gb || (x > gb.min.x + 0.5 && x < gb.max.x - 0.5 && z > gb.min.z + 0.6 && z < 4.6);
  if (patch && lights.length) {
    let best = null;
    for (const light of lights) {
      const target = v3(light.position.x, ground(light.position.x, light.position.z), light.position.z);
      const n = v3(center.x - target.x, 0, center.z - target.z).normalize(); // into the courtyard
      for (const side of [1, -1]) {
        const t = v3(-n.z * side, 0, n.x * side);
        const x = target.x + t.x * 0.7 + n.x * 0.35;
        const z = target.z + t.z * 0.7 + n.z * 0.35;
        if (!reachable(x, z)) continue;
        const stand = v3(x, ground(x, z), z);
        const toLight = v3(target.x - x, 0, target.z - z).normalize();
        for (const w of [0.4, 0.55, 0.7]) {
          const f = toLight.clone().multiplyScalar(1 - w).addScaledVector(n, w).normalize();
          const yaw = Math.atan2(f.x, f.z);
          if (![0, 0.25, -0.25].some((a) => inside(x + Math.sin(yaw + a) * 2.8, z + Math.cos(yaw + a) * 2.8))) continue;
          const score = Math.acos(Math.min(1, f.dot(toLight))) + 0.12 * Math.hypot(target.x - patch[0], target.z - patch[1]);
          if (!best || score < best.score) best = { score, stand, yaw, target, light };
          break; // the least turned-away facing that fits
        }
      }
    }
    if (best) out.pumpkin = { stand: best.stand, yaw: best.yaw, target: best.target, light: best.light };
  }
  // The gate: a little to one side of the path, so his face turns towards the camera as well as the gate.
  if (gate) {
    const target = v3(gate.x, ground(gate.x, fenceZ + 0.2), fenceZ);
    const place = standNear(target, 1.25, 0.55);
    if (place) out.gate = place;
  }
  // The apparatus: the standing place worked out when the box was placed.
  if (apparatus?.stand) {
    const s = apparatus.stand;
    out.lever = { stand: v3(s.x, ground(s.x, s.z), s.z), yaw: s.yaw, target: apparatus.handleWorld() };
  }
  return out;
}

// ----------------------------------------------------------------------------------------

class GiftEvent {
  constructor(director, run) {
    this.d = director;
    this.ctx = director.ctx;
    this.run = run;
    this.type = run.type;
    this.t = 0;
    this.waits = [];
    this.cleanups = [];
    this.markers = new Set();
    this.layers = [];
    this.cancelled = false;
  }

  // --- the frame clock ---
  wait(seconds) {
    const until = this.t + seconds;
    return this.until(() => this.t >= until);
  }

  // Resolves true when `cond` holds, false at the timeout; rejects if the event is cancelled.
  until(cond, timeout = Infinity) {
    if (this.cancelled) return Promise.reject(CANCEL);
    if (cond()) return Promise.resolve(true);
    return new Promise((resolve, reject) => this.waits.push({ cond, deadline: this.t + timeout, resolve, reject }));
  }

  marker(stunt, name) {
    this.markers.add(`${stunt}:${name}`);
    this.markers.add(name);
    for (const l of this.layers) l.marker?.(stunt, name);
  }

  saw(name) {
    return this.markers.has(name);
  }

  tick(dt, t) {
    this.t += dt;
    for (const w of [...this.waits]) {
      if (w.cond()) {
        this.waits.splice(this.waits.indexOf(w), 1);
        w.resolve(true);
      } else if (this.t >= w.deadline) {
        this.waits.splice(this.waits.indexOf(w), 1);
        w.resolve(false);
      }
    }
    this.frame?.(dt, t);
    this.layers = this.layers.filter((l) => {
      if (l.update(dt, t)) return true;
      l.restore();
      return false;
    });
  }

  cancel() {
    this.cancelled = true;
    for (const w of this.waits.splice(0)) w.reject(CANCEL);
  }

  // Registers how to undo something this event changed; undone in reverse order at the end.
  own(undo) {
    this.cleanups.push(undo);
  }

  // A temporary object in the scene, removed and disposed at the end.
  prop(object) {
    this.ctx.scene.add(object);
    this.own(() => {
      this.ctx.scene.remove(object);
      object.traverse?.((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
    });
    return object;
  }

  beat(name) {
    this.d.cue(this, name);
  }

  // --- staging helpers ---
  get avatar() {
    return this.ctx.avatar;
  }

  perform(action) {
    this.avatar.perform(action, { priority: PRIORITY.gift });
    return this.until(() => this.avatar.current?.name === action, 6);
  }

  async finished(action, timeout = 12) {
    await this.until(() => this.avatar.current?.name === action, 3);
    return this.until(() => this.avatar.current?.name !== action, timeout);
  }

  // Walks to a validated place; true when he got there. A failed route leaves him where he is.
  // The camera waits out to one side of where he is going, level with it or a little beyond,
  // and watches him come, so a walk away from the audience is seen from the front, not as his back.
  async walkTo(place, timeout = 10) {
    const p = this.avatar.root.position;
    if (Math.hypot(p.x - place.stand.x, p.z - place.stand.z) < 0.35) return true;
    const loco = this.avatar.locomotion;
    const walking = () => this.avatar.current?.name === "event_walk";
    this.avatar.performer.walkToPoint(place.stand.x, place.stand.z, { priority: PRIORITY.gift, pace: 1.45 });
    await this.until(walking, 2);
    // For the last few metres (in the open by then, not behind the crypt), the approach shot.
    if (await this.until(() => !walking() || loco.remaining() < 3.2, timeout)) {
      if (walking() && loco.remaining() > 1.6) {
        const back = Math.atan2(p.x - place.stand.x, p.z - place.stand.z); // from where he is going, back to him
        const head = () => this.avatar.root.position.clone().add(v3(0, 1.7, 0));
        // Never somewhere his route passes close by (he'd fill the lens and lose his head).
        const route = loco.route.map((q) => v3(q.x, 0, q.y));
        const roomy = (pos) => route.every((q) => Math.hypot(q.x - pos.x, q.z - pos.z) > 2);
        this.shot(place.stand, head(), { yaw: back, angles: [1.5, -1.5, 1.75, -1.75, 1.3, -1.3, 2.0, -2.0], dist: 2.6, height: 1.8, body: place.stand, track: head, accept: roomy });
      }
    }
    await this.until(() => !walking(), timeout);
    return Math.hypot(p.x - place.stand.x, p.z - place.stand.z) < 0.6;
  }

  // Resolves once he faces `yaw`. Safe to call without awaiting: a cancel doesn't surface as an
  // unhandled rejection here (the script's next wait stops it anyway).
  async face(yaw) {
    const loco = this.avatar.locomotion;
    loco.faceYaw = yaw;
    this.own(() => (loco.faceYaw = null));
    await this.until(() => Math.abs(Math.atan2(Math.sin(loco.yaw - yaw), Math.cos(loco.yaw - yaw))) < 0.08, 2.5).catch((e) => {
      if (e !== CANCEL) throw e;
    });
  }

  // A camera shot around a subject: the first candidate angle (relative to the way he faces)
  // that is inside the cemetery, unobstructed and clear of foliage; otherwise the normal camera.
  shot(subject, look, { yaw = this.avatar.locomotion.yaw, angles = [0.6, -0.6, 0.95, -0.95, 0.3, -0.3, 1.3, -1.3], dist = 3.1, height = 1.9, fov, track, body = this.avatar.root.position, accept = () => true } = {}) {
    const started = performance.now();
    const report = (ok, i) => {
      const ms = performance.now() - started;
      if (ms > 12 || !ok) this.ctx.log?.(`${this.type} shot: ${ok ? `angle ${i + 1}` : "no clear angle, normal camera"} (${ms.toFixed(0)} ms)`);
      return ok;
    };
    for (const [i, a] of angles.entries()) {
      const pos = v3(subject.x + Math.sin(yaw + a) * dist, subject.y + height, subject.z + Math.cos(yaw + a) * dist);
      const ok = accept(pos) && this.ctx.cameraRig.set({ pos, look, fov, subject: body, track });
      if (ok) {
        this.own(() => this.ctx.cameraRig.clear());
        return report(true, i);
      }
    }
    return report(false);
  }

  // His head, roughly, for looking at.
  head(lift = 1.95) {
    return this.avatar.root.position.clone().add(v3(0, lift, 0));
  }

  // Queued at once: a walk below gift priority already waits while he talks (Performer.takeNext).
  // (It used to wait on this event's frame clock, which stops when the event ends, so a line
  // playing at that moment left him standing at the gate or the apparatus.)
  returnToAudience() {
    const c = this.d.locations.center;
    const p = this.avatar.root.position;
    if (!c || Math.hypot(p.x - c.stand.x, p.z - c.stand.z) < 1.2) return;
    this.avatar.performer.walkToPoint(c.stand.x, c.stand.z, { priority: PRIORITY.command, name: "return_walk" });
  }

  restore() {
    for (const l of this.layers.splice(0)) l.restore();
    for (const undo of this.cleanups.splice(0).reverse()) {
      try {
        undo();
      } catch (error) {
        console.warn("Event cleanup failed", error);
      }
    }
  }
}

// 30+ coins. A spark at his neck: his shoulders jump, his hand goes to the bolt, the candles
// nearby flicker in answer, and he shrugs it off with a grin. About 3.5 s, where he stands.
class BoltSpark extends GiftEvent {
  async script() {
    const { avatar, sparks, environment, arcs } = this.ctx;
    this.beat("recognition");
    if (avatar.neckBolts) sparks.fire(() => avatar.neckBolts(), 0.5);
    environment?.flare(0.35);
    this.shot(avatar.root.position, this.head(1.9), { yaw: 0, angles: [0.25, -0.25, 0.5, -0.5], dist: 2.6, height: 2.05 });
    this.beat("anticipation");
    await this.perform("twitch");
    this.d.holdSpeech(this, true);
    this.beat("development");
    await this.until(() => this.saw("spark"), 2);
    if (avatar.neckBolts) {
      sparks.fire(() => avatar.neckBolts(), 1.4);
      const [l, r] = avatar.neckBolts();
      for (let i = 0; i < 3; i++) arcs.zap(l.clone(), r.clone().add(v3(0, 0.05 * i, 0)), 0.12, 0.2);
    }
    await this.until(() => this.saw("climax"), 2);
    this.beat("climax");
    environment?.flare(0.8);
    this.d.flickerLamps(this, avatar.root.position, 4, 0.9);
    await this.until(() => this.saw("settle"), 2);
    this.beat("reaction");
    this.d.holdSpeech(this, false);
    await this.finished("twitch", 3);
    this.beat("decay");
    await this.wait(0.4);
  }
}

// 100+ coins. He walks over to the pumpkin display and leans in to listen; its carved face
// glows brighter and orange motes curl up from it; it whispers, he jerks upright, then laughs.
class PumpkinWhisper extends GiftEvent {
  async script() {
    const place = this.d.locations.pumpkin;
    const { environment } = this.ctx;
    const light = place.light;
    const base = light.intensity;
    let glow = 1;
    this.frame = () => {
      // The lantern's own flicker (env.js) runs first; this scales its light on top.
      light.intensity *= glow;
    };
    this.own(() => (this.frame = null));
    this.beat("recognition");
    glow = 1.8;
    environment?.flare(0.3);
    await this.d.waitForQuiet(this);
    this.d.holdSpeech(this, true);
    this.beat("anticipation");
    glow = 1.3;
    const arrived = await this.walkTo(place);
    // He turns to the lantern as he starts to lean in (not first, then lean: that dragged).
    this.face(arrived ? place.yaw : yawTo(this.avatar.root.position, place.target));
    // From in front of him: his face as he leans in to listen, the glowing lantern low beside him.
    const me = this.avatar.root.position.clone();
    // (Framed with room above him for when he jerks upright, under TikTok's top bar.)
    const look = me.clone().add(v3(0, 1.6, 0)).lerp(place.target.clone().add(v3(0, 0.4, 0)), 0.25);
    this.shot(me, look, { yaw: place.yaw, angles: [0, 0.25, -0.25, 0.45, -0.45, 0.65, -0.65], dist: 3.1, height: 1.65 });
    const swirl = this.prop(motes(140, { color: 0xffa040, size: 0.07, height: 1.1, rise: 1, spread: 0.22 }));
    const su = swirl.material.uniforms;
    su.center.value.copy(place.target).add(v3(0, 0.2, 0));
    await this.perform("listen");
    this.beat("development");
    let alpha = 0;
    this.frame = (dt, t) => {
      su.time.value = t;
      su.alpha.value = alpha;
      light.intensity *= glow;
    };
    await this.until(() => this.saw("listen"), 3);
    for (let i = 0; i < 30 && !this.saw("climax"); i++) {
      alpha = Math.min(0.9, alpha + 0.05);
      glow = Math.min(3, glow + 0.06);
      await this.wait(0.05);
    }
    await this.until(() => this.saw("climax"), 4);
    this.beat("climax");
    glow = 4.5;
    su.burst.value = 0.6;
    environment?.flare(0.6);
    await this.until(() => this.saw("reaction"), 2);
    this.beat("reaction");
    this.d.holdSpeech(this, false);
    // The glow dies away through his chuckle; the event ends with the chuckle.
    for (let i = 0; i < 16; i++) {
      glow = 1 + (glow - 1) * 0.82;
      alpha *= 0.86;
      await this.wait(0.06);
    }
    this.beat("decay");
    await this.finished("listen", 1.5);
    glow = 1;
    light.intensity = base;
    this.returnToAudience();
    await this.wait(0.4);
  }
}

// 500+ coins. He walks to the gate; the lamps by it gutter, the gate creaks, a hooded spectral
// figure gathers behind the bars and a ribbon of bats pours over the fence; he recoils, then
// straightens his lapels with great dignity.
class HauntedGate extends GiftEvent {
  async script() {
    const place = this.d.locations.gate;
    const { bats, environment } = this.ctx;
    this.beat("recognition");
    this.d.flickerLamps(this, place.target, 3, 0.6);
    mist.flash.value = Math.max(mist.flash.value, 0.05);
    await this.d.waitForQuiet(this);
    this.d.holdSpeech(this, true);
    this.beat("anticipation");
    // He walks up to the gate, peers through the bars while the lamps gutter, sees nothing, and
    // turns back to the viewers.
    const arrived = await this.walkTo(place);
    this.face(arrived ? place.yaw : yawTo(this.avatar.root.position, place.target)); // he squares up to it as he peers
    this.d.flickerLamps(this, place.target, 3, 1.2);
    await this.wait(0.9);
    const me = this.avatar.root.position.clone();
    const away = Math.atan2(me.x - place.target.x, me.z - place.target.z); // from the gate through him
    await this.face(away);
    // A portrait frame is narrow, so the shot is in depth: him in front, facing the camera, the
    // gate behind him and a little to one side, where the figure will appear over his shoulder.
    const look = me.clone().add(v3(0, 1.6, 0)).lerp(place.target.clone().add(v3(0, 1.4, 0)), 0.22);
    this.shot(me, look, { yaw: away, angles: [0.5, -0.5, 0.36, -0.36, 0.7, -0.7], dist: 3.2, height: 1.75 });
    // The figure, in the gateway just behind the bars, cold and bright enough to read on a phone.
    const tex = silhouetteTexture();
    const figure = this.prop(new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.7), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.7, 1.9, 2.3), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    this.own(() => tex.dispose());
    figure.position.copy(place.target).add(v3(0, 1.35, -0.45));
    await this.perform("gate_turn");
    this.beat("development");
    let show = 0;
    let lunge = 0;
    this.frame = (dt, t) => {
      figure.lookAt(this.ctx.camera.position.x, figure.position.y, this.ctx.camera.position.z);
      figure.material.opacity = 0.85 * show * (0.85 + 0.15 * Math.sin(t * 7));
      figure.position.z = place.target.z - 0.45 + 0.3 * lunge;
      figure.position.x = place.target.x + Math.sin(t * 1.3) * 0.05;
      figure.scale.setScalar(1 + 0.15 * lunge);
    };
    // It gathers while he stands unaware; the creak is when he feels it.
    for (let i = 0; i < 30 && !this.saw("climax"); i++) {
      show = Math.min(1, show + 0.04);
      await this.wait(0.05);
    }
    await this.until(() => this.saw("climax"), 4);
    this.beat("climax");
    lunge = 1;
    show = 1;
    bats?.swarm(place.target.clone().add(v3(0, 1.6, -2.5)), 14);
    environment?.flare(0.4);
    this.d.flickerLamps(this, place.target, 3, 0.9);
    this.ctx.shake?.(0.25);
    for (let i = 0; i < 14; i++) {
      show *= 0.8;
      await this.wait(0.05);
    }
    show = 0;
    await this.until(() => this.saw("reaction"), 3);
    this.beat("reaction");
    this.d.holdSpeech(this, false);
    await this.finished("gate_turn", 4);
    this.beat("decay");
    this.returnToAudience();
    await this.wait(0.6);
  }
}

// 1,000+ coins. He walks to the apparatus and throws its switch; the energy crawls along the
// cables to the coils, the candles dim as the power is drawn, the coils charge and crackle and
// discharge into the bolts in his neck; he looks at his hands, amazed. The Galaxy variant
// opens the night sky over the courtyard as the energy lands.
class LabSurge extends GiftEvent {
  async script() {
    const place = this.d.locations.lever;
    const { apparatus, coils, arcs, bolts, environment, lighting, sparks, avatar } = this.ctx;
    const crown = coils.crown;
    this.own(() => {
      crown.emissiveIntensity = 0;
      apparatus.lamp.emissiveIntensity = 0;
      apparatus.setCharge(0);
      environment?.power?.(1);
    });
    this.beat("recognition");
    crown.emissiveIntensity = 0.5;
    apparatus.lamp.emissiveIntensity = 1.2;
    await this.d.waitForQuiet(this);
    this.d.holdSpeech(this, true);
    this.beat("anticipation");
    const arrived = await this.walkTo(place);
    await this.face(place.yaw);
    // From the audience's side: him behind the switch box like a console, the coils behind him.
    const me = avatar.root.position.clone();
    const mid = me.clone().lerp(apparatus.position, 0.35);
    this.shot(me, mid.add(v3(0, 1.45, 0)), { yaw: place.yaw, angles: [0.3, -0.3, 0.5, -0.5, 0.12, -0.12, 0.75, -0.75], dist: 3.3, height: 1.75 });
    this.own(() => this.d.springLever());
    if (!arrived) apparatus.setLever(0);
    await this.perform("activate");
    this.beat("development");
    // The lever follows his hand: up until the grip, down through the pull.
    this.frame = () => {
      const cur = avatar.current;
      if (cur?.name === "activate") {
        const u = cur.elapsed / 4.4;
        apparatus.setLever(smooth((u - 0.27) / 0.18));
      }
    };
    await this.until(() => this.saw("lever"), 4);
    apparatus.setLever(1);
    this.frame = null;
    // Energy runs along each cable to its coil, then the coils charge.
    let charge = 0;
    this.frame = () => {
      crown.emissiveIntensity = (0.4 + 2.8 * charge) * (0.8 + Math.random() * 0.4);
      apparatus.lamp.emissiveIntensity = 1.5 + 2 * charge;
      apparatus.setCharge(charge);
    };
    environment?.power?.(0.45);
    for (let i = 0; i <= 10; i++) {
      for (const curve of apparatus.cables) {
        const a = curve.getPoint(i / 10);
        const b = curve.getPoint(Math.min(1, i / 10 + 0.12));
        arcs.zap(a, b, 0.12, 0.25);
      }
      await this.wait(0.1);
    }
    for (let i = 0; i < 16; i++) {
      charge = (i + 1) / 16;
      const [a, b] = coils.coils;
      if (i % 2 === 0) arcs.zap(a.top, b.top, 0.14, 0.1);
      for (const c of coils.coils) if (Math.random() < 0.6) arcs.zap(c.top, c.top.clone().add(v3((Math.random() - 0.5) * 0.8, 0.3, (Math.random() - 0.5) * 0.8)), 0.08, 0.2);
      await this.wait(0.1);
    }
    this.beat("climax");
    const neck = () => {
      const bp = avatar.neckBolts?.();
      return bp ? bp[0].clone().lerp(bp[1], 0.5) : this.head(2.1);
    };
    for (const c of coils.coils) bolts?.strike(neck(), { from: c.top.clone(), color: 0xbfe0ff });
    lighting?.strike(0.6);
    environment?.power?.(1);
    environment?.flare(1.2);
    this.ctx.shake?.(0.45);
    if (avatar.neckBolts) sparks.fire(() => avatar.neckBolts(), 2.5);
    const galaxy = this.run.variant === "galaxy";
    if (galaxy) {
      // The energy goes on up into the sky and opens it, inside the event's own climax and
      // reaction. The trees overhang the apparatus, so once the bolts have struck the camera cuts
      // to the front of the courtyard, where the sky shows above the treeline, and the galaxy is
      // placed for that view, on a quicker timeline than on its own.
      await this.wait(0.8);
      const me = avatar.root.position;
      this.shot(me, me.clone().add(v3(0, 2.6, 0)), { yaw: 0, angles: [0.1, -0.1, 0.22, -0.22, 0.35, -0.35], dist: 8.6, height: 1.45, fov: 62 });
      await this.wait(0.1);
      const timing = { anticipation: 0.3, development: 0.9, earliest: 1.8, latest: 2.6, reaction: 0.6, decay: 1.8, end: 3.8 };
      this.layers.push(new Galaxy(this.ctx, { timing }, (beat) => this.d.cue(this, beat, "galaxy", { layer: true })));
    }
    await this.finished("activate", 3);
    this.beat("reaction");
    this.d.holdSpeech(this, false);
    if (galaxy) {
      // The galaxy peaks on its own quick timeline (by `latest`) while he looks up, then at his
      // hands; the coils die down alongside.
      (async () => {
        for (let i = 0; i < 20; i++) {
          charge *= 0.85;
          await this.wait(0.08);
        }
      })().catch(() => {});
      avatar.perform("glance_up", { priority: PRIORITY.gift });
      avatar.perform("look_hands", { priority: PRIORITY.gift });
      await this.until(() => !this.layers.length, 5);
      this.beat("decay");
      await this.finished("look_hands", 1.5);
      this.returnToAudience();
      await this.wait(0.3);
      return;
    } else {
      avatar.perform("look_hands", { priority: PRIORITY.gift });
      for (let i = 0; i < 20; i++) {
        charge *= 0.85;
        await this.wait(0.08);
      }
      this.beat("decay");
    }
    await this.finished("look_hands", 6);
    this.returnToAudience();
    await this.wait(0.5);
  }
}

// 3,000+ coins. The courtyard storm: thunder rolls, the rain thickens, the candles dim as the
// apparatus powers up and arcs leap between the coils and into him; he goes through the whole
// reanimation, and as he rises both coils discharge; then he raises his arms into the
// aftermath: the rain eases, the mist glows, the stars come out and the candles burn warm,
// before everything settles back to the ordinary night. The Lion variant brings the spectral
// lion, roaring with him.
class GrandReanimation extends GiftEvent {
  async script() {
    const { coils, arcs, bolts, environment, lighting, sky, weather, avatar, sparks } = this.ctx;
    const crown = coils?.crown;
    this.own(() => {
      if (crown) crown.emissiveIntensity = 0;
      environment?.power?.(1);
      lighting?.setAura?.(0);
      sky?.setStars?.(1);
      weather?.setStorm(0);
      this.d.apparatusActive = false;
    });
    this.beat("recognition");
    lighting?.strike(0.35);
    if (crown) crown.emissiveIntensity = 0.5;
    await this.d.waitForQuiet(this);
    this.d.holdSpeech(this, true);
    this.beat("anticipation");
    weather?.setStorm(1);
    await this.walkTo(this.d.locations.center, 8);
    await this.face(0);
    // Wide, from the front edge of the courtyard (the camera can't go further back), with the
    // lens opened up so the coils, the fence and the storm sky are in the frame behind him.
    this.shot(avatar.root.position, this.head(1.75), { yaw: 0, angles: [0, 0.2, -0.2, 0.4, -0.4], dist: 4.1, height: 1.9, fov: 60 });
    this.beat("development");
    this.d.apparatusActive = true;
    let charge = 0;
    let arcing = true;
    this.frame = (dt) => {
      if (crown) crown.emissiveIntensity = (0.5 + 2.6 * charge) * (0.8 + Math.random() * 0.4);
      if (arcing && coils && Math.random() < dt * (3 + 10 * charge)) {
        const [a, b] = coils.coils;
        arcs.zap(a.top, b.top, 0.14, 0.1);
        if (charge > 0.4 && Math.random() < 0.5) {
          const bp = avatar.neckBolts?.();
          if (bp) arcs.zap(coils.coils[Math.random() < 0.5 ? 0 : 1].top, bp[0].clone().lerp(bp[1], 0.5), 0.1, 0.08);
        }
      }
    };
    environment?.power?.(0.35);
    await this.perform("reanimate");
    for (let i = 0; i < 30 && !this.saw("reanimate:climax"); i++) {
      charge = Math.min(1, charge + 0.04);
      await this.wait(0.1);
    }
    await this.until(() => this.saw("reanimate:climax"), 5);
    this.beat("climax");
    arcing = false;
    const neck = () => {
      const bp = avatar.neckBolts?.();
      return bp ? bp[0].clone().lerp(bp[1], 0.5) : this.head(2.1);
    };
    if (coils) for (const c of coils.coils) bolts?.strike(neck(), { from: c.top.clone(), color: 0xbfe0ff });
    lighting?.strike(1);
    environment?.power?.(1.15);
    environment?.flare(2);
    this.ctx.shake?.(0.6);
    if (avatar.neckBolts) sparks.fire(() => avatar.neckBolts(), 3);
    const ring = this.prop(new THREE.Mesh(new THREE.PlaneGeometry(14, 14), additive(RING_FRAGMENT, { progress: { value: 0.14 }, alpha: { value: 1.6 }, color: { value: new THREE.Color(0.7, 1.1, 1.6) } })));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(avatar.root.position).add(v3(0, 0.06, 0));
    const ringStart = this.t;
    this.frame = (dt) => {
      ring.material.uniforms.progress.value = 0.14 + 0.86 * clamp01((this.t - ringStart) / 1.2);
      if (crown) crown.emissiveIntensity *= 0.94;
      charge *= 0.97;
    };
    await this.finished("reanimate", 5);
    // The aftermath.
    this.beat("reaction");
    weather?.setStorm(0);
    if (this.run.variant === "lion") this.layers.push(new Lion(this.ctx, {}, (beat) => this.d.cue(this, beat, "lion", { layer: true })));
    // Low and a little closer as he raises his arms into the aftermath (room above for the hands).
    this.shot(avatar.root.position, this.head(1.85), { yaw: 0, angles: [0.18, -0.18, 0, 0.35, -0.35], dist: 3.9, height: 1.25, fov: 58 });
    await this.perform("celebrate");
    const glowStart = this.t;
    this.frame = () => {
      const k = smooth((this.t - glowStart) / 2) * (1 - smooth((this.t - glowStart - 6) / 3));
      lighting?.setAura?.(0.28 * k, 0xbfd0ff); // stronger washed the wet paving out like snow
      sky?.setStars?.(1 + 1.6 * k);
      mist.flash.value = Math.max(mist.flash.value, 0.06 * k);
    };
    await this.until(() => this.saw("celebrate:climax"), 6);
    this.d.holdSpeech(this, false);
    await this.finished("celebrate", 6);
    this.beat("decay");
    await this.wait(2.5);
    if (this.layers.length) await this.until(() => !this.layers.length, 6);
  }
}

const EVENTS = { bolt: BoltSpark, pumpkin: PumpkinWhisper, gate: HauntedGate, lab: LabSurge, grand: GrandReanimation };
const LOCATION_OF = { pumpkin: "pumpkin", gate: "gate", lab: "lever" };

// Runs one event at a time; at most three wait behind it. Beyond that, waiting events are
// combined into one performance of the highest of them, credited to everyone in it, so every
// contributor is still acknowledged. Speech is held while an event is being performed and
// released at its reaction beat.
export class EventDirector {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = [];
    this.current = null;
    this.speechHeld = null;
    this.apparatusActive = false;
    this.locations = eventLocations(ctx);
    ctx.environment?.clearWisps?.([...Object.values(this.locations).map((l) => l.stand), ...(ctx.apparatus ? [ctx.apparatus.position] : [])], 1.6);
    this.available = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, true]));
    for (const [type, where] of Object.entries(LOCATION_OF)) if (!this.locations[where]) this.available[type] = false;
    if (!ctx.coils || !ctx.apparatus) this.available.lab = false;
    if (!ctx.coils) this.available.grand = false;
    this.lampFlicker = [];
  }

  order(type) {
    return Object.keys(EVENTS).indexOf(type);
  }

  play(run) {
    if (!EVENTS[run.type] || !this.available[run.type]) return false;
    if (this.queue.length >= 3) {
      // Combine everything waiting into one performance of the highest event among them.
      const all = [...this.queue, run];
      const top = all.reduce((a, b) => (this.order(b.type) > this.order(a.type) ? b : a));
      const users = all.flatMap((r) => r.users || [r.user]);
      this.queue = [{ ...top, id: `combined-${top.id}`, users, combined: users.length }];
      this.ctx.log?.(`Combined ${all.length} waiting events into one ${top.name} for ${users.length} supporters`);
    } else {
      this.queue.push(run);
    }
    this.publishQueue();
    return true;
  }

  publishQueue() {
    const brief = (r) => r && { id: r.type, name: r.name, user: r.combined ? `${r.combined} supporters` : r.user?.nick };
    this.ctx.hub.emit("message", { t: "eventQueue", active: brief(this.current?.run), waiting: this.queue.map(brief), batched: this.queue.find((r) => r.combined)?.combined || 0, local: true });
  }

  // `layer`: a variant's own beats (the Galaxy over the Laboratory Surge) go to the hub for
  // sound and effects, but only the event's beats are written to the operator's log.
  cue(ev, beat, variant = ev.run.variant, { layer = false } = {}) {
    this.ctx.hub.emit("signature", { event: ev.type, beat, variant: variant || null, id: ev.run.id, layer });
    if (!layer && (beat === "climax" || beat === "end" || beat === "cut")) this.ctx.send?.({ t: "eventLog", text: `${ev.run.name}${variant ? ` (${variant})` : ""}: ${beat}${ev.run.audition ? " (audition)" : ""}` });
  }

  marker(stunt, name) {
    this.current?.marker(stunt, name);
  }

  // --- speech: held while he performs, so voices and walks never talk over each other ---
  holdSpeech(ev, on) {
    this.speechHeld = on ? ev : this.speechHeld === ev ? null : this.speechHeld;
  }

  speechBusy() {
    return !!this.ctx.speech?.talking;
  }

  speechGate() {
    if (!this.speechHeld) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => (!this.speechHeld ? resolve() : setTimeout(check, 80));
      check();
    });
  }

  // An event lets a line in progress finish (up to six seconds) before it walks anywhere.
  waitForQuiet(ev) {
    return ev.until(() => !this.speechBusy(), 6);
  }

  // The nearest candles gutter for a moment, then recover.
  flickerLamps(ev, at, count, seconds) {
    const lamps = [...(this.ctx.environment?.lamps || [])].sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at)).slice(0, count);
    const until = ev.t + seconds;
    const previous = ev.frame;
    const flicker = () => {
      if (ev.t > until) return;
      for (const l of lamps) l.intensity *= Math.random() < 0.5 ? 0.15 : 1.4;
    };
    ev.frame = (dt, t) => {
      previous?.(dt, t);
      flicker();
    };
  }

  springLever() {
    const a = this.ctx.apparatus;
    if (!a) return;
    const from = a.lever;
    let k = 0;
    const step = () => {
      k = Math.min(1, k + 0.04);
      a.setLever(from * (1 - smooth(k)));
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  update(dt, t) {
    if (!this.current && this.queue.length) this.start(this.queue.shift());
    this.current?.tick(dt, t);
  }

  start(run) {
    const ev = new EVENTS[run.type](this, run);
    ev.script = ev.script.bind(ev);
    this.current = ev;
    this.publishQueue();
    let cut = false;
    ev.script()
      .then(() => this.cue(ev, "end"))
      .catch((error) => {
        cut = true;
        if (error !== CANCEL) console.warn(`${run.name} failed`, error);
        this.cue(ev, "cut");
      })
      .finally(() => {
        ev.restore();
        this.holdSpeech(ev, false);
        if (this.current === ev) this.current = null;
        // Stopped part-way (by the operator, or because it failed): he walks back to the audience.
        const c = this.locations.center;
        const p = this.ctx.avatar.root.position;
        if (cut && c && Math.hypot(p.x - c.stand.x, p.z - c.stand.z) > 1.2) this.ctx.avatar.performer.walkToPoint(c.stand.x, c.stand.z, { priority: PRIORITY.command, name: "return_walk" });
        this.publishQueue();
      });
  }

  // Stops the running event (and optionally everything queued); its cleanup restores the scene.
  cancel({ all = true } = {}) {
    if (all) this.queue = [];
    this.current?.cancel();
    this.speechHeld = null;
  }

  // Builds the events' effects once out of sight, so their shaders compile before the show.
  prewarm() {
    const g = new Galaxy(this.ctx, {}, () => {});
    const l = new Lion(this.ctx, {}, () => {});
    const m = motes(8, { color: 0xffffff });
    const tex = silhouetteTexture();
    const fig = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(RING_FRAGMENT, { progress: { value: 0 }, alpha: { value: 0 }, color: { value: new THREE.Color() } }));
    for (const o of [m, fig, ring]) {
      o.position.set(0, -60, 0);
      this.ctx.scene.add(o);
    }
    return () => {
      g.restore();
      l.restore();
      for (const o of [m, fig, ring]) {
        this.ctx.scene.remove(o);
        o.geometry.dispose();
        o.material.dispose();
      }
      tex.dispose();
    };
  }
}
