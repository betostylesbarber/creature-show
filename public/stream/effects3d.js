import * as THREE from "three";

const rand = (a, b) => a + Math.random() * (b - a);

function canvasTexture(w, h, draw, color = true) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(canvas);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDot(ctx, w, h, inner = "rgba(255,255,255,1)") {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Night sky dome with stars and a large moon behind the mausoleum.
export function buildSky(scene) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 16),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      map: canvasTexture(1024, 512, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "#03030a");
        g.addColorStop(0.42, "#0b0d24");
        g.addColorStop(0.5, "#2a1838");
        g.addColorStop(0.56, "#120a14");
        g.addColorStop(1, "#050307");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 900; i++) {
          const y = Math.pow(Math.random(), 1.6) * h * 0.48;
          ctx.fillStyle = `rgba(255,255,255,${rand(0.2, 0.9)})`;
          ctx.fillRect(rand(0, w), y, rand(0.6, 1.8), rand(0.6, 1.8));
        }
      }),
    }),
  );
  scene.add(sky);

  const moonTex = canvasTexture(256, 256, (ctx, w, h) => {
    softDot(ctx, w, h, "rgba(200,215,255,0.55)");
    const g = ctx.createRadialGradient(w / 2 - 8, h / 2 - 8, 4, w / 2, h / 2, w * 0.22);
    g.addColorStop(0, "#fbfbff");
    g.addColorStop(0.85, "#d9def0");
    g.addColorStop(1, "rgba(200,210,240,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(150,160,190,0.35)";
    for (const [x, y, r] of [[0.45, 0.42, 0.05], [0.56, 0.55, 0.035], [0.5, 0.6, 0.025]]) {
      ctx.beginPath();
      ctx.arc(w * x, h * y, w * r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true }));
  moon.position.set(-14, 22, -40);
  moon.scale.setScalar(16);
  scene.add(moon);
  return { sky, moon };
}

// Low drifting mist and wandering will-o'-wisps.
export function buildAtmosphere(scene, bounds) {
  const mistTex = canvasTexture(256, 256, (ctx, w, h) => {
    for (let i = 0; i < 26; i++) {
      const x = rand(w * 0.2, w * 0.8);
      const y = rand(h * 0.3, h * 0.7);
      const r = rand(30, 90);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.18)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  });
  const mist = [];
  for (let i = 0; i < 26; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, color: 0x9aa2c8, transparent: true, opacity: rand(0.12, 0.26), depthWrite: false }));
    s.position.set(rand(bounds.min.x, bounds.max.x), rand(0.35, 0.7), rand(bounds.min.z, bounds.max.z - 1.5));
    s.scale.set(rand(4, 7), rand(0.9, 1.5), 1);
    s.userData = { vx: rand(-0.15, 0.15), phase: rand(0, 6) };
    scene.add(s);
    mist.push(s);
  }

  const wispTex = canvasTexture(64, 64, (ctx, w, h) => softDot(ctx, w, h));
  const wisps = [];
  for (let i = 0; i < 4; i++) {
    const color = new THREE.Color().setHSL(rand(0.28, 0.36), 0.9, 0.6);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: wispTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sprite.scale.setScalar(0.35);
    const light = new THREE.PointLight(color, 1.2, 3, 2);
    sprite.add(light);
    sprite.userData = { cx: rand(-4, 4), cz: rand(-4, 3), r: rand(0.8, 2), speed: rand(0.15, 0.35), phase: rand(0, 6) };
    scene.add(sprite);
    wisps.push(sprite);
  }

  return {
    update(t, dt) {
      for (const s of mist) {
        s.position.x += s.userData.vx * dt;
        if (s.position.x > bounds.max.x + 2) s.position.x = bounds.min.x - 2;
        if (s.position.x < bounds.min.x - 2) s.position.x = bounds.max.x + 2;
        s.material.rotation = Math.sin(t * 0.05 + s.userData.phase) * 0.2;
      }
      for (const w of wisps) {
        const u = w.userData;
        const a = t * u.speed + u.phase;
        w.position.set(u.cx + Math.cos(a) * u.r, 1.1 + Math.sin(a * 2.3) * 0.35, u.cz + Math.sin(a) * u.r);
        w.material.opacity = 0.6 + Math.sin(t * 3 + u.phase) * 0.3;
      }
    },
  };
}

// Dust kicked up when the creature lands or stomps.
export class DustBursts {
  constructor(scene) {
    this.scene = scene;
    // The ground is soaked, so a landing throws up a faint spray of water, not a cloud of dust.
    this.tex = canvasTexture(64, 64, (ctx, w, h) => softDot(ctx, w, h, "rgba(170,182,200,0.55)"));
    this.puffs = [];
  }

  burst(position, strength = 1) {
    for (let i = 0; i < 10 + strength * 14; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, opacity: 0.3, depthWrite: false }));
      const a = rand(0, Math.PI * 2);
      s.position.set(position.x + Math.cos(a) * 0.2, position.y + 0.1, position.z + Math.sin(a) * 0.2);
      s.scale.setScalar(rand(0.3, 0.6));
      s.userData = { v: new THREE.Vector3(Math.cos(a) * rand(0.6, 1.6) * strength, rand(0.2, 0.7), Math.sin(a) * rand(0.6, 1.6) * strength), life: rand(0.8, 1.4) };
      this.scene.add(s);
      this.puffs.push(s);
    }
  }

  update(dt) {
    for (const s of this.puffs) {
      s.position.addScaledVector(s.userData.v, dt);
      s.userData.v.multiplyScalar(1 - dt * 2.5);
      s.userData.life -= dt;
      s.scale.multiplyScalar(1 + dt * 0.8);
      s.material.opacity = Math.max(0, s.userData.life * 0.26);
    }
    this.puffs = this.puffs.filter((s) => {
      if (s.userData.life > 0) return true;
      this.scene.remove(s);
      s.material.dispose();
      return false;
    });
  }
}

