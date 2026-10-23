// Authoritative gift / supporter ledger for the show, independent of visuals and speech.
//
// - record(event) is synchronous and is the single place where gift value is counted.
// - Every gift send or streak is one "contribution". A streak's cumulative repeatCount replaces
//   that contribution's count (never adds), so 1, 2, 3, final 3 is 3 gifts. Finalization happens
//   once; a streak whose final event never arrives is finalized at its last known count after
//   `streakTimeoutMs` and marked "timeout".
// - Values are the provider-reported diamondCount per gift x count, labelled with VALUE_UNIT.
//   Gifts without metadata stay "pending" (value null) until the gift list resolves them.
// - Gifts to someone other than this creator (co-host / guest) are kept separately and never
//   counted toward this creator's supporters.
// - State, including dedupe ids and open streaks, is persisted to data/ledger.json (temp file +
//   rename, debounced). Same roomId after a restart or reconnect = same session; a new roomId =
//   a new session. Session totals are separate from all-time totals.
//
// Everything here is locally observed through an unofficial connector: it is not TikTok's
// accounting, and events missed while disconnected are not recovered (gaps are recorded).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALUE_UNIT, clip } from "./tiktok.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DATA_DIR = path.join(ROOT, "data");
export const UNIT = VALUE_UNIT;
export const DISCLAIMER =
  "Locally observed by this app for this session through an unofficial, reverse-engineered connector. Not TikTok's authoritative figures; events missed while disconnected are not recovered.";
const SCHEMA_VERSION = 1;

const emptyTotals = () => ({ value: 0, provisionalValue: 0, giftCount: 0, provisionalGiftCount: 0, pendingGiftCount: 0, pendingContributions: 0, contributions: 0 });

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    savedAt: null,
    session: null,
    allTime: { totals: { value: 0, giftCount: 0, contributions: 0 }, sessions: 0, supporters: {} },
    pastSessions: [],
  };
}

const safe = (fn, fallback = undefined) => {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
};

// What a contribution adds to the totals. Recomputed before and after every change, so a
// cumulative update replaces the old figure instead of adding to it.
function footprint(c) {
  const known = c.diamondCount != null && c.recipientClass !== "unverified";
  const value = known ? c.count * c.diamondCount : 0;
  return {
    bucket: c.recipientClass === "other" ? "other" : "supporter",
    value,
    provisionalValue: c.status === "provisional" ? value : 0,
    giftCount: c.recipientClass === "unverified" ? 0 : c.count,
    provisionalGiftCount: c.status === "provisional" && c.recipientClass !== "unverified" ? c.count : 0,
    pendingGiftCount: known ? 0 : c.count,
    pendingContributions: known ? 0 : 1,
    contributions: 1,
  };
}

function addInto(target, fp, sign) {
  for (const k of ["value", "provisionalValue", "giftCount", "provisionalGiftCount", "pendingGiftCount", "pendingContributions", "contributions"]) target[k] = (target[k] || 0) + sign * fp[k];
}

// Higher value first, then whoever reached that value earlier, then id.
function compareSupporters(a, b) {
  if (b.value !== a.value) return b.value - a.value;
  const ra = a.valueReachedAt ?? Infinity;
  const rb = b.valueReachedAt ?? Infinity;
  if (ra !== rb) return ra - rb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows can refuse a rename for a moment while antivirus or an indexer holds the file.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) throw err;
      sleepSync(25 * (i + 1));
    }
  }
}

export class Ledger extends EventEmitter {
  constructor({
    dir = DEFAULT_DATA_DIR,
    file = "ledger.json",
    now = Date.now,
    persist = true,
    saveDebounceMs = 750,
    streakTimeoutMs = 15_000,
    sweepIntervalMs = 1000,
    autoSweep = true,
    maxEventLog = 500,
    maxSeenIds = 6000,
    maxClosedContributions = 1500,
    log = () => {},
  } = {}) {
    super();
    this.dir = dir;
    this.file = path.join(dir, file);
    this.now = now;
    this.persist = persist;
    this.saveDebounceMs = saveDebounceMs;
    this.streakTimeoutMs = streakTimeoutMs;
    this.maxEventLog = maxEventLog;
    this.maxSeenIds = maxSeenIds;
    this.maxClosedContributions = maxClosedContributions;
    this.logger = log;
    this.state = emptyState();
    this.seen = new Map(); // dedupe ids of the current session, oldest first
    this.events = []; // recent outcomes for the operator view (memory only)
    this.eventSeq = 0;
    this.noticeEntries = new Map();
    this.outcomes = new WeakMap(); // event object -> outcome, so recording the same object twice is harmless
    this.saveTimer = null;
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSaveError = null;
    this.unbind = [];
    if (persist) this._load();
    this.sweepTimer = autoSweep ? setInterval(() => this.sweep(), sweepIntervalMs) : null;
    this.sweepTimer?.unref?.();
  }

  // ---------------------------------------------------------------------------------------
  // Sessions, creator identity and gaps

