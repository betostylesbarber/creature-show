import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { meshPieces } from "./env.js";
import { addWindSway } from "./mist.js";

// The land beyond the fence, so the cemetery stands in a real place instead of on a flat plane:
// rolling ground that rises gently towards the hills of the skyline, and an overgrown old
// graveyard and wood of real 3D objects: copies of the cemetery's own dead trees and bushes
// (with their leaves), and weathered headstones. Everything is merged into a handful of meshes
// (a few draw calls), lit by the same moon and fading into the same mist and haze.

const rand = (a, b) => a + Math.random() * (b - a);

// Smooth value noise for the terrain.
function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Distance from (x, z) to the outside of the box (0 inside it).
const outside = (box, x, z) => Math.hypot(Math.max(box.min.x - x, 0, x - box.max.x), Math.max(box.min.z - z, 0, z - box.max.z));

// Rolling ground around the cemetery: flat for the first metre and a half beyond the fence (so
// it meets the cemetery's own ground cleanly), then low mounds, rising slowly with distance to
// meet the hills. Matte, not rain-glossy: a big wet plane mirrors the sky and reads as a sheet.
export function buildTerrain(scene, box, soilTexture, base = 0.367) {
  const heightAt = (x, z) => {
    const d = outside(box, x, z);
    const mounds = (noise(x * 0.09, z * 0.09) * 1.3 + noise(x * 0.23 + 7, z * 0.23 + 3) * 0.55 - 0.75) * smooth(1.5, 9, d);
    const rise = d > 18 ? ((d - 18) / 42) ** 2 * 7 : 0;
    return base - 0.012 + Math.max(-0.15, mounds) + rise;
  };
  const half = 62;
  const cell = 1.5;
  const n = Math.round((half * 2) / cell);
  const positions = [];
  const uvs = [];
  const index = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -half + i * cell;
      const z = -half + j * cell;
      positions.push(x, heightAt(x, z), z);
      uvs.push(x * 0.25, z * 0.25);
    }
  }
  const inset = 0.08;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * cell;
      const z0 = -half + j * cell;
      // Leave out cells that lie entirely inside the cemetery.
      if (x0 >= box.min.x + inset && x0 + cell <= box.max.x - inset && z0 >= box.min.z + inset && z0 + cell <= box.max.z - inset) continue;
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const tex = soilTexture.clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: tex, color: 0x2a2622, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);
  return { mesh: ground, heightAt };
}

// A copy of some triangles of a mesh in world space, moved so the piece's footprint centre is at
// the origin (x, z) and its lowest point at y = 0.
function extract(mesh, tris, pivot) {
  const src = mesh.geometry;
  const index = src.index ? src.index.array : null;
  const names = ["position", "normal", "uv", "uv1"].filter((k) => src.attributes[k]);
  const remap = new Map();
  const out = Object.fromEntries(names.map((k) => [k, []]));
  const idx = [];
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[t + k] : t + k;
      let ni = remap.get(vi);
      if (ni === undefined) {
        ni = remap.size;
        remap.set(vi, ni);
        v.fromBufferAttribute(src.attributes.position, vi).applyMatrix4(m).sub(pivot);
        out.position.push(v.x, v.y, v.z);
        if (out.normal) {
          v.fromBufferAttribute(src.attributes.normal, vi).applyMatrix3(nm).normalize();
          out.normal.push(v.x, v.y, v.z);
        }
        if (out.uv) out.uv.push(src.attributes.uv.getX(vi), src.attributes.uv.getY(vi));
        if (out.uv1) out.uv1.push(src.attributes.uv1.getX(vi), src.attributes.uv1.getY(vi));
      }
      idx.push(ni);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.position, 3));
  if (out.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(out.normal, 3));
  if (out.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  if (out.uv1) g.setAttribute("uv1", new THREE.Float32BufferAttribute(out.uv1, 2));
  g.setIndex(idx);
  return g;
}

// Whether a piece of a mesh glows: its emission map sampled at the piece's first triangle.
function emissiveTest(mesh) {
  const image = mesh?.material?.emissiveMap?.image;
  const uv = mesh?.geometry.attributes.uv;
  if (!image || !uv) return () => false;
  const w = 256;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const index = mesh.geometry.index?.array;
  return (piece) => {
    let u = 0;
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[piece.tris[0] + k] : piece.tris[0] + k;
      u += uv.getX(vi) / 3;
      v += uv.getY(vi) / 3;
    }
    const x = Math.min(w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor((1 - (v - Math.floor(v))) * h)));
    const p = (y * w + x) * 4;
    return data[p] + data[p + 1] + data[p + 2] > 120;
  };
}

