// Which Halloween event a gift plays: the highest tier its own verified value reaches, once per
// gift or completed combo, never added up across gifts, a thank-you while the value is unknown,
// the next event down when one can't be staged, and the operator's thresholds when set.
import test from "node:test";
import assert from "node:assert/strict";
import { Show } from "../src/show.js";
import { Ledger } from "../src/ledger.js";
import { normalizeEvent } from "../src/tiktok.js";
import { character, tales } from "../src/config.js";
import { Moderation } from "../src/moderation.js";

const ROOM = "7400000000000000002";

function harness({ thresholds, available } = {}) {
  let t = 1_800_000_000_000;
  const now = () => t;
  const ledger = new Ledger({ persist: false, autoSweep: false, now, streakTimeoutMs: 15_000 });
  ledger.beginSession({ roomId: ROOM, connectedAt: t });
  const sent = [];
  const settings = { get: () => ({ commandsEnabled: true, readComments: true, readerVoice: "varied", ...(thresholds ? { eventThresholds: thresholds } : {}) }) };
  const show = new Show({ character, tales, settings, brain: {}, voice: {}, moderation: new Moderation([]), broadcast: (m) => sent.push(m), streamCount: () => 1, log: () => {} });
  show.ledger = ledger;
  if (available) show.eventsAvailable = available;
  ledger.on("finalized", ({ contribution: c, reason }) => {
    if (reason === "final_event" || !c.counted) return;
    show.handle({ kind: "gift", user: c.supporter, gift: { id: c.giftId, name: c.giftName, count: c.count, coins: c.diamondCount ?? 0 }, ledger: { accepted: true, contribution: c, finalizedNow: true } });
  });
  let seq = 0;
  const deliver = (from, gift, repeatCount = 1, { end = true, groupId = "", msgId = `m${++seq}` } = {}) => {
    t += 300;
    const payload = { common: { msgId, createTime: String(t), roomId: ROOM }, user: from, giftId: gift.id, gift, repeatCount, repeatEnd: end ? 1 : 0, groupId };
    const { ok, event } = normalizeEvent("gift", payload, { roomId: ROOM, receivedAt: t });
    assert.ok(ok);
    ledger.record(event);
    show.handle(event);
  };
  const played = () => sent.filter((m) => m.t === "gift");
  return { ledger, show, sent, deliver, played, advance: (ms) => (t += ms) };
}

const user = (id, nickname) => ({ id, displayId: nickname.toLowerCase(), nickname });
// A non-streaking gift worth exactly `coins` (type 2 gifts don't combo).
const worth = (coins, name = `Gift${coins}`) => ({ id: String(9000 + coins), name, diamondCount: coins, type: 2 });
const rose = { id: "5655", name: "Rose", diamondCount: 1, type: 1 };

test("each tier boundary plays exactly the event it reaches", () => {
  const cases = [
    [1, "ack"], [29, "ack"], [30, "bolt"], [99, "bolt"], [100, "pumpkin"], [499, "pumpkin"], [500, "gate"],
    [999, "gate"], [1000, "lab"], [2999, "lab"], [3000, "grand"], [44999, "grand"],
  ];
  for (const [coins, tier] of cases) {
    const h = harness();
    h.deliver(user("1", "Ana"), worth(coins));
    const [g] = h.played();
    assert.equal(g.tier, tier, `${coins} coins`);
    assert.equal(g.total, coins);
    assert.equal(Boolean(g.event), tier !== "ack");
    if (g.event) assert.equal(g.event.type, tier);
  }
});

test("a combo is one gift: its completed value picks one event, played once", () => {
  const h = harness();
  const ana = user("2", "Ana");
  for (let i = 1; i <= 35; i++) h.deliver(ana, rose, i, { end: false, groupId: "c1" });
  assert.equal(h.played().length, 0, "nothing plays while the combo runs");
  assert.ok(h.sent.filter((m) => m.t === "giftStreak").length >= 1, "the combo is acknowledged while it runs");
  h.deliver(ana, rose, 35, { end: true, groupId: "c1" });
  const plays = h.played();
  assert.equal(plays.length, 1);
  assert.equal(plays[0].total, 35);
  assert.equal(plays[0].event.type, "bolt");
});

test("separate gifts never add up towards a higher event", () => {
  const h = harness();
  const kai = user("3", "Kai");
  h.deliver(kai, worth(60));
  h.deliver(kai, worth(60, "Another"));
  const plays = h.played();
  assert.deepEqual(plays.map((p) => p.event?.type), ["bolt", "bolt"]); // 120 in total, but not a Pumpkin Whisper
});