  beginSession({ roomId, uniqueId = null, creator = null, connectedAt, liveStartedAt = null } = {}) {
    roomId = roomId == null ? "" : String(roomId);
    if (!roomId) return null;
    const at = Number.isFinite(connectedAt) ? connectedAt : this.now();
    const current = this.state.session;
    if (current && current.roomId === roomId) {
      if (uniqueId) current.uniqueId = uniqueId;
      if (creator) this.setCreator(creator, { save: false });
      this.closeGap({ end: at, endKnown: true, closedBy: "reconnected", save: false });
      this._scheduleSave();
      return { sessionId: current.id, resumed: true };
    }
    if (current) this._archive(at, "new_room");
    this.state.session = {
      id: `room:${roomId}`,
      roomId,
      uniqueId: uniqueId || creator?.uniqueId || null,
      creator: { userId: creator?.userId || null, uniqueId: creator?.uniqueId || uniqueId || null, nick: creator?.nick || null },
      startedAt: at,
      lastActivityAt: at,
      liveStartedAt: Number.isFinite(liveStartedAt) ? liveStartedAt : null,
      // We can only be sure nothing was missed if we were connected before the live started.
      trackingBeganMidStream: !(Number.isFinite(liveStartedAt) && at <= liveStartedAt),
      streamEndedAt: null,
      gaps: [],
      totals: emptyTotals(),
      other: emptyTotals(),
      counters: { finalized: 0, timedOut: 0, corrected: 0, resolved: 0 },
      supporters: {},
      otherRecipients: {},
      contributions: {},
      latest: {}, // streak slot -> newest contribution key
      closed: [], // finalized contribution keys, oldest first, for pruning
      catalog: {},
      seq: 0,
    };
    this.state.allTime.sessions++;
    this.seen.clear();
    this._scheduleSave();
    this.emit("session", { sessionId: this.state.session.id, roomId, resumed: false });
    return { sessionId: this.state.session.id, resumed: false };
  }

  _archive(at, reason) {
    const s = this.state.session;
    if (!s) return;
    this.closeGap({ end: at, endKnown: false, closedBy: reason, save: false });
    for (const c of Object.values(s.contributions)) if (c.status === "provisional") this._finalizeTimeout(c, at, "session_closed");
    this.state.pastSessions.unshift({
      id: s.id,
      roomId: s.roomId,
      uniqueId: s.uniqueId,
      startedAt: s.startedAt,
      endedAt: s.streamEndedAt ?? s.lastActivityAt,
      streamEnded: Boolean(s.streamEndedAt),
      totals: { ...s.totals },
      otherRecipients: { ...s.other },
      topSupporter: this._view(this._sortedSupporters(s)[0] || null, 1),
      gaps: s.gaps.length,
      trackingBeganMidStream: s.trackingBeganMidStream,
      incomplete: s.gaps.length > 0,
      unit: UNIT.id,
    });
    this.state.pastSessions.length = Math.min(this.state.pastSessions.length, 50);
  }

  setCreator(creator, { save = true } = {}) {
    const s = this.state.session;
    if (!s || !creator) return;
    const topBefore = this._topId();
    s.creator = {
      userId: creator.userId || s.creator.userId || null,
      uniqueId: creator.uniqueId || s.creator.uniqueId || null,
      nick: creator.nick || s.creator.nick || null,
    };
    // Gifts whose recipient could not be compared before can be classified now.
    let changed = false;
    for (const c of Object.values(s.contributions)) {
      if (c.recipientClass !== "unverified") continue;
      const cls = this._classifyRecipient(c.recipient);
      if (cls === "unverified") continue;
      const before = footprint(c);
      c.recipientClass = cls;
      this._apply(c, before, footprint(c));
      changed = true;
    }
    if (changed && this._topId() !== topBefore) this.emit("top", this.topSupporter());
    if (save) this._scheduleSave();
  }

  markStreamEnded({ at } = {}) {
    const s = this.state.session;
    if (!s) return;
    s.streamEndedAt = Number.isFinite(at) ? at : this.now();
    this._scheduleSave();
  }

  openGap({ start, at, reason = "disconnected", detail = null, save = true } = {}) {
    const s = this.state.session;
    if (!s || s.gaps.some((g) => g.end == null)) return null;
    const gap = { start: Number.isFinite(start) ? start : Number.isFinite(at) ? at : this.now(), end: null, reason, detail, endKnown: null, closedBy: null };
    s.gaps.push(gap);
    if (s.gaps.length > 500) s.gaps.splice(0, s.gaps.length - 500);
    if (save) this._scheduleSave();
    this.emit("gap", { ...gap });
    return gap;
  }

  closeGap({ end, at, endKnown = true, closedBy = null, save = true } = {}) {
    const s = this.state.session;
    const gap = s?.gaps.find((g) => g.end == null);
    if (!gap) return null;
    gap.end = Number.isFinite(end) ? end : Number.isFinite(at) ? at : this.now();
    gap.endKnown = endKnown;
    gap.closedBy = closedBy;
    if (save) this._scheduleSave();
    this.emit("gap", { ...gap });
    return gap;
  }

  gaps() {
    const s = this.state.session;
    if (!s) return { sessionId: null, gaps: [], open: false, incomplete: false };
    return { sessionId: s.id, roomId: s.roomId, gaps: s.gaps.map((g) => ({ ...g, durationMs: g.end != null ? g.end - g.start : this.now() - g.start })), open: s.gaps.some((g) => g.end == null), incomplete: s.gaps.length > 0 };
  }

  _classifyRecipient(r) {
    if (!r || (!r.id && !r.uniqueId)) return "unspecified"; // single-host room: the gift is for the host
    const cr = this.state.session?.creator || {};
    if (r.idKind === "member") return cr.userId && r.id === cr.userId ? "creator" : "unverified";
    if (r.id && cr.userId) return r.id === cr.userId ? "creator" : "other";
    if (r.uniqueId && cr.uniqueId) return r.uniqueId.toLowerCase() === cr.uniqueId.toLowerCase() ? "creator" : "other";
    return "unverified";
  }

