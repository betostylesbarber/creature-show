import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, DISCLAIMER } from "../src/ledger.js";
import { normalizeEvent, normalizeGiftCatalog } from "../src/tiktok.js";
import { giftMessage, chatMessage, giftStruct, user, VIEWERS, ROOM, T0, CREATOR } from "./fixtures.test.mjs";

function setup(over = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
  const ledger = new Ledger({ persist: false, autoSweep: false, now: clock.now, ...over });
  ledger.beginSession({ roomId: ROOM, uniqueId: CREATOR.uniqueId, creator: CREATOR, connectedAt: T0 });
  return { ledger, clock };
}

// Normalized gift event built from a captured-shape fixture.
function gift(opts, receivedAt = T0) {
  const r = normalizeEvent("gift", giftMessage({ createTime: receivedAt, ...opts }), { roomId: ROOM, receivedAt });
  assert.ok(r.ok, r.detail);
  return r.event;
}

const streak = (msgId, repeatCount, repeatEnd, extra = {}) => gift({ msgId, repeatCount, repeatEnd, groupId: "g1", ...extra }, extra.at ?? T0 + repeatCount * 100 + (repeatEnd ? 50 : 0));

test("streak 1, 2, 3 plus final 3 contributes exactly 3 gifts, not 9", () => {
  const { ledger } = setup();
  const outs = [streak("a1", 1, false), streak("a2", 2, false), streak("a3", 3, false), streak("a4", 3, true)].map((e) => ledger.record(e));
  assert.deepEqual(outs.map((o) => o.accepted), [true, true, true, true]);
  assert.deepEqual(outs.map((o) => o.provisional), [true, true, true, false]);
  assert.deepEqual(outs.map((o) => o.contribution.deltaCount), [1, 1, 1, 0]);
  assert.deepEqual(outs.map((o) => o.finalizedNow), [false, false, false, true]);
  const t = ledger.sessionTotals();
  assert.equal(t.giftCount, 3);
  assert.equal(t.value, 3);
  assert.equal(t.provisionalValue, 0);
  assert.equal(t.contributions, 1);
  assert.equal(t.unit.id, "diamondCount");
  assert.equal(ledger.topSupporter().value, 3);
  // while the streak was open, the value was visible but marked provisional
  const { ledger: l2 } = setup();
  l2.record(streak("b1", 1, false));
  l2.record(streak("b2", 2, false));
  assert.deepEqual([l2.sessionTotals().value, l2.sessionTotals().provisionalValue, l2.sessionTotals().finalValue], [2, 2, 0]);
});

test("duplicate deliveries never add value", () => {
  const { ledger } = setup();
  const first = streak("d1", 1, false);
  const o1 = ledger.record(first);
  assert.equal(ledger.record(first), o1, "recording the same object twice returns the same outcome");
  assert.equal(first.ledger, o1);
  const dup = ledger.record(streak("d1", 1, false));
  assert.deepEqual([dup.accepted, dup.outcome, dup.reason], [false, "duplicate", "already_recorded"]);
  // no msgId: the deterministic hash id catches the duplicate as well
  const h1 = gift({ msgId: "0", repeatCount: 1, groupId: "0", gift: giftStruct({ id: "7", name: "Big", diamondCount: 100, type: 2 }), giftId: "7" });
  const h2 = gift({ msgId: "0", repeatCount: 1, groupId: "0", gift: giftStruct({ id: "7", name: "Big", diamondCount: 100, type: 2 }), giftId: "7" });
  assert.equal(h1.id, h2.id);
  assert.equal(ledger.record(h1).accepted, true);
  assert.equal(ledger.record(h2).outcome, "duplicate");
  // final delivered twice with different msgIds
  ledger.record(streak("d2", 2, true));
  const again = ledger.record(streak("d3", 2, true));
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "already_finalized");
  assert.equal(ledger.sessionTotals().giftCount, 3);
  assert.equal(ledger.sessionTotals().value, 102);
});

