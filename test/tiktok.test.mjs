// TikTokSource lifecycle tests against a fake connection that speaks the same event names and
// payload shapes as tiktok-live-connector 2.5.0. No network access, deterministic clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as P from "tiktok-live-connector";
import { TikTokSource } from "../src/tiktok.js";
import { Ledger } from "../src/ledger.js";
import { giftMessage, chatMessage, giftStruct, num, ROOM, T0, CREATOR, VIEWERS } from "./fixtures.test.mjs";

const flush = () => new Promise((r) => setImmediate(r));

function fakeClock(start = T0) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(++seq, { id: seq, at: now + ms, fn }), seq),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => (timers.set(++seq, { id: seq, at: now + ms, fn, every: ms }), seq),
    clearInterval: (id) => timers.delete(id),
    pending: () => [...timers.values()],
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every;
        else timers.delete(due.id);
        due.fn();
        await flush();
        await flush();
      }
      now = end;
      await flush();
      await flush();
    },
  };
}

const ROOM_INFO = { data: { owner: { id_str: CREATOR.userId, display_id: CREATOR.uniqueId, nickname: CREATOR.nick }, status: 2 } };

class FakeConnection extends EventEmitter {
  constructor(uniqueId, options, step, gifts) {
    super();
    this.uniqueId = uniqueId;
    this.options = options;
    this.step = step;
    this.gifts = gifts;
    this.isConnected = false;
    this.ws = new EventEmitter();
    this.disconnectCalls = 0;
    this.listenersAtConnect = null;
  }
  async connect() {
    this.listenersAtConnect = this.eventNames().map(String);
    await flush();
    if (this.step.error) throw this.step.error;
    this.roomId = this.step.roomId || ROOM;
    this.emit("websocketConnected", this.ws);
    this.isConnected = true;
    const state = { isConnected: true, isConnecting: false, roomId: this.roomId, roomInfo: this.step.roomInfo ?? ROOM_INFO, availableGifts: null };
    this.emit("connected", state);
    return state;
  }
  async disconnect() {
    this.disconnectCalls++;
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit("disconnected", { code: 1000, reason: "" });
  }
  async fetchAvailableGifts() {
    if (this.gifts instanceof Error) throw this.gifts;
    return this.gifts;
  }
  // What the connector does for one decoded webcast message.
  push(eventName, data) {
    this.emit("websocketData", Buffer.from([1]));
    this.emit("decodedData", eventName, data, new Uint8Array());
    this.emit(eventName, data);
  }
  drop(code = 1006) {
    this.isConnected = false;
    this.emit("disconnected", { code, reason: "abnormal closure" });
  }
}

function harness({ plan = [{}], gifts = [], ledger = true, ...opts } = {}) {
  const clock = fakeClock();
  const conns = [];
  const source = new TikTokSource({
    eulerApiKey: "test-key-not-real",
    now: clock.now,
    random: () => 0.5,
    timers: clock,
    createConnection: (uniqueId, options) => {
      const step = plan[Math.min(conns.length, plan.length - 1)];
      const c = new FakeConnection(uniqueId, options, step, gifts);
      conns.push(c);
      return c;
    },
    ...opts,
  });
  const events = [];
  const dropped = [];
  const logs = [];
  const l = ledger ? new Ledger({ persist: false, autoSweep: false, now: clock.now }) : null;
  if (l) l.bindSource(source);
  source.on("event", (e) => events.push(e));
  source.on("dropped", (d) => dropped.push(d));
  source.on("log", (t) => logs.push(t));
  return { clock, conns, source, events, dropped, logs, ledger: l };
}

const now = (h) => h.clock.now();
const chat = (h, msgId, content, at = now(h)) => chatMessage({ msgId, content, createTime: at });
const rose = (h, msgId, repeatCount, repeatEnd, at = now(h)) => giftMessage({ msgId, repeatCount, repeatEnd, groupId: "G1", createTime: at });

test("one controlled connection: listeners before connect, concurrent connects deduplicated, everything removed on teardown", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.source.connect("casadeselvin"), h.source.connect("@casadeselvin")]);
  assert.equal(h.conns.length, 1, "a second connect() for the same target reuses the attempt");
  assert.equal(a.state, "connected");
  assert.equal(b.state, "connected");
  const conn = h.conns[0];
  for (const name of ["chat", "gift", "like", "follow", "share", "streamEnd", "disconnected", "error", "connected", "decodedData"]) {
    assert.ok(conn.listenersAtConnect.includes(name), `${name} listener registered before connect()`);
    assert.equal(conn.listenerCount(name), 1, `exactly one ${name} listener`);
  }
  assert.equal(conn.options.processInitialData, false);
  assert.equal(conn.options.enableExtendedGiftInfo, false);
  const s = h.source.status;
  assert.deepEqual([s.uniqueId, s.roomId, s.creator.userId], ["casadeselvin", ROOM, CREATOR.userId]);
  assert.equal(JSON.stringify(s).includes("test-key-not-real"), false, "the sign key never appears in status");
  await h.source.connect("casadeselvin");
  assert.equal(h.conns.length, 1, "connect() while connected is a no-op");
  await h.source.disconnect();
  assert.equal(conn.eventNames().length, 0, "all listeners removed");
  assert.equal(conn.ws.listenerCount("protoMessageFetchResult"), 0);
  assert.equal(h.source.status.state, "disconnected");
  assert.equal(h.ledger.gaps().gaps[0].reason, "stopped");
  await h.clock.advance(10 * 60_000);
  assert.equal(h.conns.length, 1, "no reconnect after a deliberate disconnect");
});

