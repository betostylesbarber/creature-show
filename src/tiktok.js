// TikTok LIVE ingestion through tiktok-live-connector 2.5.0.
//
// The connector is UNOFFICIAL and reverse engineered: TikTok offers no public API for reading
// LIVE events, so field meanings below come from the connector's installed types
// (node_modules/tiktok-live-proto/dist/node/v3.d.ts) and its source, not from TikTok.
//
// What this module guarantees:
// - one connection object per attempt, listeners registered before connect() and all removed
//   on teardown, a generation counter so a stale attempt can never emit events or reconnect;
// - distinct lifecycle states for offline, stream ended, auth/sign failure, network loss and
//   rate limiting, with bounded exponential backoff plus jitter that honours retry-after;
// - health that separates "socket open" from "events verified" (time since the last decoded
//   message of any kind);
// - a history policy so a (re)connect never replays old comments or gifts, and gap records
//   for every period in which events could not be collected. Missed events are never claimed.
//
// Installed-version notes (where the README and the installed types disagree, the types win):
// - v3 proto User has `id` (stable numeric id, int64 as string), `displayId` (the @handle) and
//   `nickname`; the README's `user.uniqueId` / `profilePictureUrl` do not exist in v3.
// - Chat text is `content` (README says `comment`). Gift metadata is `gift` (README says
//   `giftDetails`); `gift.type === 1` marks a streakable gift, `repeatEnd` is a number (1 = end).
// - `enableExtendedGiftInfo` makes connect() fail if the signed gift-list request fails, and its
//   lookup compares a numeric JSON id with the string `giftId`, so it is left off here and the
//   gift list is fetched separately, after connecting, without blocking chat.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as Connector from "tiktok-live-connector";

const {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  ControlAction,
  UserOfflineError,
  SignatureRateLimitError,
  SignAPIError,
  PremiumFeatureError,
  AuthenticatedWebSocketConnectionError,
  ConnectTimeoutError,
  InvalidUniqueIdError,
  InvalidResponseCompositeError,
} = Connector;

export const CONNECTOR = `tiktok-live-connector ${Connector.VERSION || "2.5.0"} (unofficial, reverse engineered; not a TikTok API)`;

// The only value TikTok's gift metadata carries is `diamondCount` per gift. Neither the
// connector's types nor its docs state the unit; TikTok's gift list calls the same number
// `diamond_count`. It is reported as-is and never converted to money.
export const VALUE_UNIT = Object.freeze({
  id: "diamondCount",
  label: "diamonds",
  description:
    "Sum of the per-gift diamondCount reported by the unofficial connector (TikTok gift metadata) x gift count. Not a cash amount and not converted to any currency.",
});

const NETWORK_CODES = new Set(["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ERR_SOCKET_CONNECTION_TIMEOUT"]);

// Message types that mention gifts or diamonds but are not paid gifts to this creator.
const NOTICE_EVENTS = [
  ["giftPanelUpdate", WebcastEvent.GIFT_PANEL_UPDATE],
  ["goalUpdate", WebcastEvent.GOAL_UPDATE],
  ["battleScore", WebcastEvent.LINK_MIC_ARMIES],
  ["battle", WebcastEvent.LINK_MIC_BATTLE],
  ["giftBroadcast", WebcastEvent.GIFT_BROADCAST],
  ["giftPrompt", WebcastEvent.GIFT_PROMPT],
  ["envelope", WebcastEvent.ENVELOPE],
];

// ---------------------------------------------------------------------------------------------
// Normalization helpers (pure, exported for tests)

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

// Shortens text to `max` user-perceived characters without splitting emoji or combining marks.
export function clip(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  if (!segmenter) return Array.from(text).slice(0, max).join("") + "…";
  let out = "";
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (n === max) return out + "…";
    out += segment;
    n++;
  }
  return out;
}

// Ids arrive as int64 strings ("0" means unset in proto3). Returns "" for unset.
export function idString(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const v = value.trim();
    return v === "0" ? "" : v;
  }
  if (typeof value === "bigint") return value === 0n ? "" : value.toString();
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? String(Math.trunc(value)) : "";
  return "";
}

const str = (v) => (typeof v === "string" ? v : "");

