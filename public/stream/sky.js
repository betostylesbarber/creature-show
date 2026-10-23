import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

// The colour of the night haze at the horizon (linear). The distance fog uses the same colour,
// so the ground, the distant hills and the sky melt into each other instead of meeting at a line.
export const HAZE = new THREE.Color().setRGB(0.026, 0.029, 0.036);
const glsl = (c) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

// Night gradient with a warm Halloween glow on the horizon and twinkling stars.
const SKY_FRAGMENT = /* glsl */ `
  #define HAZE ${glsl(HAZE)}
  uniform float time, blood, flash, starBoost;
  uniform vec3 moonDir;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    // Blue-grey night, hazy at the horizon where it meets the distance fog, with a faint warm
    // glow from far-off villages right at the bottom. Low saturation on purpose: filmic tone
    // mapping turns saturated night blues violet.
    vec3 horizon = mix(HAZE, vec3(0.24, 0.02, 0.015), blood);
    vec3 mid = mix(vec3(0.011, 0.014, 0.019), vec3(0.07, 0.01, 0.02), blood);
    vec3 top = vec3(0.0025, 0.0035, 0.0055);
    vec3 col = mix(horizon, mid, smoothstep(0.0, 0.2, h));
    col = mix(col, top, smoothstep(0.2, 0.75, h));
    col += vec3(0.012, 0.006, 0.002) * (1.0 - smoothstep(-0.02, 0.05, h)) * (1.0 - blood);
    float moonGlow = pow(max(dot(d, moonDir), 0.0), 40.0);
    col += moonGlow * mix(vec3(0.3, 0.34, 0.5), vec3(0.55, 0.08, 0.04), blood) * 0.35;
    vec3 p = d * 260.0;
    vec3 cell = floor(p);
    float r = hash(cell);
    if (r > 0.992 && h > 0.04) {
      vec3 local = fract(p) - 0.5;
      float star = smoothstep(0.08, 0.0, length(local)) * (0.55 + 0.45 * sin(time * (1.0 + r * 4.0) + r * 60.0));
      col += star * vec3(0.9, 0.92, 1.0) * smoothstep(0.04, 0.3, h) * starBoost;
    }
    col += flash * vec3(0.35, 0.4, 0.55) * (0.4 + 0.6 * smoothstep(0.0, 0.5, h));
    gl_FragColor = vec4(col, 1.0);
  }`;

function cloudTexture() {
  return canvasTexture(512, 256, (ctx, w, h) => {
    for (let i = 0; i < 60; i++) {
      const x = rand(w * 0.1, w * 0.9);
      const y = rand(h * 0.35, h * 0.7);
      const r = rand(30, 90);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.22)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  });
}

// The land around the cemetery, in three layers that fade into the night haze with distance
// (atmospheric perspective), so the horizon has depth instead of reading as one black band:
// far crags with a castle and one burning window, a forested ridge, and close by a ragged line
// of dead trees with a church spire and a few lit cottages. Each layer is darkest at its top
// edge and dissolves into ground mist at its foot.
const toHex = (c, k) => `#${new THREE.Color().setRGB(c.r * k, c.g * k, c.b * k).getHexString()}`; // linear in, sRGB out

function deadTree(ctx, x, y, s) {
  const branch = (bx, by, len, ang, depth) => {
    const ex = bx + Math.cos(ang) * len;
    const ey = by - Math.sin(ang) * len;
    ctx.lineWidth = Math.max(1.2, depth * s * 0.022);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    if (depth > 0) for (let i = 0; i < 2 + (depth > 2 ? 1 : 0); i++) branch(ex, ey, len * rand(0.55, 0.78), ang + rand(-0.75, 0.75), depth - 1);
  };
  branch(x, y, s * 0.42, Math.PI / 2 + rand(-0.12, 0.12), 5);
}

function pine(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.04, y);
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const half = s * 0.2 * (1 - t) + s * 0.02;
    ctx.lineTo(x - half - rand(0, s * 0.03), y - t * s);
    ctx.lineTo(x - half * 0.45, y - t * s - s * 0.06);
  }
  ctx.lineTo(x, y - s * 1.04);
  for (let k = 6; k >= 0; k--) {
    const t = k / 6;
    const half = s * 0.2 * (1 - t) + s * 0.02;
    ctx.lineTo(x + half * 0.45, y - t * s - s * 0.06);
    ctx.lineTo(x + half + rand(0, s * 0.03), y - t * s);
  }
  ctx.lineTo(x + s * 0.04, y);
  ctx.fill();
}

