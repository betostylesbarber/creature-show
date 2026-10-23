// Pure decision logic of the sound system (no Web Audio here, so it is unit-tested in Node:
// test/sound-*.test.mjs). Everything that decides *whether* and *which* sound plays lives here;
// engine.js only plays what these rules allow.

// Seedable random source (tests pass their own).
export function makeRandom(seed) {
  if (seed == null) return Math.random;
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// Anti-repetition: picks variants in a shuffled order, never the same one twice in a row and,
// with enough variants, none of the last `memory` picks.
export class ShuffleBag {
  constructor(count, { memory = null, random = Math.random } = {}) {
    this.count = count;
    this.memory = memory ?? Math.min(Math.floor(count / 2), 3);
    this.random = random;
    this.recent = [];
  }

  next() {
    if (this.count <= 1) return 0;
    const banned = new Set(this.recent.slice(-Math.min(this.memory, this.count - 1)));
    if (!banned.size && this.recent.length) banned.add(this.recent[this.recent.length - 1]);
    const options = [];
    for (let i = 0; i < this.count; i++) if (!banned.has(i)) options.push(i);
    const pick = options[Math.floor(this.random() * options.length)];
    this.recent.push(pick);
    if (this.recent.length > 8) this.recent.shift();
    return pick;
  }
}

// Per-key cooldowns on a caller-supplied clock (seconds).
export class Cooldowns {
  constructor() {
    this.until = new Map();
  }
  ready(key, now) {
    return (this.until.get(key) ?? -Infinity) <= now;
  }
  // Takes the slot if ready; returns whether it did.
  take(key, now, seconds) {
    if (!this.ready(key, now)) return false;
    this.until.set(key, now + seconds);
    return true;
  }
  clear(key) {
    if (key == null) this.until.clear();
    else this.until.delete(key);
  }
}

// Bounded concurrency: a global voice budget and per-category limits. When a category is full
// a new sound may steal the oldest voice of lower or equal priority, otherwise it is dropped.
export class VoiceLimiter {
  constructor({ total = 40, limits = {} } = {}) {
    this.total = total;
    this.limits = limits;
    this.voices = []; // { id, category, priority, started }
    this.nextId = 1;
  }

  count(category) {
    return category ? this.voices.filter((v) => v.category === category).length : this.voices.length;
  }

  // -> { ok, id, steal: [ids to stop] }
  request(category, priority = 1, now = 0) {
    const steal = [];
    const limit = this.limits[category] ?? 8;
    const mine = this.voices.filter((v) => v.category === category);
    if (mine.length >= limit) {
      const victim = mine.filter((v) => v.priority <= priority).sort((a, b) => a.priority - b.priority || a.started - b.started)[0];
      if (!victim) return { ok: false, steal };
      steal.push(victim.id);
      this.release(victim.id);
    }
    if (this.voices.length >= this.total) {
      const victim = this.voices.filter((v) => v.priority < priority).sort((a, b) => a.priority - b.priority || a.started - b.started)[0];
      if (!victim) return { ok: false, steal };
      steal.push(victim.id);
      this.release(victim.id);
    }
    const id = this.nextId++;
    this.voices.push({ id, category, priority, started: now });
    return { ok: true, id, steal };
  }

  release(id) {
    const i = this.voices.findIndex((v) => v.id === id);
    if (i >= 0) this.voices.splice(i, 1);
  }
}

// --- His nonverbal reactions -----------------------------------------------------------------
// Never over speech (his or the reader's), never while a line is waiting to be spoken, never
// two at once, and rarely enough that he stays endearing rather than constantly vocal.
export class ReactionPolicy {
  constructor({ gap = 6, perKind = { curious: 25, thoughtful: 25, chuckle: 20, surprised: 15, relieved: 20, effort: 1.2, delight: 15, roar: 4 } } = {}) {
    this.gap = gap; // seconds between any two expressive reactions (effort sounds exempt)
    this.perKind = perKind;
    this.cooldowns = new Cooldowns();
    this.lastAt = -Infinity;
    this.speaking = false; // a voice clip is playing
    this.lineActive = false; // a line (reader + reply) is in progress, including its gaps
    this.lineEndedAt = -Infinity;
  }

  // force: always (unless he speaks). priority (a gift event's reaction beat): only a short
  // minimum gap to the previous reaction, no per-kind cooldown.
  allowed(kind, now, { force = false, priority = false } = {}) {
    if (this.speaking || this.lineActive) return false;
    if (now - this.lineEndedAt < 0.6) return false; // let the last word land
    if (force) return true;
    if (priority) return now - this.lastAt >= 2.5;
    const effort = kind === "effort";
    if (!effort && now - this.lastAt < this.gap) return false;
    return this.cooldowns.ready(kind, now);
  }

  take(kind, now, opts) {
    if (!this.allowed(kind, now, opts)) return false;
    this.cooldowns.until.set(kind, now + (this.perKind[kind] ?? 10));
    if (kind !== "effort") this.lastAt = now;
    return true;
  }

  speech(phase, now) {
    this.speaking = phase === "start";
    if (phase === "end") this.lineEndedAt = now;
  }

  line(phase, now) {
    this.lineActive = phase === "start";
    if (phase === "end") this.lineEndedAt = now;
  }
}

// --- Gifts -----------------------------------------------------------------------------------
// Signature events (value-based) and their thematic variants. The old names still work.
export const SIGNATURES = ["bolt", "pumpkin", "gate", "lab", "grand"];
const LEGACY = { galaxy: { event: "lab", variant: "galaxy" }, lion: { event: "grand", variant: "lion" }, reanimate: { event: "grand", variant: null } };
export function signatureName(event, variant) {
  if (SIGNATURES.includes(event)) return { event, variant: variant || null };
  if (LEGACY[event]) return { ...LEGACY[event], variant: variant || LEGACY[event].variant };
  return null;
}

// The brief acknowledgment for a gift that has no signature event of its own: small, varied,
// and thinned out when gifts arrive in a burst so chat never becomes a jingle machine.
//   level 0 = a single soft glint ... 2 = a short three-note figure
export function ackLevel(coins) {
  const c = Number(coins) || 0;
  if (c >= 15) return 2;
  if (c >= 5) return 1;
  return 0;
}

export class AckGate {
  constructor({ window = 3, maxInWindow = 2, minGap = 0.45 } = {}) {
    this.window = window;
    this.maxInWindow = maxInWindow;
    this.minGap = minGap;
    this.times = [];
  }
  // -> "full" | "soft" (a quieter, simpler variant) | null (skip)
  decide(now) {
    this.times = this.times.filter((t) => now - t < this.window);
    const last = this.times[this.times.length - 1] ?? -Infinity;
    if (now - last < this.minGap) return null;
    const n = this.times.length;
    if (n >= this.maxInWindow + 2) return null;
    this.times.push(now);
    return n >= this.maxInWindow ? "soft" : "full";
  }
}

// Duplicate protection: the same server message seen twice (a reconnect race, a double
// broadcast) plays once. Keys are built from the message's identity fields.
export class Dedupe {
  constructor(windowSeconds = 3) {
    this.window = windowSeconds;
    this.seen = new Map();
  }
  key(msg) {
    if (!msg || typeof msg !== "object") return null;
    if (msg.t === "gift") return `gift|${msg.user?.id ?? msg.user?.nick ?? ""}|${msg.gift?.id ?? msg.gift?.name ?? ""}|${msg.gift?.count ?? ""}|${msg.total ?? ""}|${msg.msgId ?? ""}`;
    if (msg.t === "milestone") return `milestone|${msg.kind}|${msg.total}`;
    return null;
  }
  // true when this message should be acted on
  fresh(msg, now) {
    const k = this.key(msg);
    if (!k) return true;
    for (const [key, t] of this.seen) if (now - t > this.window) this.seen.delete(key);
    if (this.seen.has(k)) return false;
    this.seen.set(k, now);
    return true;
  }
}

// --- Thunder ---------------------------------------------------------------------------------
// The lighting reports a flash with the delay its thunder needs (distance / 343 m/s).
export function thunderPlan({ delay = 3, strength = 0 } = {}) {
  const d = Math.max(0, Number(delay) || 0);
  const distance = d * 343;
  const kind = d < 1.6 ? "close" : d < 4 ? "mid" : "far";
  // Farther thunder is quieter and darker; very far rolls are low rumbles.
  const gainDb = kind === "close" ? 0 : kind === "mid" ? -6 : -10 - Math.min(8, (distance - 1400) / 300);
  const lowpass = kind === "close" ? 16000 : kind === "mid" ? 6000 : Math.max(900, 3500 - (distance - 1400) * 0.9);
  return { kind, delay: Math.min(d, 9), gainDb, lowpass, distance };
}

// --- Footsteps -------------------------------------------------------------------------------
export function stepPlan({ strength = 0.5, surface = "stone", inPlace = false, speed = 1 } = {}, { rain = 0.32 } = {}) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  const surf = ["stone", "soil", "grass"].includes(surface) ? surface : "stone";
  // In-place steps (turning on the spot) are lighter shuffles, mostly the scuff.
  const heelDb = inPlace ? -9 : -7 + 7 * s;
  const scuffDb = inPlace ? -6 : -14 + 4 * s;
  const weightDb = inPlace ? -30 : -14 + 8 * s; // body weight: heavy but controlled
  const wet = surf !== "grass" && rain > 0.6; // standing water on the path and soil in a storm
  return { surface: surf, heelDb, scuffDb, weightDb, wet, rate: 0.96 + 0.06 * Math.min(1, Number(speed) || 0) };
}

// Where a sound sits for the camera: subtle pan (never hard), distance gain and air absorption.
export function spatial(local, { maxPan = 0.6, ref = 3 } = {}) {
  const x = local?.x ?? 0;
  const z = local?.z ?? -ref; // camera looks down -z
  const dist = Math.max(0.5, Math.hypot(x, local?.y ?? 0, z));
  const pan = Math.max(-maxPan, Math.min(maxPan, (x / (Math.abs(z) + 1.5)) * 0.9));
  const gainDb = dist <= ref ? 0 : -20 * Math.log10(dist / ref) * 0.8;
  const lowpass = dist <= ref ? 20000 : Math.max(2200, 20000 * (ref / dist) ** 0.9);
  return { pan, gainDb: Math.max(-30, gainDb), lowpass, dist };
}