  // ---------------------------------------------------------------------------------------
  // Recording

  record(event) {
    if (event && typeof event === "object" && this.outcomes.has(event)) return this.outcomes.get(event);
    let outcome;
    try {
      outcome = this._record(event);
    } catch (err) {
      this.logger(`Ledger could not record an event: ${err?.message || err}`);
      outcome = this._out(event, "ignored", "malformed", { detail: err?.message });
    }
    if (event && typeof event === "object") {
      this.outcomes.set(event, outcome);
      try {
        event.ledger = outcome;
      } catch {
        // frozen object
      }
    }
    return outcome;
  }

  _record(event) {
    if (!event || typeof event !== "object" || typeof event.kind !== "string") return this._out(event, "ignored", "malformed");
    if (event.source !== "tiktok") return this._out(event, "ignored", "not_from_provider");
    if (typeof event.id !== "string" || !event.id || typeof event.user?.id !== "string" || !event.user.id) return this._out(event, "ignored", "malformed");
    const at = Number.isFinite(event.receivedAt) ? event.receivedAt : this.now();
    let s = this.state.session;
    if (!s) {
      if (!event.roomId) return this._out(event, "ignored", "no_session");
      this.beginSession({ roomId: event.roomId, connectedAt: at });
      s = this.state.session;
    }
    if (event.roomId && String(event.roomId) !== s.roomId) return this._out(event, "ignored", "other_room");
    if (this.seen.has(event.id)) return this._out(event, "duplicate", "already_recorded");
    if (event.kind === "gift" && (!event.gift || typeof event.gift.id !== "string" || !event.gift.id)) return this._out(event, "ignored", "malformed");
    this._remember(event.id);
    s.lastActivityAt = Math.max(s.lastActivityAt || 0, at);
    this._touchDisplay(event.user);
    if (event.kind !== "gift") {
      // Chat dedupe ids are saved with the next gift, gap or periodic flush; replays of old chat
      // are caught by the source's history policy anyway.
      this.dirty = this.persist;
      return this._out(event, "accepted", null);
    }
    return this._recordGift(event, at);
  }

  _remember(id) {
    this.seen.set(id, 1);
    if (this.seen.size > this.maxSeenIds * 1.2) {
      const extra = this.seen.size - this.maxSeenIds;
      const it = this.seen.keys();
      for (let i = 0; i < extra; i++) this.seen.delete(it.next().value);
    }
  }

  // Keeps the current display name and avatar of a supporter (names can change mid-stream).
  _touchDisplay(user) {
    const s = this.state.session;
    const sup = s.supporters[user.id];
    const all = this.state.allTime.supporters[user.id];
    for (const rec of [sup, all]) {
      if (!rec) continue;
      if (typeof user.nick === "string" && user.nick) rec.nick = clip(user.nick, 256);
      if (typeof user.uniqueId === "string" && user.uniqueId) rec.uniqueId = clip(user.uniqueId, 128);
      if (typeof user.avatar === "string" && user.avatar) rec.avatar = user.avatar;
    }
  }

  _recordGift(event, at) {
    const s = this.state.session;
    const g = event.gift;
    if (g.diamondCount != null && (g.metadata === "payload" || g.metadata === "extended")) this._learnGift({ id: g.id, name: g.name, image: g.image, diamondCount: g.diamondCount, type: g.type }, g.metadata, at);
    const known = Number.isFinite(g.diamondCount) && g.diamondCount >= 0 ? g.diamondCount : s.catalog[g.id]?.diamondCount ?? null;
    const u = {
      count: Number.isInteger(g.repeatCount) && g.repeatCount >= 1 ? g.repeatCount : 1,
      end: g.repeatEnd === true,
      pt: Number.isFinite(event.providerTime) ? event.providerTime : null,
      dc: known,
      metadata: known == null ? "pending" : g.diamondCount != null ? g.metadata : s.catalog[g.id]?.source || "catalog",
    };
    this._ensureSupporter(event.user, at);
    const topBefore = this._topId();
    const result = g.streakable === false ? this._single(event, u, at) : this._streak(event, u, at);
    if (!result.c) return this._out(event, "ignored", result.reason, { detail: result.detail });
    // Metadata learned from this payload may resolve other pending gifts with the same id.
    if ((u.metadata === "payload" || u.metadata === "extended") && s.totals.pendingContributions + s.other.pendingContributions > 0) this._resolvePending(g.id, { silentTop: true });
    const topAfter = this._topId();
    const isNewTop = topAfter !== topBefore && topAfter === event.user.id;
    if (topAfter !== topBefore) this.emit("top", this.topSupporter());
    this._scheduleSave();
    const view = this._contributionView(result.c, result.before);
    if (result.finalizedNow) this.emit("finalized", { contribution: view, reason: "final_event" });
    return this._out(event, "accepted", result.reason, {
      contribution: view,
      provisional: result.c.status === "provisional",
      isNewTop,
      finalizedNow: Boolean(result.finalizedNow),
      correction: Boolean(result.correction),
    });
  }

  // Non-streakable gift: every message is its own, final contribution.
  _single(event, u, at) {
    const key = `g:${event.id}`;
    if (this.state.session.contributions[key]) return { c: null, reason: "already_recorded" };
    const c = this._create(key, event, u, at, "final", null);
    return { c, before: null, reason: null, finalizedNow: true };
  }