// The cemetery's own trees and bushes as reusable prefabs: each trunk piece of the main mesh
// together with the leaf cards of the foliage mesh that sit in its crown.
function prefabs(env, config) {
  const baseMesh = env.meshes[config.mesh || "base"];
  const leafMesh = env.meshes[config.foliage || "plants"];
  if (!baseMesh) return [];
  // Glowing foliage pieces (the jack-o'-lantern faces live in the foliage mesh) stay home: only
  // leaves are copied, so the wood adds no yellow specks.
  const glows = emissiveTest(leafMesh);
  const leaves = leafMesh ? meshPieces(leafMesh).filter((l) => !glows(l)) : [];
  const size = new THREE.Vector3();
  const out = [];
  for (const piece of meshPieces(baseMesh)) {
    piece.box.getSize(size);
    const kind = size.y > 2.8 && size.x > 1.6 ? "tree" : size.y > 1.4 && size.y <= 2.8 && size.x > 1.0 && piece.tris.length > 400 ? "bush" : null;
    if (!kind) continue;
    const pivot = new THREE.Vector3((piece.box.min.x + piece.box.max.x) / 2, piece.box.min.y, (piece.box.min.z + piece.box.max.z) / 2);
    const crown = piece.box.clone().expandByScalar(0.25);
    const leafTris = leaves.filter((l) => crown.containsPoint(l.box.getCenter(new THREE.Vector3()))).flatMap((l) => l.tris);
    // A real tree or bush carries leaves; tall, bare pieces are walls and the crypt.
    if (leafTris.length < (kind === "tree" ? 120 : 30)) continue;
    out.push({ kind, height: size.y, trunk: extract(baseMesh, piece.tris, pivot), leaves: extract(leafMesh, leafTris, pivot) });
  }
  // Ground cover: the cemetery's own grass and weed tufts (low foliage standing on the ground).
  const floor = env.groundAt;
  for (const l of leaves) {
    l.box.getSize(size);
    const c = l.box.getCenter(new THREE.Vector3());
    if (size.y < 0.12 || size.y > 0.7 || Math.max(size.x, size.z) > 0.9 || l.box.min.y - floor(c.x, c.z, 0.4) > 0.12) continue;
    if (out.filter((p) => p.kind === "tuft").length >= 24) break;
    const pivot = new THREE.Vector3(c.x, l.box.min.y, c.z);
    out.push({ kind: "tuft", height: size.y, trunk: null, leaves: extract(leafMesh, l.tris, pivot) });
  }
  return out.map((p) => ({ ...p, materials: { trunk: baseMesh.material, leaves: leafMesh?.material } }));
}

// A weathered headstone: a rounded or square-topped slab, sometimes a cross, leaning a little.
function headstoneGeometry(kind) {
  if (kind === 2) {
    const post = new THREE.BoxGeometry(0.14, 1.0, 0.12).translate(0, 0.5, 0);
    const arm = new THREE.BoxGeometry(0.56, 0.13, 0.12).translate(0, 0.68, 0);
    return mergeGeometries([post, arm]);
  }
  const w = 0.55;
  const h = 0.75;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  if (kind === 0) {
    shape.lineTo(w / 2, h - w / 2);
    shape.absarc(0, h - w / 2, w / 2, 0, Math.PI, false);
  } else {
    shape.lineTo(w / 2, h);
    shape.lineTo(-w / 2, h);
  }
  shape.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -0.06);
  return g;
}

// The wood's leaves: the cemetery's own leaf texture, matte (seen against the moon from behind,
// glossy leaves glint white like snow) and without the pumpkin glow, swaying in the same wind.
function matteLeaves(source, wind) {
  if (!source) return null;
  const m = new THREE.MeshStandardMaterial({ map: source.map, normalMap: source.normalMap, normalScale: source.normalScale.clone(), alphaTest: source.alphaTest, side: source.side, roughness: 1, color: 0xb8aa98 });
  m.envMapIntensity = 0.35;
  addWindSway(m, wind || {});
  return m;
}

