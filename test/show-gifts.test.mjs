// The show's side of gift accounting: TikTok gifts reach show.handle with the ledger's outcome
// attached, and the show must perform and count each contribution exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { Show } from "../src/show.js";
import { Ledger } from "../src/ledger.js";
import { normalizeEvent } from "../src/tiktok.js";
import { character, tales } from "../src/config.js";
import { Moderation } from "../src/moderation.js";

const ROOM = "7400000000000000001";
const settings = {
  get: () => ({ giftTiers: character.giftTiers, meterCoins: 3000, commandsEnabled: true, readComments: true, readerVoice: "varied" }),
};

function harness() {
  let t = 1_800_000_000_000;
  const now = () => t;
  const ledger = new Ledger({ persist: false, autoSweep: false, now, streakTimeoutMs: 15_000 });
  ledger.beginSession({ roomId: ROOM, connectedAt: t });
  const sent = [];
  const show = new Show({ character, tales, settings, brain: {}, voice: {}, moderation: new Moderation([]), broadcast: (m) => sent.push(m), streamCount: () => 1, log: () => {} });
  show.ledger = ledger;
  // What server.js does: timed-out streaks are performed when the ledger settles them.
  ledger.on("finalized", ({ contribution: c, reason }) => {
    if (reason === "final_event" || !c.counted) return;
    show.handle({ kind: "gift", user: c.supporter, gift: { id: c.giftId, name: c.giftName, count: c.count, coins: c.diamondCount ?? 0 }, ledger: { accepted: true, contribution: c, finalizedNow: true } });
  });
  const deliver = (payload) => {
    t += 300;
    const { ok, event } = normalizeEvent("gift", payload, { roomId: ROOM, receivedAt: t });
    assert.ok(ok);
    ledger.record(event);
    show.handle(event);
  };
  return { ledger, show, sent, deliver, advance: (ms) => (t += ms), now };
}

const user = (id, nickname) => ({ id, displayId: nickname.toLowerCase(), nickname });
const rose = { id: "5655", name: "Rose", diamondCount: 1, type: 1 };
const lion = { id: "6369", name: "Lion", diamondCount: 29999, type: 2 };
const giftMsg = (msgId, from, gift, repeatCount, repeatEnd, groupId = "g1") => ({
  common: { msgId, createTime: String(1_800_000_000_000), roomId: ROOM },
  user: from,
  giftId: gift.id,
  gift,
  repeatCount,
  repeatEnd: repeatEnd ? 1 : 0,
  groupId,
});

test("a streak 1, 2, 3 and a final 3 is performed once and counted as 3", () => {
  const h = harness();
  const ana = user("101", "Ana");
  h.deliver(giftMsg("m1", ana, rose, 1, false));
  h.deliver(giftMsg("m2", ana, rose, 2, false));
  h.deliver(giftMsg("m3", ana, rose, 3, false));
  h.deliver(giftMsg("m4", ana, rose, 3, true));
  h.deliver(giftMsg("m4", ana, rose, 3, true)); // the same final message delivered twice
  const gifts = h.sent.filter((m) => m.t === "gift");
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].gift.count, 3);
  assert.equal(gifts[0].total, 3);
  assert.equal(h.sent.filter((m) => m.t === "giftStreak").length, 3);
  assert.equal(h.show.topGifter.coins, 3);
  assert.equal(h.ledger.sessionTotals().value, 3);
  assert.equal(h.show.gifts.length, 1); // one thank-you queued, not four
});

test("a streak that never sends its final message is performed once when it times out", () => {
  const h = harness();
  const kai = user("102", "Kai");
  h.deliver(giftMsg("k1", kai, rose, 1, false));
  h.deliver(giftMsg("k2", kai, rose, 2, false));
  assert.equal(h.sent.filter((m) => m.t === "gift").length, 0);
  h.advance(16_000);
  h.ledger.sweep();
  const gifts = h.sent.filter((m) => m.t === "gift");
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].gift.count, 2);
  assert.equal(gifts[0].total, 2);
});

test("the top supporter follows the ledger, by value for this LIVE", () => {
  const h = harness();
  h.deliver(giftMsg("a1", user("101", "Ana"), rose, 5, true));
  assert.equal(h.show.topGifter.user.nick, "Ana");
  h.deliver(giftMsg("b1", user("103", "Bea"), lion, 1, false, "")); // a Lion is not a streak gift
  const last = h.sent.filter((m) => m.t === "gift").at(-1);
  assert.equal(last.total, 29999);
  assert.equal(last.newTop, true);
  assert.equal(h.show.topGifter.user.nick, "Bea");
  assert.equal(h.show.topGifter.coins, 29999);
});

test("test-panel gifts without a ledger outcome still work, with a short duplicate window", () => {
  const h = harness();
  const ev = { kind: "gift", user: { id: "p1", nick: "Panel" }, gift: { name: "Rose", coins: 1, count: 1 } };
  h.show.handle({ ...ev });
  h.show.handle({ ...ev });
  assert.equal(h.sent.filter((m) => m.t === "gift").length, 1);
});
