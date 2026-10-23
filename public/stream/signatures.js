import * as THREE from "three";
import { mist } from "./mist.js";
import { lionTextures, LION_FRAGMENT } from "./lion.js";

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

// Every signature event goes through the same beats, in order. Each beat is announced as a cue
// (for the sound system and the logs) on the frame clock, so nothing drifts against the picture.
export const BEATS = ["recognition", "anticipation", "development", "climax", "reaction", "decay", "end"];

const NOISE = /* glsl */ `
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float sNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash(i), sHash(i + vec2(1, 0)), u.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), u.x), u.y);
  }
  float sFbm(vec2 p) { return sNoise(p) * 0.55 + sNoise(p * 2.1 + 3.1) * 0.3 + sNoise(p * 4.3 + 7.7) * 0.15; }`;

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

function additive(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERTEX, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
}

// A spiral galaxy, drawn in the shader: two arms of blue and violet dust around a warm core,
// with fine stars, tilted like a disc seen at an angle.
const GALAXY_FRAGMENT = /* glsl */ `
  uniform float time, alpha, flare;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    p.y *= 2.3;
    float r = length(p);
    float a = atan(p.y, p.x);
    float spiral = sin(2.0 * a + log(r + 0.05) * 5.5 - time * 0.25);
    float dust = sFbm(p * 3.2 + time * 0.03);
    float lanes = sFbm(p * 9.0 - time * 0.02);
    float arms = smoothstep(0.25, 1.0, spiral * 0.65 + dust * 0.6) * smoothstep(1.0, 0.1, r);
    vec3 col = mix(vec3(0.3, 0.45, 1.0), vec3(0.8, 0.5, 1.0), dust) * arms * (0.45 + 0.9 * dust) * (0.55 + 0.6 * lanes);
    col += vec3(1.0, 0.88, 0.75) * exp(-r * r * 45.0) * 0.95;
    float stars = step(0.996, sHash(floor(vUv * 460.0))) * smoothstep(1.0, 0.2, r);
    col += stars * 1.2;
    gl_FragColor = vec4(col * alpha * (1.0 + flare * 2.2) * smoothstep(1.0, 0.55, r), 1.0);
  }`;

// An expanding ring of light on the ground (the lion's roar, the reanimation's discharge).
const RING_FRAGMENT = /* glsl */ `
  uniform float progress, alpha;
  uniform vec3 color;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(progress - 0.12, progress, d) * (1.0 - smoothstep(progress, progress + 0.03, d));
    gl_FragColor = vec4(color * ring * alpha * (1.0 - progress), 1.0);
  }`;

// Glowing motes moved entirely on the graphics card: they spiral around a centre, can fall or
// rise, and burst outward on cue.
const MOTES_VERTEX = /* glsl */ `
  attribute vec4 seed; // angle, radius, speed, phase
  uniform float time, burst, rise, size, height, spread;
  uniform vec3 center;
  varying float vFade;
  void main() {
    float life = fract(seed.w + time * 0.12 * seed.z);
    float y = mix(height, 0.2, life) * (1.0 - rise) + mix(0.1, height, life) * rise;
    float ang = seed.x + time * seed.z * 0.9;
    float rad = seed.y * spread * (1.0 + burst * 4.0);
    vec3 p = center + vec3(cos(ang) * rad, y + burst * seed.y * 1.5, sin(ang) * rad);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * (300.0 / -mv.z) * (0.6 + 0.4 * sin(time * 7.0 + seed.w * 30.0));
    vFade = sin(life * 3.14159) * (1.0 - burst * 0.7);
    gl_Position = projectionMatrix * mv;
  }`;

