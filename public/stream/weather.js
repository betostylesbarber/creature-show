import * as THREE from "three";
import { mist, wind } from "./mist.js";

const rand = (a, b) => a + Math.random() * (b - a);

function canvasTexture(w, h, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Rain is animated entirely on the graphics card: each drop is a thin camera-facing streak that
// falls from its seed height to the first surface below it (so nothing rains through the crypt
// roof), slanted by the wind. Only a share of the drops is drawn, set by the rain level, so a
// drizzle and a downpour use the same buffers. Streaks fade out close to the camera, so no drop
// ever smears across the frame, and far away, where they would only add noise for the encoder.
const RAIN_VERTEX = /* glsl */ `
  attribute vec4 seed;   // x, start height, z, floor
  attribute float pick;  // drawn while pick < level
  uniform float time, level, slant, height, len, width;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float span = max(0.1, height - seed.w);
    float fallen = mod(seed.y + time * 9.0, span);
    float y = height - fallen;
    vec3 head = vec3(seed.x + fallen * slant, y, seed.z);
    vec3 dir = normalize(vec3(slant, -1.0, 0.0));
    vec3 toCam = normalize(cameraPosition - head);
    vec3 side = normalize(cross(dir, toCam));
    float l = min(len, y - seed.w + 0.02);
    vec3 world = head + side * position.x * width - dir * (position.y + 0.5) * l;
    float d = distance(head, cameraPosition);
    vAlpha = step(pick, level) * smoothstep(1.2, 2.6, d) * (1.0 - smoothstep(9.0, 15.0, d));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const RAIN_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity, flash;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float along = smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
    float a = across * across * along * vAlpha * opacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(color * (1.0 + flash * 4.0), a);
  }`;

// Splashes: small rings that open and fade where drops land, on the ground, the path and the
// tops of the graves near the camera.
const SPLASH_VERTEX = /* glsl */ `
  attribute vec4 spot;   // x, surface height, z, phase
  attribute float pick;
  uniform float time, level;
  varying float vLife, vAlpha;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float period = 0.55 + fract(spot.w * 7.31) * 0.6;
    vLife = fract(time / period + spot.w);
    float r = 0.012 + vLife * 0.055;
    vec3 world = vec3(spot.x + position.x * r * 2.0, spot.y + 0.012, spot.z + position.y * r * 2.0);
    vAlpha = step(pick, level) * (1.0 - smoothstep(6.0, 10.0, distance(world, cameraPosition)));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const SPLASH_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vLife, vAlpha;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.6, 0.85, d) * (1.0 - smoothstep(0.85, 1.0, d));
    float a = ring * (1.0 - vLife) * (1.0 - vLife) * vAlpha * opacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(color, a);
  }`;

function instanced(count, attributes) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute("position", quad.attributes.position);
  g.setAttribute("uv", quad.attributes.uv);
  for (const [name, size, fill] of attributes) {
    const data = new Float32Array(count * size);
    for (let i = 0; i < count; i++) data.set(fill(i), i * size);
    g.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
  }
  g.instanceCount = count;
  return g;
}

// Persistent weather: a fine drizzle that never quite stops, heavier during a storm, with
// splashes and wet, darker, glossier ground (see mist.js) that follows the rain; wind that
// drives the mist, the rain's slant, the leaves and the sway of the plants; and now and then a
// falling leaf. Leaves and rain stop on the first solid surface below them.
export const DRIZZLE = 0.32; // share of the rain drawn when there is no storm

