import * as THREE from "three";
import { Locomotion, Performer } from "./motion.js";

const TAU = Math.PI * 2;
const DIMS = { hip: 1.22, shoulder: 0.82, arm: 1.0 };

// Fallback creature built from simple shapes, used only when no character model is set
// in character.json: eight feet tall, yellow skin, long black hair, a long dark coat.
export class Creature {
  constructor(scene, spots, { ground, onImpact, onFlash, onMarker, onStep } = {}) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.joints = {};
    this.build();
    this.locomotion = new Locomotion(this.root, spots, ground);
    this.performer = new Performer(this.locomotion, DIMS, { onImpact, onFlash, onMarker, onStep });
  }

  joint(name, parent, x = 0, y = 0, z = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    this.joints[name] = g;
    return g;
  }

  build() {
    const mat = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
    const skin = mat(0xc7b47a, 0.7);
    const coat = mat(0x2a2420, 0.9);
    const shirt = mat(0x3d3b38, 0.95);
    const trousers = mat(0x1e1c1a, 0.95);
    const boots = mat(0x121010, 0.6);
    const hair = mat(0x0a0a0c, 0.92);
    const lips = mat(0x141010, 0.5);
    const stitch = mat(0x5a4a2a, 0.9);

    const add = (parent, geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 12);
    const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);

    const pelvis = this.joint("pelvis", this.root, 0, DIMS.hip, 0);
    add(pelvis, boxG(0.44, 0.24, 0.28), trousers);
    // Long coat skirt hanging from the waist; it pivots at the waist so it can keep hanging downwards.
    this.skirt = new THREE.Group();
    pelvis.add(this.skirt);
    add(this.skirt, new THREE.CylinderGeometry(0.29, 0.4, 0.85, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9, side: THREE.DoubleSide }), 0, -0.36, 0);

    for (const [side, sx] of [["L", 1], ["R", -1]]) {
      const hip = this.joint(`hip${side}`, pelvis, 0.13 * sx, -0.06, 0);
      add(hip, capsule(0.105, 0.42), trousers, 0, -0.29, 0);
      const knee = this.joint(`knee${side}`, hip, 0, -0.58, 0);
      add(knee, capsule(0.09, 0.42), trousers, 0, -0.28, 0);
      const ankle = this.joint(`ankle${side}`, knee, 0, -0.52, 0);
      add(ankle, boxG(0.17, 0.14, 0.34), boots, 0, -0.04, 0.07);
    }

    const spine = this.joint("spine", pelvis, 0, 0.1, 0);
    add(spine, capsule(0.2, 0.18), coat, 0, 0.12, 0);
    add(spine, boxG(0.16, 0.34, 0.02), shirt, 0, 0.12, 0.2);
    const chest = this.joint("chest", spine, 0, 0.3, 0);
    add(chest, boxG(0.66, 0.52, 0.36), coat, 0, 0.22, 0);
    add(chest, boxG(0.22, 0.4, 0.02), shirt, 0, 0.24, 0.185);
    add(chest, boxG(0.7, 0.12, 0.4), coat, 0, 0.47, 0);

    const neck = this.joint("neck", chest, 0, 0.5, 0.02);
    add(neck, new THREE.CylinderGeometry(0.085, 0.1, 0.18, 12), skin, 0, 0.06, 0);
    add(neck, boxG(0.16, 0.015, 0.02), stitch, 0, 0.05, 0.095);

    const head = this.joint("head", neck, 0, 0.14, 0);
    const skull = add(head, new THREE.SphereGeometry(0.16, 24, 18), skin, 0, 0.13, 0);
    skull.scale.set(0.92, 1.25, 1.0);
    add(head, boxG(0.22, 0.035, 0.06), skin, 0, 0.165, 0.125);
    add(head, boxG(0.18, 0.012, 0.02), stitch, 0, 0.25, 0.14, -0.3);
    for (const sx of [1, -1]) {
      add(head, new THREE.SphereGeometry(0.03, 12, 10), mat(0x1a1612, 1), 0.06 * sx, 0.12, 0.125);
      add(head, new THREE.SphereGeometry(0.022, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd8d2bf, roughness: 0.15, metalness: 0.1 }), 0.06 * sx, 0.12, 0.138);
    }
    add(head, boxG(0.04, 0.08, 0.05), skin, 0, 0.07, 0.15);
    add(head, boxG(0.12, 0.018, 0.03), lips, 0, 0.0, 0.135);
    const jaw = this.joint("jaw", head, 0, 0.0, 0.02);
    add(jaw, boxG(0.19, 0.08, 0.17), skin, 0, -0.045, 0.04);
    add(jaw, boxG(0.12, 0.018, 0.03), lips, 0, -0.012, 0.118);
    add(jaw, boxG(0.1, 0.012, 0.02), mat(0xf4f1e6, 0.3), 0, 0.002, 0.11);
    add(head, boxG(0.1, 0.012, 0.02), mat(0xf4f1e6, 0.3), 0, -0.012, 0.128);

    const cap = add(head, new THREE.SphereGeometry(0.17, 24, 12, 0, TAU, 0, Math.PI / 2), hair, 0, 0.18, -0.01);
    cap.scale.set(0.95, 0.9, 1.05);
    add(head, boxG(0.3, 0.52, 0.06), hair, 0, -0.02, -0.15, 0.12);
    for (const sx of [1, -1]) {
      add(head, boxG(0.05, 0.42, 0.14), hair, 0.15 * sx, 0.0, -0.04, 0, 0, 0.06 * sx);
      add(head, boxG(0.04, 0.3, 0.05), hair, 0.11 * sx, 0.05, 0.08, 0, 0, 0.12 * sx);
    }

    for (const [side, sx] of [["L", 1], ["R", -1]]) {
      const shoulder = this.joint(`shoulder${side}`, chest, 0.38 * sx, 0.42, 0);
      add(shoulder, capsule(0.09, 0.34), coat, 0, -0.24, 0);
      const elbow = this.joint(`elbow${side}`, shoulder, 0, -0.47, 0);
      add(elbow, capsule(0.078, 0.3), coat, 0, -0.2, 0);
      add(elbow, new THREE.CylinderGeometry(0.085, 0.085, 0.06, 12), shirt, 0, -0.4, 0);
      add(elbow, boxG(0.1, 0.17, 0.06), skin, 0, -0.5, 0);
      add(elbow, boxG(0.11, 0.012, 0.065), stitch, 0, -0.44, 0);
    }
  }

  perform(action, options) {
    this.performer.perform(action, options);
  }

  clear() {
    this.performer.clear();
  }

  get current() {
    return this.performer.current;
  }

  update(dt, t, speech) {
    const p = this.performer.pose(dt, t, speech);
    for (const [name, g] of Object.entries(this.joints)) {
      g.rotation.set(p[`${name}.rx`] || 0, p[`${name}.ry`] || 0, p[`${name}.rz`] || 0);
    }
    this.joints.pelvis.position.set(p["pelvis.px"] || 0, p["pelvis.py"], p["pelvis.pz"] || 0);
    // Counter-rotate the coat so gravity wins during flips, push-ups and handstands.
    this.skirt.rotation.set(-(p["pelvis.rx"] || 0) * 0.9, 0, -(p["pelvis.rz"] || 0));
    this.root.rotation.y = this.performer.yaw;
  }

  get headPosition() {
    return this.joints.head.getWorldPosition(new THREE.Vector3());
  }
}