test("out-of-order updates: lower cumulative counts are ignored, final never double-adds", () => {
  const { ledger } = setup();
  ledger.record(streak("o1", 1, false));
  ledger.record(streak("o3", 3, false));
  const late = ledger.record(streak("o2", 2, false));
  assert.deepEqual([late.accepted, late.reason], [false, "out_of_order"]);
  ledger.record(streak("o4", 3, true));
  assert.equal(ledger.sessionTotals().giftCount, 3);

  // final arrives before the last update
  const { ledger: l2 } = setup();
  l2.record(streak("p1", 1, false));
  l2.record(streak("p3", 3, true));
  const after = l2.record(streak("p2", 3, false));
  assert.equal(after.accepted, false);
  assert.equal(l2.sessionTotals().giftCount, 3);

  // without groupId, provider time orders updates
  const { ledger: l3 } = setup();
  const ug = (id, n, end, at) => gift({ msgId: id, repeatCount: n, repeatEnd: end, groupId: "0" }, at);
  l3.record(ug("u1", 1, false, T0 + 100));
  l3.record(ug("u3", 3, false, T0 + 300));
  assert.equal(l3.record(ug("u2", 2, false, T0 + 200)).reason, "out_of_order");
  l3.record(ug("u4", 3, true, T0 + 400));
  assert.equal(l3.sessionTotals().giftCount, 3);
  // a genuinely new streak of the same gift afterwards counts separately
  l3.record(ug("u5", 1, false, T0 + 5000));
  l3.record(ug("u6", 1, true, T0 + 5100));
  assert.equal(l3.sessionTotals().giftCount, 4);
  assert.equal(l3.sessionTotals().contributions, 2);
});

test("concurrent streaks by the same and different users are tracked separately", () => {
  const { ledger } = setup();
  const lion = giftStruct({ id: "6", name: "Lion", diamondCount: 50, type: 1 });
  const ev = [
    gift({ msgId: "c1", sender: VIEWERS.ana, groupId: "A1", repeatCount: 1 }),
    gift({ msgId: "c2", sender: VIEWERS.bo, groupId: "B1", repeatCount: 1 }),
    gift({ msgId: "c3", sender: VIEWERS.ana, groupId: "A2", giftId: "6", gift: lion, repeatCount: 1 }),
    gift({ msgId: "c4", sender: VIEWERS.ana, groupId: "A1", repeatCount: 2 }),
    gift({ msgId: "c5", sender: VIEWERS.bo, groupId: "B1", repeatCount: 2 }),
    gift({ msgId: "c6", sender: VIEWERS.bo, groupId: "B1", repeatCount: 5 }),
    gift({ msgId: "c7", sender: VIEWERS.ana, groupId: "A2", giftId: "6", gift: lion, repeatCount: 2, repeatEnd: true }),
    gift({ msgId: "c8", sender: VIEWERS.ana, groupId: "A1", repeatCount: 4, repeatEnd: true }),
    gift({ msgId: "c9", sender: VIEWERS.bo, groupId: "B1", repeatCount: 5, repeatEnd: true }),
    // a second Rose streak by Ana while nothing else is open
    gift({ msgId: "c10", sender: VIEWERS.ana, groupId: "A3", repeatCount: 2, repeatEnd: true }),
  ];
  for (const e of ev) ledger.record(e);
  const top = ledger.topSupporters();
  const ana = top.find((s) => s.id === VIEWERS.ana.id);
  const bo = top.find((s) => s.id === VIEWERS.bo.id);
  assert.deepEqual([ana.giftCount, ana.value, ana.contributions], [4 + 2 + 2, 4 + 100 + 2, 3]);
  assert.deepEqual([bo.giftCount, bo.value, bo.contributions], [5, 5, 1]);
  assert.equal(ledger.sessionTotals().provisionalGiftCount, 0);
});

test("a streak whose final never arrives times out at the last known count, once", () => {
  const { ledger, clock } = setup({ streakTimeoutMs: 15_000 });
  const finalized = [];
  ledger.on("finalized", (f) => finalized.push(f));
  ledger.record(streak("t1", 1, false));
  ledger.record(streak("t2", 2, false));
  clock.advance(14_000);
  assert.equal(ledger.sweep().length, 0);
  clock.advance(2000);
  const done = ledger.sweep();
  assert.equal(done.length, 1);
  assert.deepEqual([done[0].status, done[0].count, done[0].provisional], ["timeout", 2, false]);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].reason, "timeout");
  assert.equal(ledger.sweep().length, 0, "sweeping again finalizes nothing");
  assert.equal(ledger.sessionTotals().timedOut, 1);
  // the real final arrives late with the same count: confirmed, nothing added
  const confirm = ledger.record(streak("t3", 2, true, { at: clock.now() }));
  assert.deepEqual([confirm.accepted, confirm.reason, confirm.finalizedNow], [true, "final_after_timeout", false]);
  assert.equal(ledger.sessionTotals().giftCount, 2);
  // a late update with a higher cumulative count replaces the figure (adds only the difference)
  const corr = ledger.record(streak("t4", 4, true, { at: clock.now() + 1 }));
  assert.equal(corr.contribution.deltaCount, 2);
  assert.equal(ledger.sessionTotals().giftCount, 4);
  assert.equal(ledger.sessionTotals().contributions, 1);
});

