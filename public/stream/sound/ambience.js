// The living environment: continuous layers that follow the weather and what the camera
// sees, and sparse one-shot details on randomized, context-checked schedules.
//
// Layers (each a crossfading loop from a real recording, two decorrelated playheads where a
// wide image helps; all mono-compatible):
//   wind      soft outdoor wind, louder with the gusts        amb.wind  (x2, L/R)
//   air       distant low air movement                        amb.air
//   trees     leaves and branches, driven by gusts            amb.trees (x2)
//   rain      fine distant wash + near drops                  rain.far (x2), rain.near (x2)
//   surfaces  rain on stone, foliage, the iron fence/roof, puddles; drips after a storm
//   storm     heavy rain                                      rain.heavy (x2)
//   candles   crackle scaled to the candles the camera sees   amb.candle, amb.fire (pumpkins)
//   lab       the apparatus' hum, by distance                 amb.hum
//   spirit    a barely-there supernatural air                 amb.spirit
// Details: fence creaks and rattles in gusts, crypt settling, branches, rare crows, owls and
// bats (not in a storm, never over speech), thunder for every flash in the sky.
import { thunderPlan, spatial, makeRandom } from "./rules.js";

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const DRIZZLE = 0.32;

export class Ambience {
  constructor(engine, hub, { random = Math.random } = {}) {
    this.engine = engine;
    this.hub = hub;
    this.random = random;
    this.weather = { rain: DRIZZLE, storm: 0, wind: 0.3 };
    this.layers = {};
    this.enabled = { wind: true, trees: true, rain: true, rainSurfaces: true, thunder: true, candles: true, creaks: true, wildlife: true, supernatural: true, lab: true };
    this.started = false;
    this.wet = 0; // how soaked the place is (drips linger after a storm)
    this.details = {}; // next time for each detail
    this.lastDetailAt = -Infinity;
    this.lastWildlifeAt = -Infinity;
    this.blockDetailsUntil = 0;
    this.speaking = false;
    this.eventActive = false;
    this.candleRef = null;
    this.candleSamples = [];
    this.nextScene = 0;
    this.boost = { wind: 0, candles: 0, fire: 0, spirit: 0, drips: 0 };
  }

  start() {
    if (this.started) return;
    const L = (id, opts) => this.engine.layer(id, opts);
    this.layers = {
      windL: L("amb.wind", { pan: -0.55, segment: [9, 16], xfade: 3 }),
      windR: L("amb.wind", { pan: 0.55, segment: [9, 16], xfade: 3 }),
      air: L("amb.air", { segment: [10, 18], xfade: 3.5 }),
      treesL: L("amb.trees", { pan: -0.45, segment: [8, 14], xfade: 2.5 }),
      treesR: L("amb.trees", { pan: 0.5, segment: [8, 14], xfade: 2.5 }),
      rainFarL: L("rain.far", { bus: "weather", pan: -0.6, segment: [8, 14] }),
      rainFarR: L("rain.far", { bus: "weather", pan: 0.6, segment: [8, 14] }),
      rainNearL: L("rain.near", { bus: "weather", pan: -0.35, segment: [7, 12] }),
      rainNearR: L("rain.near", { bus: "weather", pan: 0.4, segment: [7, 12] }),
      leaves: L("rain.leaves", { bus: "weather", pan: -0.3, segment: [7, 12] }),
      stone: L("rain.stone", { bus: "weather", pan: 0.15, segment: [8, 14] }),
      metal: L("rain.metal", { bus: "weather", pan: 0.45, segment: [8, 14] }),
      puddle: L("rain.puddle", { bus: "weather", pan: -0.1, segment: [6, 10] }),
      heavyL: L("rain.heavy", { bus: "weather", pan: -0.5, segment: [8, 14] }),
      heavyR: L("rain.heavy", { bus: "weather", pan: 0.5, segment: [8, 14] }),
      drips: L("rain.drips", { bus: "weather", pan: 0.2, segment: [8, 14] }),
      candle: L("amb.candle", { segment: [5, 7], xfade: 1.2, lowpass: 12000 }),
      fire: L("amb.fire", { segment: [7, 12], xfade: 2, lowpass: 12000 }),
      // (crossfaded segments, not a sample loop: an Opus round trip leaves a small step at the
      // file's wrap point, measurable on a smooth hum)
      hum: L("amb.hum", { segment: [6, 9], xfade: 2.5, lowpass: 3000 }),
      spirit: L("amb.spirit", { segment: [12, 20], xfade: 5 }),
    };
    for (const l of Object.values(this.layers)) l.start(0, 0.1);
    this.started = true;
    this.apply(4);
  }