// Small electric arcs crackling between points on his neck bolts: the "thank you" spark for
// small gifts. A few jagged segments re-drawn every frame, with a tiny blue-white light.
export class NeckSparks {
  constructor(scene) {
    this.scene = scene;
    this.material = new THREE.LineBasicMaterial({ color: new THREE.Color(0xcfe8ff).multiplyScalar(2.6), transparent: true, depthWrite: false, fog: false });
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(8 * 2 * 3 * 3), 3));
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.light = new THREE.PointLight(0xbfe0ff, 0, 1.6, 2);
    scene.add(this.lines, this.light);
    this.life = 0;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
  }

  // Sparks for `seconds`, between the bolt positions returned by `ends()` each frame.
  fire(ends, seconds = 1.2) {
    this.ends = ends;
    this.life = Math.max(this.life, seconds);
  }

  update(dt) {
    this.life = Math.max(0, this.life - dt);
    const on = this.life > 0 && this.ends && Math.random() > 0.15;
    this.lines.visible = on;
    this.light.intensity = on ? 0.5 + Math.random() * 0.7 : 0;
    if (!on) return;
    const [left, right] = this.ends();
    this.light.position.copy(left).lerp(right, 0.5);
    const pos = this.geometry.attributes.position;
    let n = 0;
    // Three arcs: across the neck and a short crackle off each bolt.
    for (const [from, to, segs] of [[left, right, 8], [left, left.clone().add(new THREE.Vector3(rand(-0.08, 0.08), rand(0.04, 0.12), rand(-0.05, 0.08))), 3], [right, right.clone().add(new THREE.Vector3(rand(-0.08, 0.08), rand(0.04, 0.12), rand(-0.05, 0.08))), 3]]) {
      let prev = from.clone();
      for (let s = 1; s <= segs; s++) {
        const p = from.clone().lerp(to, s / segs);
        if (s < segs) p.add(new THREE.Vector3(rand(-0.025, 0.025), rand(-0.025, 0.025), rand(-0.025, 0.025)));
        pos.setXYZ(n++, prev.x, prev.y, prev.z);
        pos.setXYZ(n++, p.x, p.y, p.z);
        prev = p;
      }
    }
    for (let i = n; i < pos.count; i++) pos.setXYZ(i, 0, 0, 0);
    pos.needsUpdate = true;
    this.material.opacity = Math.min(1, this.life * 3);
  }
}

// A gravestone that honours the stream's top supporter by name (no amounts, no asking).
export class GiftStone {
  constructor(scene, position, rotationY = 0) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 640;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.glow = 0;

    const shape = new THREE.Shape();
    shape.moveTo(-0.42, 0);
    shape.lineTo(-0.42, 0.78);
    shape.absarc(0, 0.78, 0.42, Math.PI, 0, true);
    shape.lineTo(0.42, 0);
    shape.lineTo(-0.42, 0);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, curveSegments: 24 });
    geometry.translate(0, 0, -0.07);
    // Front-face UVs from x/y so the carved canvas maps onto the stone face.
    const uv = geometry.attributes.uv;
    const p = geometry.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + 0.45) / 0.9, p.getY(i) / 1.22);
    this.material = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.92, emissive: 0x8cff6a, emissiveMap: this.texture, emissiveIntensity: 0 });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.copy(position);
    this.mesh.rotation.set(-0.06, rotationY, 0.04);
    scene.add(this.mesh);
    this.carve(null);
  }

  carve(entry) {
    const ctx = this.canvas.getContext("2d");
    const { width: w, height: h } = this.canvas;
    ctx.fillStyle = "#6b6a66";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2500; i++) {
      const v = rand(70, 130);
      ctx.fillStyle = `rgba(${v},${v},${v - 6},${rand(0.05, 0.25)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 4));
    }
    ctx.fillStyle = "rgba(60,90,40,0.35)";
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(rand(0, w), h - rand(0, 140), rand(6, 26), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "#24231f";
    ctx.shadowColor = "rgba(255,255,255,0.25)";
    ctx.shadowOffsetY = 2;
    ctx.font = "600 34px Georgia, serif";
    ctx.fillText(entry ? "IN HONOUR OF" : "HERE LIES", w / 2, 210);
    if (entry) {
      let size = 64;
      ctx.font = `700 ${size}px Georgia, serif`;
      while (ctx.measureText(entry.user.nick).width > w * 0.78 && size > 26) ctx.font = `700 ${(size -= 4)}px Georgia, serif`;
      ctx.fillText(entry.user.nick, w / 2, 320);
      ctx.font = "italic 30px Georgia, serif";
      ctx.fillText("tonight's top supporter", w / 2, 385);
    } else {
      ctx.fillText("MY CREATOR'S", w / 2, 270);
      ctx.fillText("PATIENCE", w / 2, 315);
      ctx.font = "italic 30px Georgia, serif";
      ctx.fillText("1797 – 1797", w / 2, 380);
    }
    ctx.font = "600 26px Georgia, serif";
    ctx.fillText("R.I.P.", w / 2, 470);
    this.texture.needsUpdate = true;
    if (entry) this.glow = 1;
  }

  update(dt) {
    this.glow = Math.max(0, this.glow - dt * 0.35);
    this.material.emissiveIntensity = this.glow * 0.6;
  }
}