test("unknown gift goes to pending (not guessed) and resolves when the gift list arrives", () => {
  const { ledger } = setup();
  const resolved = [];
  ledger.on("resolved", (r) => resolved.push(r));
  const e = gift({ msgId: "n1", giftId: "88888", gift: null, repeatCount: 3, repeatEnd: true });
  assert.equal(e.gift.diamondCount, null);
  const out = ledger.record(e);
  assert.equal(out.accepted, true);
  assert.deepEqual([out.contribution.valueStatus, out.contribution.value, out.contribution.pendingReason], ["pending", null, "gift_metadata"]);
  let t = ledger.sessionTotals();
  assert.deepEqual([t.value, t.giftCount, t.pendingGiftCount, t.pendingContributions], [0, 3, 3, 1]);
  assert.equal(ledger.topSupporter(), null, "pending value never ranks anyone");
  assert.equal(ledger.snapshot().pending.length, 1);
  const n = ledger.resolveGiftCatalog(normalizeGiftCatalog([{ id: 88888, name: "New Gift", diamond_count: 20, type: 2 }]));
  assert.equal(n, 1);
  t = ledger.sessionTotals();
  assert.deepEqual([t.value, t.giftCount, t.pendingGiftCount, t.pendingContributions], [60, 3, 0, 0]);
  assert.equal(resolved.length, 1);
  assert.equal(ledger.topSupporter().value, 60);
  // metadata carried by a later payload of the same gift id also resolves pending ones
  const { ledger: l2 } = setup();
  l2.record(gift({ msgId: "n2", giftId: "77", gift: null, repeatEnd: true }));
  l2.record(gift({ msgId: "n3", giftId: "77", gift: giftStruct({ id: "77", name: "Seen", diamondCount: 9, type: 2 }) }));
  assert.deepEqual([l2.sessionTotals().value, l2.sessionTotals().pendingContributions], [18, 0]);
});

test("gifts to a different recipient (co-host) are recorded separately and not counted", () => {
  const { ledger } = setup();
  const guest = user({ id: "8000000000000000001", nickname: "Guest", displayId: "guest_host" });
  const host = user({ id: CREATOR.userId, nickname: "Host", displayId: CREATOR.uniqueId });
  const lion = giftStruct({ id: "6", name: "Lion", diamondCount: 500, type: 2 });
  const toGuest = ledger.record(gift({ msgId: "r1", giftId: "6", gift: lion, toUser: guest }));
  assert.deepEqual([toGuest.accepted, toGuest.contribution.counted, toGuest.contribution.recipientClass], [true, false, "other"]);
  ledger.record(gift({ msgId: "r2", giftId: "6", gift: lion, toUser: host }));
  ledger.record(gift({ msgId: "r3", giftId: "6", gift: lion })); // no recipient: single-host default
  const t = ledger.sessionTotals();
  assert.deepEqual([t.value, t.giftCount], [1000, 2]);
  assert.deepEqual([t.otherRecipients.value, t.otherRecipients.giftCount, t.otherRecipients.recipients], [500, 1, 1]);
  assert.equal(ledger.snapshot().otherRecipients[0].uniqueId, "guest_host");
  assert.equal(ledger.topSupporter().value, 1000);
});

test("a recipient that cannot be compared yet stays pending until the creator id is known", () => {
  let t = T0;
  const ledger = new Ledger({ persist: false, autoSweep: false, now: () => t });
  ledger.beginSession({ roomId: ROOM, uniqueId: CREATOR.uniqueId, creator: { uniqueId: CREATOR.uniqueId }, connectedAt: T0 });
  const lion = giftStruct({ id: "6", name: "Lion", diamondCount: 500, type: 2 });
  const idOnly = (id) => user({ id });
  ledger.record(gift({ msgId: "v1", giftId: "6", gift: lion, toUser: idOnly(CREATOR.userId) }));
  ledger.record(gift({ msgId: "v2", giftId: "6", gift: lion, toUser: idOnly("8000000000000000009") }));
  let s = ledger.sessionTotals();
  assert.deepEqual([s.value, s.pendingContributions, s.pendingGiftCount], [0, 2, 2]);
  ledger.setCreator({ userId: CREATOR.userId });
  s = ledger.sessionTotals();
  assert.deepEqual([s.value, s.giftCount, s.pendingContributions, s.otherRecipients.value], [500, 1, 0, 500]);
});