function positiveInt(value) {
  const n = typeof value === "string" ? Number(value) : typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function nonNegInt(value) {
  const n = typeof value === "string" ? Number(value) : typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Provider timestamps: CommonMessageData.createTime (int64 string). Accepts s / ms / µs / ns.
export function toMs(value) {
  const n = typeof value === "string" ? Number(value) : typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e17) return Math.round(n / 1e6);
  if (n >= 1e14) return Math.round(n / 1e3);
  if (n >= 1e11) return Math.round(n);
  if (n >= 1e8) return Math.round(n * 1000);
  return null;
}

function firstUrl(image) {
  const list = image?.urlList || image?.url_list;
  const url = Array.isArray(list) ? list.find((u) => typeof u === "string" && /^https?:\/\//i.test(u)) : null;
  return url || null;
}

export function normalizeUniqueId(input) {
  if (typeof input !== "string") return "";
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
    .replace(/\/live\/?$/i, "")
    .replace(/^@/, "")
    .trim();
}

// v3 proto User -> { id (stable numeric user id), uniqueId (@handle), nick, avatar }.
export function normalizeUser(u) {
  if (!u || typeof u !== "object") return null;
  const id = idString(u.id) || idString(u.idStr) || idString(u.userId);
  const uniqueId = str(u.displayId) || str(u.uniqueId); // uniqueId: legacy/v1 spelling
  if (!id && !uniqueId) return null;
  const nick = str(u.nickname) || str(u.nick) || uniqueId || id;
  return {
    id: id || `handle:${uniqueId.toLowerCase()}`, // the numeric id is stable; a handle can change
    uniqueId: clip(uniqueId, 128),
    nick: clip(nick, 256),
    avatar: firstUrl(u.avatarThumb) || firstUrl(u.avatarMedium) || firstUrl(u.avatarLarge) || (typeof u.profilePictureUrl === "string" ? u.profilePictureUrl : null),
    idVerified: Boolean(id),
  };
}

// Gift adapter: id first, then the freshest metadata available (payload > extended > catalog).
export function normalizeGift(data, catalog = null) {
  const struct = data.gift && typeof data.gift === "object" ? data.gift : null;
  const structId = struct ? idString(struct.id) : "";
  const structUsable = Boolean(struct && (structId || str(struct.name)));
  const ext = data.extendedGiftInfo && typeof data.extendedGiftInfo === "object" ? data.extendedGiftInfo : null;
  const id = idString(data.giftId) || structId || idString(ext?.id);
  if (!id) return null;
  const known = catalog && typeof catalog.get === "function" ? catalog.get(id) || null : null;

  let diamondCount = null;
  let metadata = "pending";
  const structDc = structUsable ? positiveInt(struct.diamondCount) : null;
  const extDc = ext ? positiveInt(ext.diamond_count ?? ext.diamondCount) : null;
  if (structDc != null) [diamondCount, metadata] = [structDc, "payload"];
  else if (extDc != null) [diamondCount, metadata] = [extDc, "extended"];
  else if (known && known.diamondCount != null) [diamondCount, metadata] = [known.diamondCount, "catalog"];

  const type = structUsable && Number.isInteger(struct.type) ? struct.type : Number.isInteger(ext?.type) ? ext.type : Number.isInteger(known?.type) ? known.type : null;
  const streakable = type === 1 ? true : type == null ? (struct?.combo === true ? true : null) : false;
  const repeatCount = positiveInt(data.repeatCount) ?? 1;
  const repeatEnd = data.repeatEnd === true || Number(data.repeatEnd) === 1;
  return {
    id,
    name: clip(str(struct?.name) || str(ext?.name) || str(known?.name), 128) || null,
    image: firstUrl(struct?.image) || firstUrl(struct?.icon) || firstUrl(ext?.image) || known?.image || null,
    diamondCount, // per gift, null = not known yet (pending, never guessed)
    unit: VALUE_UNIT.id,
    metadata, // "payload" | "extended" | "catalog" | "pending"
    type,
    streakable, // true | false | null (unknown: treated as a streak until repeatEnd or timeout)
    repeatCount, // cumulative within a streak
    repeatEnd,
    groupId: idString(data.groupId),
    comboCount: nonNegInt(data.comboCount),
    groupCount: nonNegInt(data.groupCount), // recorded, not used for value (meaning unverified)
    // Legacy fields kept so the pre-ledger show.js keeps working; prefer event.ledger.
    coins: diamondCount ?? 0,
    count: repeatCount,
    streaking: streakable !== false && !repeatEnd,
  };
}

// Who the gift was sent to. In co-host / multi-guest rooms this can be someone else.
export function normalizeRecipient(data) {
  const to = normalizeUser(data.toUser);
  if (to) return { id: to.idVerified ? to.id : "", uniqueId: to.uniqueId, nick: to.nick, idKind: "user" };
  const memberId = idString(data.toMemberIdInt) || idString(data.toMemberId);
  if (memberId) return { id: memberId, uniqueId: "", nick: clip(str(data.toMemberNickname), 256), idKind: "member" };
  return null;
}

function hashId(event) {
  const parts = [event.kind, event.roomId, event.user.id, event.providerTime ?? "", event.text ?? "", event.gift?.id ?? "", event.gift?.repeatCount ?? "", event.gift?.repeatEnd ? 1 : 0, event.gift?.groupId ?? "", event.count ?? ""];
  // Without msgId and provider time, two identical comments must stay distinct messages.
  if (event.providerTime == null && event.kind !== "gift") parts.push(`rx:${event.receivedAt}`);
  return "h:" + createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

function drop(outcome, reason, detail, extra = {}) {
  return { ok: false, outcome, reason, detail, ...extra };
}

// Connector payload (v3 decoded protobuf) -> normalized event. Never throws.
export function normalizeEvent(kind, data, { roomId = "", receivedAt = Date.now(), catalog = null } = {}) {
  try {
    if (!data || typeof data !== "object") return drop("ignored", "malformed", "payload is not an object", { kind });
    const common = data.common && typeof data.common === "object" ? data.common : {};
    const msgId = idString(common.msgId) || idString(data.msgId);
    const providerTime = toMs(common.createTime) ?? toMs(data.createTime);
    const room = idString(common.roomId) || idString(roomId);
    const user = normalizeUser(data.user);
    if (!user) return drop("ignored", "malformed", "sender has no id", { kind, msgId });
    const event = { id: "", kind, source: "tiktok", roomId: room, msgId: msgId || null, providerTime: providerTime ?? null, receivedAt, user };
    if (kind === "comment") {
      const raw = typeof data.content === "string" ? data.content : typeof data.comment === "string" ? data.comment : null;
      if (raw == null) return drop("ignored", "malformed", "comment has no text", { kind, msgId });
      if (!raw.trim()) return drop("ignored", "empty_comment", "comment is empty", { kind, msgId });
      event.text = clip(raw, 2000);
      if (data.userIdentity?.isAnchor === true) event.fromCreator = true;
    } else if (kind === "gift") {
      const gift = normalizeGift(data, catalog);
      if (!gift) return drop("ignored", "malformed", "gift has no gift id", { kind, msgId });
      event.gift = gift;
      event.recipient = normalizeRecipient(data);
    } else if (kind === "like") {
      event.count = positiveInt(data.count) ?? positiveInt(data.likeCount) ?? 1;
      event.totalLikes = nonNegInt(data.total);
    } else if (kind !== "follow" && kind !== "share") {
      return drop("ignored", "unsupported", `unsupported kind ${kind}`, { kind, msgId });
    }
    event.id = msgId || hashId(event);
    return { ok: true, event };
  } catch (err) {
    return drop("ignored", "malformed", err?.message || String(err), { kind });
  }
}

// The connector's gift list is untyped JSON (`any`); accept snake_case and camelCase.
export function normalizeGiftCatalog(list) {
  const items = Array.isArray(list) ? list : Array.isArray(list?.gifts) ? list.gifts : Array.isArray(list?.data?.gifts) ? list.data.gifts : [];
  const out = [];
  for (const g of items) {
    if (!g || typeof g !== "object") continue;
    const id = idString(g.id) || idString(g.id_str);
    if (!id) continue;
    const dc = nonNegInt(g.diamond_count ?? g.diamondCount);
    out.push({ id, name: clip(str(g.name), 128) || null, diamondCount: dc, type: Number.isInteger(g.type) ? g.type : null, image: firstUrl(g.image) || firstUrl(g.icon) || null });
  }
  return out;
}

// Room info is untyped JSON from TikTok's room/info endpoint. Field names here are best-effort
// and unverified against a live payload; missing fields simply leave values null.
export function creatorFromRoomInfo(roomInfo, uniqueId) {
  const data = roomInfo?.data && typeof roomInfo.data === "object" ? roomInfo.data : {};
  const owner = data.owner && typeof data.owner === "object" ? data.owner : {};
  return {
    userId: idString(owner.id_str) || idString(data.owner_user_id_str) || idString(owner.id) || idString(data.owner_user_id) || null,
    uniqueId: str(owner.display_id) || uniqueId || null,
    nick: clip(str(owner.nickname), 256) || null,
    liveStartedAt: toMs(data.create_time) ?? toMs(data.start_time) ?? null,
  };
}

function sanitize(err, secret) {
  let text = String(err?.message || err || "unknown error")
    .replace(/[|+][-\s|+]{6,}[|+]?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (secret) text = text.split(secret).join("[redacted]");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

// Error -> lifecycle category. Exported for tests.
export function classifyError(err, { now = Date.now(), secret } = {}) {
  const message = sanitize(err, secret);
  const is = (C) => typeof C === "function" && err instanceof C;
  if (is(SignatureRateLimitError) || err?.reason === "Rate Limited" || /\b429\b|rate limited|too many connections/i.test(message)) {
    const retryAfterMs = Math.max(0, Number(err?.retryAfter) || 0);
    const reset = Number(err?.resetTime) || 0;
    const resetDelay = reset > 1e12 ? Math.max(0, reset - now) : reset > 0 ? reset : 0;
    return { kind: "rate_limited", retryable: true, retryAfterMs: Math.max(retryAfterMs, resetDelay), message };
  }
  if (is(UserOfflineError) || /isn't online|not (currently )?live|is offline|live has ended/i.test(message)) return { kind: "offline", retryable: true, message };
  if (is(InvalidUniqueIdError) || err instanceof TypeError) return { kind: "config", retryable: false, message };
  if (is(PremiumFeatureError) || is(AuthenticatedWebSocketConnectionError)) return { kind: "auth", retryable: false, message };
  if (is(SignAPIError)) {
    if (err.reason === "Connect Error") return { kind: "network", retryable: true, message };
    const status = /status (\d{3})/.exec(message)?.[1];
    if (status === "401" || status === "403") return { kind: "auth", retryable: false, message };
    return { kind: "sign", retryable: true, message };
  }
  if (is(ConnectTimeoutError) || NETWORK_CODES.has(err?.code) || NETWORK_CODES.has(err?.cause?.code) || /socket hang up|network|timed? ?out|unexpected server response|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { kind: "network", retryable: true, message };
  }
  // fetchRoomId() tried every source and failed: creator not live, wrong name, or a blocked lookup.
  if (is(InvalidResponseCompositeError)) return { kind: "offline", retryable: true, message: `Room lookup failed (creator not live, wrong username, or lookup blocked): ${message}` };
  return { kind: "unknown", retryable: true, message };
}

// Bounded exponential backoff with equal jitter: half fixed, half random.
export function computeBackoff(attempt, { baseMs = 2000, maxMs = 60_000, factor = 2 } = {}, random = Math.random) {
  const exp = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

const STATES = Object.freeze({
  idle: "Not connected yet.",
  connecting: "Connecting…",
  connected: "Connected.",
  reconnecting: "Connection lost; retrying.",
  rate_limited: "Rate limited by the sign server; waiting before retrying.",
  offline: "The creator is not live; checking again periodically.",
  ended: "The LIVE ended.",
  auth_failed: "Authentication or sign failure; not retrying. Check EULER_API_KEY.",
  error: "Configuration error; not retrying.",
  disconnected: "Disconnected by the operator.",
});

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

function withTimeout(promise, ms, timers, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------
// TikTokSource
//
// Events:
//   "event"       normalized comment | gift | follow | share | like (accepted by the history policy)
//   "dropped"     { event?, kind, outcome: "ignored" | "duplicate", reason, detail }
//   "notice"      non-gift messages that mention gifts/diamonds (panel, goals, battles)
//   "session"     { roomId, uniqueId, creator, connectedAt, liveStartedAt, resumed }
//   "creator"     { userId, uniqueId, nick } learned during the session
//   "gap"         { phase: "open" | "close", roomId, start, end, reason, endKnown }
//   "giftCatalog" { roomId, gifts, fetchedAt }
//   "streamEnd"   { roomId, at, action }
//   "status", "log"
export class TikTokSource extends EventEmitter {
  constructor({
    eulerApiKey,
    createConnection,
    now = Date.now,
    random = Math.random,
    timers = defaultTimers,
    backoff = { baseMs: 2000, maxMs: 60_000, factor: 2 },
    offlinePollMs = 60_000,
    rateLimitFloorMs = 30_000,
    historyGraceMs = 5000,
    historyWindowMs = 15_000,
    staleEventMs = 45_000,
    stallTimeoutMs = 90_000,
    healthIntervalMs = 5000,
    giftCatalog = true,
    catalogDelayMs = 3000,
    catalogRefreshMs = 5 * 60_000,
    waitForLive = true,
  } = {}) {
    super();
    this.eulerApiKey = eulerApiKey || undefined;
    this.createConnection = createConnection || ((uniqueId, options) => new TikTokLiveConnection(uniqueId, options));
    this.now = now;
    this.random = random;
    this.timers = timers;
    this.backoff = backoff;
    this.offlinePollMs = offlinePollMs;
    this.rateLimitFloorMs = rateLimitFloorMs;
    this.historyGraceMs = historyGraceMs;
    this.historyWindowMs = historyWindowMs;
    this.staleEventMs = staleEventMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.giftCatalogEnabled = giftCatalog;
    this.catalogDelayMs = catalogDelayMs;
    this.catalogRefreshMs = catalogRefreshMs;
    this.waitForLive = waitForLive;

    this.gen = 0; // bumped on every new attempt / stop; stale async work checks it
    this.conn = null;
    this.inFlight = null;
    this.state = "idle";
    this.stateSince = now();
    this.target = null;
    this.roomId = null;
    this.creator = null;
    this.connectedAt = null;
    this.attemptStartedAt = null;
    this.attempts = 0; // attempts since the last successful connection
    this.retry = null;
    this.retryTimer = null;
    this.lastError = null;
    this.manual = false;
    this.ended = false;
    this.streamPaused = false;
    this.serverOffsetMs = 0;
    this.historyMsgIds = new Set();
    this.recentIds = new Map();
    this.catalog = new Map();
    this.catalogInfo = { state: "none", count: 0, fetchedAt: null, error: null };
    this.catalogTimer = null;
    this.catalogInFlight = false;
    this.catalogLastAttemptAt = 0;
    this.catalogFailures = 0;
    this.gapList = [];
    this.openGap = null;
    this.healthTimer = null;
    this.wsHook = null;
    this.health = this._freshHealth();
    this.totals = { events: 0, dropped: { history: 0, duplicate: 0, malformed: 0, ignored: 0 }, decodeErrors: 0, consumerErrors: 0 };
  }

  _freshHealth() {
    return { lastEventAt: null, lastSocketDataAt: null, eventsThisConnection: 0 };
  }

  // Snapshot for the panel and the operator API (computed on read, so ages are current).
  get status() {
    const now = this.now();
    const h = this.health;
    const connected = this.state === "connected";
    const msSinceLastEvent = h.lastEventAt ? now - h.lastEventAt : null;
    let events = "none";
    if (connected) {
      if (!h.lastEventAt || h.lastEventAt < this.connectedAt) events = "awaiting_first_event";
      else events = msSinceLastEvent <= this.staleEventMs ? "verified" : "silent";
    }
    return {
      state: this.state,
      description: STATES[this.state] || this.state,
      since: this.stateSince,
      username: this.target,
      uniqueId: this.target,
      roomId: this.roomId,
      creator: this.creator,
      connectedAt: connected ? this.connectedAt : null,
      streamPaused: this.streamPaused,
      error: this.lastError?.message || null,
      errorKind: this.lastError?.kind || null,
      lastError: this.lastError,
      attempts: this.attempts,
      retry: this.retry ? { ...this.retry, inMs: Math.max(0, this.retry.nextAt - now) } : null,
      health: {
        socket: connected ? "open" : "closed",
        events,
        verified: events === "verified",
        staleAfterMs: this.staleEventMs,
        lastEventAt: h.lastEventAt,
        msSinceLastEvent,
        lastSocketDataAt: h.lastSocketDataAt,
        msSinceSocketData: h.lastSocketDataAt ? now - h.lastSocketDataAt : null,
        eventsThisConnection: h.eventsThisConnection,
        eventsTotal: this.totals.events,
        decodeErrors: this.totals.decodeErrors,
        consumerErrors: this.totals.consumerErrors,
        dropped: { ...this.totals.dropped },
      },
      historyPolicy: {
        processInitialData: false,
        graceMs: this.historyGraceMs,
        windowMs: this.historyWindowMs,
        serverClockOffsetMs: this.serverOffsetMs,
        boundary: this.connectedAt ? this.connectedAt + this.serverOffsetMs - this.historyGraceMs : null,
      },
      giftCatalog: { ...this.catalogInfo },
      gaps: this.gapList.slice(-20).map((g) => ({ ...g })),
      openGap: this.openGap ? { ...this.openGap } : null,
      connector: CONNECTOR,
    };
  }

  _setState(state, extra = {}) {
    if (extra.error !== undefined) this.lastError = extra.error;
    if (state !== this.state) this.stateSince = this.now();
    this.state = state;
    this.emit("status", this.status);
  }

  _log(text) {
    this.emit("log", text);
  }

  // Connects to `username`'s LIVE. Resolves after the first attempt (success or failure); retries
  // continue in the background. Calling it again for the same target never creates a second
  // connection.
  async connect(username) {
    const uniqueId = normalizeUniqueId(username);
    if (!uniqueId) {
      this._setState("error", { error: { kind: "config", message: "No TikTok username given.", at: this.now() } });
      return this.status;
    }
    const sameTarget = this.target && this.target.toLowerCase() === uniqueId.toLowerCase();
    if (sameTarget && this.inFlight) return this.inFlight;
    if (sameTarget && this.state === "connected") return this.status;
    if (sameTarget && this.state === "rate_limited" && this.retry && this.retry.nextAt > this.now()) {
      this._log(`Still rate limited; next attempt in ${Math.ceil((this.retry.nextAt - this.now()) / 1000)} s.`);
      return this.status;
    }
    if (this.target && !sameTarget) await this._stop("switching to another creator");
    if (!sameTarget) {
      this.roomId = null;
      this.creator = null;
      this.serverOffsetMs = 0;
      this.catalog.clear();
      this.catalogInfo = { state: "none", count: 0, fetchedAt: null, error: null };
      this.catalogFailures = 0;
    }
    this.target = uniqueId;
    this.manual = false;
    this.ended = false;
    this.attempts = 0;
    this._clearRetry();
    return this._attempt();
  }

  _attempt() {
    if (this.inFlight) return this.inFlight;
    const gen = ++this.gen;
    const promise = this._runAttempt(gen).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  async _runAttempt(gen) {
    this.attempts++;
    this.attemptStartedAt = this.now();
    this.retry = null;
    this._setState("connecting");
    let conn;
    try {
      conn = this.createConnection(this.target, {
        signApiKey: this.eulerApiKey,
        processInitialData: false, // the initial batch from the sign server can predate this connection
        fetchRoomInfoOnConnect: true, // gives UserOfflineError for a room that is not live
        enableExtendedGiftInfo: false, // fetched separately, see header
      });
    } catch (err) {
      this._onConnectFailed(err);
      return this.status;
    }
    this.conn = conn;
    this._bind(conn);
    try {
      const state = await conn.connect();
      if (gen !== this.gen || this.conn !== conn) {
        await this._teardown(conn);
        return this.status;
      }
      if (this.state !== "connected") this._onConnected(conn, state);
    } catch (err) {
      if (gen !== this.gen || this.conn !== conn) {
        await this._teardown(conn);
        return this.status;
      }
      await this._teardown(conn);
      if (gen === this.gen) this._onConnectFailed(err);
    }
    return this.status;
  }

  // All listeners for one connection, registered before connect(). Each checks that it still
  // belongs to the current connection, so late callbacks from an old socket are ignored.
  _bind(conn) {
    const mine = () => this.conn === conn;
    const guard = (fn) => (...args) => {
      if (!mine()) return;
      try {
        fn(...args);
      } catch (err) {
        this._log(`TikTok handler error: ${err?.message || err}`);
      }
    };
    conn.on(ControlEvent.CONNECTED, guard((state) => this._onConnected(conn, state)));
    conn.on(ControlEvent.DISCONNECTED, guard((info) => this._onDisconnected(conn, info)));
    conn.on(ControlEvent.ERROR, (payload) => {
      // The connector emits { info, exception }; keep listening even for stale connections so an
      // error never goes unhandled.
      if (!mine()) return;
      const text = sanitize(payload?.exception || payload, this.eulerApiKey);
      if (/decod/i.test(`${payload?.info || ""} ${text}`)) this.totals.decodeErrors++;
      this._log(`TikTok connector: ${payload?.info ? `${payload.info}: ` : ""}${text}`);
    });
    conn.on(ControlEvent.WEBSOCKET_CONNECTED, guard((ws) => this._hookWebSocket(conn, ws)));
    conn.on(ControlEvent.WEBSOCKET_DATA, guard(() => (this.health.lastSocketDataAt = this.now())));
    conn.on(ControlEvent.DECODED_DATA, guard(() => {
      this.health.lastEventAt = this.now();
      this.health.eventsThisConnection++;
      this.totals.events++;
    }));
    conn.on(WebcastEvent.CHAT, guard((data) => this._onProviderEvent("comment", data)));
    conn.on(WebcastEvent.GIFT, guard((data) => this._onProviderEvent("gift", data)));
    conn.on(WebcastEvent.FOLLOW, guard((data) => this._onProviderEvent("follow", data)));
    conn.on(WebcastEvent.SHARE, guard((data) => this._onProviderEvent("share", data)));
    conn.on(WebcastEvent.LIKE, guard((data) => this._onProviderEvent("like", data)));
    conn.on(WebcastEvent.STREAM_END, guard((info) => this._onStreamEnd(conn, info)));
    conn.on(WebcastEvent.CONTROL_MESSAGE, guard((data) => {
      if (data?.action === ControlAction?.CONTROL_ACTION_STREAM_PAUSED) this.streamPaused = true;
      if (data?.action === ControlAction?.CONTROL_ACTION_STREAM_UNPAUSED) this.streamPaused = false;
    }));
    for (const [subtype, name] of NOTICE_EVENTS) {
      if (!name) continue;
      conn.on(name, guard((data) => {
        const common = data?.common || {};
        this.emit("notice", {
          id: idString(common.msgId) || `notice:${subtype}:${this.now()}`,
          kind: "notice",
          subtype,
          source: "tiktok",
          roomId: idString(common.roomId) || this.roomId,
          providerTime: toMs(common.createTime),
          receivedAt: this.now(),
        });
      }));
    }
  }

  // Messages TikTok marks isHistory, and the server clock, are only visible on the raw fetch
  // result. Prepending runs before the connector decodes and emits the batch.
  _hookWebSocket(conn, ws) {
    if (!ws || typeof ws.prependListener !== "function") return;
    this._unhookWebSocket();
    const onFetch = (result) => {
      if (this.conn !== conn) return;
      try {
        const serverNow = toMs(result?.now);
        if (serverNow) {
          const offset = serverNow - this.now();
          if (Math.abs(offset) < 86_400_000) this.serverOffsetMs = offset;
        }
        for (const m of result?.messages || []) {
          if (!m?.isHistory) continue;
          for (const id of [idString(m.msgId), idString(m.decodedData?.data?.common?.msgId)]) if (id) this.historyMsgIds.add(id);
        }
        if (this.historyMsgIds.size > 5000) this.historyMsgIds = new Set([...this.historyMsgIds].slice(-2000));
      } catch {
        // never break the connector's own processing
      }
    };
    ws.prependListener("protoMessageFetchResult", onFetch);
    this.wsHook = { ws, onFetch };
  }

  _unhookWebSocket() {
    if (!this.wsHook) return;
    try {
      this.wsHook.ws.removeListener("protoMessageFetchResult", this.wsHook.onFetch);
    } catch {
      // socket already gone
    }
    this.wsHook = null;
  }

  _onConnected(conn, state) {
    if (this.conn !== conn || this.state === "connected") return;
    const at = this.now();
    const roomId = idString(state?.roomId) || idString(conn.roomId) || null;
    const info = creatorFromRoomInfo(state?.roomInfo || conn.roomInfo, this.target);
    const resumed = Boolean(roomId && this.roomId === roomId);
    if (this.openGap) {
      if (this.openGap.roomId === roomId) this._closeGap(at, { endKnown: true });
      else this._closeGap(at, { endKnown: false, closedBy: "new_room" });
    }
    this.roomId = roomId;
    this.creator = { userId: info.userId, uniqueId: info.uniqueId || this.target, nick: info.nick };
    this.connectedAt = at;
    this.attempts = 0;
    this.retry = null;
    this.lastError = null;
    this.streamPaused = false;
    this.health = this._freshHealth();
    this.historyMsgIds.clear();
    this._setState("connected");
    this._log(`Connected to @${this.target}'s LIVE (room ${roomId}) via the unofficial connector.`);
    this.emit("session", { roomId, uniqueId: this.target, creator: { ...this.creator }, connectedAt: at, liveStartedAt: info.liveStartedAt, resumed });
    this._startHealth();
    if (this.giftCatalogEnabled && (!this.catalog.size || at - this.catalogLastAttemptAt > this.catalogRefreshMs)) this._scheduleCatalog(this.catalogDelayMs);
  }

  _onDisconnected(conn, info) {
    const at = this.now();
    this._stopHealth();
    if (this.ended || this.manual) {
      this._teardown(conn);
      return;
    }
    const reason = info?.code ? `socket closed (code ${info.code}${info.reason ? `: ${sanitize(info.reason)}` : ""})` : "socket closed";
    this._openGap("disconnected", at, reason);
    this._log(`TikTok connection lost (${reason}).`);
    this._teardown(conn);
    this.lastError = { kind: "network", message: reason, at };
    this._scheduleRetry("network", reason);
  }

  _onStreamEnd(conn, info) {
    this.ended = true;
    this._clearRetry();
    this._stopHealth();
    this._setState("ended");
    this._log(`@${this.target}'s LIVE ended${info?.action === ControlAction?.CONTROL_ACTION_STREAM_SUSPENDED ? " (suspended by TikTok)" : ""}.`);
    this.emit("streamEnd", { roomId: this.roomId, at: this.now(), action: info?.action ?? null });
    // The connector disconnects by itself after a stream end; make sure our listeners go too.
    this.timers.setTimeout(() => {
      if (this.conn === conn) this._teardown(conn);
    }, 5000);
  }

  _onConnectFailed(err) {
    const at = this.now();
    const c = classifyError(err, { now: at, secret: this.eulerApiKey });
    const error = { kind: c.kind, message: c.message, at };
    if (c.kind === "offline") {
      this._setState("offline", { error });
      if (this.waitForLive) this._scheduleRetry("offline", c.message);
      else this._log(`@${this.target} is not live.`);
      return;
    }
    if (c.kind === "rate_limited") {
      this._setState("rate_limited", { error });
      this._scheduleRetry("rate_limited", c.message, c.retryAfterMs);
      return;
    }
    if (!c.retryable) {
      this._setState(c.kind === "auth" ? "auth_failed" : "error", { error });
      this._log(`TikTok connection stopped (${c.kind}): ${c.message}`);
      return;
    }
    this._setState("reconnecting", { error });
    this._scheduleRetry(c.kind, c.message);
  }

  _scheduleRetry(kind, reason, retryAfterMs = 0) {
    if (this.manual || this.ended || !this.target) return;
    this._clearRetry();
    const attempt = this.attempts + 1; // number of the attempt being scheduled
    let delayMs;
    if (kind === "offline") {
      delayMs = Math.round(this.offlinePollMs * (0.9 + this.random() * 0.2));
    } else {
      delayMs = computeBackoff(Math.max(1, this.attempts), this.backoff, this.random);
      if (kind === "rate_limited") {
        const floor = retryAfterMs > 0 ? retryAfterMs : this.rateLimitFloorMs;
        // never earlier than the provider asked; jitter only ever adds time
        delayMs = Math.max(delayMs, floor) + Math.round(this.random() * Math.min(5000, 0.1 * floor));
      }
    }
    const nextAt = this.now() + delayMs;
    this.retry = { attempt, kind, reason, delayMs, nextAt, retryAfterMs: retryAfterMs || null };
    if (this.state === "connected" || this.state === "connecting") this._setState(kind === "rate_limited" ? "rate_limited" : kind === "offline" ? "offline" : "reconnecting");
    else this.emit("status", this.status);
    this._log(`TikTok: next attempt in ${Math.round(delayMs / 1000)} s (${kind}, attempt ${attempt}).`);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.manual || this.ended) return;
      this._attempt();
    }, delayMs);
  }

  _clearRetry() {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = null;
  }

  _startHealth() {
    this._stopHealth();
    this.healthTimer = this.timers.setInterval(() => this._checkHealth(), this.healthIntervalMs);
    this.healthTimer?.unref?.();
  }

  _stopHealth() {
    if (this.healthTimer) this.timers.clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  // A socket that stays open but delivers nothing (not even heartbeat replies) is treated as a
  // transient interruption: the gap starts at the last data we saw.
  _checkHealth() {
    if (this.state !== "connected" || !this.conn) return;
    const now = this.now();
    const last = Math.max(this.health.lastSocketDataAt || 0, this.health.lastEventAt || 0, this.connectedAt || 0);
    if (now - last <= this.stallTimeoutMs) return;
    const conn = this.conn;
    this._log(`TikTok socket silent for ${Math.round((now - last) / 1000)} s; reconnecting.`);
    this._stopHealth();
    this._openGap("stalled", last, "no data from the socket");
    this.conn = null;
    this._teardown(conn);
    this.lastError = { kind: "network", message: "socket stalled", at: now };
    this._setState("reconnecting");
    this._scheduleRetry("network", "socket stalled");
  }

  _onProviderEvent(kind, data) {
    const receivedAt = this.now();
    const result = normalizeEvent(kind, data, { roomId: this.roomId, receivedAt, catalog: this.catalog });
    if (!result.ok) {
      if (result.reason === "malformed") {
        this.totals.dropped.malformed++;
        this._log(`Dropped a malformed ${kind} payload: ${result.detail}`);
      } else this.totals.dropped.ignored++;
      this.emit("dropped", { kind, id: result.msgId || null, roomId: this.roomId, receivedAt, outcome: "ignored", reason: result.reason, detail: result.detail });
      return;
    }
    const event = result.event;
    if (event.fromCreator && event.user.idVerified && this.creator && this.creator.userId !== event.user.id) {
      this.creator = { ...this.creator, userId: event.user.id, uniqueId: event.user.uniqueId || this.creator.uniqueId };
      this.emit("creator", { ...this.creator });
    }
    const history = this._historyReason(event);
    if (history) {
      this.totals.dropped.history++;
      this.emit("dropped", { event, kind, id: event.id, roomId: event.roomId, receivedAt, outcome: "ignored", reason: "history", detail: history });
      return;
    }
    if (this.recentIds.has(event.id)) {
      this.totals.dropped.duplicate++;
      this.emit("dropped", { event, kind, id: event.id, roomId: event.roomId, receivedAt, outcome: "duplicate", reason: "duplicate_delivery", detail: "same id seen on this connection" });
      return;
    }
    this.recentIds.set(event.id, receivedAt);
    if (this.recentIds.size > 3000) this.recentIds.delete(this.recentIds.keys().next().value);
    if (kind === "gift" && event.gift.metadata === "pending") this._maybeRefreshCatalog();
    try {
      this.emit("event", event);
    } catch (err) {
      this.totals.consumerErrors++;
      this._log(`Event consumer error: ${err?.message || err}`);
    }
  }

  // History policy (see README section in the report):
  //   1. the sign server's initial batch is never processed (processInitialData: false);
  //   2. messages the push frame flags isHistory are dropped;
  //   3. during the first `historyWindowMs` after the socket opens, messages whose provider
  //      createTime is earlier than the connect time (server-clock corrected, minus a small
  //      grace) are dropped. After that window everything delivered is live, so a skewed local
  //      clock can only affect the first seconds;
  //   4. ids already seen are dropped here (per connection) and in the ledger (persisted).
  _historyReason(event) {
    if (event.msgId && this.historyMsgIds.has(event.msgId)) return "flagged isHistory by the push frame";
    if (event.providerTime == null || !this.connectedAt) return null;
    if (event.receivedAt - this.connectedAt > this.historyWindowMs) return null;
    const boundary = this.connectedAt + this.serverOffsetMs - this.historyGraceMs;
    return event.providerTime < boundary ? `created ${Math.round((boundary + this.historyGraceMs - event.providerTime) / 1000)} s before this connection` : null;
  }

  _maybeRefreshCatalog() {
    if (!this.giftCatalogEnabled || this.catalogTimer || this.catalogInFlight) return;
    if (this.now() - this.catalogLastAttemptAt < this.catalogRefreshMs) return;
    this._scheduleCatalog(1000);
  }

  _scheduleCatalog(delayMs) {
    if (!this.giftCatalogEnabled || this.catalogTimer || this.catalogInFlight) return;
    const conn = this.conn;
    this.catalogTimer = this.timers.setTimeout(() => {
      this.catalogTimer = null;
      this._fetchCatalog(conn);
    }, delayMs);
    this.catalogTimer?.unref?.();
  }

  // The gift list is a signed request (it uses sign-server quota), so it runs once per
  // connection at most, off the event path, with a timeout and a bounded retry.
  async _fetchCatalog(conn) {
    if (!conn || this.conn !== conn || this.state !== "connected" || typeof conn.fetchAvailableGifts !== "function") return;
    this.catalogInFlight = true;
    this.catalogLastAttemptAt = this.now();
    try {
      const list = await withTimeout(Promise.resolve().then(() => conn.fetchAvailableGifts()), 20_000, this.timers, "gift list");
      if (this.conn !== conn) return;
      const gifts = normalizeGiftCatalog(list);
      for (const g of gifts) this.catalog.set(g.id, g);
      this.catalogFailures = 0;
      this.catalogInfo = { state: "ok", count: this.catalog.size, fetchedAt: this.now(), error: null };
      this._log(`Gift list loaded: ${gifts.length} gifts.`);
      this.emit("giftCatalog", { roomId: this.roomId, gifts, fetchedAt: this.catalogInfo.fetchedAt });
    } catch (err) {
      this.catalogFailures++;
      this.catalogInfo = { state: "failed", count: this.catalog.size, fetchedAt: this.catalogInfo.fetchedAt, error: sanitize(err, this.eulerApiKey) };
      this._log(`Could not load the gift list (gifts without metadata stay pending): ${this.catalogInfo.error}`);
      this.catalogInFlight = false;
      if (this.catalogFailures < 3 && this.conn === conn) this._scheduleCatalog(60_000 * this.catalogFailures);
    } finally {
      this.catalogInFlight = false;
    }
  }

  _openGap(reason, at, detail) {
    if (this.openGap || !this.roomId) return;
    const gap = { roomId: this.roomId, start: at, end: null, reason, detail: detail || null, endKnown: null };
    this.openGap = gap;
    this.gapList.push(gap);
    if (this.gapList.length > 100) this.gapList.shift();
    this.emit("gap", { phase: "open", ...gap });
  }

  _closeGap(at, { endKnown = true, closedBy = null } = {}) {
    const gap = this.openGap;
    if (!gap) return;
    gap.end = at;
    gap.endKnown = endKnown;
    gap.closedBy = closedBy;
    this.openGap = null;
    this.emit("gap", { phase: "close", ...gap });
  }

  async _teardown(conn) {
    if (!conn) return;
    if (this.conn === conn) this.conn = null;
    this._unhookWebSocket();
    if (this.catalogTimer) this.timers.clearTimeout(this.catalogTimer);
    this.catalogTimer = null;
    // Listeners go first, so nothing from this socket can reach the show while it closes. The
    // connector only emits "error" when an error listener exists, so this is safe.
    try {
      conn.removeAllListeners();
    } catch {
      // not an emitter
    }
    try {
      await withTimeout(Promise.resolve().then(() => conn.disconnect()), 5000, this.timers, "disconnect");
    } catch {
      // already closed or forced closed
    }
  }

  async _stop(reason) {
    this.gen++;
    this.inFlight = null;
    this._clearRetry();
    this._stopHealth();
    const conn = this.conn;
    const wasConnected = this.state === "connected";
    if (wasConnected) this._openGap("stopped", this.now(), reason);
    this.conn = null;
    await this._teardown(conn);
  }

  // Operator pressed disconnect: stop, no automatic reconnect. The time until the next connect
  // to the same room is recorded as a gap.
  async disconnect() {
    this.manual = true;
    await this._stop("disconnected by the operator");
    this._setState("disconnected");
    return this.status;
  }

  // Graceful process shutdown: stop timers and close the socket.
  async shutdown() {
    this.manual = true;
    await this._stop("app shutting down");
    this._setState("disconnected");
  }
}
