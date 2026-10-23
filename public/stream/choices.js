// Audience choices, environmental mysteries and free surprises on the stream side. The server
// (src/choices.js) decides and sends "choice", "mystery", "surprise" and "scene" messages; this
// file draws them: the vote card (through overlay.js), a flickering lantern or knocking crypt, a
// ghost rising from the right grave, a shooting star. main.js only calls initChoices.
//
// Cues for the sound system, emitted on the hub as hub.emit("cue", { name, ... }):
//   choice-open     a vote started               { id, setId }
//   choice-close    the vote ended               { id, setId, how: "votes" | "tie" | "none", winner }
//   mystery-clue    a clue appeared              { id, kind, visual, at: [x, z] }
//   mystery-payoff  he arrived and it paid off   { id, kind, payoff, at: [x, z] }
//   surprise        a shooting star crossed      { id, kind: "star" }
import { Ghosts } from "./spooky.js";

const smooth = (x) => x * x * (3 - 2 * x);

// How strongly a clue disturbs a light at `t` seconds after it began: multiplies the light's
// normal intensity (1 is untouched).
const PATTERNS = {
  // A lantern that cannot hold its flame: hard, uneven flicker.
  flicker: (t) => {
    const n = Math.sin(t * 37) + Math.sin(t * 23.3 + 1) + Math.sin(t * 9.1 + 2);
    return n > 0.15 ? 1.7 : 0.06;
  },
  // Three knocks, a pause, again: the nearest light jumps with each.
  knock: (t) => {
    const phase = t % 3.6;
    let pulse = 0;
    for (const at of [0, 0.5, 1.0]) pulse = Math.max(pulse, Math.exp(-(((phase - at) * 9) ** 2)));
    return 0.45 + 2.4 * pulse;
  },
  // Pumpkins that breathe slowly.
  breathe: (t) => 1 + 1.3 * (0.5 + 0.5 * Math.sin(t * 2.2)),
  // A slow sway of light, as if something moved in the branches.
  creak: (t) => 0.4 + 1.1 * (0.5 + 0.5 * Math.sin(t * 1.3)) * (Math.sin(t * 0.37) > -0.3 ? 1 : 0.4),
};

