import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, normalizeGift, normalizeUser, normalizeGiftCatalog, classifyError, computeBackoff, toMs, clip, VALUE_UNIT } from "../src/tiktok.js";
import * as P from "tiktok-live-connector";
import { giftMessage, chatMessage, likeMessage, socialMessage, user, giftStruct, VIEWERS, ROOM, T0, CREATOR } from "./fixtures.test.mjs";

const ctx = (over = {}) => ({ roomId: ROOM, receivedAt: T0 + 500, ...over });

test("comment: stable id from msgId, stable numeric user id, Unicode preserved", () => {
  const text = "Ünïcödé 👩🏽‍💻 مرحبا 日本語 \u200d e\u0301";
  const sender = user({ id: "7000000000000000009", nickname: "ẞtraße 🦇", displayId: "strasse" });
  const r = normalizeEvent("comment", chatMessage({ msgId: "7301", content: text, sender }), ctx());
  assert.equal(r.ok, true);
  const e = r.event;
  assert.equal(e.id, "7301");
  assert.equal(e.kind, "comment");
  assert.equal(e.roomId, ROOM);
  assert.equal(e.text, text);
  assert.deepEqual([e.user.id, e.user.uniqueId, e.user.nick], ["7000000000000000009", "strasse", "ẞtraße 🦇"]);
  assert.equal(e.providerTime, T0);
  assert.equal(e.receivedAt, T0 + 500);
});

test("identical comment text is two messages unless the id matches", () => {
  const a = normalizeEvent("comment", chatMessage({ msgId: "1", content: "same" }), ctx()).event;
  const b = normalizeEvent("comment", chatMessage({ msgId: "2", content: "same" }), ctx()).event;
  assert.notEqual(a.id, b.id);
  // no msgId: deterministic hash of the fields, distinct when provider time differs
  const c = normalizeEvent("comment", chatMessage({ msgId: "0", content: "same", createTime: T0 }), ctx()).event;
  const d = normalizeEvent("comment", chatMessage({ msgId: "0", content: "same", createTime: T0 + 1 }), ctx()).event;
  const c2 = normalizeEvent("comment", chatMessage({ msgId: "0", content: "same", createTime: T0 }), ctx()).event;
  assert.match(c.id, /^h:/);
  assert.notEqual(c.id, d.id);
  assert.equal(c.id, c2.id, "hash ids are deterministic");
  // no msgId and no provider time: still distinct per receipt
  const e1 = normalizeEvent("comment", { user: VIEWERS.ana, content: "same" }, ctx({ receivedAt: 1 })).event;
  const e2 = normalizeEvent("comment", { user: VIEWERS.ana, content: "same" }, ctx({ receivedAt: 2 })).event;
  assert.notEqual(e1.id, e2.id);
});

test("very long and exotic usernames are clipped by grapheme, never split, never throw", () => {
  const longNick = "👨‍👩‍👧‍👦".repeat(400) + "z".repeat(5000);
  const longHandle = "a".repeat(1000);
  const u = normalizeUser(user({ id: "42", nickname: longNick, displayId: longHandle }));
  assert.equal(u.id, "42");
  assert.ok(u.nick.endsWith("…"));
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(u.nick)];
  assert.equal(graphemes.length, 257); // 256 + ellipsis
  assert.equal(graphemes[0].segment, "👨‍👩‍👧‍👦");
  assert.equal(u.uniqueId.length, 129);
  assert.equal(clip("short", 10), "short");
  // handle only, no numeric id: falls back to a handle-based id, marked unverified
  const h = normalizeUser({ displayId: "Only_Handle" });
  assert.equal(h.id, "handle:only_handle");
  assert.equal(h.idVerified, false);
});

test("malformed payloads are dropped with a reason, never thrown", () => {
  const cases = [
    ["comment", null],
    ["comment", 42],
    ["comment", "text"],
    ["comment", {}],
    ["comment", { user: {} }],
    ["comment", { user: VIEWERS.ana }],
    ["comment", { user: VIEWERS.ana, content: 5 }],
    ["gift", { user: VIEWERS.ana }],
    ["gift", { user: VIEWERS.ana, giftId: "0", gift: { id: "0" } }],
    ["gift", P.deserializeMessage("WebcastGiftMessage", Buffer.from([]))],
    ["like", { user: null }],
    ["gift", Object.defineProperty({}, "user", { get() { throw new Error("boom"); } })],
  ];
  for (const [kind, payload] of cases) {
    const r = normalizeEvent(kind, payload, ctx());
    assert.equal(r.ok, false, `${kind} ${JSON.stringify(payload)}`);
    assert.ok(["malformed", "empty_comment"].includes(r.reason), r.reason);
  }
  assert.equal(normalizeEvent("comment", chatMessage({ content: "   " }), ctx()).reason, "empty_comment");
});

test("gift adapter: id + payload metadata, unit label, streak fields from the v3 schema", () => {
  const r = normalizeEvent("gift", giftMessage({ msgId: "9", repeatCount: 4, repeatEnd: false, groupId: "555" }), ctx());
  const g = r.event.gift;
  assert.equal(g.id, "5655");
  assert.equal(g.name, "Rose");
  assert.equal(g.diamondCount, 1);
  assert.equal(g.unit, VALUE_UNIT.id);
  assert.equal(VALUE_UNIT.label, "diamonds");
  assert.equal(g.metadata, "payload");
  assert.equal(g.streakable, true);
  assert.equal(g.repeatCount, 4);
  assert.equal(g.repeatEnd, false);
  assert.equal(g.groupId, "555");
  assert.equal(g.image, "https://p16.example/rose.png");
  assert.equal(r.event.recipient, null, "no toUser: unspecified recipient");
  const big = normalizeEvent("gift", giftMessage({ msgId: "10", giftId: "6", gift: giftStruct({ id: "6", name: "Lion", diamondCount: 29999, type: 2 }) }), ctx()).event.gift;
  assert.equal(big.streakable, false);
  assert.equal(big.diamondCount, 29999);
});

