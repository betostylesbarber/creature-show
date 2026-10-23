import { PRIORITY } from "./motion.js";

// What he does on his own in quiet moments, so he lives in the cemetery instead of standing
// still or pacing at random: now and then he goes to look over the pumpkins, checks the gate,
// inspects the apparatus, or just looks around, and he glances up at distant thunder. Each
// outing walks to a checked place (the gift events' own locations), looks, and comes back to
// the audience. Never while he is talking, while lines are waiting, during a gift event or an
// audience moment; at irregular intervals with real rests between them.
const rand = (a, b) => a + Math.random() * (b - a);

export class Activities {
  constructor(hub, events, { minGap = 60, maxGap = 140 } = {}) {
    const ctx = hub.ctx;
    this.ctx = ctx;
    this.events = events;
    this.gap = [minGap, maxGap];
    this.next = rand(minGap, maxGap);
    this.task = null;
    this.last = null;
    this.quietSince = performance.now();
    this.interactionUntil = 0;
    hub.on("message", (m) => {
      if (m.t === "choice" || m.t === "mystery" || m.t === "surprise") this.interactionUntil = performance.now() + 60_000;
      if (m.t === "segStart" || m.t === "gift" || m.t === "action") this.quietSince = performance.now();
      if (m.t === "skip") this.cancel();
    });
    hub.on("speech", () => (this.quietSince = performance.now()));
    hub.on("lightning", (t) => this.thunder(t));
  }

  get avatar() {
    return this.ctx.avatar;
  }

  // He sets off only in a lull: a few seconds after a line ends (idle chatter comes every 20 s or
  // so, and an outing that a new line interrupts just ends with him talking where he is, then
  // walking back), never with lines waiting, an event on, or an audience moment running.
  busy() {
    const a = this.avatar.current;
    return !!(this.events.current || this.events.queue.length || this.ctx.speech?.talking || this.ctx.linesPending?.() || (a && a.priority > PRIORITY.fidget) || performance.now() < this.interactionUntil || performance.now() - this.quietSince < 4000);
  }

  thunder({ delay = 1, strength = 0.5 } = {}) {
    if (strength < 0.25 || this.busy() || this.task || Math.random() < 0.4) return;
    setTimeout(() => !this.busy() && !this.task && this.avatar.perform("glance_up", { priority: PRIORITY.ai }), Math.min(2500, delay * 600));
  }

  frame(place) {
    const { THREE, cameraRig } = this.ctx;
    const p = this.avatar.root.position;
    const look = new THREE.Vector3(p.x, p.y + 1.55, p.z).lerp(new THREE.Vector3(place.target.x, p.y + 1.0, place.target.z), 0.25);
    for (const a of [0.75, -0.75, 1.0, -1.0, 1.3, -1.3]) {
      const yaw = place.yaw + a;
      if (cameraRig?.set({ pos: new THREE.Vector3(p.x + Math.sin(yaw) * 3, p.y + 1.8, p.z + Math.cos(yaw) * 3), look })) return;
    }
  }

  // Ends an outing early. He stops where he is (so he can face the viewer he answers) and walks
  // back to the audience once he is free again; walks wait while he talks.
  cancel() {
    if (!this.task) return;
    this.task = null;
    if (!this.events.current) this.ctx.cameraRig?.clear();
    this.ctx.send?.({ t: "activity", seconds: 0 });
    const a = this.avatar;
    a.locomotion.faceYaw = null;
    if (a.current?.name === "activity_walk") a.performer.interrupt();
    a.performer.queue = a.performer.queue.filter((q) => q.name !== "activity_walk");
    const c = this.events.locations.center;
    const p = a.locomotion.root.position;
    if (c && Math.hypot(p.x - c.stand.x, p.z - c.stand.z) > 1.2) a.performer.walkToPoint(c.stand.x, c.stand.z, { priority: PRIORITY.ai, name: "return_walk" });
  }

  update(dt) {
    if (this.task) return this.step(dt);
    if (this.busy()) {
      this.next = Math.max(this.next, 12);
      return;
    }
    if ((this.next -= dt) > 0) return;
    this.next = rand(...this.gap);
    const options = ["pumpkin", "gate", "lever", "look"].filter((k) => k === "look" || this.events.locations[k]);
    let kind = options[Math.floor(Math.random() * options.length)];
    if (kind === this.last && options.length > 1) kind = options[(options.indexOf(kind) + 1) % options.length];
    this.last = kind;
    if (kind === "look") {
      this.avatar.perform(Math.random() < 0.5 ? "look_around" : "glance_up", { priority: PRIORITY.ai });
      return;
    }
    const place = this.events.locations[kind];
    this.task = { place, phase: "walk", t: 0 };
    // The server holds its idle chatter meanwhile (and logs the outing for the operator).
    this.ctx.send?.({ t: "activity", seconds: 22, kind: { pumpkin: "the pumpkins", gate: "the gate", lever: "the apparatus" }[kind] });
    this.avatar.performer.walkToPoint(place.stand.x, place.stand.z, { priority: PRIORITY.ai, name: "activity_walk" });
  }

  // walk → face what he came to see → look it over → back to the audience.
  step(dt) {
    const task = this.task;
    task.t += dt;
    const a = this.avatar;
    const loco = a.locomotion;
    // Anything more important (a gift, a line, a viewer's command) ends the outing at once.
    if (this.events.current || this.ctx.speech?.talking || this.ctx.linesPending?.() || (a.current && a.current.priority > PRIORITY.ai)) {
      // A gift event stages him itself; anything else gets him back to the audience.
      if (this.events.current) {
        this.task = null;
        loco.faceYaw = null;
      } else this.cancel();
      return;
    }
    if (task.phase === "walk") {
      const arrived = a.current?.name !== "activity_walk" && task.t > 1;
      if (!arrived && task.t < 14) return;
      loco.faceYaw = task.place.yaw;
      task.phase = "look";
      task.t = 0;
      a.perform("inspect", { priority: PRIORITY.ai });
    } else if (task.phase === "look") {
      // Once he has turned to it, a quiet side angle on him looking it over (if one is clear).
      if (!task.framed && task.t > 0.9) {
        task.framed = true;
        this.frame(task.place);
      }
      if (task.t < 4.2) return;
      this.ctx.cameraRig?.clear();
      loco.faceYaw = null;
      const c = this.events.locations.center;
      task.phase = "return";
      task.t = 0;
      if (c) a.performer.walkToPoint(c.stand.x, c.stand.z, { priority: PRIORITY.ai, name: "activity_walk" });
    } else if (task.t > 1 && a.current?.name !== "activity_walk") {
      this.task = null;
      this.ctx.send?.({ t: "activity", seconds: 0 });
    }
  }
}
