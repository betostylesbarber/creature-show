import * as THREE from "three";

// Where the creature can walk to, in the built-in room.
export const ROOM_SPOTS = {
  center: [0, 0, 0],
  library: [-4.9, 0, -4.2],
  fireplace: [4.7, 0, -1.2],
  lab: [3.0, 0, -5.4],
  window: [-1.5, 0, -7.0],
};

function canvasTexture(width, height, draw, repeat = [1, 1]) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...repeat);
  texture.anisotropy = 4;
  return texture;
}

const rand = (a, b) => a + Math.random() * (b - a);

function planks(ctx, w, h) {
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    let x = -rand(0, 200);
    while (x < w) {
      const len = rand(180, 420);
      const shade = rand(28, 48);
      ctx.fillStyle = `rgb(${shade + 22},${shade + 10},${shade})`;
      ctx.fillRect(x, (r * h) / rows, len, h / rows);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, (r * h) / rows, len, h / rows);
      for (let g = 0; g < 6; g++) {
        ctx.strokeStyle = `rgba(0,0,0,${rand(0.08, 0.2)})`;
        ctx.lineWidth = 1;
        const y = (r * h) / rows + rand(4, h / rows - 4);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + len / 3, y + rand(-4, 4), x + (2 * len) / 3, y + rand(-4, 4), x + len, y);
        ctx.stroke();
      }
      x += len;
    }
  }
}