test("unknown gift: metadata missing stays pending (null), catalog fills it, names never used as identity", () => {
  const raw = giftMessage({ msgId: "11", giftId: "99999", gift: null });
  const pending = normalizeEvent("gift", raw, ctx()).event.gift;
  assert.equal(pending.id, "99999");
  assert.equal(pending.diamondCount, null);
  assert.equal(pending.metadata, "pending");
  assert.equal(pending.streakable, null);
  assert.equal(pending.coins, 0, "legacy coins field never guesses a value");
  const catalog = new Map(normalizeGiftCatalog([{ id: 99999, name: "Brand New", diamond_count: 250, type: 2, image: { url_list: ["https://p16.example/new.png"] } }]).map((g) => [g.id, g]));
  const resolved = normalizeEvent("gift", raw, ctx({ catalog })).event.gift;
  assert.equal(resolved.diamondCount, 250);
  assert.equal(resolved.metadata, "catalog");
  assert.equal(resolved.streakable, false);
  // A gift with a known name but a different id is a different gift
  const sameName = normalizeGift({ giftId: "1", gift: giftStruct({ id: "1", name: "Rose", diamondCount: 5 }) });
  assert.equal(sameName.id, "1");
  assert.equal(sameName.diamondCount, 5);
});

test("recipient: toUser identity is extracted for co-host gifts", () => {
  const guest = user({ id: "8000000000000000001", nickname: "Guest", displayId: "guest" });
  const r = normalizeEvent("gift", giftMessage({ msgId: "12", toUser: guest }), ctx()).event;
  assert.deepEqual(r.recipient, { id: "8000000000000000001", uniqueId: "guest", nick: "Guest", idKind: "user" });
  const toHost = normalizeEvent("gift", giftMessage({ msgId: "13", toUser: user({ id: CREATOR.userId, displayId: CREATOR.uniqueId }) }), ctx()).event;
  assert.equal(toHost.recipient.id, CREATOR.userId);
  const member = normalizeEvent("gift", giftMessage({ msgId: "14", toMemberIdInt: "123" }), ctx()).event;
  assert.equal(member.recipient.idKind, "member");
});

test("like / follow / share normalize; isAnchor marks the creator", () => {
  assert.equal(normalizeEvent("like", likeMessage({ msgId: "20", count: 15 }), ctx()).event.count, 15);
  assert.equal(normalizeEvent("follow", socialMessage({ msgId: "21" }), ctx()).event.kind, "follow");
  assert.equal(normalizeEvent("share", socialMessage({ msgId: "22" }), ctx()).event.kind, "share");
  const host = user({ id: CREATOR.userId, nickname: "Host", displayId: CREATOR.uniqueId });
  assert.equal(normalizeEvent("comment", chatMessage({ msgId: "23", sender: host, isAnchor: true }), ctx()).event.fromCreator, true);
});

test("provider timestamps in s / ms / µs normalize to ms", () => {
  assert.equal(toMs("1761200000"), 1761200000000);
  assert.equal(toMs("1761200000123"), 1761200000123);
  assert.equal(toMs("1761200000123456"), 1761200000123);
  assert.equal(toMs("0"), null);
  assert.equal(toMs("garbage"), null);
});

test("error classification uses this version's error classes", () => {
  const rate = new P.SignatureRateLimitError("You have exceeded the free connection limit for now.", "retry in %s", { headers: { "retry-after": "30" } });
  assert.deepEqual([classifyError(rate).kind, classifyError(rate).retryAfterMs], ["rate_limited", 30_000]);
  const reset = new P.SignatureRateLimitError(null, "retry in %s", { headers: { "x-ratelimit-reset": String(Math.floor(T0 / 1000) + 90) } });
  assert.equal(classifyError(reset, { now: T0 }).retryAfterMs, 90_000);
  assert.equal(classifyError(new P.UserOfflineError("The requested user isn't online :(")).kind, "offline");
  assert.equal(classifyError(new P.PremiumFeatureError("This needs a paid plan API key here", "x")).kind, "auth");
  assert.equal(classifyError(new P.SignAPIError("Sign Error", "a", "b", "Unexpected sign server status 401. Payload: {}")).kind, "auth");
  assert.equal(classifyError(new P.SignAPIError("Sign Error", "a", "b", "Unexpected sign server status 503. Payload: {}")).kind, "sign");
  assert.equal(classifyError(new P.SignAPIError("Connect Error", undefined, undefined, "Failed to connect to sign server.")).kind, "network");
  assert.equal(classifyError(new P.ConnectTimeoutError("Timed out whilst connecting to WebSocket")).kind, "network");
  assert.equal(classifyError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })).kind, "network");
  assert.equal(classifyError(new P.InvalidUniqueIdError("bad")).kind, "config");
  const secret = classifyError(new Error("failed with key sk-secret-123"), { secret: "sk-secret-123" });
  assert.equal(secret.message.includes("sk-secret-123"), false);
});

test("backoff is bounded, exponential and jittered", () => {
  const opts = { baseMs: 2000, maxMs: 60_000, factor: 2 };
  assert.equal(computeBackoff(1, opts, () => 0), 1000);
  assert.equal(computeBackoff(1, opts, () => 1), 2000);
  assert.equal(computeBackoff(3, opts, () => 1), 8000);
  assert.equal(computeBackoff(20, opts, () => 1), 60_000);
  assert.equal(computeBackoff(20, opts, () => 0), 30_000);
});
