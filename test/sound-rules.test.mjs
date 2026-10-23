// The sound system's decision logic: anti-repetition, cooldowns, voice limits, the rules for
// his nonverbal reactions, gift acknowledgments in bursts, duplicate protection after a
// reconnect, thunder distance, footsteps, panning and the event beat routing.
import test from "node:test";
import assert from "node:assert/strict";
import { ShuffleBag, Cooldowns, VoiceLimiter, ReactionPolicy, AckGate, Dedupe, thunderPlan, stepPlan, spatial, signatureName, ackLevel, makeRandom } from "../public/stream/sound/rules.js";
import { routeBeat, BEATS } from "../public/stream/sound/events.js";
import { STUNT_FOLEY, MARKER_FOLEY } from "../public/stream/sound/foley.js";
import { LIBRARY, CATEGORY_LIMITS } from "../public/stream/sound/library.js";
import fs from "node:fs";

test("shuffle bag never repeats a variant immediately and spreads picks evenly", () => {
  for (const n of [2, 3, 5, 12]) {
    const bag = new ShuffleBag(n, { random: makeRandom(n * 7) });
    const counts = new Array(n).fill(0);
    let last = -1;
    for (let i = 0; i < 1200; i++) {
      const v = bag.next();
      assert.notEqual(v, last, `immediate repeat with ${n} variants`);
      assert.ok(v >= 0 && v < n);
      counts[v]++;
      last = v;
    }
    const expected = 1200 / n;
    for (const c of counts) assert.ok(Math.abs(c - expected) < expected * 0.35, `uneven use ${counts}`);
  }
});

test("shuffle bag with many variants avoids the last few picks", () => {
  const bag = new ShuffleBag(8, { random: makeRandom(3) });
  const seq = Array.from({ length: 400 }, () => bag.next());
  for (let i = 3; i < seq.length; i++) assert.ok(!seq.slice(i - 3, i).includes(seq[i]), `repeat within 3 at ${i}`);
});

test("a single variant is always variant 0", () => {
  const bag = new ShuffleBag(1);
  assert.equal(bag.next(), 0);
  assert.equal(bag.next(), 0);
});

test("cooldowns block until their time has passed", () => {
  const c = new Cooldowns();
  assert.equal(c.take("crow", 10, 40), true);
  assert.equal(c.take("crow", 30, 40), false);
  assert.equal(c.take("owl", 30, 40), true);
  assert.equal(c.take("crow", 50.1, 40), true);
});

test("voice limiter bounds each category and the total, stealing only lower or equal priority", () => {
  const v = new VoiceLimiter({ total: 5, limits: { steps: 2, event: 3 } });
  const a = v.request("steps", 1, 0);
  const b = v.request("steps", 1, 1);
  assert.ok(a.ok && b.ok);
  const c = v.request("steps", 1, 2);
  assert.ok(c.ok);
  assert.deepEqual(c.steal, [a.id], "oldest step is stolen");
  assert.equal(v.count("steps"), 2);
  v.request("event", 3, 3);
  v.request("event", 3, 4);
  v.request("event", 3, 5);
  assert.equal(v.count(), 5);
  const low = v.request("event", 1, 6);
  assert.equal(low.ok, false, "a low-priority sound cannot steal a climax");
  const ui = v.request("ui", 2, 7);
  assert.ok(ui.ok, "a new category may take a lower-priority voice when the total is full");
  assert.ok(v.count() <= 5);
});

test("nonverbal reactions never play over speech or a pending line", () => {
  const p = new ReactionPolicy({ gap: 6 });
  assert.equal(p.take("curious", 100), true);
  assert.equal(p.take("chuckle", 102), false, "too soon after the last reaction");
  p.line("start", 110);
  assert.equal(p.take("chuckle", 110), false, "a line is in progress");
  p.speech("start", 111);
  assert.equal(p.allowed("effort", 111), false, "not even an effort breath over speech");
  p.speech("end", 113);
  assert.equal(p.take("chuckle", 113.2), false, "still inside the line");
  p.line("end", 114);
  assert.equal(p.take("chuckle", 114.2), false, "let the last word land");
  assert.equal(p.take("chuckle", 115), true);
  assert.equal(p.take("chuckle", 130), false, "per-kind cooldown");
  assert.equal(p.take("effort", 116), true, "effort sounds are exempt from the gap");
  assert.equal(p.take("surprised", 116, { force: true }), true, "force skips gap and cooldown, not speech");
  p.speech("start", 117);
  assert.equal(p.take("surprised", 117, { force: true }), false);
  p.speech("end", 118);
  // a gift event's reaction beat outranks an idle reaction, but still keeps a short gap
  const q = new ReactionPolicy();
  assert.equal(q.take("relieved", 10), true, "an idle fidget sigh");
  assert.equal(q.take("chuckle", 11, { priority: true }), false, "too close to the sigh");
  assert.equal(q.take("chuckle", 13, { priority: true }), true, "the event reaction plays despite the 6 s gap");
  assert.equal(q.take("chuckle", 16, { priority: true }), true, "no per-kind cooldown for event reactions");
});