const MOTES_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float alpha;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(color * a * a * vFade * alpha, 1.0);
  }`;

// The direction from the camera through a point of the frame (x, y from -1 to 1, y up).
function onScreen(camera, x, y) {
  camera.updateMatrixWorld();
  return new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
}

function motes(count, { color, size = 0.12, height = 6, rise = 0, spread = 1 }) {
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seeds.set([rand(0, Math.PI * 2), rand(0.4, 2.2), rand(0.5, 1.4), Math.random()], i * 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  const uniforms = { time: { value: 0 }, burst: { value: 0 }, rise: { value: rise }, size: { value: size }, height: { value: height }, spread: { value: spread }, center: { value: new THREE.Vector3() }, color: { value: new THREE.Color(color) }, alpha: { value: 0 } };
  const points = new THREE.Points(geometry, new THREE.ShaderMaterial({ uniforms, vertexShader: MOTES_VERTEX, fragmentShader: MOTES_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  points.frustumCulled = false;
  return points;
}

// Electric arcs as jagged lines redrawn every frame (cheap: one draw call for all of them),
// bright enough to bloom.
export class Arcs {
  constructor(scene, max = 24) {
    this.segs = 10;
    this.max = max;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * this.segs * 2 * 3), 3));
    this.material = new THREE.LineBasicMaterial({ color: new THREE.Color(0xc8e4ff).multiplyScalar(5), transparent: true, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.arcs = [];
  }

  // An arc between two points (or functions returning points) for `life` seconds.
  zap(a, b, life = 0.15, jag = 0.12) {
    if (this.arcs.length >= this.max) this.arcs.shift();
    this.arcs.push({ a, b, life, jag });
  }

  update(dt) {
    const pos = this.geometry.attributes.position;
    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const jitter = new THREE.Vector3();
    let n = 0;
    this.arcs = this.arcs.filter((arc) => (arc.life -= dt) > 0);
    for (const arc of this.arcs) {
      const a = typeof arc.a === "function" ? arc.a() : arc.a;
      const b = typeof arc.b === "function" ? arc.b() : arc.b;
      const span = a.distanceTo(b) * arc.jag;
      prev.copy(a);
      for (let s = 1; s <= this.segs; s++) {
        p.copy(a).lerp(b, s / this.segs);
        if (s < this.segs) p.add(jitter.set(rand(-span, span), rand(-span, span), rand(-span, span)).multiplyScalar(Math.sin((s / this.segs) * Math.PI)));
        pos.setXYZ(n++, prev.x, prev.y, prev.z);
        pos.setXYZ(n++, p.x, p.y, p.z);
        prev.copy(p);
      }
    }
    for (let i = n; i < pos.count; i++) pos.setXYZ(i, 0, -100, 0);
    pos.needsUpdate = true;
    this.lines.visible = n > 0;
  }
}

// Two Tesla coils outside the back fence, either side of the gate: the Doctor's apparatus,
// dark and quiet until the reanimation milestone charges them. Outside the fence, so they
// never stand in his way.
export function buildCoils(scene, at, ground) {
  const iron = new THREE.MeshStandardMaterial({ color: 0x24221f, metalness: 0.85, roughness: 0.5 });
  const copperTex = (() => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 256;
    const g = c.getContext("2d");
    for (let y = 0; y < 256; y += 4) {
      g.fillStyle = y % 8 ? "#7a3f1c" : "#b86a34";
      g.fillRect(0, y, 16, 4);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 6);
    return t;
  })();
  const copper = new THREE.MeshStandardMaterial({ map: copperTex, metalness: 0.9, roughness: 0.38 });
  const crown = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3, emissive: 0x8fc8ff, emissiveIntensity: 0 });
  const coils = [];
  for (const dx of [-1.5, 1.7]) {
    const x = at.x + dx;
    const z = at.z;
    const y = ground(x, z);
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.28, 20), iron);
    base.position.y = 0.14;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 1.5, 20), copper);
    column.position.y = 0.28 + 0.75;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.085, 14, 36), crown);
    torus.rotation.x = Math.PI / 2;
    torus.position.y = 1.86;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), crown);
    ball.position.y = 1.98;
    for (const m of [base, column, torus, ball]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    g.position.set(x, y - 0.02, z);
    scene.add(g);
    coils.push({ group: g, top: new THREE.Vector3(x, y + 1.95, z) });
  }
  return { coils, crown };
}

// ----------------------------------------------------------------------------------------
// The events. Each runs its beats on the frame clock; the climax waits for his "climax"
// marker (the celebrate or reanimate stunt) between `earliest` and `latest` seconds, so the
// picture and his arms peak together, and falls back to `latest` if no marker comes.

class Signature {
  constructor(ctx, info, cue) {
    this.ctx = ctx;
    this.info = info;
    this.cue = cue;
    this.t = 0;
    this.beat = -1;
    this.climaxAt = null;
    this.objects = [];
  }

  // The beat timeline, in seconds; an event can pass a quicker one ({ timing } in info) when the
  // layer has to fit inside its own climax and reaction.
  get timing() {
    return { anticipation: 0.7, development: 2.4, earliest: 3.2, latest: 9, reaction: 0.9, decay: 2.6, end: 7.5, ...this.info?.timing };
  }

  add(object) {
    this.ctx.scene.add(object);
    this.objects.push(object);
    return object;
  }

  marker(stunt, name) {
    if (name === "climax" && this.climaxAt == null && this.t >= this.timing.earliest - 2) this.climaxAt = Math.max(this.t, this.timing.earliest);
  }

  since(beat) {
    return this.t - (this.times?.[BEATS.indexOf(beat)] ?? Infinity);
  }

  update(dt, t) {
    this.t += dt;
    const s = this.timing;
    if (this.climaxAt == null && this.t >= s.latest) this.climaxAt = this.t;
    const c = this.climaxAt;
    this.times = [0, s.anticipation, s.development, c, c == null ? null : c + s.reaction, c == null ? null : c + s.decay, c == null ? null : c + s.end];
    while (this.beat + 1 < BEATS.length && this.times[this.beat + 1] != null && this.t >= this.times[this.beat + 1]) {
      this.beat++;
      this.cue(BEATS[this.beat]);
      this.onBeat?.(BEATS[this.beat]);
    }
    this.animate(dt, t);
    return this.beat < BEATS.length - 1;
  }

  restore() {
    for (const o of this.objects) {
      this.ctx.scene.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this.objects = [];
    this.reset?.();
  }
}

// Galaxy: the night opens up. The stars brighten, a spiral galaxy gathers in the sky above the
// cemetery while sparks of starlight spiral down around him, and at the climax it blazes and the
// sparks burst outward, then everything settles back into the ordinary night.
class Galaxy extends Signature {
  constructor(ctx, info, cue) {
    super(ctx, info, cue);
    const at = ctx.avatar.root.position;
    this.uniforms = { time: { value: 0 }, alpha: { value: 0 }, flare: { value: 0 } };
    // Far behind him, placed by where it should appear on screen (upper middle of the portrait
    // frame) wherever the camera is, facing the camera.
    const cam = ctx.camera.position;
    const dir = onScreen(ctx.camera, 0.04, 0.56);
    this.disc = this.add(new THREE.Mesh(new THREE.PlaneGeometry(13, 13), additive(GALAXY_FRAGMENT, this.uniforms)));
    this.disc.position.copy(cam).addScaledVector(dir, 30);
    this.disc.lookAt(cam);
    this.disc.rotateZ(0.32);
    this.disc.renderOrder = -8;
    this.sparks = this.add(motes(420, { color: 0xc6d6ff, size: 0.17, height: 4.6 }));
    this.sparks.material.uniforms.center.value.set(at.x, at.y, at.z);
  }

  animate(dt, t) {
    const u = this.uniforms;
    const m = this.sparks.material.uniforms;
    u.time.value = t;
    m.time.value = t;
    const build = smooth((this.t - 0.6) / 3);
    const flare = this.climaxAt == null ? 0 : Math.exp(-Math.max(0, this.t - this.climaxAt) * 2.2) * smooth((this.t - this.climaxAt + 0.15) / 0.15);
    const fade = this.climaxAt == null ? 1 : 1 - smooth((this.t - this.climaxAt - this.timing.decay) / (this.timing.end - this.timing.decay));
    u.alpha.value = 0.85 * build * fade;
    u.flare.value = flare;
    m.alpha.value = smooth((this.t - 1.6) / 1.5) * fade * 0.9;
    m.burst.value = this.climaxAt == null ? 0 : smooth((this.t - this.climaxAt) / 1.6);
    this.ctx.sky?.setStars?.(1 + 2.2 * build * fade + flare * 2);
    this.ctx.lighting?.setAura?.(0.5 * build * fade + 1.4 * flare, 0x9fb0ff);
  }

  reset() {
    this.ctx.sky?.setStars?.(1);
    this.ctx.lighting?.setAura?.(0);
  }
}

// Lion: a golden spirit rises. The mist warms to gold and motes drift up from the ground,
// a spectral lion's head forms over the graves behind him, and at the climax it roars: its
// mouth opens, a ring of light sweeps the ground, the candles blaze and the camera shakes. It
// dissolves into rising motes as he answers it.
class Lion extends Signature {
  constructor(ctx, info, cue) {
    super(ctx, info, cue);
    const at = ctx.avatar.root.position;
        const tex = lionTextures();
    this.uniforms = { time: { value: 0 }, alpha: { value: 0 }, roar: { value: 0 }, flare: { value: 0 }, closedTex: { value: tex.closed.tex }, openTex: { value: tex.open.tex }, closedEyes: { value: tex.closed.eyeTex }, openEyes: { value: tex.open.eyeTex } };
    // Behind him, placed by where it should appear on screen (the upper half of the portrait
    // frame, its chin behind his head), so the whole head stays in view.
    const cam = ctx.camera.position;
    this.basePos = cam.clone().addScaledVector(onScreen(ctx.camera, 0, 0.47), at.distanceTo(cam) + 3.5);
    this.head = this.add(new THREE.Mesh(new THREE.PlaneGeometry(3.1, 3.1), additive(LION_FRAGMENT, this.uniforms)));
    this.head.position.copy(this.basePos);
    this.motes = this.add(motes(320, { color: 0xffc46a, size: 0.09, height: 5, rise: 1 }));
    this.motes.material.uniforms.center.value.set(at.x, at.y, at.z - 2.5);
    this.ringUniforms = { progress: { value: 0 }, alpha: { value: 0 }, color: { value: new THREE.Color(1.4, 0.95, 0.45) } };
    this.ring = this.add(new THREE.Mesh(new THREE.PlaneGeometry(16, 16), additive(RING_FRAGMENT, this.ringUniforms)));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(at.x, at.y + 0.06, at.z);
    this.mistColor = mist.color.value.clone();
    this.gold = new THREE.Color(0x5a4426);
  }

  get timing() {
    return { anticipation: 0.6, development: 2.2, earliest: 3.4, latest: 9, reaction: 1.0, decay: 2.8, end: 7.5, ...this.info?.timing };
  }

  animate(dt, t) {
    const u = this.uniforms;
    u.time.value = t;
    this.motes.material.uniforms.time.value = t;
    // Face the camera, turning about the vertical only.
    const cam = this.ctx.camera.position;
    this.head.rotation.y = Math.atan2(cam.x - this.head.position.x, cam.z - this.head.position.z);
    const glow = smooth(this.t / 1.2);
    const form = smooth((this.t - 1.4) / 2.2);
    const since = this.climaxAt == null ? -1 : this.t - this.climaxAt;
    const roar = since < 0 ? 0 : smooth(since / 0.25) * (1 - smooth((since - 1.3) / 0.6));
    const fade = since < 0 ? 1 : 1 - smooth((since - this.timing.decay) / (this.timing.end - this.timing.decay));
    u.alpha.value = 0.95 * form * fade;
    u.roar.value = roar;
    u.flare.value = since < 0 ? 0 : Math.exp(-since * 2);
    this.head.scale.setScalar(0.85 + 0.15 * form + 0.12 * roar);
    this.head.position.copy(this.basePos);
    this.head.position.y += -0.35 + 0.35 * form - 0.25 * (1 - fade);
    this.motes.material.uniforms.alpha.value = glow * (0.5 + 0.5 * (1 - fade) + 0.4 * roar) * Math.min(1, fade + 0.6);
    this.ringUniforms.progress.value = since < 0 ? 0 : 0.14 + 0.86 * clamp01(since / 1.4);
    this.ringUniforms.alpha.value = since < 0 ? 0 : 1.6;
    mist.color.value.copy(this.mistColor).lerp(this.gold, 0.55 * glow * fade);
    if (since >= 0 && !this.roared) {
      this.roared = true;
      this.ctx.shake?.(0.7);
      this.ctx.environment?.flare(1.6);
    }
    this.ctx.lighting?.setAura?.(0.35 * glow * fade + 1.1 * roar, 0xffc07a);
  }

  reset() {
    mist.color.value.copy(this.mistColor);
    this.ctx.lighting?.setAura?.(0);
  }
}

// Shared with the gift events (events.js): the effect layers and helpers above.
export { motes, additive, RING_FRAGMENT, onScreen, Galaxy, Lion };