export function initChoices(hub) {
  const ctx = hub.ctx;
  if (!ctx) return;
  const { overlay, environment, scene } = ctx;
  const preview = !!ctx.preview;
  // The protected regions are the overlay's live object (overlay.js keeps it up to date); this is
  // a second way to hand it over in case main.js builds ctx again.
  if (overlay?.layout) ctx.layout = overlay.layout;

  const ghosts = scene ? new Ghosts(scene) : null;
  let clue = null; // the mystery clue on show: { id, kind, visual, spot, lights, t0, fading }
  let watch = null; // him walking to a mystery's spot: { id, at, since }

  const spotOf = (key) => ctx.spots?.[key]?.at || null; // [x, z]
  const worldAt = (at, lift = 0) => new ctx.THREE.Vector3(at[0], ctx.ground(at[0], at[1]) + lift, at[1]);

  // The lights nearest a spot: the real candle lamps (or pumpkin lights) are what a clue plays on.
  function lightsNear(at, pool, count) {
    if (!at || !pool?.length) return [];
    return pool
      .map((light) => ({ light, d: Math.hypot(light.position.x - at[0], light.position.z - at[1]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .filter((l) => l.d < 6)
      .map((l) => l.light);
  }

  // --- Choices ---------------------------------------------------------------------------
  function onChoice(msg) {
    switch (msg.phase) {
      case "open":
        overlay.showChoice(msg);
        if (!msg.quiet) hub.emit("cue", { name: "choice-open", id: msg.id, setId: msg.setId }); // (not when catching up)
        break;
      case "update":
        overlay.updateChoice(msg);
        break;
      case "close":
        overlay.closeChoice(msg);
        hub.emit("cue", { name: "choice-close", id: msg.id, setId: msg.setId, how: msg.how, winner: msg.winner });
        break;
      case "cancel":
        overlay.hideCard(msg.id);
        break;
    }
  }

  // A scene outcome the vote (or a wish) picked: the same effects gifts use.
  function onScene(msg) {
    if (typeof msg.effect === "string") ctx.effect?.(msg.effect);
  }

  // --- Mysteries -------------------------------------------------------------------------
  function startClue(msg) {
    endClue(true);
    const at = spotOf(msg.spot);
    const pool = msg.visual === "breathe" ? environment?.pumpkins : environment?.lamps;
    clue = { id: msg.id, kind: msg.kind, visual: msg.visual, spot: msg.spot, at, lights: lightsNear(at, pool, msg.visual === "breathe" ? 3 : 2), t0: performance.now() / 1000, fade: 1, fading: false };
    if (!msg.quiet) {
      overlay.toast(msg.hint);
      hub.emit("cue", { name: "mystery-clue", id: msg.id, kind: msg.kind, visual: msg.visual, at });
    }
  }

  function endClue(now) {
    if (!clue) return;
    if (now) clue = null;
    else clue.fading = true;
  }

  function startWatch(msg) {
    if (preview) return;
    watch = { id: msg.id, at: spotOf(msg.spot), since: performance.now() };
  }

  // He has walked to the spot: tell the server (it plays the payoff for every window at once).
  function checkArrival() {
    if (!watch) return;
    const p = ctx.avatar?.root?.position;
    const waited = performance.now() - watch.since;
    const near = watch.at && p ? Math.hypot(p.x - watch.at[0], p.z - watch.at[1]) < 1.6 : waited > 6000; // no map: assume he made it
    if (!near || waited < 800) return;
    ctx.send?.({ t: "mysteryArrived", id: watch.id });
    watch = null;
  }

  function payoff(msg) {
    watch = null;
    const at = spotOf(msg.spot);
    overlay.toast(msg.payoffText);
    hub.emit("cue", { name: "mystery-payoff", id: msg.id, kind: msg.kind, payoff: msg.payoff, at });
    environment?.flare(1.3);
    if (msg.payoff === "ghost" && ghosts && at) {
      // A ghost, and a smaller one behind it, rise from that very grave.
      const p = worldAt(at, 0.2);
      ghosts.rise([p, p.clone().add(new ctx.THREE.Vector3(0.5, 0, -0.4))]);
    } else if (msg.payoff === "bats") ctx.effect?.("bats");
    else if (msg.payoff === "pumpkins") ctx.effect?.("pumpkins");
    else if (msg.payoff === "lightning") ctx.effect?.("lightning");
    endClue(false);
  }

  function onMystery(msg) {
    switch (msg.phase) {
      case "clue":
        startClue(msg);
        break;
      case "investigate":
        startWatch(msg);
        break;
      case "payoff":
        payoff(msg);
        break;
      case "expire":
      case "cancel":
        watch = null;
        endClue(false);
        break;
    }
  }

  // --- Surprises -------------------------------------------------------------------------
  // A streak across the upper sky, far behind everything (so he and the trees pass in front of
  // it): a camera-facing strip with a bright head and a fading tail, drawn additively.
  const stars = [];
  let starTexture = null;
  function shootingStar() {
    const { THREE, camera } = ctx;
    if (!THREE || !scene || !camera) return;
    if (!starTexture) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 16;
      const g = canvas.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 256, 0);
      grad.addColorStop(0, "rgba(180,210,255,0)");
      grad.addColorStop(0.7, "rgba(200,225,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,1)");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 8);
      g.quadraticCurveTo(200, 0, 256, 8);
      g.quadraticCurveTo(200, 16, 0, 8);
      g.fill();
      starTexture = new THREE.CanvasTexture(canvas);
    }
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const material = new THREE.MeshBasicMaterial({ map: starTexture, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false });
    material.color.setScalar(3); // bright enough to bloom
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.22), material);
    mesh.position.copy(camera.position).addScaledVector(dir, 70).addScaledVector(right, 24).addScaledVector(up, 19);
    // Travel across and down the sky, head first; the strip faces the camera, turned along its path.
    const velocity = new THREE.Vector3().addScaledVector(right, -40).addScaledVector(up, -7);
    mesh.quaternion.copy(camera.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(-7, -40)));
    scene.add(mesh);
    stars.push({ mesh, material, velocity, age: 0 });
  }

  function updateStars(dt) {
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.age += dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      s.material.opacity = Math.min(1, s.age / 0.12) * Math.min(1, (1.5 - s.age) / 0.4);
      if (s.age >= 1.5) {
        scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.material.dispose();
        stars.splice(i, 1);
      }
    }
  }

  function onSurprise(msg) {
    switch (msg.phase) {
      case "start":
        overlay.showWish({ id: msg.id, title: "A shooting star", hint: "Type wish in chat", leftMs: msg.leftMs, count: msg.count });
        if (!msg.quiet) {
          shootingStar();
          hub.emit("cue", { name: "surprise", id: msg.id, kind: msg.kind });
        }
        break;
      case "update":
        overlay.updateWish(msg);
        break;
      case "end":
        overlay.closeWish(msg);
        break;
      case "cancel":
        overlay.hideCard(msg.id);
        break;
    }
  }

  hub.on("message", (msg) => {
    if (msg.t === "choice") onChoice(msg);
    else if (msg.t === "scene") onScene(msg);
    else if (msg.t === "mystery") onMystery(msg);
    else if (msg.t === "surprise") onSurprise(msg);
    else if (msg.t === "skip") {
      // "Unstick" clears the audience moments on the server; clear them here at once too.
      watch = null;
      endClue(false);
    }
  });

  // A window opened in the middle of a vote or a clue: the server's first message on connect came
  // before this scene was ready, so ask for the moment again now.
  ctx.send?.({ t: "syncInteraction" });

  // Every frame, after the environment has set its lights: bend the clue's lights, drive the
  // ghosts raised for a payoff, and watch for his arrival.
  let frames = 0;
  hub.on("frame", ({ dt, t }) => {
    ghosts?.update(t, dt);
    if (stars.length) updateStars(dt);
    if (watch && ++frames % 6 === 0) checkArrival();
    if (!clue) return;
    if (clue.fading) clue.fade -= dt;
    if (clue.fade <= 0) {
      clue = null;
      return;
    }
    const age = performance.now() / 1000 - clue.t0;
    const strength = smooth(Math.min(1, age / 1.2)) * smooth(Math.min(1, clue.fade));
    const factor = 1 + ((PATTERNS[clue.visual]?.(age) ?? 1) - 1) * strength;
    for (const light of clue.lights) light.intensity *= factor;
  });
}