  _streak(event, u, at) {
    const s = this.state.session;
    const g = event.gift;
    const base = `s:${event.user.id}:${g.id}`;
    const grouped = Boolean(g.groupId);
    const slot = grouped ? `${base}:${g.groupId}` : `${base}:~`;
    const c = s.contributions[s.latest[slot]];
    if (!c) return this._startStreak(slot, grouped, event, u, at);
    const action = this._decide(c, u, at, grouped);
    if (action.startsWith("ignore:")) return { c: null, reason: action.slice(7) };
    if (action === "restart" || action === "restart_supersede") {
      if (action === "restart_supersede") {
        const prev = { count: c.count, value: footprint(c).value, status: c.status };
        this._finalizeTimeout(c, at, "superseded_by_new_streak");
        this.emit("finalized", { contribution: this._contributionView(c, prev), reason: "superseded" });
      }
      return this._startStreak(slot, grouped, event, u, at);
    }
    const before = footprint(c);
    const prev = { count: c.count, value: before.value, status: c.status };
    const wasOpen = c.status === "provisional";
    if (["update", "update_final", "correct", "correct_final"].includes(action)) c.count = u.count;
    if (u.dc != null) {
      c.diamondCount = u.dc;
      c.metadataSource = u.metadata;
    }
    c.lastAt = Math.max(c.lastAt, at);
    if (u.pt != null) c.lastProviderTime = Math.max(c.lastProviderTime ?? 0, u.pt);
    c.events++;
    if (c.eventIds.length < 8) c.eventIds.push(event.id);
    let reason = null;
    if (action === "update_final" || action === "finalize" || action === "finalize_keep" || action === "correct_final" || action === "confirm") {
      c.status = "final";
      c.finalizedAt = c.finalizedAt && !wasOpen ? c.finalizedAt : at;
      if (action === "finalize_keep") c.finalCountBelowObserved = u.count;
      if (action === "confirm" || action === "correct_final") c.confirmedAfterTimeout = true;
    }
    if (action === "correct" || action === "correct_final") {
      c.corrected = true;
      s.counters.corrected++;
      reason = prev.status === "timeout" ? "late_update_after_timeout" : "late_update_after_final";
    }
    if (action === "confirm") reason = "final_after_timeout";
    if (action === "finalize_keep") reason = "final_with_lower_count";
    this._apply(c, before, footprint(c));
    const finalizedNow = wasOpen && c.status !== "provisional";
    if (finalizedNow) this._closed(c);
    return { c, before: prev, reason, finalizedNow, correction: action.startsWith("correct") };
  }

  _startStreak(slot, grouped, event, u, at) {
    const s = this.state.session;
    let key = slot;
    if (!grouped) key = `${slot}${++s.seq}`;
    else if (s.contributions[slot] || s.latest[slot]) key = `${slot}#${++s.seq}`;
    const c = this._create(key, event, u, at, u.end ? "final" : "provisional", slot);
    return { c, before: null, reason: null, finalizedNow: c.status === "final" };
  }

  // Decides what an update means for an existing streak contribution.
  _decide(c, u, at, grouped) {
    const later = u.pt != null && c.lastProviderTime != null && u.pt > c.lastProviderTime;
    if (c.status === "provisional") {
      if (u.count > c.count) return u.end ? "update_final" : "update";
      if (u.count === c.count) return u.end ? "finalize" : "ignore:no_change";
      if (!grouped && later) return "restart_supersede"; // same gift restarted at a lower count: the old streak ended unseen
      return u.end ? "finalize_keep" : "ignore:out_of_order";
    }
    if (c.status === "final") {
      if (u.count > c.count) return !grouped && later ? "restart" : "correct";
      if (u.count < c.count) return later ? "restart" : "ignore:out_of_order";
      if (!grouped && later) return "restart";
      if (!grouped && u.pt == null && at - c.lastAt > this.streakTimeoutMs) return "restart";
      return "ignore:already_finalized";
    }
    // timeout: the provider may still deliver the real end of this streak
    if (u.count > c.count) return u.end ? "correct_final" : "correct";
    if (u.count === c.count) return u.end ? "confirm" : "ignore:no_change";
    return later ? "restart" : "ignore:out_of_order";
  }

  _create(key, event, u, at, status, slot) {
    const s = this.state.session;
    const g = event.gift;
    const c = {
      key,
      supporterId: event.user.id,
      giftId: g.id,
      giftName: typeof g.name === "string" ? clip(g.name, 128) : null,
      giftImage: typeof g.image === "string" ? g.image : null,
      groupId: g.groupId || null,
      streakable: g.streakable ?? null,
      count: u.count,
      diamondCount: u.dc,
      metadataSource: u.metadata,
      status,
      recipient: event.recipient && typeof event.recipient === "object" ? { id: String(event.recipient.id || ""), uniqueId: String(event.recipient.uniqueId || ""), nick: clip(String(event.recipient.nick || ""), 256), idKind: event.recipient.idKind || "user" } : null,
      recipientClass: null,
      firstAt: at,
      lastAt: at,
      firstProviderTime: u.pt,
      lastProviderTime: u.pt,
      finalizedAt: status === "provisional" ? null : at,
      events: 1,
      eventIds: [event.id],
      corrected: false,
    };
    c.recipientClass = this._classifyRecipient(c.recipient);
    s.contributions[key] = c;
    if (slot) s.latest[slot] = key;
    this._apply(c, null, footprint(c));
    if (status !== "provisional") this._closed(c);
    return c;
  }