test("top supporter: higher value, then earlier to reach it, then id", () => {
  const { ledger, clock } = setup();
  const g10 = giftStruct({ id: "10", name: "Ten", diamondCount: 10, type: 2 });
  const send = (msgId, sender, at) => ledger.record(gift({ msgId, sender, giftId: "10", gift: g10 }, at));
  const first = send("x1", VIEWERS.bo, T0 + 1000);
  assert.equal(first.isNewTop, true);
  const tie = send("x2", VIEWERS.ana, T0 + 2000);
  assert.equal(tie.isNewTop, false, "Ana ties Bo but reached the value later");
  assert.equal(ledger.topSupporter().id, VIEWERS.bo.id);
  const ahead = send("x3", VIEWERS.ana, T0 + 3000);
  assert.equal(ahead.isNewTop, true);
  assert.equal(ledger.topSupporter().id, VIEWERS.ana.id);
  // exact tie in value and time: lower id wins
  const { ledger: l2 } = setup();
  const same = (msgId, sender) => l2.record(gift({ msgId, sender, giftId: "10", gift: g10 }, T0 + 500));
  same("y1", VIEWERS.cy);
  same("y2", VIEWERS.ana);
  assert.equal(l2.topSupporter().id, VIEWERS.ana.id);
  assert.deepEqual(l2.topSupporters().map((s) => s.rank), [1, 2]);
  void clock;
});

test("current display name and avatar follow the supporter", () => {
  const { ledger } = setup();
  ledger.record(gift({ msgId: "z1", sender: user({ id: VIEWERS.ana.id, nickname: "Old Name", displayId: "ana.k" }) }));
  const renamed = user({ id: VIEWERS.ana.id, nickname: "New Name 🌙", displayId: "ana.k", avatar: "https://p16.example/a.jpg" });
  ledger.record(normalizeEvent("comment", chatMessage({ msgId: "z2", sender: renamed }), { roomId: ROOM, receivedAt: T0 }).event);
  const top = ledger.topSupporter();
  assert.deepEqual([top.nick, top.avatar], ["New Name 🌙", "https://p16.example/a.jpg"]);
});

test("flags: mid-stream tracking and incomplete while gaps exist", () => {
  const { ledger, clock } = setup();
  assert.equal(ledger.flags().trackingBeganMidStream, true);
  assert.equal(ledger.flags().incomplete, false);
  ledger.openGap({ start: clock.now(), reason: "disconnected" });
  assert.deepEqual([ledger.flags().incomplete, ledger.flags().gapOpen], [true, true]);
  clock.advance(5000);
  ledger.beginSession({ roomId: ROOM, connectedAt: clock.now() });
  const g = ledger.gaps();
  assert.equal(g.gaps.length, 1);
  assert.equal(g.gaps[0].durationMs, 5000);
  assert.equal(ledger.flags().incomplete, true, "a closed gap still means events may be missing");
  assert.equal(ledger.flags().gapOpen, false);
  const early = new Ledger({ persist: false, autoSweep: false, now: () => T0 });
  early.beginSession({ roomId: "1", connectedAt: T0, liveStartedAt: T0 + 1000 });
  assert.equal(early.flags().trackingBeganMidStream, false);
});

test("reconnect to the same room keeps the session; a replay is not double counted", () => {
  const { ledger, clock } = setup();
  const before = [streak("q1", 1, false), streak("q2", 2, false), gift({ msgId: "q9", groupId: "0", giftId: "6", gift: giftStruct({ id: "6", diamondCount: 50, type: 2 }) })];
  before.forEach((e) => ledger.record(e));
  ledger.openGap({ start: clock.now(), reason: "disconnected" });
  clock.advance(3000);
  const r = ledger.beginSession({ roomId: ROOM, connectedAt: clock.now() });
  assert.equal(r.resumed, true);
  // the provider replays what we already saw (new objects, same ids)
  const replays = [streak("q1", 1, false), streak("q2", 2, false), gift({ msgId: "q9", groupId: "0", giftId: "6", gift: giftStruct({ id: "6", diamondCount: 50, type: 2 }) })].map((e) => ledger.record(e));
  assert.deepEqual(replays.map((o) => o.outcome), ["duplicate", "duplicate", "duplicate"]);
  ledger.record(streak("q3", 3, true, { at: clock.now() }));
  assert.equal(ledger.sessionTotals().giftCount, 4);
  assert.equal(ledger.sessionTotals().value, 53);
  // a new live (new roomId) starts a new session; all-time keeps both
  ledger.beginSession({ roomId: "7429000000000000999", connectedAt: clock.now() + 1000 });
  assert.equal(ledger.sessionTotals().value, 0);
  assert.equal(ledger.allTimeTotals().value, 53);
  assert.equal(ledger.snapshot().pastSessions[0].totals.value, 53);
});

