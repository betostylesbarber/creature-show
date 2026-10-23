import * as THREE from "three";

// The spectral lion's head, painted once into textures whose channels are the parts the shader
// lights separately: R = mane, G = face and ears, B = dark features (brows, nose, mouth, muzzle
// marks), A = the glowing eyes and fangs. One texture with the mouth closed, one roaring.

const SIZE = 1024;
const U = 400; // pixels per unit; the head is about 2.4 units across with its mane
const X = (x) => SIZE / 2 + x * U;
const Y = (y) => SIZE * 0.52 - y * U;

// A smooth closed (or open) curve through points, as Catmull-Rom converted to Bezier.
function curve(ctx, pts, closed = true) {
  const p = pts.map(([x, y]) => [X(x), Y(y)]);
  const n = p.length;
  const at = (i) => p[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  ctx.moveTo(...p[0]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}

const mirror = (pts) => [...pts, ...pts.slice(1, -1).reverse().map(([x, y]) => [-x, y])];

function layer(draw) {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.fillStyle = ctx.strokeStyle = "#fff";
  ctx.lineCap = ctx.lineJoin = "round";
  draw(ctx);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

// Right half of the face outline, from the top of the forehead down to the chin.
const FACE = mirror([
  [0, 0.56], [0.2, 0.54], [0.36, 0.44], [0.46, 0.24], [0.5, 0.02], [0.46, -0.2], [0.36, -0.38], [0.27, -0.5], [0.15, -0.62], [0, -0.66],
]);

function mane(ctx) {
  ctx.beginPath();
  ctx.ellipse(X(0), Y(-0.05), 0.82 * U, 0.9 * U, 0, 0, Math.PI * 2);
  ctx.fill();
  // Flame-like tufts all round, longest at the cheeks and under the chin (the beard).
  const tufts = 26;
  for (let i = 0; i < tufts; i++) {
    const a = (i / tufts) * Math.PI * 2 + 0.06;
    const side = Math.abs(Math.cos(a));
    const below = Math.max(0, -Math.sin(a));
    const len = 1.0 + 0.18 * side + 0.22 * below + 0.06 * Math.sin(i * 2.7);
    const w = 0.15 + 0.04 * Math.sin(i * 1.3);
    const curl = 0.18 * Math.sin(i * 0.9 + 1);
    const base = 0.62;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = (r, off) => [ca * r - sa * off, sa * r + ca * off];
    ctx.beginPath();
    curve(ctx, [px(base, -w), px((base + len) / 2, -w * 0.7 + curl * 0.5), px(len, curl), px((base + len) / 2, w * 0.7 + curl * 0.5), px(base, w)]);
    ctx.fill();
  }
}

function face(ctx) {
  ctx.beginPath();
  curve(ctx, FACE);
  ctx.fill();
  // Rounded ears, half hidden in the mane.
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(X(s * 0.36), Y(0.56), 0.15 * U, 0.13 * U, s * -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function features(ctx, roar) {
  // Inner ears.
  ctx.globalAlpha = 0.7;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(X(s * 0.37), Y(0.56), 0.07 * U, 0.06 * U, s * -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Heavy brows over the eyes, angled down to the nose: the lion's frown.
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 0.05 * U;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    curve(ctx, [[s * 0.06, 0.24], [s * 0.17, 0.25], [s * 0.3, 0.2]], false);
    ctx.stroke();
  }
  // Shadows either side of the broad nose bridge.
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 0.035 * U;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    curve(ctx, [[s * 0.07, 0.14], [s * 0.1, -0.02], [s * 0.13, -0.16]], false);
    ctx.stroke();
  }
  // The broad nose.
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  curve(ctx, [[-0.14, -0.17], [0, -0.15], [0.14, -0.17], [0.07, -0.27], [0, -0.31], [-0.07, -0.27]]);
  ctx.fill();
  // Mouth: closed, a line down from the nose that curves out to each side; roaring, wide open.
  ctx.lineWidth = 0.028 * U;
  if (!roar) {
    ctx.beginPath();
    curve(ctx, [[0, -0.31], [0, -0.39], [0.09, -0.44], [0.19, -0.42]], false);
    ctx.stroke();
    ctx.beginPath();
    curve(ctx, [[0, -0.39], [-0.09, -0.44], [-0.19, -0.42]], false);
    ctx.stroke();
  } else {
    ctx.beginPath();
    curve(ctx, [[0, -0.33], [0.16, -0.36], [0.22, -0.5], [0.12, -0.68], [0, -0.71], [-0.12, -0.68], [-0.22, -0.5], [-0.16, -0.36]]);
    ctx.fill();
  }
  // Whisker spots on the muzzle.
  ctx.globalAlpha = 0.55;
  for (const s of [-1, 1]) {
    for (const [x, y] of [[0.09, -0.36], [0.14, -0.34], [0.12, -0.4], [0.18, -0.38]]) {
      ctx.beginPath();
      ctx.arc(X(s * x), Y(y), 0.011 * U, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function glow(ctx, roar) {
  // Almond eyes, the outer corners lifted.
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(X(s * 0.17), Y(0.12));
    ctx.rotate(s * -0.28);
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.075 * U, 0.03 * U, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (roar) {
    // Fangs.
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(X(s * 0.12), Y(-0.37));
      ctx.lineTo(X(s * 0.08), Y(-0.37));
      ctx.lineTo(X(s * 0.1), Y(-0.48));
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(s * 0.11), Y(-0.69));
      ctx.lineTo(X(s * 0.07), Y(-0.68));
      ctx.lineTo(X(s * 0.095), Y(-0.6));
      ctx.closePath();
      ctx.fill();
    }
  }
}

function headTexture(roar) {
  const r = layer(mane);
  const g = layer(face);
  const b = layer((ctx) => features(ctx, roar));
  const a = layer((ctx) => glow(ctx, roar));
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(SIZE, SIZE);
  // Channels hold coverage, read straight back by the shader (no colour management).
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = r[i + 3];
    out.data[i + 1] = g[i + 3];
    out.data[i + 2] = b[i + 3];
    out.data[i + 3] = 255;
  }
  const eyes = new Uint8ClampedArray(SIZE * SIZE);
  for (let i = 0, j = 0; i < a.length; i += 4, j++) eyes[j] = a[i + 3];
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  // The eyes go in a second, single-channel texture so the RGB stays free of premultiplication.
  const eyeTex = new THREE.DataTexture(eyes, SIZE, SIZE, THREE.RedFormat);
  eyeTex.flipY = true;
  eyeTex.needsUpdate = true;
  eyeTex.magFilter = eyeTex.minFilter = THREE.LinearFilter;
  return { tex, eyeTex };
}

let cached = null;
export function lionTextures() {
  cached ??= { closed: headTexture(false), open: headTexture(true) };
  return cached;
}

export const LION_FRAGMENT = /* glsl */ `
  uniform sampler2D closedTex, openTex, closedEyes, openEyes;
  uniform float time, alpha, roar, flare;
  varying vec2 vUv;
  float lHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(lHash(i), lHash(i + vec2(1, 0)), u.x), mix(lHash(i + vec2(0, 1)), lHash(i + vec2(1, 1)), u.x), u.y);
  }
  vec4 head(vec2 uv) { return mix(texture2D(closedTex, uv), texture2D(openTex, uv), roar); }
  void main() {
    vec2 c = vUv - vec2(0.5, 0.52);
    float r = length(c);
    vec2 outward = c / max(r, 1e-3);
    // The mane streams outward like flame: sample it pushed in along the radius by moving noise.
    float ang = atan(c.y, c.x);
    float flow = lNoise(vec2(ang * 4.0, r * 9.0 - time * 1.6)) * 0.6 + lNoise(vec2(ang * 9.0, r * 22.0 - time * 2.4)) * 0.4;
    // Fine streaks running outward along the hair, drifting like flame.
    float streaks = lNoise(vec2(ang * 38.0, r * 3.0 - time * 1.1)) * 0.55 + lNoise(vec2(ang * 80.0, r * 6.0 - time * 1.8)) * 0.45;
    vec2 maneUv = vUv - outward * (flow - 0.35) * 0.1 * (1.0 + roar * 0.6);
    float mane = head(maneUv).r;
    vec4 h = head(vUv);
    float eyes = mix(texture2D(closedEyes, vUv).r, texture2D(openEyes, vUv).r, roar);
    float face = h.g;
    float dark = h.b;
    vec3 amber = vec3(1.0, 0.46, 0.1);
    vec3 gold = vec3(1.0, 0.66, 0.26);
    // A spirit, not a sticker: the mane is see-through amber fire, densest in streaks and at its
    // tips; the face is a faint golden glow, brightest on the brow and muzzle; the features are
    // hollows; only the eyes burn bright enough to bloom.
    float tips = smoothstep(0.2, 0.5, r);
    float hair = smoothstep(0.25, 0.85, streaks * 0.7 + flow * 0.5);
    // A blurred copy of the mane (a coarse mipmap) gives the outline a soft glow instead of a cut edge.
    float halo = mix(texture2D(closedTex, maneUv, 4.0).r, texture2D(openTex, maneUv, 4.0).r, roar);
    vec3 col = amber * mane * (1.0 - face) * (0.03 + 0.3 * hair + 0.1 * tips) * (0.55 + 0.45 * tips);
    col += amber * halo * (1.0 - mane) * 0.12;
    float shape = 0.4 + 0.6 * smoothstep(0.28, 0.0, length(c - vec2(0.0, 0.07))) + 0.35 * smoothstep(0.15, 0.0, length(c - vec2(0.0, -0.15)));
    col += gold * face * 0.17 * shape * (0.8 + 0.4 * flow);
    col *= 1.0 - 0.92 * dark;
    col += vec3(1.0, 0.92, 0.75) * eyes * (1.5 + roar * 1.2);
    float shimmer = 0.75 + 0.25 * lNoise(vUv * 30.0 + time * 2.5);
    gl_FragColor = vec4(col * shimmer * alpha * (1.0 + flare * 1.1), 1.0);
  }`;