  _finalizeTimeout(c, at, reason) {
    const before = footprint(c);
    c.status = "timeout";
    c.finalizedAt = at;
    c.timeoutReason = reason;
    this._apply(c, before, footprint(c));
    this._closed(c);
  }

  _closed(c) {
    const s = this.state.session;
    if (c.status === "timeout") s.counters.timedOut++;
    else s.counters.finalized++;
    s.closed.push(c.key);
    while (s.closed.length > this.maxClosedContributions) {
      const key = s.closed.shift();
      const old = s.contributions[key];
      if (!old || old.status === "provisional" || footprint(old).pendingContributions) continue; // pending stays resolvable
      delete s.contributions[key];
      for (const [slot, k] of Object.entries(s.latest)) if (k === key) delete s.latest[slot];
    }
  }

  _ensureSupporter(user, at) {
    const s = this.state.session;
    if (!s.supporters[user.id]) {
      s.supporters[user.id] = { id: user.id, uniqueId: clip(user.uniqueId || "", 128), nick: clip(user.nick || user.id, 256), avatar: user.avatar || null, ...emptyTotals(), firstAt: at, lastContributionAt: null, valueReachedAt: null };
    }
    const all = this.state.allTime.supporters;
    if (!all[user.id]) all[user.id] = { id: user.id, uniqueId: clip(user.uniqueId || "", 128), nick: clip(user.nick || user.id, 256), avatar: user.avatar || null, value: 0, giftCount: 0, contributions: 0, sessions: 0, lastSessionId: null, lastContributionAt: null };
    return s.supporters[user.id];
  }

  _otherRecord(c) {
    const s = this.state.session;
    const r = c.recipient || {};
    const id = r.id || (r.uniqueId ? `handle:${r.uniqueId.toLowerCase()}` : "unknown");
    if (!s.otherRecipients[id]) s.otherRecipients[id] = { id, uniqueId: r.uniqueId || "", nick: r.nick || "", ...emptyTotals() };
    return s.otherRecipients[id];
  }

