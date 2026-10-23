import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { NavGrid } from "./nav.js";
import { addWindSway } from "./mist.js";

const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

// Gloss maps store smoothness; three.js expects roughness, so flip it in the shader
// instead of re-encoding the original textures.
function useGlossAsRoughness(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `float roughnessFactor = roughness;
      #ifdef USE_ROUGHNESSMAP
        vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
        roughnessFactor *= 1.0 - texelRoughness.g;
      #endif`,
    );
  };
  material.customProgramCacheKey = () => "gloss";
}

// Builds a material from character.json and waits for every texture, so the scene never
// appears with missing or popping textures.
async function buildMaterial(spec, folder, renderer) {
  const loader = new THREE.TextureLoader();
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const tex = async (file, color = false) => {
    const t = await loader.loadAsync(folder + file);
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = anisotropy;
    // The ground and path textures tile across the terrain; clamping would smear their edge pixels.
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: spec.metalness ?? 0 });
  const [map, normalMap, aoMap, glossMap, roughnessMap, emissiveMap, alphaMap] = await Promise.all([
    spec.map && tex(spec.map, true),
    spec.normalMap && tex(spec.normalMap),
    spec.aoMap && tex(spec.aoMap),
    spec.glossMap && tex(spec.glossMap),
    spec.roughnessMap && tex(spec.roughnessMap),
    spec.emissiveMap && tex(spec.emissiveMap, true),
    spec.alphaMap && tex(spec.alphaMap),
  ]);
  if (map) material.map = map;
  if (normalMap) {
    material.normalMap = normalMap;
    // This model's normal maps are DirectX-style (green points down); flip green so bumps are
    // lit as bumps, not dents. Faces rendered from their back side need their own sign (soil).
    if (Array.isArray(spec.normalScale)) material.normalScale.set(...spec.normalScale);
    else if (spec.normalScale) material.normalScale.multiplyScalar(spec.normalScale);
    if (spec.normalFlipY) material.normalScale.y *= -1;
  }
  if (aoMap) {
    material.aoMap = aoMap;
    material.aoMapIntensity = spec.aoIntensity ?? 1;
  }
  if (glossMap) {
    material.roughnessMap = glossMap;
    useGlossAsRoughness(material);
  } else if (roughnessMap) material.roughnessMap = roughnessMap;
  if (emissiveMap) {
    material.emissiveMap = emissiveMap;
    material.emissive = new THREE.Color(spec.emissiveColor || 0xffffff);
    material.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  if (alphaMap) {
    material.alphaMap = alphaMap;
    material.alphaTest = spec.alphaTest ?? 0.5;
  } else if (spec.alphaTest !== undefined) {
    material.alphaTest = spec.alphaTest; // cut-out from the colour map's own alpha
  }
  if (spec.doubleSide) material.side = THREE.DoubleSide;
  // The terrain's triangles face down; drawing its back side (rather than both) keeps the
  // shadow bias working with the surface instead of against it.
  if (spec.side === "back") material.side = THREE.BackSide;
  if (spec.roughness !== undefined) material.roughness = spec.roughness;
  if (spec.wind) addWindSway(material, spec.wind);
  return material;
}