function skylineTexture(layer) {
  const { seed, top, hazeK, baseAt, amp, kind } = layer;
  const ink = toHex(HAZE, top);
  return canvasTexture(4096, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = ink;
    const base = h * baseAt;
    const ridge = (x) => base - (Math.sin((x + seed) * 0.0019) * 0.45 + Math.sin((x + seed) * 0.0061) * 0.3 + Math.sin((x + seed) * 0.017) * 0.08 + 0.55) * h * amp;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, ridge(x));
    ctx.lineTo(w, h);
    ctx.fill();
    if (kind === "far") {
      // The castle on the crag, small with distance.
      const kx = w * 0.4;
      const ky = ridge(kx + 30) + 6;
      ctx.fillRect(kx, ky - 30, 70, 35);
      for (const [tx, th] of [[-5, 75], [30, 100], [65, 65]]) {
        ctx.fillRect(kx + tx, ky - th, 17, th);
        for (let c = 0; c < 4; c++) ctx.fillRect(kx + tx + c * 4.5, ky - th - 5, 3, 5);
      }
      ctx.fillStyle = "#a8783c";
      ctx.fillRect(kx + 36, ky - 85, 4, 6);
    } else if (kind === "ridge") {
      // A dense, uneven forest along the ridge: pines with a few bare trees among them.
      ctx.fillStyle = ctx.strokeStyle = ink;
      for (let x = 0; x < w; x += rand(10, 26)) {
        const y = ridge(x) + 4;
        if (Math.random() < 0.82) pine(ctx, x, y, rand(36, 84));
        else deadTree(ctx, x, y, rand(50, 110));
      }
    } else {
      for (let i = 0; i < 34; i++) {
        const x = rand(0, w);
        deadTree(ctx, x, ridge(x) + 20, rand(90, 230));
      }
      // Church with a spire.
      const cx = w * 0.62;
      const cy = ridge(cx) + 10;
      ctx.fillRect(cx, cy - 90, 120, 95);
      ctx.beginPath();
      ctx.moveTo(cx + 20, cy - 90);
      ctx.lineTo(cx + 45, cy - 240);
      ctx.lineTo(cx + 70, cy - 90);
      ctx.fill();
      ctx.fillRect(cx + 43, cy - 272, 4, 34);
      ctx.fillRect(cx + 33, cy - 260, 24, 4);
      // A few crooked cottages with dim, warm windows.
      for (const hx of [w * 0.18, w * 0.24, w * 0.82]) {
        const hy = ridge(hx) + 12;
        ctx.fillStyle = ink;
        ctx.fillRect(hx, hy - 60, 70, 62);
        ctx.beginPath();
        ctx.moveTo(hx - 8, hy - 60);
        ctx.lineTo(hx + 30, hy - 105);
        ctx.lineTo(hx + 78, hy - 60);
        ctx.fill();
        ctx.fillStyle = "#b8803a";
        ctx.fillRect(hx + 14, hy - 40, 10, 12);
        if (Math.random() > 0.4) ctx.fillRect(hx + 44, hy - 38, 10, 12);
      }
    }
    // Mist at the foot of the layer: everything fades towards the haze colour going down, so
    // the layer behind shows through as a lighter band and each one reads at its own depth.
    ctx.globalCompositeOperation = "source-atop";
    const fade = ctx.createLinearGradient(0, base - h * amp * 1.2, 0, h);
    fade.addColorStop(0, `${toHex(HAZE, hazeK)}00`);
    fade.addColorStop(1, toHex(HAZE, hazeK));
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  });
}