function stoneMaterial() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#6d6a63";
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    const s = Math.random();
    g.fillStyle = `rgba(${s < 0.5 ? "30,32,28" : "150,148,140"},${Math.random() * 0.25})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // Moss towards the foot.
  const moss = g.createLinearGradient(0, 128, 0, 60);
  moss.addColorStop(0, "rgba(58,70,40,0.6)");
  moss.addColorStop(1, "rgba(58,70,40,0)");
  g.fillStyle = moss;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  m.userData.wet = true;
  return m;
}

export function buildSurroundings(scene, env, { box, heightAt, keepClear = [], config = {} }) {
  const kinds = prefabs(env, config);
  const trees = kinds.filter((k) => k.kind === "tree");
  const bushes = kinds.filter((k) => k.kind === "bush");
  const parts = { trunk: [], leaves: [], stone: [] };
  const placed = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const clear = (x, z, r) => keepClear.every((c) => Math.hypot(c.x - x, c.z - z) > c.r + r) && placed.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
  // `behind`: the share of placements in the land behind the back fence, which is what the
  // camera mostly looks at; the rest go to the sides.
  const spot = (near, far, r, behind = 0.7) => {
    for (let i = 0; i < 60; i++) {
      const back = Math.random() < behind;
      const x = back ? rand(box.min.x - far * 0.6, box.max.x + far * 0.6) : rand(box.min.x - far, box.max.x + far);
      const z = back ? rand(box.min.z - far, box.min.z - near) : rand(box.min.z - far, box.max.z - 1);
      const d = outside(box, x, z);
      if (d < near || d > far || !clear(x, z, r)) continue;
      return { x, z };
    }
    return null;
  };
  const put = (prefab, at, scale) => {
    q.setFromAxisAngle(up, rand(0, Math.PI * 2));
    s.setScalar(scale);
    p.set(at.x, heightAt(at.x, at.z) - 0.05 * scale, at.z);
    m.compose(p, q, s);
    if (prefab.trunk) parts.trunk.push(prefab.trunk.clone().applyMatrix4(m));
    if (prefab.leaves) parts.leaves.push(prefab.leaves.clone().applyMatrix4(m));
  };
  // Grass and weeds all over the near ground, thinning out with distance (they never block anything).
  const tufts = kinds.filter((k) => k.kind === "tuft");
  if (tufts.length) {
    for (let i = 0; i < 520; i++) {
      const back = Math.random() < 0.7;
      const x = back ? rand(box.min.x - 6, box.max.x + 6) : rand(box.min.x - 9, box.max.x + 9);
      const z = back ? rand(box.min.z - 9, box.min.z - 0.25) : rand(box.min.z - 9, box.max.z - 1);
      const d = outside(box, x, z);
      if (d < 0.25 || d > 9 || Math.random() < d / 12) continue;
      put(tufts[i % tufts.length], { x, z }, rand(0.9, 1.6));
    }
  }
  // Trees: a few close behind the fence, more further out, bigger with distance.
  if (trees.length) {
    for (let i = 0; i < 74; i++) {
      const near = i < 34 ? 1.2 : 5;
      const far = i < 34 ? 7 : 26;
      const at = spot(near, far, 1.3, 0.55);
      if (!at) continue;
      const d = outside(box, at.x, at.z);
      const scale = rand(1.1, 1.5) + d * 0.04;
      placed.push({ ...at, r: 1.0 * scale });
      put(trees[i % trees.length], at, scale);
    }
  }
  // Bushes and undergrowth along the fence and between the trees.
  if (bushes.length) {
    for (let i = 0; i < 90; i++) {
      const at = spot(i < 48 ? 0.7 : 2, i < 48 ? 5 : 18, 0.7);
      if (!at) continue;
      const scale = rand(0.8, 1.35);
      placed.push({ ...at, r: 0.55 * scale });
      put(bushes[i % bushes.length], at, scale);
    }
  }
  // An older graveyard beyond the fence: headstones in loose rows, leaning, some fallen behind.
  const shapes = [0, 1, 2].map((k) => {
    const g = headstoneGeometry(k);
    return g.index ? g.toNonIndexed() : g;
  });
  for (let i = 0; i < 64; i++) {
    const at = spot(1.0, 14, 0.4);
    if (!at) continue;
    placed.push({ ...at, r: 0.35 });
    const lean = new THREE.Euler(rand(-0.18, 0.12), rand(-0.5, 0.5) + (at.x < box.min.x || at.x > box.max.x ? Math.PI / 2 : 0), rand(-0.12, 0.12));
    q.setFromEuler(lean);
    s.setScalar(rand(0.8, 1.25));
    p.set(at.x, heightAt(at.x, at.z) - 0.06, at.z);
    m.compose(p, q, s);
    parts.stone.push(shapes[i % 3].clone().applyMatrix4(m));
  }

  const group = new THREE.Group();
  const add = (list, material) => {
    if (!list.length || !material) return;
    const mesh = new THREE.Mesh(mergeGeometries(list), material);
    mesh.receiveShadow = true;
    group.add(mesh);
    list.forEach((g) => g.dispose());
  };
  add(parts.trunk, kinds[0]?.materials.trunk);
  add(parts.leaves, matteLeaves(kinds[0]?.materials.leaves, config.wind));
  add(parts.stone, stoneMaterial());
  scene.add(group);
  return { group, counts: { trees: trees.length, bushes: bushes.length, placed: placed.length } };
}
