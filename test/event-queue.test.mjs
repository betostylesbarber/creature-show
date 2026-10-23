// The stream's event queue (public/stream/events.js): one event at a time, at most three
// waiting, and beyond that the waiting ones combine into one performance of the highest,
// credited to everyone in it. Events whose places or props could not be built are unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { EventDirector } from "../public/stream/events.js";

function director(extra = {}) {
  const emitted = [];
  const hub = { emit: (type, m) => emitted.push([type, m]), on() {} };
  const ctx = { hub, spots: { center: { at: [0, 0] } }, ground: () => 0, nav: null, avatar: { root: { position: { x: 0, y: 0, z: 0 } } }, send() {}, log() {}, coils: {}, apparatus: { stand: { x: 1, z: -3, yaw: 0 }, handleWorld: () => ({ x: 1, y: 1, z: -3 }), position: { x: 1, y: 0, z: -3 } }, environment: { pumpkins: [] }, ...extra };
  return { d: new EventDirector(ctx), emitted };
}
const run = (type, nick, i) => ({ id: `r${i}`, type, name: type, user: { id: nick, nick } });

test("one runs, three wait, and a fifth combines the waiting ones into the highest", () => {
  const { d } = director({ gate: { x: 1, z: -4 }, fenceZ: -5 });
  d.current = { run: run("bolt", "a", 0) }; // something already performing
  d.play(run("bolt", "b", 1));
  d.play(run("gate", "c", 2));
  d.play(run("bolt", "d", 3));
  assert.equal(d.queue.length, 3);
  d.play(run("lab", "e", 4));
  assert.equal(d.queue.length, 1);
  const [combined] = d.queue;
  assert.equal(combined.type, "lab");
  assert.equal(combined.combined, 4);
  assert.deepEqual(combined.users.map((u) => u.nick).sort(), ["b", "c", "d", "e"]);
});

test("events without a place to happen are reported unavailable and not queued", () => {
  const { d } = director({ coils: null, apparatus: null });
  assert.equal(d.available.lab, false);
  assert.equal(d.available.grand, false);
  assert.equal(d.available.pumpkin, false); // no lanterns on this map
  assert.equal(d.available.bolt, true);
  assert.equal(d.play(run("lab", "x", 1)), false);
  assert.equal(d.queue.length, 0);
});