  stop() {
    for (const l of Object.values(this.layers)) l.stop(1.5);
    this.layers = {};
    this.started = false;
  }

  setEnabled(layers = {}) {
    Object.assign(this.enabled, layers);
    this.apply(0.8);
  }

  setWeather({ rain, storm, wind }) {
    if (Number.isFinite(rain)) this.weather.rain = rain;
    if (Number.isFinite(storm)) this.weather.storm = storm;
    if (Number.isFinite(wind)) this.weather.wind = wind;
  }

  // Target levels from the weather, ~every 0.5 s; setTargetAtTime smooths between updates.
  apply(seconds = 1.2) {
    if (!this.started) return;
    const e = this.enabled;
    const s = clamp01((this.weather.rain - DRIZZLE) / (1 - DRIZZLE)); // 0 drizzle .. 1 storm
    const w = this.weather.wind;
    const gust = clamp01((w - 0.25) / 0.4); // 0 calm .. 1 a strong normal gust
    const stormWind = clamp01((w - 0.65) / 1.0);
    const on = (flag, v) => (flag ? v : 0);
    const L = this.layers;
    const b = this.boost;
    const set = (name, v, t = seconds) => L[name]?.setLevel(v, t);
    const windLevel = on(e.wind, 0.45 + 0.4 * gust + 0.45 * stormWind + b.wind);
    set("windL", windLevel);
    set("windR", windLevel * (0.9 + 0.1 * Math.sin(this.engine.now * 0.13)));
    set("air", on(e.wind, 0.5 + 0.4 * s + 0.3 * b.wind));
    const trees = on(e.trees, 0.12 + 0.75 * gust ** 1.4 + 0.5 * stormWind + 0.5 * b.wind);
    set("treesL", trees, seconds * 0.8);
    set("treesR", trees * 0.85, seconds * 1.1);
    const rain = on(e.rain, 1);
    set("rainFarL", rain * (0.7 + 0.5 * s));
    set("rainFarR", rain * (0.7 + 0.5 * s));
    set("rainNearL", rain * (0.5 + 0.7 * s));
    set("rainNearR", rain * (0.45 + 0.7 * s));
    const surf = on(e.rain && e.rainSurfaces, 1);
    set("leaves", surf * (0.55 + 0.6 * s));
    set("stone", surf * (0.5 + 0.6 * s));
    set("metal", surf * (0.22 + 0.9 * s));
    set("puddle", surf * (0.35 + 0.75 * s));
    set("heavyL", rain * s ** 1.5);
    set("heavyR", rain * s ** 1.5);
    set("drips", surf * clamp01(0.25 + 0.6 * this.wet * (1 - s) + b.drips));
    set("spirit", on(e.supernatural, 0.55 + b.spirit), 3);
  }

  // ~10 Hz from the frame hook: candles and the apparatus follow the camera; details.
  update(ctx, now) {
    if (!this.started) return;
    if (now >= this.nextScene) {
      this.nextScene = now + 0.25;
      this.scene(ctx);
    }
    const s = clamp01((this.weather.rain - DRIZZLE) / (1 - DRIZZLE));
    this.wet += ((s > 0.3 ? 1 : 0) - this.wet) * (s > 0.3 ? 0.02 : 0.002);
    this.detailsTick(ctx, now, s);
  }