function wallpaper(ctx, w, h) {
  ctx.fillStyle = "#43202a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(170,95,70,0.22)";
  for (let y = 0; y < h; y += 64) {
    for (let x = (y / 64) % 2 ? 32 : 0; x < w; x += 64) {
      ctx.beginPath();
      ctx.ellipse(x, y, 14, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - 2, y - 30, 4, 60);
    }
  }
  const grime = ctx.createLinearGradient(0, 0, 0, h);
  grime.addColorStop(0, "rgba(0,0,0,0.55)");
  grime.addColorStop(0.5, "rgba(0,0,0,0.1)");
  grime.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = grime;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rand(0.05, 0.15)})`;
    ctx.beginPath();
    ctx.arc(rand(0, w), rand(0, h), rand(10, 60), 0, Math.PI * 2);
    ctx.fill();
  }
}

function stones(ctx, w, h) {
  ctx.fillStyle = "#1c1b1d";
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 40) {
    for (let x = (y / 40) % 2 ? -30 : 0; x < w; x += 60) {
      const s = rand(60, 95);
      ctx.fillStyle = `rgb(${s},${s - 4},${s - 8})`;
      ctx.fillRect(x + 2, y + 2, 56, 36);
    }
  }
}

function rug(ctx, w, h) {
  ctx.fillStyle = "#3b0d12";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#a07a3a";
  ctx.lineWidth = 10;
  ctx.strokeRect(20, 20, w - 40, h - 40);
  ctx.lineWidth = 4;
  ctx.strokeRect(45, 45, w - 90, h - 90);
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, 40 + i * 30, 20 + i * 18, 0, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(160,122,58,0.35)";
    ctx.stroke();
  }
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function flameSprite(color = 0xffa040, size = 0.12) {
  const texture = canvasTexture(64, 128, (ctx) => {
    const g = ctx.createRadialGradient(32, 80, 2, 32, 70, 50);
    g.addColorStop(0, "rgba(255,255,220,1)");
    g.addColorStop(0.3, "rgba(255,180,60,0.9)");
    g.addColorStop(1, "rgba(255,80,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(32, 72, 22, 52, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color, blending: THREE.AdditiveBlending, depthWrite: false }));
  sprite.scale.set(size, size * 2, 1);
  return sprite;
}

// Builds a candle-lit haunted study: library, fireplace, Victor's lab and a moonlit window.
// With furnished: false only the lighting, fog and dust are added (for a loaded .glb environment).
export function buildRoom(scene, { furnished = true } = {}) {
  const flickers = [];
  const animated = [];
  let glassMat = null;

  scene.background = new THREE.Color(0x050407);
  scene.fog = new THREE.FogExp2(0x07060a, furnished ? 0.055 : 0.03);

  const ambient = new THREE.AmbientLight(0x2a2440, 0.85);
  const hemi = new THREE.HemisphereLight(0x3a3a6a, 0x120808, 0.5);
  const moonBase = furnished ? 0.9 : 1.7;
  const moon = new THREE.DirectionalLight(0x9fb4ff, moonBase);
  moon.position.set(-2.5, 6, -12);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(4096, 4096);
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.03;
  Object.assign(moon.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 34 });
  scene.add(ambient, hemi, moon, moon.target);

  if (furnished) {
    glassMat = furnishRoom(scene, flickers, animated);
  } else {
    for (const [x, z] of [[-3, -2], [3, -3], [0, 2]]) {
      const light = new THREE.PointLight(0xffa860, 4, 10, 1.6);
      light.position.set(x, 2.4, z);
      scene.add(light);
      flickers.push({ light, base: 4, amount: 1 });
    }
  }

  // Drifting dust in the candlelight.
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(300 * 3);
  for (let i = 0; i < 300; i++) dustPos.set([rand(-6.5, 6.5), rand(0, 4.5), rand(-9, 6)], i * 3);
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustTex = canvasTexture(32, 32, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xffe8c0, map: dustTex, size: 0.03, transparent: true, opacity: 0.4, depthWrite: false }));
  scene.add(dust);

  let lightning = 0;
  let nextLightning = rand(8, 20);

  return {
    spots: ROOM_SPOTS,
    flashLightning() {
      lightning = 1;
    },
    update(t, dt) {
      for (const f of flickers) f.light.intensity = f.base + (Math.sin(t * 13 + f.base) * 0.5 + Math.sin(t * 7.3) * 0.5) * f.amount * 0.5 + rand(-0.1, 0.1) * f.amount;
      for (const fn of animated) fn(t, dt);
      dust.rotation.y += dt * 0.01;
      dust.position.y = Math.sin(t * 0.2) * 0.1;

      nextLightning -= dt;
      if (nextLightning <= 0) {
        lightning = 1;
        nextLightning = rand(15, 40);
      }
      const flash = lightning > 0.5 ? (Math.sin(lightning * 40) > 0 ? 1 : 0.3) : lightning;
      moon.intensity = moonBase + flash * 6;
      ambient.intensity = 0.85 + flash * 1.2;
      glassMat?.color.setScalar(1 + flash * 2);
      lightning = Math.max(0, lightning - dt * 1.6);
    },
  };
}

// Walls, furniture and props of the built-in room. Returns the window glass so lightning can light it.
function furnishRoom(scene, flickers, animated) {
  const floorMat = new THREE.MeshStandardMaterial({ map: canvasTexture(1024, 1024, planks, [6, 8]), roughness: 0.85 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 18), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ map: canvasTexture(512, 512, wallpaper, [4, 2]), roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(14, 7), wallMat);
  back.position.set(0, 3.5, -9);
  back.receiveShadow = true;
  const left = new THREE.Mesh(new THREE.PlaneGeometry(18, 7), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-7, 3.5, -2);
  left.receiveShadow = true;
  const right = left.clone();
  right.rotation.y = -Math.PI / 2;
  right.position.x = 7;
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(14, 18), new THREE.MeshStandardMaterial({ color: 0x0c0a0a, roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 7, -2);
  scene.add(back, left, right, ceiling);

  const wood = new THREE.MeshStandardMaterial({ color: 0x2b1a10, roughness: 0.8 });
  for (const x of [-4.5, 0, 4.5]) scene.add(box(0.35, 0.35, 18, wood, x, 6.8, -2));
  scene.add(box(14, 0.3, 0.12, wood, 0, 0.15, -8.94));

  const rugMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 3), new THREE.MeshStandardMaterial({ map: canvasTexture(512, 384, rug), roughness: 1 }));
  rugMesh.rotation.x = -Math.PI / 2;
  rugMesh.position.set(0, 0.01, -0.6);
  rugMesh.receiveShadow = true;
  scene.add(rugMesh);

  // Moonlit window on the back wall.
  const windowGroup = new THREE.Group();
  windowGroup.position.set(-1.5, 3.4, -8.95);
  const glassMat = new THREE.MeshBasicMaterial({
    map: canvasTexture(256, 384, (ctx, w, h) => {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#1b2a4a");
      sky.addColorStop(1, "#0a0f1e");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      const moonGlow = ctx.createRadialGradient(170, 100, 5, 170, 100, 70);
      moonGlow.addColorStop(0, "rgba(240,240,255,1)");
      moonGlow.addColorStop(0.35, "rgba(200,210,255,0.9)");
      moonGlow.addColorStop(1, "rgba(120,140,220,0)");
      ctx.fillStyle = moonGlow;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#05070d";
      for (let i = 0; i < 9; i++) ctx.fillRect(i * 30, h - rand(40, 120), 22, 200);
    }),
  });
  windowGroup.add(new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.6), glassMat));
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 0.7 });
  windowGroup.add(box(2.1, 0.15, 0.2, frameMat, 0, 1.35, 0.05), box(2.1, 0.15, 0.2, frameMat, 0, -1.35, 0.05));
  windowGroup.add(box(0.15, 2.8, 0.2, frameMat, -1.0, 0, 0.05), box(0.15, 2.8, 0.2, frameMat, 1.0, 0, 0.05));
  windowGroup.add(box(0.07, 2.6, 0.1, frameMat, 0, 0, 0.05), box(1.8, 0.07, 0.1, frameMat, 0, 0.3, 0.05));
  scene.add(windowGroup);

  // Library: a tall bookshelf on the left wall.
  const shelf = new THREE.Group();
  shelf.position.set(-6.55, 0, -4.2);
  shelf.rotation.y = Math.PI / 2;
  shelf.add(box(3.6, 4.2, 0.12, wood, 0, 2.1, -0.4));
  for (const x of [-1.8, 1.8]) shelf.add(box(0.12, 4.2, 0.8, wood, x, 2.1, 0));
  for (let s = 0; s < 6; s++) {
    const y = 0.1 + s * 0.78;
    shelf.add(box(3.6, 0.08, 0.8, wood, 0, y, 0));
    let x = -1.7;
    while (x < 1.65 && s < 5) {
      const bw = rand(0.08, 0.16);
      const bh = rand(0.45, 0.68);
      const hue = [0x5a1e1e, 0x1e3a2a, 0x2a2a4a, 0x4a3a1e, 0x3a1e3a, 0x222222][Math.floor(rand(0, 6))];
      const book = box(bw, bh, 0.5, new THREE.MeshStandardMaterial({ color: hue, roughness: 0.8 }), x + bw / 2, y + bh / 2 + 0.04, 0);
      if (Math.random() < 0.08) book.rotation.z = 0.25;
      shelf.add(book);
      x += bw + 0.01;
    }
  }
  scene.add(shelf);

  // Fireplace on the right wall.
  const fire = new THREE.Group();
  fire.position.set(6.6, 0, -1.2);
  fire.rotation.y = -Math.PI / 2;
  const stoneMat = new THREE.MeshStandardMaterial({ map: canvasTexture(256, 256, stones, [2, 2]), roughness: 0.9 });
  fire.add(box(0.5, 2.0, 0.6, stoneMat, -1.05, 1.0, 0), box(0.5, 2.0, 0.6, stoneMat, 1.05, 1.0, 0));
  fire.add(box(2.6, 0.5, 0.6, stoneMat, 0, 2.2, 0), box(2.9, 0.12, 0.8, wood, 0, 2.5, 0.05));
  fire.add(box(1.6, 1.7, 0.1, new THREE.MeshStandardMaterial({ color: 0x050303 }), 0, 0.85, -0.25));
  for (let i = 0; i < 3; i++) fire.add(box(0.9, 0.12, 0.14, wood, rand(-0.2, 0.2), 0.12 + i * 0.06, rand(-0.1, 0.1)));
  const flames = [];
  for (let i = 0; i < 5; i++) {
    const f = flameSprite(0xff8a30, rand(0.35, 0.55));
    f.position.set(rand(-0.45, 0.45), 0.5, rand(-0.1, 0.1));
    fire.add(f);
    flames.push(f);
  }
  const fireLight = new THREE.PointLight(0xff7a2a, 9, 12, 1.6);
  fireLight.position.set(0, 0.9, 0.7);
  fireLight.castShadow = true;
  fireLight.shadow.mapSize.set(512, 512);
  fire.add(fireLight);
  scene.add(fire);
  flickers.push({ light: fireLight, base: 9, amount: 3 });
  animated.push((t) =>
    flames.forEach((f, i) => {
      f.scale.y = f.scale.x * (2 + Math.sin(t * 9 + i * 1.7) * 0.35);
      f.position.y = 0.45 + Math.sin(t * 7 + i) * 0.03;
    }),
  );

  // Victor's laboratory table with glowing flasks and a spark coil.
  const lab = new THREE.Group();
  lab.position.set(3.0, 0, -6.9);
  lab.add(box(3.0, 0.1, 1.1, wood, 0, 1.0, 0));
  for (const [x, z] of [[-1.4, -0.45], [1.4, -0.45], [-1.4, 0.45], [1.4, 0.45]]) lab.add(box(0.1, 1.0, 0.1, wood, x, 0.5, z));
  const flaskColors = [0x55ff88, 0xaa55ff, 0x55ccff, 0x88ff55];
  for (let i = 0; i < 6; i++) {
    const color = flaskColors[i % flaskColors.length];
    const flask = new THREE.Mesh(
      new THREE.SphereGeometry(rand(0.09, 0.15), 16, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4, transparent: true, opacity: 0.85 }),
    );
    flask.position.set(-1.1 + i * 0.36, 1.18, rand(-0.25, 0.25));
    lab.add(flask);
    lab.add(box(0.04, 0.2, 0.04, new THREE.MeshStandardMaterial({ color: 0xcccccc, transparent: true, opacity: 0.4 }), flask.position.x, 1.32, flask.position.z));
  }
  const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, metalness: 0.8, roughness: 0.3 }));
  coil.position.set(1.15, 1.65, 0.1);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshStandardMaterial({ color: 0xbbbbcc, metalness: 0.9, roughness: 0.2 }));
  ball.position.set(1.15, 2.3, 0.1);
  lab.add(coil, ball);
  const labLight = new THREE.PointLight(0x66ff99, 2.5, 6, 1.8);
  labLight.position.set(0, 1.6, 0.6);
  lab.add(labLight);
  const arcMat = new THREE.LineBasicMaterial({ color: 0xccddff, transparent: true, opacity: 0 });
  const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 8 }, () => new THREE.Vector3())), arcMat);
  lab.add(arc);
  scene.add(lab);
  flickers.push({ light: labLight, base: 2.5, amount: 0.8 });
  animated.push(() => {
    if (Math.random() < 0.02) {
      const pts = arc.geometry.attributes.position;
      for (let i = 0; i < 8; i++) pts.setXYZ(i, 1.15 + rand(-0.3, 0.3) * Math.sin((i / 7) * Math.PI), 2.3 - i * 0.1, 0.1 + rand(-0.2, 0.2));
      pts.needsUpdate = true;
      arcMat.opacity = 1;
    }
    arcMat.opacity *= 0.85;
  });

  // Candelabras.
  const brass = new THREE.MeshStandardMaterial({ color: 0x7a5a2a, metalness: 0.7, roughness: 0.4 });
  const wax = new THREE.MeshStandardMaterial({ color: 0xe8e0c8 });
  for (const [x, z] of [[-3.2, -1.5], [2.4, -3.6], [-5.6, -7.6], [5.6, -6.5]]) {
    const stand = new THREE.Group();
    stand.position.set(x, 0, z);
    stand.add(box(0.06, 1.6, 0.06, brass, 0, 0.8, 0), box(0.5, 0.05, 0.05, brass, 0, 1.6, 0));
    for (const cx of [-0.22, 0, 0.22]) {
      stand.add(box(0.05, 0.22, 0.05, wax, cx, 1.74, 0));
      const f = flameSprite(0xffb060, 0.06);
      f.position.set(cx, 1.9, 0);
      stand.add(f);
    }
    const light = new THREE.PointLight(0xffa860, 1.6, 5, 1.8);
    light.position.set(0, 2.0, 0);
    stand.add(light);
    scene.add(stand);
    flickers.push({ light, base: 1.6, amount: 0.5 });
  }

  // Wall sconces that wash the back wall in candlelight.
  for (const x of [-4.4, 0.9, 5.2]) {
    scene.add(box(0.12, 0.3, 0.12, brass, x, 3.0, -8.85));
    const f = flameSprite(0xffb060, 0.08);
    f.position.set(x, 3.3, -8.75);
    scene.add(f);
    const light = new THREE.PointLight(0xffa060, 3.5, 7, 1.4);
    light.position.set(x, 3.4, -8.3);
    scene.add(light);
    flickers.push({ light, base: 3.5, amount: 0.8 });
  }

  // Portrait of a stern gentleman (Victor) on the back wall.
  const portrait = new THREE.Group();
  portrait.position.set(3.2, 3.8, -8.93);
  portrait.add(box(1.5, 1.9, 0.08, new THREE.MeshStandardMaterial({ color: 0x6a4a1a, metalness: 0.6, roughness: 0.4 })));
  const painting = new THREE.Mesh(
    new THREE.PlaneGeometry(1.25, 1.65),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 320, (ctx, w, h) => {
        ctx.fillStyle = "#1a1410";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#3a2c20";
        ctx.beginPath();
        ctx.ellipse(w / 2, h * 0.38, 46, 58, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(w / 2 - 80, h * 0.6, 160, h * 0.4);
      }),
      roughness: 0.9,
    }),
  );
  painting.position.z = 0.05;
  portrait.add(painting);
  scene.add(portrait);

  return glassMat;
}