// Renders the cemetery straight down into float targets: the ground meshes, every solid mesh,
// and the foliage through its own alpha cut-out. The results are height maps of the ground, of
// whatever stands on it and of the plants, used for walking, rain shelter and resting leaves.
function heightMaps(renderer, scene, groundMeshes, solidMeshes, foliage, box, pavedMeshes = [], res = 512) {
  const size = box.getSize(new THREE.Vector3());
  const camera = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.z / 2, -size.z / 2, 0.1, 100);
  const center = box.getCenter(new THREE.Vector3());
  camera.position.set(center.x, box.max.y + 20, center.z);
  camera.up.set(0, 0, -1); // image rows run from -z (top) to +z (bottom)
  camera.lookAt(center.x, 0, center.z);
  camera.layers.set(31);
  const vertexShader = "varying float vY; varying vec2 vUv; void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }";
  // Alpha marks covered pixels; uncovered ones stay at the clear value (alpha 0).
  const solid = new THREE.ShaderMaterial({ side: THREE.DoubleSide, vertexShader, fragmentShader: "varying float vY; void main() { gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }" });
  // Leaves, pumpkins and bushes only where their texture is opaque, not the empty card around them.
  const cutout = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { map: { value: null } },
    vertexShader,
    fragmentShader: "uniform sampler2D map; varying float vY; varying vec2 vUv; void main() { if (texture2D(map, vUv).a < 0.5) discard; gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }",
  });
  const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  const read = (meshes, cut = false) => {
    if (!meshes.length) return null;
    const saved = meshes.map((m) => m.material);
    meshes.forEach((m) => {
      m.layers.enable(31);
      if (cut) {
        m.material = cutout.clone();
        m.material.uniforms.map.value = saved[meshes.indexOf(m)].map;
      }
    });
    const prev = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadow: renderer.shadowMap.autoUpdate };
    scene.overrideMaterial = cut ? null : solid;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = new Float32Array(res * res * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, res, res, pixels);
    renderer.setRenderTarget(prev.target);
    renderer.setClearColor(prev.color, prev.alpha);
    renderer.shadowMap.autoUpdate = prev.shadow;
    scene.overrideMaterial = prev.override;
    meshes.forEach((m, i) => {
      m.layers.disable(31);
      if (cut) {
        m.material.dispose();
        m.material = saved[i];
      }
    });
    // readRenderTargetPixels returns rows bottom-up; flip so row 0 is the -z edge.
    const out = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const p = ((res - 1 - y) * res + x) * 4;
        out[y * res + x] = pixels[p + 3] > 0.5 ? pixels[p] : -100;
      }
    }
    return out;
  };
  const ground = read(groundMeshes);
  const top = read(solidMeshes);
  const plants = read(foliage, true);
  const paved = read(pavedMeshes); // where the path is, for footstep sounds
  rt.dispose();
  solid.dispose();
  cutout.dispose();
  const cellX = size.x / res;
  const cellZ = size.z / res;
  const sample = (map, x, z) => {
    const i = Math.floor((x - box.min.x) / cellX);
    const j = Math.floor((z - box.min.z) / cellZ);
    if (!map || i < 0 || j < 0 || i >= res || j >= res) return -100;
    return map[j * res + i];
  };
  return { ground, top, plants, paved, res, min: box.min.clone(), cellX, cellZ, sample };
}
// Loads the environment model named in character.json (FBX or glTF) at its original quality.
export async function loadEnvironment(config, scene, renderer) {
  const url = config.model;
  const folder = config.textures || url.slice(0, url.lastIndexOf("/") + 1);
  let root;
  if (/\.fbx$/i.test(url)) {
    const manager = new THREE.LoadingManager();
    // The FBX points at texture paths from the artist's computer; materials are rebuilt below.
    manager.setURLModifier((u) => (/\.(png|jpe?g|tiff?|tga)$/i.test(u) ? BLANK : u));
    root = await new FBXLoader(manager).loadAsync(url);
  } else {
    root = (await new GLTFLoader().loadAsync(url)).scene;
  }

  root.scale.setScalar(config.scale ?? 1);
  root.position.set(...(config.position || [0, 0, 0]));
  root.rotation.y = config.rotationY ?? 0;

  const materials = {};
  await Promise.all(
    Object.entries(config.materials || {}).map(async ([name, spec]) => {
      materials[name] = await buildMaterial(spec, folder, renderer);
      // Everything in the cemetery gets wet in the rain (mist.js); the ground and the path
      // collect puddles. Foliage and the floating lights stay as they are.
      materials[name].userData.wet = !(config.foliage || []).includes(name) && name !== config.wisps?.mesh;
      materials[name].userData.puddles = (config.ground || []).includes(name);
    }),
  );

  const ground = [];
  const meshes = {};
  root.traverse((o) => {
    if (!o.isMesh) return;
    const key = Object.keys(materials).find((k) => k === o.name || k === o.material?.name);
    if (key) o.material = materials[key];
    o.castShadow = !(config.noShadow || []).includes(o.name);
    o.receiveShadow = true;
    meshes[o.name] = o;
    if ((config.ground || []).includes(o.name)) ground.push(o);
  });
  // Small placement fixes in the model's own units (e.g. lift the road above the soil it
  // otherwise pokes through).
  for (const [name, [x, y, z]] of Object.entries(config.offsets || {})) meshes[name]?.position.add(new THREE.Vector3(x, y, z));
  scene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const groundBox = new THREE.Box3();
  ground.forEach((m) => groundBox.union(new THREE.Box3().setFromObject(m)));

  // Height maps of the ground and of everything standing on it (not foliage or flames).
  const solid = Object.values(meshes).filter((m) => !(config.notSolid || []).includes(m.name));
  const foliage = (config.foliage || []).map((n) => meshes[n]).filter((m) => m?.material?.map);
  const paved = (config.paved || ["road"]).map((n) => meshes[n]).filter(Boolean);
  const heights = heightMaps(renderer, scene, ground, solid, foliage, box, paved);
  const groundHeight = (x, z, fallback = 0) => {
    const y = heights.sample(heights.ground, x, z);
    return y > -50 ? y : fallback;
  };
  const surfaceHeight = (x, z) => Math.max(heights.sample(heights.top, x, z), groundHeight(x, z, -100));
  const nav = new NavGrid(heights, config.nav || {});

  // The model's "light" mesh is 170 small floating spheres. All of them read as yellow specks
  // across the sky, so only a few low ones are kept, as pale will-o'-wisps over the graves:
  // faint, pulsing slowly, drifting a little on the wind, casting no shadows.
  const wisps = config.wisps && meshes[config.wisps.mesh];
  if (wisps) {
    keepLowSpheres(wisps, config.wisps, groundHeight);
    wisps.castShadow = false;
    if (config.wisps.color) {
      wisps.material.emissiveMap = null;
      wisps.material.emissive.set(config.wisps.color);
      wisps.material.color.set(0x202428);
    }
    wisps.material.emissiveIntensity = config.wisps.intensity ?? 0.45;
    addWindSway(wisps.material, { ground: 0, reach: 1, amount: config.wisps.drift ?? 0.1 });
  }

  // The real candle flames are in the base mesh, marked by its emission map: each cluster of
  // flames gets one warm, flickering point light.
  const lamps = [];
  const candles = config.candles;
  if (candles && meshes[candles.mesh]) {
    try {
      for (const p of await glowPositions(meshes[candles.mesh], folder + candles.map, candles)) {
        const light = new THREE.PointLight(candles.color ?? 0xffa24a, candles.intensity ?? 3, candles.distance ?? 5, 1.8);
        light.position.copy(p).add(new THREE.Vector3(0, 0.08, 0));
        scene.add(light);
        lamps.push(light);
      }
    } catch (error) {
      console.warn("Could not place candle lights", error);
    }
  }

  // Orange light from each glowing jack-o'-lantern.
  const pumpkins = [];
  const glow = config.glowMesh && config.materials?.[config.glowMesh]?.emissiveMap;
  if (glow && meshes[config.glowMesh]) {
    try {
      for (const p of await glowPositions(meshes[config.glowMesh], folder + glow)) {
        const light = new THREE.PointLight(0xff7a1a, config.pumpkinIntensity ?? 2.5, 4, 1.8);
        light.position.copy(p).add(new THREE.Vector3(0, 0.25, 0));
        scene.add(light);
        pumpkins.push(light);
      }
    } catch (error) {
      console.warn("Could not place pumpkin lights", error);
    }
  }
  let flare = 0;
  let power = 1; // the reanimation draws the power: candles and windows dim, then surge
  const glowing = Object.entries(materials).filter(([name, m]) => m.emissiveMap && name !== config.wisps?.mesh).map(([, m]) => [m, m.emissiveIntensity]);
  const lampBase = candles?.intensity ?? 3;
  const pumpkinBase = config.pumpkinIntensity ?? 2.5;
  const wispBase = config.wisps?.intensity ?? 0.45;

  return {
    root,
    meshes,
    lamps,
    pumpkins,
    nav,
    heights,
    soilMap: materials[config.ground?.[0]]?.map || null,
    box: new THREE.Box3().setFromObject(root),
    groundBox, // the soil and road only: where the outer ground has to meet the cemetery
    // Every pumpkin and lantern blazes up for a moment (a gift effect).
    flare(strength = 1) {
      flare = Math.max(flare, strength);
    },
    // 1 is normal; lower dims every candle, lantern and lit window together.
    power(level = 1) {
      power = Math.max(0, level);
    },
    // Height of the ground under (x, z), so the creature walks on the terrain.
    groundAt: groundHeight,
    // Height of the first solid surface under (x, z): a roof, a grave or the ground.
    surfaceAt: surfaceHeight,
    pieces: (name) => (meshes[name] ? meshPieces(meshes[name]) : []),
    // Takes away the will-o'-wisps floating within `radius` of these places (where he stands for
    // the gift events), so none sits in front of him in a close shot like a stray light on his coat.
    clearWisps(points, radius = 1.4) {
      if (!wisps) return 0;
      const center = new THREE.Vector3();
      const drop = new Set();
      for (const p of meshPieces(wisps)) {
        p.box.getCenter(center);
        if (points.some((q) => Math.hypot(q.x - center.x, q.z - center.z) < radius)) for (const t of p.tris) drop.add(t);
      }
      if (!drop.size) return 0;
      const g = wisps.geometry;
      const index = g.index ? g.index.array : Array.from({ length: g.attributes.position.count }, (_, i) => i);
      const kept = [];
      for (let t = 0; t < index.length; t += 3) if (!drop.has(t)) kept.push(index[t], index[t + 1], index[t + 2]);
      g.setIndex(kept);
      return drop.size;
    },
    // What he is standing on at (x, z), for footstep sounds: the stone path, grass or wet soil.
    surfaceKind(x, z) {
      const g = groundHeight(x, z, -100);
      const path = heights.sample(heights.paved, x, z);
      if (path > -50 && path >= g - 0.02) return "stone";
      if (heights.sample(heights.plants, x, z) - g > 0.12) return "grass";
      return "soil";
    },
    update(t, dt = 0.016) {
      flare = Math.max(0, flare - dt * 0.6);
      const boost = (1 + flare * 3) * power;
      for (const [m, base] of glowing) m.emissiveIntensity = base * (0.2 + 0.8 * power) * (1 + flare * 0.4);
      // Candle flicker: two incommensurate wobbles per lamp plus an occasional gutter.
      lamps.forEach((l, i) => {
        const gutter = Math.sin(t * 0.7 + i * 3.1) > 0.97 ? 0.75 : 1;
        l.intensity = lampBase * boost * gutter * (0.86 + Math.sin(t * 11 + i * 2.1) * 0.07 + Math.sin(t * 23.7 + i) * 0.05);
      });
      pumpkins.forEach((l, i) => (l.intensity = pumpkinBase * boost * (0.82 + Math.sin(t * 9 + i * 1.7) * 0.1 + Math.sin(t * 17 + i) * 0.06)));
      if (wisps) wisps.material.emissiveIntensity = wispBase * (0.65 + 0.35 * Math.sin(t * 0.8)) * (1 + flare);
    },
  };
}