  // Loudness of the candles and pumpkins the camera can see, relative to the usual view.
  scene(ctx) {
    const cam = ctx?.camera;
    const env = ctx?.environment;
    if (!cam || !env) return;
    const lights = (list) => {
      let sum = 0;
      let pan = 0;
      for (const l of list || []) {
        const local = toCamera(cam, l, ctx.THREE);
        if (!local || local.z > -0.2) continue; // behind the camera
        const d2 = local.x * local.x + local.y * local.y + local.z * local.z;
        const c = (l.intensity || 1) / Math.max(1.5, d2);
        sum += c;
        pan += c * Math.max(-1, Math.min(1, local.x / (Math.abs(local.z) + 1)));
      }
      return { sum, pan: sum ? pan / sum : 0 };
    };
    const c = lights(env.lamps);
    const p = lights(env.pumpkins);
    // the first seconds of the show set the reference ("the usual view" = level 1)
    if (this.candleRef == null) {
      this.candleSamples.push(c.sum + p.sum * 0.5);
      if (this.candleSamples.length >= 12) this.candleRef = Math.max(0.05, this.candleSamples.sort((a, b) => a - b)[6]);
    }
    const ref = this.candleRef ?? Math.max(0.05, c.sum + p.sum * 0.5);
    const e = this.enabled;
    const level = (x) => Math.min(2.2, Math.sqrt(x / ref));
    const now = this.engine.now;
    const pan = (layer, v) => layer?.panner.pan.setTargetAtTime(Math.max(-0.6, Math.min(0.6, v)), now, 0.4);
    this.layers.candle?.setLevel(e.candles ? Math.min(2, 0.7 * level(c.sum) + this.boost.candles) : 0, 0.6);
    pan(this.layers.candle, c.pan * 0.5);
    this.layers.fire?.setLevel(e.candles ? Math.min(2.2, 0.35 * level(p.sum * 2) + this.boost.fire) : 0, 0.6);
    pan(this.layers.fire, p.pan * 0.5);
    // the apparatus outside the back fence
    if (this.coil == null) this.coil = coilPosition(ctx);
    if (this.coil) {
      const local = toCamera(cam, this.coil, ctx.THREE);
      const d = local ? Math.hypot(local.x, local.y, local.z) : 9;
      this.layers.hum?.setLevel(e.lab ? Math.min(1.5, 5 / Math.max(3, d)) : 0, 1);
      pan(this.layers.hum, local ? local.x / (Math.abs(local.z) + 1) : 0);
    }
  }

  detailsTick(ctx, now, s) {
    if (now < this.blockDetailsUntil) return;
    const due = (name, min, max) => {
      if (this.details[name] == null) this.details[name] = now + min * 0.5 + this.random() * (max - min);
      if (now < this.details[name]) return false;
      this.details[name] = now + min + this.random() * (max - min);
      return true;
    };
    const spacing = now - this.lastDetailAt > 5;
    const gust = this.weather.wind;
    const e = this.enabled;
    const quiet = !this.eventActive;
    // fence creaks come more often in gusts
    if (e.creaks && quiet && due("creak", gust > 0.45 ? 14 : 28, gust > 0.45 ? 35 : 75) && spacing) this.detail("amb.creak", ctx, { far: [6, 11] });
    if (e.creaks && quiet && (gust > 0.5 || s > 0.4) && due("rattle", 35, 90) && spacing) this.detail("amb.rattle", ctx, { far: [6, 10] });
    if (e.creaks && quiet && due("settle", 45, 130) && spacing) this.detail("amb.settle", ctx, { at: { x: -4.8, y: 1.5, z: -3 }, far: [5, 9] });
    if (e.trees && gust > 0.42 && due("branch", 12, 40) && spacing) this.detail("amb.branch", ctx, { far: [7, 13] });
    // wildlife: rare, not in a storm, never over speech or during a gift event
    const wild = e.wildlife && quiet && !this.speaking && now - this.lastWildlifeAt > 28;
    if (wild && s < 0.3 && due("crow", 70, 170)) this.wildlife("amb.crow", ctx, [12, 22]);
    else if (wild && s < 0.2 && due("owl", 90, 220)) this.wildlife("amb.owl", ctx, [12, 25]);
    else if (wild && s < 0.25 && due("bat", 110, 260)) {
      const v = this.wildlife("amb.batwings", ctx, [3, 6]);
      if (v && this.random() < 0.6) this.engine.play("amb.batsqueak", { delay: 0.2 + this.random() * 0.5, pan: (this.random() - 0.5) * 0.8, lowpass: 9000 });
    }
  }