test("transient drop: gap recorded, jittered backoff, reconnect replay is neither re-emitted nor double counted", async () => {
  const h = harness();
  await h.source.connect("casadeselvin");
  const c1 = h.conns[0];
  await h.clock.advance(1000);
  const tChat = now(h);
  c1.push("chat", chat(h, "m1", "hello there"));
  c1.push("gift", rose(h, "g1", 1, false));
  c1.push("gift", rose(h, "g2", 2, false));
  assert.equal(h.events.length, 3);
  await h.clock.advance(10_000);
  c1.drop(1006);
  assert.equal(h.source.status.state, "reconnecting");
  assert.equal(h.source.status.errorKind, "network");
  assert.equal(h.source.status.retry.delayMs, 1500, "attempt 1: base 2 s with equal jitter (random 0.5)");
  assert.equal(c1.eventNames().length, 0);
  assert.equal(h.ledger.flags().gapOpen, true);
  await h.clock.advance(1499);
  assert.equal(h.conns.length, 1);
  await h.clock.advance(1);
  assert.equal(h.conns.length, 2);
  const c2 = h.conns[1];
  assert.equal(h.source.status.state, "connected");
  assert.equal(h.ledger.flags().gapOpen, false, "gap closed on reconnect to the same room");
  assert.equal(h.ledger.gaps().gaps[0].durationMs, 1500);
  // the push frame flags history; the server clock is reported too
  c2.ws.emit("protoMessageFetchResult", { now: String(now(h)), messages: [{ isHistory: true, msgId: num("hist-1") }] });
  c2.push("chat", chatMessage({ msgId: "hist-1", content: "flagged history", createTime: now(h) }));
  c2.push("chat", chat(h, "m1", "hello there", tChat)); // replay of what we saw
  c2.push("chat", chat(h, "m-gap", "sent while we were away", now(h) - 1000 - 6000)); // missed during the gap
  c2.push("gift", rose(h, "g2", 2, false, tChat)); // replayed streak update
  await h.clock.advance(500);
  c2.push("gift", rose(h, "g3", 3, false));
  c2.push("gift", rose(h, "g4", 3, true));
  c2.push("chat", chat(h, "m2", "hello there")); // identical text, new message
  const texts = h.events.filter((e) => e.kind === "comment").map((e) => e.id);
  assert.deepEqual(texts, [num("m1"), num("m2")]);
  assert.deepEqual(h.dropped.map((d) => d.reason), ["history", "history", "history", "history"]);
  const t = h.ledger.sessionTotals();
  assert.deepEqual([t.giftCount, t.value, t.contributions], [3, 3, 1]);
  assert.equal(h.ledger.flags().incomplete, true);
  // after the history window, late delivery is treated as live regardless of clock skew
  await h.clock.advance(20_000);
  c2.push("chat", chat(h, "m3", "skewed clock", now(h) - 60_000));
  assert.equal(h.events.at(-1).id, num("m3"));
});

test("rate limit: retry-after is honoured and connect() does not bypass it", async () => {
  const limited = new P.SignatureRateLimitError("You have exceeded the free connection limit for now.", "Too many connections started, try again in %s", { headers: { "retry-after": "30" } });
  const h = harness({ plan: [{ error: limited }, {}] });
  const s = await h.source.connect("casadeselvin");
  assert.equal(s.state, "rate_limited");
  assert.equal(s.errorKind, "rate_limited");
  assert.ok(s.retry.delayMs >= 30_000, `delay ${s.retry.delayMs}`);
  assert.equal(s.retry.retryAfterMs, 30_000);
  await h.source.connect("casadeselvin");
  assert.equal(h.conns.length, 1, "pressing connect again does not skip the wait");
  await h.clock.advance(29_999);
  assert.equal(h.conns.length, 1);
  await h.clock.advance(s.retry.delayMs - 29_999);
  assert.equal(h.conns.length, 2);
  assert.equal(h.source.status.state, "connected");
});