test("restart restores from disk without erasing or double counting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  try {
    let t = T0;
    const opts = { dir, autoSweep: false, now: () => t, saveDebounceMs: 5 };
    const a = new Ledger(opts);
    a.beginSession({ roomId: ROOM, uniqueId: CREATOR.uniqueId, creator: CREATOR, connectedAt: T0 });
    const first = [streak("s1", 1, false), streak("s2", 2, false), gift({ msgId: "s9", groupId: "0", giftId: "6", gift: giftStruct({ id: "6", diamondCount: 50, type: 2 }) }), normalizeEvent("comment", chatMessage({ msgId: "s10" }), { roomId: ROOM, receivedAt: T0 }).event];
    first.forEach((e) => a.record(e));
    a.close();
    const file = path.join(dir, "ledger.json");
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp files left behind");
    JSON.parse(fs.readFileSync(file, "utf8"));

    t = T0 + 60_000;
    const b = new Ledger(opts);
    assert.equal(b.sessionTotals().giftCount, 3, "totals survive the restart");
    assert.equal(b.sessionTotals().value, 52);
    assert.equal(b.flags().gapOpen, true, "the time the app was down is a gap");
    assert.equal(b.gaps().gaps[0].reason, "app_not_running");
    b.beginSession({ roomId: ROOM, connectedAt: t });
    assert.equal(b.flags().gapOpen, false);
    const again = [streak("s1", 1, false), streak("s2", 2, false), gift({ msgId: "s9", groupId: "0", giftId: "6", gift: giftStruct({ id: "6", diamondCount: 50, type: 2 }) }), normalizeEvent("comment", chatMessage({ msgId: "s10" }), { roomId: ROOM, receivedAt: T0 }).event].map((e) => b.record(e));
    assert.deepEqual(again.map((o) => o.outcome), ["duplicate", "duplicate", "duplicate", "duplicate"]);
    // the open streak continues: its cumulative count replaces the persisted one
    b.record(streak("s3", 5, true, { at: t }));
    assert.equal(b.sessionTotals().giftCount, 6);
    assert.equal(b.sessionTotals().value, 55);
    assert.equal(b.allTimeTotals().value, 55);
    b.close();

    // a corrupt file is moved aside instead of crashing the show
    fs.writeFileSync(file, "{not json");
    const c = new Ledger(opts);
    assert.equal(c.sessionTotals().value, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes(".unreadable-")));
    c.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("record() never throws and every outcome is visible in the event log", () => {
  const { ledger } = setup();
  for (const bad of [null, undefined, 5, "x", {}, { kind: "gift" }, { kind: "gift", source: "tiktok", id: "q", user: { id: "1" } }, { kind: "comment", source: "tiktok", id: "", user: {} }]) {
    const o = ledger.record(bad);
    assert.equal(o.accepted, false);
    assert.equal(o.outcome, "ignored");
  }
  assert.equal(ledger.record({ kind: "comment", user: { id: "sim", nick: "sim" }, text: "from the test panel" }).reason, "not_from_provider");
  ledger.record(normalizeEvent("comment", chatMessage({ msgId: "L1", content: "hi" }), { roomId: ROOM, receivedAt: T0 }).event);
  ledger.record(normalizeEvent("comment", chatMessage({ msgId: "L1", content: "hi" }), { roomId: ROOM, receivedAt: T0 }).event);
  ledger.record(normalizeEvent("comment", chatMessage({ msgId: "L2", content: "elsewhere", roomId: "1" }), { roomId: "1", receivedAt: T0 }).event);
  ledger.logDropped({ kind: "comment", id: "old", outcome: "ignored", reason: "history", detail: "created 30 s before this connection" });
  ledger.logNotice({ subtype: "battleScore", receivedAt: T0 });
  ledger.logNotice({ subtype: "battleScore", receivedAt: T0 + 1 });
  const log = ledger.history(50);
  assert.equal(log[0].kind, "notice:battleScore");
  assert.equal(log[0].repeats, 2);
  assert.equal(log[0].reason, "not_a_paid_gift");
  const outcomes = log.map((e) => `${e.outcome}:${e.reason}`);
  for (const want of ["accepted:null", "duplicate:already_recorded", "ignored:other_room", "ignored:history", "ignored:malformed", "ignored:not_from_provider"]) assert.ok(outcomes.includes(want), want);
  assert.equal(ledger.snapshot().disclaimer, DISCLAIMER);
});