test("gift acknowledgments thin out in a burst instead of stacking jingles", () => {
  const g = new AckGate();
  const out = [];
  for (let i = 0; i < 20; i++) out.push(g.decide(i * 0.2));
  const played = out.filter(Boolean).length;
  assert.ok(played <= 6, `${played} acknowledgments in 4 s`);
  assert.ok(out.includes("soft"), "busy moments get the softer variant");
  assert.equal(g.decide(10), "full", "back to normal after a quiet moment");
  assert.equal(ackLevel(1), 0);
  assert.equal(ackLevel(5), 1);
  assert.equal(ackLevel(29), 2);
});

test("the same gift message twice (reconnect race) plays once; state messages are not gifts", () => {
  const d = new Dedupe(4);
  const gift = { t: "gift", user: { id: "u1" }, gift: { name: "Rose", count: 1 }, total: 1 };
  assert.equal(d.fresh(gift, 0), true);
  assert.equal(d.fresh({ ...gift }, 1), false);
  assert.equal(d.fresh({ ...gift, gift: { name: "Rose", count: 2 } }, 1.2), true, "a different gift plays");
  assert.equal(d.fresh(gift, 6), true, "the same gift later is a new gift");
  assert.equal(d.fresh({ t: "state", meter: {} }, 6), true);
});

test("thunder: distance sets kind, delay, level and darkness", () => {
  const close = thunderPlan({ delay: 0.6 });
  const mid = thunderPlan({ delay: 2.5 });
  const far = thunderPlan({ delay: 8 });
  assert.equal(close.kind, "close");
  assert.equal(mid.kind, "mid");
  assert.equal(far.kind, "far");
  assert.ok(close.gainDb > mid.gainDb && mid.gainDb > far.gainDb);
  assert.ok(close.lowpass > mid.lowpass && mid.lowpass > far.lowpass);
  assert.ok(thunderPlan({ delay: 30 }).delay <= 9, "never scheduled absurdly late");
});

test("footsteps follow surface and strength; turning on the spot is lighter", () => {
  const soft = stepPlan({ strength: 0.2, surface: "soil" });
  const hard = stepPlan({ strength: 1, surface: "soil" });
  assert.ok(hard.heelDb > soft.heelDb && hard.weightDb > soft.weightDb);
  const turn = stepPlan({ strength: 1, surface: "stone", inPlace: true });
  assert.ok(turn.heelDb < hard.heelDb && turn.weightDb < -20);
  assert.equal(stepPlan({ surface: "lava" }).surface, "stone");
  assert.equal(stepPlan({ surface: "stone" }, { rain: 0.9 }).wet, true);
  assert.equal(stepPlan({ surface: "grass" }, { rain: 0.9 }).wet, false);
});

test("spatial: subtle pans, never hard; distance gets quieter and darker", () => {
  const left = spatial({ x: -6, y: 0, z: -1 });
  assert.ok(left.pan < 0 && left.pan >= -0.6);
  const near = spatial({ x: 0, y: 0, z: -2 });
  const far = spatial({ x: 0, y: 0, z: -12 });
  assert.equal(near.gainDb, 0);
  assert.ok(far.gainDb < -6 && far.lowpass < near.lowpass);
});

test("signature names: the five events, the old names mapped onto them", () => {
  assert.deepEqual(signatureName("lab", "galaxy"), { event: "lab", variant: "galaxy" });
  assert.deepEqual(signatureName("galaxy"), { event: "lab", variant: "galaxy" });
  assert.deepEqual(signatureName("lion"), { event: "grand", variant: "lion" });
  assert.equal(signatureName("nonsense"), null);
});