test("creator offline: distinct state, slow polling, then connects when live", async () => {
  const h = harness({ plan: [{ error: new P.UserOfflineError("The requested user isn't online :(") }, {}], offlinePollMs: 60_000 });
  const s = await h.source.connect("casadeselvin");
  assert.equal(s.state, "offline");
  assert.equal(s.retry.kind, "offline");
  assert.equal(s.retry.delayMs, 60_000);
  await h.clock.advance(60_000);
  assert.equal(h.source.status.state, "connected");
  assert.equal(h.ledger.flags().trackingBeganMidStream, true);
});

test("stream ended: ended state and no reconnect", async () => {
  const h = harness();
  await h.source.connect("casadeselvin");
  const c = h.conns[0];
  c.push("streamEnd", { action: P.ControlAction.CONTROL_ACTION_STREAM_ENDED });
  await c.disconnect(); // the connector disconnects by itself after a stream end
  assert.equal(h.source.status.state, "ended");
  await h.clock.advance(30 * 60_000);
  assert.equal(h.conns.length, 1);
  assert.equal(c.eventNames().length, 0);
  assert.equal(h.ledger.flags().gapOpen, false, "an ended stream is not a collection gap");
  assert.ok(h.ledger.snapshot().session.streamEndedAt);
});

test("auth / sign failures: auth is final, transient sign errors back off", async () => {
  const h = harness({ plan: [{ error: new P.PremiumFeatureError("This endpoint requires a paid plan API key", "Error fetching the signed TikTok WebSocket") }] });
  const s = await h.source.connect("casadeselvin");
  assert.equal(s.state, "auth_failed");
  assert.equal(s.retry, null);
  await h.clock.advance(10 * 60_000);
  assert.equal(h.conns.length, 1);

  const h2 = harness({ plan: [{ error: new P.SignAPIError("Sign Error", "l", "a", "Unexpected sign server status 503. Payload: busy") }, { error: new P.SignAPIError("Empty Cookies", "l", "a", "No cookies") }, {}] });
  const s2 = await h2.source.connect("casadeselvin");
  assert.equal(s2.state, "reconnecting");
  assert.equal(s2.errorKind, "sign");
  assert.equal(s2.retry.delayMs, 1500);
  await h2.clock.advance(1500);
  assert.equal(h2.source.status.retry.delayMs, 3000, "exponential growth");
  await h2.clock.advance(3000);
  assert.equal(h2.source.status.state, "connected");
});

test("health separates socket open from events verified; a silent socket is reconnected", async () => {
  const h = harness({ staleEventMs: 45_000, stallTimeoutMs: 90_000, healthIntervalMs: 5000 });
  await h.source.connect("casadeselvin");
  let s = h.source.status;
  assert.deepEqual([s.health.socket, s.health.events, s.health.verified], ["open", "awaiting_first_event", false]);
  h.conns[0].push("roomUser", { common: {} });
  s = h.source.status;
  assert.deepEqual([s.health.events, s.health.verified, s.health.msSinceLastEvent], ["verified", true, 0]);
  await h.clock.advance(50_000);
  s = h.source.status;
  assert.deepEqual([s.health.socket, s.health.events], ["open", "silent"]);
  await h.clock.advance(45_000);
  s = h.source.status;
  assert.equal(s.state, "reconnecting");
  assert.equal(h.ledger.gaps().gaps[0].reason, "stalled");
  assert.equal(h.ledger.gaps().gaps[0].start, T0, "the gap starts at the last data seen");
});

test("malformed payloads are dropped and logged without breaking the connection", async () => {
  const h = harness();
  await h.source.connect("casadeselvin");
  const c = h.conns[0];
  assert.doesNotThrow(() => {
    c.push("chat", null);
    c.push("gift", { user: {} });
    c.push("gift", { user: VIEWERS.ana });
    c.push("like", "garbage");
  });
  c.push("chat", chat(h, "ok1", "still works"));
  assert.equal(h.source.status.health.dropped.malformed, 4);
  assert.equal(h.events.length, 1);
  assert.ok(h.logs.some((l) => l.startsWith("Dropped a malformed")));
  assert.equal(h.ledger.history(10).filter((e) => e.reason === "malformed").length, 4);
  // a consumer that throws does not break ingestion either
  h.source.on("event", () => {
    throw new Error("consumer bug");
  });
  c.push("chat", chat(h, "ok2", "and again"));
  assert.equal(h.source.status.health.consumerErrors, 1);
  assert.equal(h.source.status.state, "connected");
});