test("a duplicate gift message plays once, and a late out-of-order repeat count is not counted again", () => {
  const h = harness();
  const bea = user("4", "Bea");
  h.deliver(bea, worth(500), 1, { msgId: "dup" });
  h.deliver(bea, worth(500), 1, { msgId: "dup" });
  assert.equal(h.played().length, 1);
  // A combo whose messages arrive 1, 3, 2, final 3: counted as 3 once.
  for (const n of [1, 3, 2]) h.deliver(bea, rose, n, { end: false, groupId: "c2" });
  h.deliver(bea, rose, 3, { end: true, groupId: "c2" });
  const last = h.played().at(-1);
  assert.equal(last.total, 3);
  assert.equal(last.tier, "ack");
  assert.equal(h.played().length, 2);
});

test("a gift whose value is still unknown gets a thank-you, never a guessed event", () => {
  const h = harness();
  const c = { value: null, counted: true, provisional: false, count: 1, giftName: "Mystery box", diamondCount: null };
  h.show.handle({ kind: "gift", user: { id: "5", nick: "Cy" }, gift: { name: "Mystery box", count: 1 }, ledger: { accepted: true, contribution: c, finalizedNow: true } });
  const [g] = h.played();
  assert.equal(g.tier, "ack");
  assert.equal(g.event, null);
});

test("an event the stream could not stage gives way to the next one down", () => {
  const h = harness({ available: { gate: false, lab: false } });
  h.deliver(user("6", "Dee"), worth(1500));
  assert.equal(h.played()[0].event.type, "pumpkin");
  h.deliver(user("6", "Dee"), worth(3000, "Big"));
  assert.equal(h.played()[1].event.type, "grand");
});

test("the operator's thresholds are used for the events and the guide", () => {
  const h = harness({ thresholds: { bolt: 50, pumpkin: 150, gate: 600, lab: 1200, grand: 4000 } });
  h.deliver(user("7", "Eve"), worth(40));
  h.deliver(user("7", "Eve"), worth(120, "B"));
  h.deliver(user("7", "Eve"), worth(3500, "C"));
  assert.deepEqual(h.played().map((p) => p.tier), ["ack", "bolt", "lab"]);
  const guide = h.show.giftGuide("full").tiers;
  assert.deepEqual(guide.map((t) => [t.id, t.minCoins, t.maxCoins]), [["bolt", 50, 149], ["pumpkin", 150, 599], ["gate", 600, 1199], ["lab", 1200, 3999], ["grand", 4000, null]]);
});

test("rehearsal supporters are cleared from the display when the real LIVE connects", () => {
  const h = harness();
  // A test-panel gift (no ledger), as /api/sim sends it: it sets the badge and the stone.
  h.show.simulated = true;
  h.show.handle({ kind: "gift", user: { id: "sim1", nick: "Rehearsal Rita" }, gift: { name: "Lion", coins: 29999, count: 1 } });
  assert.equal(h.show.topGifter.user.nick, "Rehearsal Rita");
  const real = { id: "real1", nick: "RealViewer", value: 5 };
  assert.equal(h.show.clearSimulatedSupport(real), true);
  const cleared = h.sent.find((m) => m.t === "state" && m.clearTop);
  assert.ok(cleared, "the stream is told to clear the badge and the stone");
  assert.equal(cleared.topGifter, null);
  assert.equal(h.show.topGifter.user.nick, "RealViewer");
  assert.equal(h.show.viewers.get("sim1").coins, 0);
  assert.equal(h.show.clearSimulatedSupport(real), false, "only once, and never without a rehearsal");
});

test("the Galaxy and the Lion are variants of their tiers, not events of their own", () => {
  const h = harness();
  h.deliver(user("8", "Fay"), { id: "5656", name: "Galaxy", diamondCount: 1000, type: 2 });
  h.deliver(user("8", "Fay"), { id: "6369", name: "Lion", diamondCount: 29999, type: 2 });
  const [galaxy, lion] = h.played();
  assert.deepEqual([galaxy.event.type, galaxy.event.variant], ["lab", "galaxy"]);
  assert.deepEqual([lion.event.type, lion.event.variant], ["grand", "lion"]);
  assert.equal(new Set(h.played().map((p) => p.event.type)).size, 2);
  assert.ok((character.giftEvents || []).length === 5);
});