  // Moves a contribution's footprint from `before` to `after` in every total it touches.
  _apply(c, before, after) {
    const s = this.state.session;
    const sup = this._ensureSupporter({ id: c.supporterId, nick: s.supporters[c.supporterId]?.nick, uniqueId: s.supporters[c.supporterId]?.uniqueId }, c.lastAt);
    const all = this.state.allTime.supporters[c.supporterId];
    for (const [fp, sign] of [
      [before, -1],
      [after, 1],
    ]) {
      if (!fp) continue;
      if (fp.bucket === "other") {
        addInto(s.other, fp, sign);
        addInto(this._otherRecord(c), fp, sign);
        continue;
      }
      addInto(s.totals, fp, sign);
      addInto(sup, fp, sign);
      const t = this.state.allTime.totals;
      t.value += sign * fp.value;
      t.giftCount += sign * fp.giftCount;
      t.contributions += sign * fp.contributions;
      all.value += sign * fp.value;
      all.giftCount += sign * fp.giftCount;
      all.contributions += sign * fp.contributions;
    }
    const valueBefore = before?.bucket === "supporter" ? before.value : 0;
    const valueAfter = after?.bucket === "supporter" ? after.value : 0;
    if (valueAfter > valueBefore) sup.valueReachedAt = Math.max(sup.valueReachedAt ?? 0, c.lastAt);
    if (after?.bucket === "supporter") {
      sup.lastContributionAt = Math.max(sup.lastContributionAt ?? 0, c.lastAt);
      all.lastContributionAt = Math.max(all.lastContributionAt ?? 0, c.lastAt);
      if (all.lastSessionId !== s.id) {
        all.lastSessionId = s.id;
        all.sessions++;
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Gift metadata

  _learnGift(g, source, at) {
    const s = this.state.session;
    if (!s || !g?.id) return;
    const dc = Number.isFinite(g.diamondCount) && g.diamondCount >= 0 ? g.diamondCount : null;
    const prev = s.catalog[g.id];
    if (dc == null && prev?.diamondCount != null) return;
    s.catalog[g.id] = { id: g.id, name: g.name || prev?.name || null, image: g.image || prev?.image || null, diamondCount: dc, type: Number.isInteger(g.type) ? g.type : prev?.type ?? null, source, at };
  }

  // The connector's gift list arrived (asynchronously): fill in pending values.
  resolveGiftCatalog(gifts, { source = "catalog" } = {}) {
    if (!this.state.session || !Array.isArray(gifts)) return 0;
    const at = this.now();
    for (const g of gifts) if (g && typeof g === "object" && g.id) this._learnGift({ ...g, id: String(g.id) }, source, at);
    const n = this._resolvePending(null);
    this._scheduleSave();
    return n;
  }

  _resolvePending(giftId, { silentTop = false } = {}) {
    const s = this.state.session;
    if (!s) return 0;
    const topBefore = silentTop ? null : this._topId();
    let n = 0;
    for (const c of Object.values(s.contributions)) {
      if (c.diamondCount != null || (giftId && c.giftId !== giftId)) continue;
      const meta = s.catalog[c.giftId];
      if (meta?.diamondCount == null) continue;
      const before = footprint(c);
      const prev = { count: c.count, value: before.value, status: c.status };
      c.diamondCount = meta.diamondCount;
      c.metadataSource = meta.source || "catalog";
      c.resolvedAt = this.now();
      if (!c.giftName && meta.name) c.giftName = meta.name;
      this._apply(c, before, footprint(c));
      s.counters.resolved++;
      n++;
      const view = this._contributionView(c, prev);
      this._log({ at: c.resolvedAt, id: c.key, kind: "gift_resolved", roomId: s.roomId, user: this._userBrief(s.supporters[c.supporterId]), outcome: "accepted", reason: "pending_value_resolved", contribution: this._briefContribution(view) });
      this.emit("resolved", view);
    }
    if (n && !silentTop) {
      if (this._topId() !== topBefore) this.emit("top", this.topSupporter());
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------
  // Streak timeouts

  sweep(now = this.now()) {
    const s = this.state.session;
    if (this.dirty && !this.saveTimer && now - (this.lastSavedAt ?? 0) >= 10_000) this._scheduleSave();
    if (!s) return [];
    const due = Object.values(s.contributions)
      .filter((c) => c.status === "provisional" && now - c.lastAt >= this.streakTimeoutMs)
      .sort((a, b) => a.lastAt - b.lastAt || (a.key < b.key ? -1 : 1));
    if (!due.length) return [];
    const topBefore = this._topId();
    const out = [];
    for (const c of due) {
      const prev = { count: c.count, value: footprint(c).value, status: c.status };
      this._finalizeTimeout(c, now, "no_final_event");
      const view = this._contributionView(c, prev);
      out.push(view);
      this._log({ at: now, id: c.key, kind: "streak_timeout", roomId: s.roomId, user: this._userBrief(s.supporters[c.supporterId]), outcome: "accepted", reason: "finalized_at_last_known_count", contribution: this._briefContribution(view) });
      this.emit("finalized", { contribution: view, reason: "timeout" });
    }
    if (this._topId() !== topBefore) this.emit("top", this.topSupporter());
    this._scheduleSave();
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Read API

  _sortedSupporters(s = this.state.session) {
    if (!s) return [];
    return Object.values(s.supporters)
      .filter((x) => x.value > 0)
      .sort(compareSupporters);
  }

  _topId() {
    const s = this.state.session;
    if (!s) return null;
    let best = null;
    for (const x of Object.values(s.supporters)) if (x.value > 0 && (!best || compareSupporters(x, best) < 0)) best = x;
    return best?.id ?? null;
  }

  _view(x, rank) {
    if (!x) return null;
    return {
      rank,
      id: x.id,
      uniqueId: x.uniqueId,
      nick: x.nick,
      avatar: x.avatar,
      value: x.value,
      finalValue: x.value - x.provisionalValue,
      provisionalValue: x.provisionalValue,
      unit: UNIT.id,
      giftCount: x.giftCount,
      provisionalGiftCount: x.provisionalGiftCount,
      pendingGiftCount: x.pendingGiftCount,
      pendingContributions: x.pendingContributions,
      contributions: x.contributions,
      lastContributionAt: x.lastContributionAt,
      valueReachedAt: x.valueReachedAt,
    };
  }

  topSupporter() {
    const s = this.state.session;
    const id = this._topId();
    return id ? this._view(s.supporters[id], 1) : null;
  }

  topSupporters(limit = 20) {
    return this._sortedSupporters()
      .slice(0, limit)
      .map((x, i) => this._view(x, i + 1));
  }

  sessionTotals() {
    const s = this.state.session;
    const t = s ? s.totals : emptyTotals();
    return {
      sessionId: s?.id ?? null,
      unit: UNIT,
      value: t.value,
      finalValue: t.value - t.provisionalValue,
      provisionalValue: t.provisionalValue,
      giftCount: t.giftCount,
      provisionalGiftCount: t.provisionalGiftCount,
      pendingGiftCount: t.pendingGiftCount,
      pendingContributions: t.pendingContributions,
      contributions: t.contributions,
      supporters: s ? Object.values(s.supporters).filter((x) => x.contributions > 0).length : 0,
      finalized: s?.counters.finalized ?? 0,
      timedOut: s?.counters.timedOut ?? 0,
      corrected: s?.counters.corrected ?? 0,
      resolved: s?.counters.resolved ?? 0,
      otherRecipients: { ...(s ? s.other : emptyTotals()), recipients: s ? Object.keys(s.otherRecipients).length : 0 },
    };
  }

  allTimeTotals() {
    const a = this.state.allTime;
    return {
      unit: UNIT,
      value: a.totals.value,
      giftCount: a.totals.giftCount,
      contributions: a.totals.contributions,
      sessions: a.sessions,
      topSupporters: Object.values(a.supporters)
        .filter((x) => x.value > 0)
        .sort((x, y) => y.value - x.value || (x.id < y.id ? -1 : 1))
        .slice(0, 10)
        .map((x, i) => ({ rank: i + 1, id: x.id, uniqueId: x.uniqueId, nick: x.nick, value: x.value, giftCount: x.giftCount, sessions: x.sessions })),
    };
  }

  flags() {
    const s = this.state.session;
    return {
      trackingBeganMidStream: s ? s.trackingBeganMidStream : null,
      incomplete: s ? s.gaps.length > 0 : false,
      gapOpen: s ? s.gaps.some((g) => g.end == null) : false,
      gapCount: s ? s.gaps.length : 0,
      streamEnded: Boolean(s?.streamEndedAt),
      hasPending: Boolean(s?.totals.pendingContributions),
      hasProvisional: Boolean(s?.totals.provisionalGiftCount),
      lastSaveError: this.lastSaveError,
    };
  }

  _contributionView(c, prev = null) {
    const fp = footprint(c);
    const known = c.diamondCount != null && c.recipientClass !== "unverified";
    const sup = this.state.session?.supporters[c.supporterId];
    return {
      key: c.key,
      supporterId: c.supporterId,
      supporter: sup ? { id: sup.id, uniqueId: sup.uniqueId, nick: sup.nick, avatar: sup.avatar } : { id: c.supporterId, uniqueId: "", nick: c.supporterId, avatar: null },
      giftId: c.giftId,
      giftName: c.giftName,
      giftImage: c.giftImage,
      groupId: c.groupId,
      count: c.count,
      deltaCount: c.count - (prev?.count ?? 0),
      diamondCount: c.diamondCount,
      value: known ? fp.value : null,
      deltaValue: fp.value - (prev?.value ?? 0),
      unit: UNIT.id,
      status: c.status,
      provisional: c.status === "provisional",
      valueStatus: known ? "verified" : "pending",
      pendingReason: c.diamondCount == null ? "gift_metadata" : c.recipientClass === "unverified" ? "recipient_unverified" : null,
      recipientClass: c.recipientClass,
      counted: c.recipientClass === "creator" || c.recipientClass === "unspecified",
      recipient: c.recipient,
      metadataSource: c.metadataSource,
      corrected: Boolean(c.corrected),
      timeoutReason: c.timeoutReason || null,
      firstAt: c.firstAt,
      lastAt: c.lastAt,
      finalizedAt: c.finalizedAt,
    };
  }

  snapshot() {
    const s = this.state.session;
    const contributions = s ? Object.values(s.contributions) : [];
    return {
      generatedAt: this.now(),
      disclaimer: DISCLAIMER,
      unit: UNIT,
      session: s
        ? { id: s.id, roomId: s.roomId, uniqueId: s.uniqueId, creator: s.creator, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, liveStartedAt: s.liveStartedAt, streamEndedAt: s.streamEndedAt }
        : null,
      flags: this.flags(),
      totals: this.sessionTotals(),
      topSupporter: this.topSupporter(),
      topSupporters: this.topSupporters(50),
      provisional: contributions.filter((c) => c.status === "provisional").map((c) => this._contributionView(c)),
      pending: contributions.filter((c) => footprint(c).pendingContributions).map((c) => this._contributionView(c)),
      otherRecipients: s ? Object.values(s.otherRecipients).sort((a, b) => b.value - a.value || b.giftCount - a.giftCount) : [],
      gaps: this.gaps(),
      allTime: this.allTimeTotals(),
      pastSessions: this.state.pastSessions.slice(0, 10),
      persistence: { file: this.persist ? this.file : null, lastSavedAt: this.lastSavedAt, error: this.lastSaveError },
    };
  }

  // ---------------------------------------------------------------------------------------
  // Operator event log

  history(limit = 100) {
    const n = Math.max(1, Math.min(Number(limit) || 100, this.maxEventLog));
    return this.events
      .slice(-n)
      .reverse()
      .map((e) => ({ ...e }));
  }

  _userBrief(u) {
    if (!u) return null;
    return { id: safe(() => String(u.id), null), uniqueId: safe(() => String(u.uniqueId || ""), ""), nick: safe(() => clip(String(u.nick || ""), 80), "") };
  }

  _briefContribution(v) {
    return v ? { key: v.key, count: v.count, deltaCount: v.deltaCount, value: v.value, status: v.status, valueStatus: v.valueStatus, counted: v.counted, recipientClass: v.recipientClass } : null;
  }

  _log(entry) {
    entry.seq = ++this.eventSeq;
    this.events.push(entry);
    if (this.events.length > this.maxEventLog) this.events.splice(0, this.events.length - this.maxEventLog);
    return entry;
  }

  _entry(event, outcome, reason, extra = {}) {
    const e = event && typeof event === "object" ? event : {};
    const gift = safe(() => e.gift && typeof e.gift === "object" ? { id: String(e.gift.id ?? ""), name: e.gift.name ?? null, repeatCount: e.gift.repeatCount ?? null, repeatEnd: Boolean(e.gift.repeatEnd), groupId: e.gift.groupId || null, diamondCount: e.gift.diamondCount ?? null } : null, null);
    return {
      at: safe(() => (Number.isFinite(e.receivedAt) ? e.receivedAt : this.now()), this.now()),
      id: safe(() => (typeof e.id === "string" ? e.id : null), null),
      kind: safe(() => (typeof e.kind === "string" ? e.kind : "unknown"), "unknown"),
      roomId: safe(() => (e.roomId ? String(e.roomId) : null), null),
      providerTime: safe(() => (Number.isFinite(e.providerTime) ? e.providerTime : null), null),
      user: safe(() => this._userBrief(e.user), null),
      text: safe(() => (typeof e.text === "string" ? clip(e.text, 300) : null), null),
      count: safe(() => (Number.isFinite(e.count) ? e.count : null), null),
      gift,
      outcome,
      reason,
      detail: extra.detail ? clip(String(extra.detail), 200) : null,
      contribution: this._briefContribution(extra.contribution),
    };
  }

  _out(event, outcome, reason, extra = {}) {
    this._log(this._entry(event, outcome, reason, extra));
    return {
      accepted: outcome === "accepted",
      outcome,
      reason: reason || null,
      contribution: extra.contribution ?? null,
      provisional: extra.provisional ?? false,
      isNewTop: extra.isNewTop ?? false,
      finalizedNow: extra.finalizedNow ?? false,
      correction: extra.correction ?? false,
    };
  }

  // Events the source dropped before they reached record() (history, malformed, duplicates).
  logDropped(d) {
    if (!d || typeof d !== "object") return;
    const base = d.event || { id: d.id ?? null, kind: d.kind, roomId: d.roomId, receivedAt: d.receivedAt };
    this._log(this._entry(base, d.outcome || "ignored", d.reason || "dropped", { detail: d.detail }));
  }

  // Gift panels, goals and battle scores are not paid gifts. Logged at most once per 30 s each.
  logNotice(n) {
    if (!n || typeof n !== "object") return;
    const at = Number.isFinite(n.receivedAt) ? n.receivedAt : this.now();
    const key = String(n.subtype || "notice");
    const last = this.noticeEntries.get(key);
    if (last && at - last.at < 30_000 && this.events.includes(last)) {
      last.repeats = (last.repeats || 1) + 1;
      return;
    }
    const entry = this._log(this._entry({ ...n, kind: `notice:${key}` }, "ignored", "not_a_paid_gift"));
    this.noticeEntries.set(key, entry);
  }

  // ---------------------------------------------------------------------------------------
  // Wiring

  // Subscribes to a TikTokSource. Events are recorded with prependListener, so the ledger is
  // updated before any other listener (the show) sees the event; the outcome is attached as
  // event.ledger. Returns an unbind function.
  bindSource(source, { recordEvents = true } = {}) {
    const on = (name, fn, prepend = false) => {
      const wrapped = (arg) => {
        try {
          fn(arg);
        } catch (err) {
          this.logger(`Ledger ${name} handler failed: ${err?.message || err}`);
        }
      };
      if (prepend) source.prependListener(name, wrapped);
      else source.on(name, wrapped);
      this.unbind.push(() => source.removeListener(name, wrapped));
    };
    on("session", (s) => this.beginSession(s));
    on("gap", (g) => {
      const s = this.state.session;
      if (!s || (g.roomId && String(g.roomId) !== s.roomId)) return;
      if (g.phase === "open") this.openGap({ start: g.start, reason: g.reason, detail: g.detail });
      else this.closeGap({ end: g.end, endKnown: g.endKnown !== false, closedBy: g.closedBy || null });
    });
    on("creator", (c) => this.setCreator(c));
    on("giftCatalog", (c) => this.resolveGiftCatalog(c?.gifts));
    on("dropped", (d) => this.logDropped(d));
    on("notice", (n) => this.logNotice(n));
    on("streamEnd", (e) => this.markStreamEnded(e));
    if (recordEvents) on("event", (e) => this.record(e), true);
    return () => {
      for (const off of this.unbind.splice(0)) off();
    };
  }

  // ---------------------------------------------------------------------------------------
  // Persistence

  _scheduleSave() {
    if (!this.persist) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this._saveNow();
      } catch (err) {
        this.lastSaveError = err?.message || String(err);
        this.logger(`Ledger save failed (will retry): ${this.lastSaveError}`);
        this._scheduleSave();
      }
    }, this.saveDebounceMs);
    this.saveTimer.unref?.();
  }

  _saveNow() {
    if (!this.persist) return;
    const s = this.state.session;
    const data = JSON.stringify({ ...this.state, savedAt: this.now(), session: s ? { ...s, seen: [...this.seen.keys()].slice(-this.maxSeenIds) } : null });
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, this.file);
    this.dirty = false;
    this.lastSavedAt = this.now();
    this.lastSaveError = null;
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.dirty) this._saveNow();
  }

  // Graceful shutdown: write pending state, stop timers, detach from the source.
  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const off of this.unbind.splice(0)) off();
    this.flush();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!data || typeof data !== "object" || data.version !== SCHEMA_VERSION) throw new Error(`unsupported ledger file version ${data?.version}`);
    } catch (err) {
      const aside = `${this.file}.unreadable-${this.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        // leave it
      }
      this.logger(`Ledger file could not be read (${err.message}); moved it to ${aside} and started empty.`);
      return;
    }
    const fresh = emptyState();
    this.state = {
      ...fresh,
      ...data,
      allTime: { ...fresh.allTime, ...(data.allTime || {}), totals: { ...fresh.allTime.totals, ...(data.allTime?.totals || {}) }, supporters: data.allTime?.supporters || {} },
      pastSessions: Array.isArray(data.pastSessions) ? data.pastSessions : [],
    };
    const s = data.session;
    if (s && typeof s === "object" && s.roomId) {
      this.seen = new Map((Array.isArray(s.seen) ? s.seen : []).map((id) => [id, 1]));
      delete s.seen;
      s.latest ||= {};
      s.closed ||= [];
      s.catalog ||= {};
      s.counters = { finalized: 0, timedOut: 0, corrected: 0, resolved: 0, ...(s.counters || {}) };
      this.state.session = s;
      // While the app was not running nothing was collected.
      if (!s.streamEndedAt) this.openGap({ start: data.savedAt || s.lastActivityAt || this.now(), reason: "app_not_running", save: false });
    } else this.state.session = null;
  }
}