test("gift list is fetched after connecting, off the event path; pending gifts resolve", async () => {
  const h = harness({ gifts: [{ id: 99001, name: "Brand New", diamond_count: 15, type: 2, image: { url_list: ["https://p16.example/new.png"] } }], catalogDelayMs: 3000 });
  await h.source.connect("casadeselvin");
  const c = h.conns[0];
  c.push("gift", giftMessage({ msgId: "u1", giftId: "99001", gift: null, repeatEnd: true, createTime: now(h) }));
  assert.equal(h.events.length, 1, "chat/gift flow is not blocked by the gift list");
  assert.equal(h.ledger.sessionTotals().pendingContributions, 1);
  await h.clock.advance(3000);
  assert.equal(h.source.status.giftCatalog.state, "ok");
  const t = h.ledger.sessionTotals();
  assert.deepEqual([t.value, t.pendingContributions], [15, 0]);
  // later events for that gift id now carry catalog metadata straight away
  c.push("gift", giftMessage({ msgId: "u2", giftId: "99001", gift: null, createTime: now(h) }));
  assert.equal(h.events.at(-1).gift.metadata, "catalog");

  const failing = harness({ gifts: new Error("sign quota"), catalogDelayMs: 3000 });
  await failing.source.connect("casadeselvin");
  await failing.clock.advance(3000);
  assert.equal(failing.source.status.giftCatalog.state, "failed");
  assert.equal(failing.source.status.state, "connected", "a failed gift list never breaks the connection");
});

test("switching creators tears the old connection down; stale callbacks are ignored", async () => {
  const h = harness({ plan: [{ roomId: "111" }, { roomId: "222" }] });
  await h.source.connect("first_creator");
  const old = h.conns[0];
  await h.source.connect("second_creator");
  assert.equal(h.conns.length, 2);
  assert.equal(old.eventNames().length, 0);
  old.emit("chat", chat(h, "stale", "from the old room"));
  assert.equal(h.events.length, 0);
  assert.deepEqual([h.source.status.uniqueId, h.source.status.roomId], ["second_creator", "222"]);
  assert.equal(h.ledger.snapshot().session.roomId, "222");
  assert.equal(h.ledger.snapshot().pastSessions[0].roomId, "111");
});

test("graceful shutdown leaves no timers or listeners behind", async () => {
  const h = harness();
  await h.source.connect("casadeselvin");
  await h.source.shutdown();
  assert.equal(h.conns[0].eventNames().length, 0);
  assert.deepEqual(h.clock.pending(), []);
  assert.equal(h.source.status.state, "disconnected");
});

test("the ledger records before any other listener sees the event (show integration)", async () => {
  const clock = fakeClock();
  const conns = [];
  const source = new TikTokSource({ now: clock.now, random: () => 0.5, timers: clock, createConnection: (u, o) => (conns.push(new FakeConnection(u, o, {}, [])), conns.at(-1)) });
  const seen = [];
  source.on("event", (e) => seen.push(e.ledger)); // registered first, like show.handle in server.js
  const ledger = new Ledger({ persist: false, autoSweep: false, now: clock.now, streakTimeoutMs: 15_000 });
  ledger.bindSource(source);
  const finals = [];
  ledger.on("finalized", (f) => finals.push(f));
  await source.connect("casadeselvin");
  const c = conns[0];
  c.push("gift", rose({ clock }, "s1", 1, false));
  c.push("gift", rose({ clock }, "s2", 2, false));
  assert.deepEqual(seen.map((o) => [o.accepted, o.provisional, o.contribution.count]), [[true, true, 1], [true, true, 2]]);
  await clock.advance(16_000);
  ledger.sweep();
  assert.equal(finals.length, 1);
  assert.deepEqual([finals[0].reason, finals[0].contribution.count, finals[0].contribution.supporter.nick], ["timeout", 2, "Ana"]);
});

test("co-host gifts and creator identity flow through to the ledger", async () => {
  const h = harness({ plan: [{ roomInfo: { data: {} } }] }); // room info without owner fields
  await h.source.connect("casadeselvin");
  const c = h.conns[0];
  const lion = giftStruct({ id: "6", name: "Lion", diamondCount: 500, type: 2 });
  const toHostById = { ...giftMessage({ msgId: "x1", giftId: "6", gift: lion, createTime: now(h) }) };
  toHostById.toUser = { ...toHostById.user, id: CREATOR.userId, displayId: "", nickname: "" };
  c.push("gift", toHostById);
  assert.equal(h.ledger.sessionTotals().pendingContributions, 1, "recipient cannot be compared yet");
  // the creator speaks in chat: userIdentity.isAnchor reveals their stable id
  const hostChat = chatMessage({ msgId: "x2", content: "thank you!", isAnchor: true, createTime: now(h), sender: { ...VIEWERS.ana, id: CREATOR.userId, displayId: CREATOR.uniqueId } });
  c.push("chat", hostChat);
  assert.deepEqual([h.ledger.sessionTotals().value, h.ledger.sessionTotals().pendingContributions], [500, 0]);
});