export class Weather {
  constructor(scene, box, surfaceAt = () => 0.4) {
    this.scene = scene;
    this.box = box;
    this.surfaceAt = surfaceAt;
    this.rainLevel = DRIZZLE;
    this.rainTarget = DRIZZLE;

    // A few falling autumn leaves (never close to the camera, where they would fill the frame).
    const leafTex = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.translate(w / 2, h / 2);
      ctx.rotate(0.6);
      const g = ctx.createLinearGradient(-20, 0, 20, 0);
      g.addColorStop(0, "#5a2208");
      g.addColorStop(1, "#a8561a");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -26);
      ctx.quadraticCurveTo(22, -8, 0, 26);
      ctx.quadraticCurveTo(-22, -8, 0, -26);
      ctx.fill();
      ctx.strokeStyle = "rgba(50,18,5,0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -24);
      ctx.lineTo(0, 24);
      ctx.stroke();
    });
    const count = 36;
    this.leaves = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.07, 0.07),
      new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 }),
      count,
    );
    this.leaves.castShadow = false;
    this.leafState = Array.from({ length: count }, () => this.spawnLeaf(true));
    this.dummy = new THREE.Object3D();
    scene.add(this.leaves);

    const min = box.min;
    const max = box.max;
    const top = 9;
    this.rainUniforms = {
      time: { value: 0 },
      level: { value: DRIZZLE },
      slant: { value: 0 },
      height: { value: top },
      len: { value: 0.26 },
      width: { value: 0.0055 },
      color: { value: new THREE.Color(0.5, 0.56, 0.66) },
      opacity: { value: 0.3 },
      flash: { value: 0 },
    };
    const drops = 7000;
    const rainGeo = instanced(drops, [
      ["seed", 4, () => {
        const x = rand(min.x - 1, max.x + 1);
        const z = rand(min.z - 1, max.z + 1);
        return [x, rand(0, top), z, Math.max(0, surfaceAt(x, z))];
      }],
      ["pick", 1, () => [Math.random()]],
    ]);
    this.rain = new THREE.Mesh(rainGeo, new THREE.ShaderMaterial({ uniforms: this.rainUniforms, vertexShader: RAIN_VERTEX, fragmentShader: RAIN_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    scene.add(this.rain);

    this.splashUniforms = { time: { value: 0 }, level: { value: DRIZZLE }, color: { value: new THREE.Color(0.42, 0.47, 0.55) }, opacity: { value: 0.36 } };
    const splashes = 1400;
    const splashGeo = instanced(splashes, [
      ["spot", 4, () => {
        const x = rand(Math.max(min.x, -5), Math.min(max.x, 5.5));
        const z = rand(Math.max(min.z, -4), Math.min(max.z, 4.6));
        return [x, surfaceAt(x, z), z, Math.random()];
      }],
      ["pick", 1, () => [Math.random()]],
    ]);
    this.splashes = new THREE.Mesh(splashGeo, new THREE.ShaderMaterial({ uniforms: this.splashUniforms, vertexShader: SPLASH_VERTEX, fragmentShader: SPLASH_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.splashes.frustumCulled = false;
    this.splashes.renderOrder = 4;
    scene.add(this.splashes);
  }

  spawnLeaf(anywhere) {
    const x = rand(this.box.min.x - 1, this.box.max.x + 1);
    const z = rand(this.box.min.z - 1, this.box.max.z - 1.5);
    return {
      x,
      y: anywhere ? rand(0.5, 8) : rand(6, 9),
      z,
      floor: this.surfaceAt(x, z),
      vy: rand(0.25, 0.55),
      spin: new THREE.Vector3(rand(-2, 2), rand(-2, 2), rand(-2, 2)),
      rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)),
      phase: rand(0, 6),
      rest: 0,
    };
  }

  // 1 for a storm, 0 for the usual drizzle.
  setStorm(level) {
    this.rainTarget = DRIZZLE + (1 - DRIZZLE) * level;
  }

  update(t, dt, flash, camera) {
    this.rainLevel += (this.rainTarget - this.rainLevel) * Math.min(1, dt * 0.7);
    const storm = (this.rainLevel - DRIZZLE) / (1 - DRIZZLE);
    // Slow gusts, stronger in a storm.
    const gust = 0.25 + Math.max(0, Math.sin(t * 0.21) * 0.2 + Math.sin(t * 0.53 + 1.3) * 0.12) + storm * 1.1;
    wind.strength.value = gust;
    wind.time.value += dt * (0.6 + gust);
    mist.time.value += dt * (0.6 + gust);
    mist.flash.value = flash;
    // Surfaces are damp in the drizzle and soaked in a storm; they dry off slowly afterwards.
    mist.wet.value += (0.5 + storm * 0.5 - mist.wet.value) * Math.min(1, dt * 0.15);

    const r = this.rainUniforms;
    r.time.value = t;
    r.level.value = this.rainLevel;
    r.slant.value = gust * 0.22;
    r.flash.value = flash;
    r.opacity.value = 0.26 + storm * 0.16;
    r.len.value = 0.22 + storm * 0.1;
    this.splashUniforms.time.value = t;
    this.splashUniforms.level.value = this.rainLevel * 0.9;

    const cam = camera?.position;
    for (let i = 0; i < this.leafState.length; i++) {
      const l = this.leafState[i];
      if (l.y > l.floor + 0.02) {
        l.y = Math.max(l.floor + 0.01, l.y - l.vy * dt);
        l.x += (gust + Math.sin(t * 1.3 + l.phase) * 0.35) * dt;
        l.z += Math.cos(t * 0.9 + l.phase) * 0.25 * dt;
        l.rot.x += l.spin.x * dt;
        l.rot.y += l.spin.y * dt;
        l.rot.z += l.spin.z * dt;
        l.floor = this.surfaceAt(l.x, l.z);
        if (l.y <= l.floor + 0.02) l.rot.set(-Math.PI / 2 + rand(-0.2, 0.2), rand(0, 6), 0); // settle flat
      } else if ((l.rest += dt) > 10) {
        this.leafState[i] = this.spawnLeaf(false);
      }
      if (l.x > this.box.max.x + 2) this.leafState[i] = this.spawnLeaf(false);
      this.dummy.position.set(l.x, l.y, l.z);
      this.dummy.rotation.copy(l.rot);
      // A leaf drifting right past the lens would fill the frame: it simply isn't drawn there.
      const near = cam ? cam.distanceTo(this.dummy.position) : 9;
      this.dummy.scale.setScalar(THREE.MathUtils.smoothstep(near, 1.6, 2.4));
      this.dummy.updateMatrix();
      this.leaves.setMatrixAt(i, this.dummy.matrix);
    }
    this.leaves.instanceMatrix.needsUpdate = true;
  }
}