// A soft band of mist between two layers of the skyline.
function mistBandTexture() {
  return canvasTexture(16, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.6, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0.75)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export function buildSky(scene) {
  const moonDir = new THREE.Vector3(-0.22, 0.2, -1).normalize();
  const uniforms = { time: { value: 0 }, blood: { value: 0 }, flash: { value: 0 }, starBoost: { value: 1 }, moonDir: { value: moonDir } };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(90, 48, 24),
    new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  dome.renderOrder = -10;
  scene.add(dome);

  const moonTex = canvasTexture(512, 512, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w * 0.47, h * 0.46, w * 0.02, w / 2, h / 2, w * 0.2);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.8, "#e4e6f0");
    g.addColorStop(1, "#c9cddc");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.2, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const rr = Math.sqrt(Math.random()) * w * 0.17;
      ctx.fillStyle = `rgba(120,125,150,${rand(0.12, 0.35)})`;
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr, rand(4, 22), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const haloTex = canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.25, "rgba(255,255,255,0.18)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const moonPos = moonDir.clone().multiplyScalar(60);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0xb4c0d8, fog: false, depthWrite: false, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending }));
  halo.position.copy(moonPos);
  halo.scale.setScalar(15);
  const moonMat = new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true, color: 0xffffff });
  const moon = new THREE.Sprite(moonMat);
  moon.position.copy(moonPos);
  moon.scale.setScalar(13);
  // Brighter than 1 so the bloom pass gives the moon a soft glow.
  moonMat.color.setScalar(1.3);
  // Drawn before the skyline (and the clouds after it), so a low moon sinks behind the hills.
  halo.renderOrder = moon.renderOrder = -9.5;
  scene.add(halo, moon);

  const clouds = [];
  const cloudTex = cloudTexture();
  for (let i = 0; i < 9; i++) {
    // Darker than the sky behind them, so they read as clouds passing over the moon, not haze.
    const mat = new THREE.SpriteMaterial({ map: cloudTex, color: 0x0b0912, fog: false, depthWrite: false, transparent: true, opacity: rand(0.7, 0.95) });
    const c = new THREE.Sprite(mat);
    const a = rand(-0.9, 0.5);
    c.position.set(Math.sin(a) * 55, rand(10, 22), -Math.cos(a) * 55);
    c.scale.set(rand(30, 48), rand(10, 16), 1);
    c.userData = { speed: rand(0.25, 0.6), a };
    c.renderOrder = -9.4;
    scene.add(c);
    clouds.push(c);
  }

  // Skyline layers from far to near, with a band of mist in front of each of the two far ones.
  // `top` and `hazeK` are the layer's brightness at its top edge and at its foot, as fractions
  // of the haze colour: the further away, the closer to the haze.
  const LAYERS = [
    { kind: "far", radius: 76, height: 26, drop: 1.5, repeat: 1, seed: 900, top: 0.6, hazeK: 1.0, baseAt: 0.74, amp: 0.17 },
    { mist: true, radius: 66, height: 7, drop: 0.6, opacity: 0.5 },
    { kind: "ridge", radius: 60, height: 16, drop: 1.0, repeat: 2, seed: 300, top: 0.36, hazeK: 0.95, baseAt: 0.8, amp: 0.13 },
    { mist: true, radius: 52, height: 5, drop: 0.4, opacity: 0.45 },
    { kind: "near", radius: 46, height: 12, drop: 0.8, repeat: 2, seed: 0, top: 0.14, hazeK: 0.75, baseAt: 0.88, amp: 0.06 },
  ];
  const mistTex = mistBandTexture();
  const skyline = [];
  LAYERS.forEach((layer, i) => {
    const material = layer.mist
      ? new THREE.MeshBasicMaterial({ map: mistTex, color: HAZE.clone().multiplyScalar(1.15), transparent: true, opacity: layer.opacity, side: THREE.BackSide, depthWrite: false, fog: false })
      : new THREE.MeshBasicMaterial({ map: skylineTexture(layer), transparent: true, side: THREE.BackSide, depthWrite: false, fog: false });
    if (!layer.mist) {
      material.map.wrapS = THREE.RepeatWrapping;
      material.map.repeat.x = layer.repeat;
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(layer.radius, layer.radius, layer.height, 96, 1, true), material);
    ring.position.y = layer.height / 2 - layer.drop;
    ring.renderOrder = -9 + i * 0.1; // far to near
    scene.add(ring);
    skyline.push(ring);
  });

  let blood = 0;
  let bloodTarget = 0;
  return {
    moonDir,
    setBloodMoon(on) {
      bloodTarget = on ? 1 : 0;
    },
    // How bright the stars are (1 normal); the Galaxy event opens the night up.
    setStars(k) {
      uniforms.starBoost.value = k;
    },
    update(t, dt, flash) {
      uniforms.time.value = t;
      uniforms.flash.value = flash;
      blood += (bloodTarget - blood) * Math.min(1, dt * 0.8);
      uniforms.blood.value = blood;
      moonMat.color.setRGB(1.3, 1.3 - blood * 1.0, 1.3 - blood * 1.12);
      halo.material.color.setRGB(0.7 + blood * 0.3, 0.75 - blood * 0.6, 0.85 - blood * 0.7);
      for (const c of clouds) {
        c.userData.a += dt * c.userData.speed * 0.004;
        if (c.userData.a > 0.7) c.userData.a = -1.0;
        c.position.x = Math.sin(c.userData.a) * 55;
        c.position.z = -Math.cos(c.userData.a) * 55;
        // Neutral blue-grey, a touch darker than the sky behind (a violet tint here turned the
        // whole sky purple).
        c.material.color.setRGB(0.014 + flash * 0.5, 0.016 + flash * 0.5, 0.021 + flash * 0.6);
      }
    },
  };
}

