import * as THREE from "three";

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

const glowTexture = canvasTexture(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});

// --- Bats ----------------------------------------------------------------------------
function wingGeometry(side) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.12 * side, 0.1, 0.3 * side, 0.05);
  s.quadraticCurveTo(0.26 * side, -0.02, 0.22 * side, -0.06);
  s.quadraticCurveTo(0.17 * side, -0.02, 0.13 * side, -0.07);
  s.quadraticCurveTo(0.08 * side, -0.02, 0.03 * side, -0.06);
  s.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

export class Bats {
  constructor(scene, center) {
    this.scene = scene;
    this.center = center;
    this.material = new THREE.MeshBasicMaterial({ color: 0x050307, side: THREE.DoubleSide });
    this.bodyGeo = new THREE.SphereGeometry(0.045, 8, 6);
    this.bodyGeo.scale(1, 0.8, 1.7);
    this.wingL = wingGeometry(1);
    this.wingR = wingGeometry(-1);
    this.bats = [];
    // A couple circle high overhead; small groups cross the sky now and then, so a swarm
    // from a gift still feels special.
    for (let i = 0; i < 3; i++) this.add({ orbit: true });
    this.nextFlyover = 20 + Math.random() * 25;
  }

  flyover() {
    const fromLeft = Math.random() < 0.5;
    const n = 2 + Math.floor(Math.random() * 3);
    const y = rand(4.5, 7);
    const z = rand(-6, -2);
    for (let i = 0; i < n; i++) {
      const bat = this.add({ orbit: false, life: 9, scale: rand(1.3, 2), from: new THREE.Vector3(this.center.x + (fromLeft ? -14 : 14), y + rand(-0.6, 0.6), z + rand(-1, 1)) });
      bat.vel.set((fromLeft ? 1 : -1) * rand(3, 4.5), rand(-0.2, 0.3), rand(-0.4, 0.4));
      bat.steady = true;
    }
  }

  add({ orbit, from, life = Infinity, scale = rand(1.6, 2.6) }) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.material);
    const l = new THREE.Mesh(this.wingL, this.material);
    const r = new THREE.Mesh(this.wingR, this.material);
    g.add(body, l, r);
    g.scale.setScalar(scale);
    this.scene.add(g);
    const bat = {
      g,
      l,
      r,
      orbit,
      life,
      phase: rand(0, 10),
      radius: rand(5, 11),
      height: rand(3.6, 7),
      speed: rand(0.25, 0.5) * (Math.random() < 0.5 ? -1 : 1),
      angle: rand(0, Math.PI * 2),
      vel: from ? new THREE.Vector3(rand(-2, 2), rand(1.5, 3.5), rand(2, 5)) : null,
    };
    if (from) g.position.copy(from).add(new THREE.Vector3(rand(-0.4, 0.4), rand(0, 0.6), rand(-0.4, 0.4)));
    this.bats.push(bat);
    return bat;
  }

  // A swarm bursts out of the crypt towards the camera, then scatters into the sky.
  swarm(from, count = 30) {
    // Performance budget: never more than 50 swarming bats at once, however many gifts arrive.
    const room = Math.max(0, 50 - this.bats.filter((b) => !b.orbit).length);
    for (let i = 0; i < Math.min(count, room); i++) this.add({ orbit: false, from, life: rand(3, 5), scale: rand(1.2, 2.2) });
  }

  update(t, dt) {
    if ((this.nextFlyover -= dt) <= 0) {
      this.flyover();
      this.nextFlyover = 30 + Math.random() * 50;
    }
    for (const b of this.bats) {
      const flap = Math.sin(t * 18 + b.phase) * 0.9;
      b.l.rotation.z = flap;
      b.r.rotation.z = -flap;
      if (b.orbit) {
        b.angle += b.speed * dt * 0.35;
        const x = this.center.x + Math.cos(b.angle) * b.radius;
        const z = this.center.z + Math.sin(b.angle) * b.radius * 0.7;
        const y = b.height + Math.sin(t * 0.7 + b.phase) * 1.2;
        const next = new THREE.Vector3(x, y, z);
        b.g.lookAt(next.clone().add(new THREE.Vector3(-Math.sin(b.angle) * b.speed, 0, Math.cos(b.angle) * b.speed)));
        b.g.position.copy(next);
      } else {
        if (!b.steady) {
          b.vel.x += Math.sin(t * 3 + b.phase) * dt * 4;
          b.vel.y += dt * 0.6;
        } else b.vel.y += Math.sin(t * 2.2 + b.phase) * dt * 0.8;
        b.g.lookAt(b.g.position.clone().add(b.vel));
        b.g.position.addScaledVector(b.vel, dt);
        b.life -= dt;
      }
    }
    this.bats = this.bats.filter((b) => {
      if (b.life > 0) return true;
      this.scene.remove(b.g);
      return false;
    });
  }
}