  detail(id, ctx, { far = [6, 10], at = null } = {}) {
    const pos = at ? relative(ctx, at) : randomFar(this.random, far);
    const sp = spatial(pos, { maxPan: 0.65, ref: 3 });
    const v = this.engine.play(id, { pan: sp.pan, gainDb: Math.max(-10, sp.gainDb + 6), lowpass: sp.lowpass });
    if (v) this.lastDetailAt = this.engine.now;
    return v;
  }

  wildlife(id, ctx, far) {
    const v = this.detail(id, ctx, { far });
    if (v) this.lastWildlifeAt = this.engine.now;
    return v;
  }

  // Thunder for a flash in the sky (lighting.js reports delay = distance / 343).
  // While he speaks thunder stays under his voice; during a gift event (whose flashes strike
  // several times in a few seconds) only one close clap per 4 s, a little quieter, so the
  // rolls do not stack into a wall.
  thunder(detail, { quieter = 0 } = {}) {
    if (!this.enabled.thunder) return null;
    const p = thunderPlan(detail);
    const id = `thunder.${p.kind}`;
    const pan = (this.random() - 0.5) * (p.kind === "close" ? 0.3 : 0.8);
    const under = (this.speaking ? 5 : 0) + (this.eventActive ? 4 : 0) + quieter;
    const cooldown = p.kind === "close" ? (this.eventActive ? 4 : 1.5) : 2.5;
    return this.engine.play(id, { delay: p.delay, gainDb: p.gainDb - under, lowpass: p.lowpass, pan, cooldown, cooldownKey: `thunder.${p.kind}` });
  }

  // Details pause while something else should be heard (a gift event's recognition, say).
  hold(seconds) {
    this.blockDetailsUntil = Math.max(this.blockDetailsUntil, this.engine.now + seconds);
  }
}

// --- geometry helpers (work with or without three.js objects) ------------------------------
function toCamera(camera, obj, THREE) {
  if (!camera?.matrixWorldInverse) return null;
  const p = obj.isObject3D && THREE ? obj.getWorldPosition(new THREE.Vector3()) : obj.position || obj;
  if (!THREE) return null;
  const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
  return { x: v.x, y: v.y, z: v.z };
}

function relative(ctx, at) {
  const local = toCamera(ctx?.camera, at, ctx?.THREE);
  return local || { x: at.x * 0.5, y: 0, z: -6 };
}

function randomFar(random, [a, b]) {
  const d = a + random() * (b - a);
  const ang = (random() - 0.5) * Math.PI * 1.3; // mostly in front, some to the sides
  return { x: Math.sin(ang) * d, y: 0.5, z: -Math.cos(ang) * d };
}

function coilPosition(ctx) {
  const gate = ctx?.spots?.gate?.at;
  const box = ctx?.environment?.groundBox;
  if (!gate || !box) return null;
  return { x: gate[0], y: 1.5, z: box.min.z - 0.55 };
}

export { toCamera, relative, makeRandom };