// Woodland far beyond the fence: dead trees, pines and shrubs on the outer ground, as crossed
// cut-out cards 30-44 m away (the 3D wood of surroundings.js fills the land nearer in), each tinted towards the haze by its distance, so the land between
// the fence and the skyline has depth instead of reading as one flat plane. None stand on the
// camera's side of the cemetery.
export function buildOuterWoods(scene, box, height = 0.367) {
  const variants = [
    (ctx, w, h) => deadTree(ctx, w / 2, h - 4, h * 0.95),
    (ctx, w, h) => deadTree(ctx, w / 2, h - 4, h * 0.8),
    (ctx, w, h) => {
      pine(ctx, w * 0.5, h - 2, h * 0.92);
      pine(ctx, w * 0.25, h - 2, h * 0.55);
    },
    (ctx, w, h) => {
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        ctx.ellipse(rand(w * 0.15, w * 0.85), h - rand(h * 0.08, h * 0.3), rand(w * 0.1, w * 0.22), rand(h * 0.08, h * 0.2), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  ].map((draw, i) =>
    canvasTexture(i === 3 ? 256 : 384, i === 3 ? 128 : 512, (ctx, w, h) => {
      ctx.fillStyle = ctx.strokeStyle = "#ffffff"; // tinted per card by its distance
      draw(ctx, w, h);
    }),
  );
  const pieces = variants.map(() => []);
  const center = box.getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4();
  const tint = new THREE.Color();
  const NEAR = 30;
  const FAR = 44;
  for (let i = 0, placed = 0; i < 500 && placed < 46; i++) {
    const a = rand(0, Math.PI * 2);
    const r = rand(NEAR, FAR);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    if (z > box.max.z - 1) continue; // behind the camera
    const kind = placed % 3 === 2 ? 3 : Math.floor(rand(0, 3));
    const tall = kind === 3 ? rand(0.6, 1.2) : rand(2.4, 5);
    const spin = rand(0, Math.PI);
    // Atmospheric perspective: the further away, the closer to the haze colour.
    tint.copy(HAZE).multiplyScalar(THREE.MathUtils.lerp(0.42, 0.85, (r - NEAR) / (FAR - NEAR)));
    for (const quarter of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(kind === 3 ? tall * 2 : tall * 0.75, tall);
      g.translate(0, tall / 2, 0);
      g.applyMatrix4(turn.makeRotationY(spin + quarter));
      g.translate(x, height - 0.05, z);
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let v = 0; v < colors.length; v += 3) colors.set([tint.r, tint.g, tint.b], v);
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      pieces[kind].push(g);
    }
    placed++;
  }
  // One merged mesh per card kind: four draw calls for the whole wood.
  const woods = new THREE.Group();
  pieces.forEach((list, kind) => {
    if (!list.length) return;
    const material = new THREE.MeshBasicMaterial({ map: variants[kind], alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
    woods.add(new THREE.Mesh(mergeGeometries(list), material));
    list.forEach((g) => g.dispose());
  });
  scene.add(woods);
  return woods;
}