// --- Ghosts --------------------------------------------------------------------------
const ghostTexture = canvasTexture(256, 320, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(235,245,255,0.95)");
  g.addColorStop(1, "rgba(200,220,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(w * 0.15, h * 0.42);
  ctx.bezierCurveTo(w * 0.15, h * 0.02, w * 0.85, h * 0.02, w * 0.85, h * 0.42);
  ctx.lineTo(w * 0.88, h * 0.95);
  for (let i = 0; i < 5; i++) ctx.quadraticCurveTo(w * (0.8 - i * 0.15), h * 0.8, w * (0.73 - i * 0.15), h * 0.95);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(10,10,25,0.9)";
  for (const x of [0.38, 0.62]) {
    ctx.beginPath();
    ctx.ellipse(w * x, h * 0.3, w * 0.06, h * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.45, w * 0.07, h * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
});

export class Ghosts {
  constructor(scene) {
    this.scene = scene;
    this.ghosts = [];
  }

  rise(positions) {
    for (const p of positions.slice(0, Math.max(0, 10 - this.ghosts.length))) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ghostTexture, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xb8d0ff }));
      s.position.set(p.x, p.y + 0.3, p.z);
      s.scale.set(0.9, 1.1, 1);
      this.scene.add(s);
      this.ghosts.push({ s, age: 0, life: rand(6, 8), phase: rand(0, 6), drift: new THREE.Vector3(rand(-0.3, 0.3), rand(0.35, 0.6), rand(-0.2, 0.3)) });
    }
  }

  update(t, dt) {
    for (const g of this.ghosts) {
      g.age += dt;
      g.s.position.addScaledVector(g.drift, dt);
      g.s.position.x += Math.sin(t * 1.6 + g.phase) * dt * 0.4;
      const fade = Math.min(1, g.age / 1.2) * Math.min(1, (g.life - g.age) / 1.5);
      g.s.material.opacity = Math.max(0, fade) * 0.75;
      g.s.material.rotation = Math.sin(t * 2 + g.phase) * 0.12;
    }
    this.ghosts = this.ghosts.filter((g) => {
      if (g.age < g.life) return true;
      this.scene.remove(g.s);
      g.s.material.dispose();
      return false;
    });
  }
}

// --- Lightning bolts -----------------------------------------------------------------
export class Bolts {
  constructor(scene) {
    this.scene = scene;
    this.bolts = [];
    this.light = new THREE.PointLight(0xb8c8ff, 0, 18, 1.4);
    scene.add(this.light);
  }

  strike(target, { color = 0xcfe0ff, from } = {}) {
    if (this.bolts.length >= 3) return; // a few bolts at a time is plenty, and stays cheap
    const start = from || target.clone().add(new THREE.Vector3(rand(-5, 5), 22, rand(-8, -2)));
    const meshes = [];
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, fog: false });
    material.color.multiplyScalar(4); // HDR bright so it blooms
    const branch = (a, b, radius, depth) => {
      const points = [a.clone()];
      const steps = 14;
      for (let i = 1; i < steps; i++) {
        const p = a.clone().lerp(b, i / steps);
        const jitter = a.distanceTo(b) * 0.06;
        p.add(new THREE.Vector3(rand(-jitter, jitter), rand(-jitter * 0.3, jitter * 0.3), rand(-jitter, jitter)));
        points.push(p);
      }
      points.push(b.clone());
      const path = new THREE.CurvePath();
      for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, points.length * 2, radius, 5, false), material);
      this.scene.add(mesh);
      meshes.push(mesh);
      if (depth > 0) {
        for (let i = 0; i < 2; i++) {
          const from = points[Math.floor(rand(2, points.length - 3))];
          branch(from, from.clone().add(new THREE.Vector3(rand(-3, 3), rand(-4, -1.5), rand(-3, 3))), radius * 0.5, depth - 1);
        }
      }
    };
    branch(start, target, 0.05, 2);
    this.light.position.copy(target).add(new THREE.Vector3(0, 1.5, 0.5));
    this.light.intensity = 60;
    this.bolts.push({ meshes, material, life: 0.45 });
  }

  update(dt) {
    this.light.intensity *= Math.exp(-dt * 9);
    for (const b of this.bolts) {
      b.life -= dt;
      b.material.opacity = Math.max(0, b.life / 0.45) * (Math.random() > 0.2 ? 1 : 0.3);
    }
    this.bolts = this.bolts.filter((b) => {
      if (b.life > 0) return true;
      for (const m of b.meshes) {
        this.scene.remove(m);
        m.geometry.dispose();
      }
      b.material.dispose();
      return false;
    });
  }
}

// --- Fireworks -----------------------------------------------------------------------
export class Fireworks {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
  }

  launch(count = 5, colors = [0xff8a1e, 0xa040ff, 0x6aff4a, 0xffd24a]) {
    for (let i = 0; i < Math.min(count, Math.max(0, 10 - this.bursts.length)); i++) {
      // Low over the back fence, so they land inside a portrait frame.
      setTimeout(() => this.burst(new THREE.Vector3(rand(-5, 6), rand(4.8, 7.5), rand(-13, -9)), colors[i % colors.length]), i * 380);
    }
  }

  burst(center, color) {
    const n = 160;
    const positions = new Float32Array(n * 3);
    const velocities = [];
    for (let i = 0; i < n; i++) {
      positions.set([center.x, center.y, center.z], i * 3);
      const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(3, 5.5));
      velocities.push(v);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ map: glowTexture, color, size: 0.45, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    mat.color.multiplyScalar(3);
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.bursts.push({ points, velocities, life: 2.2 });
  }

  update(dt) {
    for (const b of this.bursts) {
      b.life -= dt;
      const pos = b.points.geometry.attributes.position;
      for (let i = 0; i < b.velocities.length; i++) {
        const v = b.velocities[i];
        v.y -= dt * 2.2;
        v.multiplyScalar(1 - dt * 0.9);
        pos.setXYZ(i, pos.getX(i) + v.x * dt, pos.getY(i) + v.y * dt, pos.getZ(i) + v.z * dt);
      }
      pos.needsUpdate = true;
      b.points.material.opacity = Math.min(1, b.life);
    }
    this.bursts = this.bursts.filter((b) => {
      if (b.life > 0) return true;
      this.scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      return false;
    });
  }
}
