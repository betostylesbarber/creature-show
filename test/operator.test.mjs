import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { operatorRoutes, configureOperator } from "../src/operator.js";
import { Ledger, DISCLAIMER } from "../src/ledger.js";
import { normalizeEvent } from "../src/tiktok.js";
import { giftMessage, ROOM, T0, CREATOR } from "./fixtures.test.mjs";

function call(pathAndQuery, { method = "GET", ctx } = {}) {
  const url = new URL(pathAndQuery, "http://localhost");
  const res = {
    code: null,
    headers: null,
    body: "",
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    },
  };
  const handled = operatorRoutes({ method }, res, url, ctx);
  return { handled, code: res.code, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

function context() {
  const ledger = new Ledger({ persist: false, autoSweep: false, now: () => T0 });
  ledger.beginSession({ roomId: ROOM, uniqueId: CREATOR.uniqueId, creator: CREATOR, connectedAt: T0 });
  for (const [msgId, n, end] of [["a", 1, false], ["b", 2, false], ["c", 2, true], ["c", 2, true]]) {
    ledger.record(normalizeEvent("gift", giftMessage({ msgId, repeatCount: n, repeatEnd: end, groupId: "G" }), { roomId: ROOM, receivedAt: T0 }).event);
  }
  const source = { status: { state: "connected", roomId: ROOM, uniqueId: CREATOR.uniqueId, retry: null, health: { socket: "open", events: "verified" } } };
  return { ledger, source };
}

test("non-operator paths are not handled", () => {
  assert.equal(call("/api/state").handled, false);
  assert.equal(call("/api/operatorx").handled, false);
});

test("GET /api/operator/ledger returns exact totals, units, flags and the disclaimer", () => {
  const r = call("/api/operator/ledger", { ctx: context() });
  assert.equal(r.handled, true);
  assert.equal(r.code, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.json.totals.giftCount, 2);
  assert.equal(r.json.totals.value, 2);
  assert.equal(r.json.unit.id, "diamondCount");
  assert.equal(r.json.topSupporter.value, 2);
  assert.equal(r.json.flags.trackingBeganMidStream, true);
  assert.equal(r.json.disclaimer, DISCLAIMER);
  assert.match(r.json.disclaimer, /not TikTok's authoritative/i);
});

test("GET /api/operator/events returns outcomes, limited", () => {
  const all = call("/api/operator/events?limit=10", { ctx: context() });
  assert.equal(all.code, 200);
  assert.deepEqual(all.json.events.map((e) => e.outcome), ["duplicate", "accepted", "accepted", "accepted"]);
  const one = call("/api/operator/events?limit=1", { ctx: context() });
  assert.equal(one.json.events.length, 1);
  const silly = call("/api/operator/events?limit=abc", { ctx: context() });
  assert.equal(silly.json.limit, 100);
});

test("GET /api/operator/connection returns lifecycle, health, gaps and retry", () => {
  const ctx = context();
  ctx.ledger.openGap({ start: T0, reason: "disconnected" });
  const r = call("/api/operator/connection", { ctx });
  assert.equal(r.code, 200);
  assert.equal(r.json.connection.state, "connected");
  assert.equal(r.json.health.events, "verified");
  assert.equal(r.json.ledgerGaps.gaps.length, 1);
  assert.equal(r.json.flags.incomplete, true);
});

test("operator routes are read-only, and report when not configured", () => {
  assert.equal(call("/api/operator/ledger", { method: "POST", ctx: context() }).code, 405);
  assert.equal(call("/api/operator/nope", { ctx: context() }).code, 404);
  assert.equal(call("/api/operator/ledger", { ctx: {} }).code, 503);
});

test("works mounted in a real http server via configureOperator()", async () => {
  const { ledger, source } = context();
  configureOperator({ ledger, source });
  const server = http.createServer((req, res) => {
    if (operatorRoutes(req, res, new URL(req.url, "http://localhost"))) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/operator/ledger`)).json();
    assert.equal(body.totals.giftCount, 2);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    server.close();
    configureOperator({});
  }
});