// The separate pieces of a mesh (triangles that share a corner belong together; corners in the
// same place count as shared): each piece's triangle list and world-space bounding box.
export function meshPieces(mesh) {
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  const index = geometry.index ? geometry.index.array : Array.from({ length: pos.count }, (_, i) => i);
  mesh.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const welded = new Int32Array(pos.count);
  const byPlace = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.z * 100)}`;
    if (!byPlace.has(key)) byPlace.set(key, i);
    welded[i] = byPlace.get(key);
  }
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(welded[index[t]]);
    parent[find(welded[index[t + 1]])] = a;
    parent[find(welded[index[t + 2]])] = a;
  }
  const pieces = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const root = find(welded[index[t]]);
    let p = pieces.get(root);
    if (!p) pieces.set(root, (p = { tris: [], box: new THREE.Box3() }));
    p.tris.push(t);
    for (let k = 0; k < 3; k++) p.box.expandByPoint(v.fromBufferAttribute(pos, index[t + k]).applyMatrix4(mesh.matrixWorld));
  }
  return [...pieces.values()];
}

// Splits a mesh made of many separate little spheres into its pieces (triangles that share a
// corner belong together; corners in the same place count as shared) and keeps `keep` of the
// ones floating no higher than `maxHeight` above the ground, spread evenly through the list.
function keepLowSpheres(mesh, { keep = 18, maxHeight = 2.2 } = {}, groundAt) {
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  const index = geometry.index ? geometry.index.array : Array.from({ length: pos.count }, (_, i) => i);
  mesh.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const welded = new Int32Array(pos.count);
  const byPlace = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;
    if (!byPlace.has(key)) byPlace.set(key, i);
    welded[i] = byPlace.get(key);
  }
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(welded[index[t]]);
    for (const k of [1, 2]) parent[find(welded[index[t + k]])] = a;
  }
  const pieces = new Map(); // root -> { triangles, center }
  for (let t = 0; t < index.length; t += 3) {
    const root = find(welded[index[t]]);
    let p = pieces.get(root);
    if (!p) pieces.set(root, (p = { tris: [], sum: new THREE.Vector3(), n: 0 }));
    p.tris.push(t);
    for (let k = 0; k < 3; k++) {
      p.sum.add(v.fromBufferAttribute(pos, index[t + k]).applyMatrix4(mesh.matrixWorld));
      p.n++;
    }
  }
  const low = [...pieces.values()].filter((p) => {
    const c = p.sum.divideScalar(p.n);
    return c.y - groundAt(c.x, c.z, c.y) <= maxHeight;
  });
  const step = Math.max(1, low.length / keep);
  const kept = [];
  for (let i = 0; i < low.length && kept.length < keep; i += step) kept.push(low[Math.floor(i)]);
  const out = [];
  for (const p of kept) for (const t of p.tris) out.push(index[t], index[t + 1], index[t + 2]);
  geometry.setIndex(out);
  geometry.clearGroups();
  return { pieces: pieces.size, kept: kept.length };
}

// Finds the glowing parts of a mesh (jack-o'-lantern faces) by sampling its emission
// texture at every vertex, then clusters them so each pumpkin gets one light.
async function glowPositions(mesh, url, { cell = 0.7, limit = 10, threshold = 0.35 } = {}) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = 1024;
  const h = Math.round((img.height / img.width) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const uv = mesh.geometry.attributes.uv;
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const buckets = new Map();
  mesh.updateMatrixWorld(true);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) - Math.floor(uv.getX(i));
    const t = uv.getY(i) - Math.floor(uv.getY(i));
    const idx = (Math.min(h - 1, Math.floor((1 - t) * h)) * w + Math.min(w - 1, Math.floor(u * w))) * 4;
    const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 765;
    if (brightness < threshold) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const key = `${Math.round(v.x / cell)},${Math.round(v.z / cell)}`;
    const b = buckets.get(key) || { sum: new THREE.Vector3(), n: 0 };
    b.sum.add(v);
    b.n++;
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((b) => b.sum.divideScalar(b.n));
}