test("beat routing separates a variant's own sequence from its base event", () => {
  // Laboratory Surge with the Galaxy: base climax, then the galaxy's sequence, then base decay/end
  const st = { variant: "galaxy", base: { last: null }, layer: null };
  const order = [
    ["recognition", "base"], ["anticipation", "base"], ["development", "base"], ["climax", "base"],
    ["recognition", "layer"], ["anticipation", "layer"], ["reaction", "base"], ["development", "layer"],
    ["climax", "layer"], ["reaction", "layer"], ["decay", "layer"], ["end", "layer"], ["decay", "base"], ["end", "base"],
  ];
  for (const [beat, want] of order) {
    const got = routeBeat(st, beat);
    assert.equal(got, want, `${beat}`);
    (got === "layer" ? st.layer : st.base).last = beat;
    if (got === "layer" && beat === "end") st.layer.done = true;
  }
  // Grand Reanimation with the Lion: the lion starts at the base reaction
  const g = { variant: "lion", base: { last: null }, layer: null };
  const order2 = [
    ["recognition", "base"], ["anticipation", "base"], ["development", "base"], ["climax", "base"], ["reaction", "base"],
    ["recognition", "layer"], ["anticipation", "layer"], ["development", "layer"], ["climax", "layer"], ["reaction", "layer"],
    ["decay", "layer"], ["decay", "base"], ["end", "layer"], ["end", "base"],
  ];
  for (const [beat, want] of order2) {
    const got = routeBeat(g, beat);
    assert.equal(got, want, `lion ${beat}`);
    (got === "layer" ? g.layer : g.base).last = beat;
    if (got === "layer" && beat === "end") g.layer.done = true;
  }
  // No variant: a repeated beat stays with the base
  const plain = { variant: null, base: { last: "climax" }, layer: null };
  assert.equal(routeBeat(plain, "recognition"), "base");
  assert.equal(BEATS.length, 7);
});

test("every sound the code plays exists in the built library, with a mix entry", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../assets/sounds/manifest.json", import.meta.url), "utf8"));
  const ids = new Set(Object.keys(manifest.sounds));
  const sources = ["events.js", "ambience.js", "foley.js"].map((f) => fs.readFileSync(new URL(`../public/stream/sound/${f}`, import.meta.url), "utf8")).join("\n");
  const used = new Set([...sources.matchAll(/(?:play|layer)\(\s*(?:"[\w:]+",\s*)?"([a-z]+\.[a-z_]+)"/g)].map((m) => m[1]));
  for (const id of ["step.stone", "step.soil", "step.grass", "step.scuff", "step.brush", "step.weight", "step.wet", "cloth.move", "cloth.big", "leather", "hardware", "breath.in", "breath.out"]) used.add(id);
  for (const id of used) {
    assert.ok(ids.has(id), `${id} is played but not built`);
    assert.ok(LIBRARY[id], `${id} has no mix entry`);
  }
  for (const voice of ["am_onyx", "am_puck", "am_michael", "bm_lewis"]) for (const kind of ["curious", "thoughtful", "chuckle", "surprised", "relieved", "effort", "delight", "roar"]) assert.ok(ids.has(`nv.${voice}.${kind}`), `nv.${voice}.${kind}`);
  for (const [id, s] of Object.entries(manifest.sounds)) for (const v of s.variants) assert.ok(v.tp == null || v.tp <= -1, `${id} ${v.file} true peak ${v.tp}`);
  for (const def of Object.values(LIBRARY)) if (def.category) assert.ok(CATEGORY_LIMITS[def.category], `limit for ${def.category}`);
});

test("stunt foley timelines stay inside their stunts and use known actions", () => {
  const durations = { nod: 1.4, wave: 2.6, bow: 2.8, flex: 3, jacks: 4.2, dance: 6.5, roar: 3.4, stomp: 2.2, kneel: 5, backflip: 2.2, pushups: 6.4, handstand: 6.5, spin: 2.4, look_around: 4, crack_neck: 2.6, look_hands: 3.4, stretch: 3.6, activate: 4.4, celebrate: 7, reanimate: 6 };
  const actions = /^(cloth|clothBig|leather|hardware|breathIn|breathOut|scuff|weight|nv:(curious|thoughtful|chuckle|surprised|relieved|effort|delight|roar))$/;
  for (const [name, list] of Object.entries(STUNT_FOLEY)) {
    for (const [at, action] of list) {
      assert.ok(at >= 0 && at <= (durations[name] ?? 10), `${name} ${action} at ${at}`);
      assert.match(action, actions);
    }
  }
  for (const list of Object.values(MARKER_FOLEY)) for (const [, action] of list) assert.match(action, actions);
});
