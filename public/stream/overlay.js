import { hub } from "./hub.js";
import { resolveLayout, TIKTOK_KEYS, TIKTOK_EDGES, REGION_KEYS, TIKTOK_SHORT, REGION_LABELS } from "./safe-areas.js";

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Shortens text at a word boundary with an ellipsis; never cuts a word in half.
export function clampText(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if ([...clean].length <= max) return clean;
  const cut = [...clean].slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

// A "word" longer than this (a link, a keyboard mash) is shortened so the caption never has to
// break a word across lines.
const LONGEST_WORD = 22;
function shortenWords(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => ([...w].length > LONGEST_WORD ? `${[...w].slice(0, LONGEST_WORD - 1).join("")}…` : w))
    .join(" ");
}

const CLAUSE_END = /[,;:—–]$|[.!?]["')”]?$/;

// Splits a line into phrase-sized captions of at most `max` characters, preferring to break at
// sentence ends and commas, and never inside a word.
export function phraseChunks(text, max = 120) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const length = (list) => list.join(" ").length;
  const chunks = [];
  let current = [];
  for (const word of words) {
    if (current.length && length([...current, word]) > max) {
      let cut = -1;
      for (let k = current.length - 1; k >= Math.floor(current.length / 2); k--) {
        if (CLAUSE_END.test(current[k])) {
          cut = k;
          break;
        }
      }
      if (cut >= 0 && cut < current.length - 1) {
        chunks.push(current.slice(0, cut + 1));
        current = current.slice(cut + 1);
      } else {
        chunks.push(current);
        current = [];
      }
    }
    current.push(word);
    if (/[.!?]["')”]?$/.test(word) && length(current) > max * 0.5) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) {
    // A dangling word or two reads better joined to the phrase before it, if it fits.
    const last = chunks[chunks.length - 1];
    if (last && length(current) < 18 && length([...last, ...current]) <= max) last.push(...current);
    else chunks.push(current);
  }
  return chunks.map((c) => c.join(" "));
}

// Splits one caption in two at the clause break (comma, dash, sentence end) nearest the middle
// that leaves both halves a readable length; null when there is no such break.
export function splitAtClause(text, minEach = 24) {
  const words = text.split(" ");
  let best = -1;
  let bestGap = Infinity;
  let at = 0;
  for (let i = 0; i < words.length - 1; i++) {
    at += words[i].length + 1;
    if (!CLAUSE_END.test(words[i])) continue;
    const left = at - 1;
    const right = text.length - at;
    if (left < minEach || right < minEach) continue;
    const gap = Math.abs(left - right);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best < 0 ? null : [words.slice(0, best + 1).join(" "), words.slice(best + 1).join(" ")];
}

// Splits at the space nearest the middle (used when no clause break exists and the text is too
// long for the panel).
export function splitAtMiddle(text) {
  const words = text.split(" ");
  if (words.length < 2) return null;
  let at = 0;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < words.length - 1; i++) {
    at += words[i].length + 1;
    const gap = Math.abs(at - 1 - (text.length - at));
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return [words.slice(0, best + 1).join(" "), words.slice(best + 1).join(" ")];
}

// Viewer picture, or their initial on a coloured circle. Viewer text only ever goes in textContent.
function avatar(user) {
  if (user?.avatar) {
    const img = el("img", "avatar");
    img.referrerPolicy = "no-referrer";
    img.src = user.avatar;
    img.alt = "";
    img.onerror = () => img.replaceWith(initial(user));
    return img;
  }
  return initial(user);
}

function initial(user) {
  const div = el("div", "avatar");
  const nick = user?.nick || "?";
  div.textContent = [...nick.trim()][0]?.toUpperCase() || "?";
  div.style.background = `hsl(${hue(nick)} 28% 30%)`;
  return div;
}

// Cards in the event slot take no room while hidden: they are display:none until shown.
function appear(node) {
  clearTimeout(node.leaveTimer);
  node.classList.remove("show", "out");
  void node.offsetWidth; // restart the entrance
  node.classList.add("show");
}

function vanish(node) {
  if (!node.classList.contains("show")) return;
  node.classList.add("out");
  clearTimeout(node.leaveTimer);
  node.leaveTimer = setTimeout(() => node.classList.remove("show", "out"), 280);
}

const GIFT_QUEUE_LIMIT = 4;
const pct = (v) => `${Math.round(v * 1000) / 10}%`;

// What the meter is called: the likes-driven community meter, or (older servers) the coin one.
const METER_LABELS = { likes: "Community storm", coins: "Storm charge" };

// The gift guide's instruction, word for word. It points at TikTok's own Gift button; nothing on
// the stream pretends to be a purchase control.
export const GUIDE_INSTRUCTION = "Optional gift effects · Open TikTok’s Gift button";
export const GUIDE_TITLE = "Halloween events";
const GUIDE_NOTE = "Gifts don’t combine · each gift or combo counts alone";
const FULL_GUIDE_MAX_MS = 60_000; // a "full" guide nobody ended falls back to the compact one

const number = (n) => Number(n).toLocaleString("en-US");

// "30–99", "3,000+": a tier's value range (no upper end means open-ended).
export function tierRange(tier) {
  const min = Number(tier?.minCoins);
  const max = tier?.maxCoins == null ? NaN : Number(tier.maxCoins);
  if (!Number.isFinite(min)) return "";
  return Number.isFinite(max) && max < Infinity ? `${number(min)}–${number(max)}` : `${number(min)}+`;
}

// The line under the supporter's name: their name and what they gave, only when the amount is
// verified (a number with its unit).
export function supporterAmount(entry) {
  const coins = Number(entry?.coins);
  const unit = typeof entry?.unit === "string" ? entry.unit.trim() : "";
  if (!Number.isFinite(coins) || coins <= 0 || !unit) return "";
  return `${number(Math.round(coins))} ${[...unit].slice(0, 10).join("")}`;
}

// "Now: Pumpkin Whisper for ana", and what is behind it, from the server's queue message.
export function queueLines(msg) {
  const active = msg?.active && msg.active.name ? msg.active : null;
  const waiting = Array.isArray(msg?.waiting) ? msg.waiting.filter((w) => w && w.name).slice(0, 50) : [];
  if (!active && !waiting.length) return null;
  const lead = active || waiting[0];
  const behind = active ? waiting.length : waiting.length - 1;
  const batched = Math.max(0, Math.floor(Number(msg?.batched) || 0));
  const meta = [];
  if (behind > 0) meta.push(`${behind} waiting`);
  if (batched > 0) meta.push(`${batched} gift${batched === 1 ? "" : "s"} combined`);
  return {
    label: active ? "Now:" : "Next:",
    main: `${clampText(lead.name, 26)}${lead.user ? ` for ${clampText(lead.user, 14)}` : ""}`,
    meta: meta.join(" · "),
  };
}

// Everything drawn over the 3D scene, placed by the safe-area profile (safe-areas.js):
//   the info zone under TikTok's top bar: the AI label, top supporter, notices, the storm meter,
//     and the gift alert, title card and audience card that stack beneath them;
//   the dialogue panel above TikTok's comments: the viewer's message, then his reply.
// Every queue is bounded. The layout-check view draws the estimated TikTok zones and our
// protected regions on request and is never shown otherwise.
export class Overlay {
  constructor(stage) {
    this.stage = stage;

    // The profile in force, as fractions of the frame; updated in place so other code
    // (hub.ctx.layout) can keep holding on to it.
    this.layout = resolveLayout({});
    this.captionLines = this.layout.captionLines;

    this.zone = el("div", "info-zone", stage);
    const row1 = el("div", "info-row r1", this.zone);
    el("div", "ai-label", row1).textContent = "AI character";
    this.top = el("div", "top-gifter glass", row1);
    const row2 = el("div", "info-row r2", this.zone);
    this.toasts = el("div", "toasts", row2);
    this.meter = el("div", "meter", row2);
    const label = el("div", "meter-label", this.meter);
    this.meterLabel = el("span", "", label);
    this.meterLabel.textContent = METER_LABELS.coins;
    this.meterPct = el("span", "pct", label);
    this.meterFill = el("div", "meter-fill", el("div", "meter-track", this.meter));
    const slot = el("div", "info-slot", this.zone);
    this.announcement = el("div", "announce slot-item glass", slot);
    this.banner = el("div", "gift-banner slot-item glass", slot);
    this.card = el("div", "event-card slot-item glass", slot);
    this.eventStatus = el("div", "event-status slot-item glass", slot); // "Now: Pumpkin Whisper for ana · 2 waiting"
    this.guideCompact = el("div", "gift-guide compact slot-item glass", slot);
    this.guideFull = el("div", "gift-guide full slot-item glass", slot);
    this.guide = { mode: "hidden", tiers: [], unit: "", at: 0 };
    this.guideShown = "none";
    // The info block never grows past its region (and down over his face): when the cards on
    // screen don't fit, the least important give way until they do: the full guide first, then
    // the compact guide and the queue line; then the vote shrinks to its one-line header (so a
    // gift alert and a running vote are both still seen); then the alert, the vote, the title card.
    this.slotSteps = [
      [this.guideFull, "squeezed"], [this.guideCompact, "squeezed"], [this.eventStatus, "squeezed"],
      [this.card, "slim"], [this.banner, "squeezed"], [this.card, "squeezed"], [this.announcement, "squeezed"],
    ];
    // (Refitted on the next frame: changing the layout inside the observer's own callback makes
    // the browser report a "ResizeObserver loop" error.)
    new ResizeObserver(() => {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = requestAnimationFrame(() => this.fitInfo());
    }).observe(this.zone);

    this.caption = el("div", "caption glass", stage);
    this.captionName = el("div", "caption-name", this.caption);
    this.captionName.textContent = "The Creature";
    this.captionText = el("div", "caption-text", this.caption);
    this.captionNote = el("div", "caption-note", this.caption); // English line under a viewer's message
    // Invisible copies with the same width and type, used to count lines before anything is shown.
    this.measure = el("div", "caption-text caption-measure", this.caption);
    this.measureNote = el("div", "caption-note caption-measure", this.caption);
    this.measure.setAttribute("aria-hidden", "true");
    this.measureNote.setAttribute("aria-hidden", "true");

    this.captionId = 0;
    this.captionTouched = 0;
    this.chunks = [];
    this.giftQueue = [];
    this.giftShowing = null;
    this.giftTimer = 0;
    this.giftGap = 0;
    this.cardId = null;
    this.cardEndsAt = 0;
    this.cardTick = 0;

    this.checkLayer = null;
    this.applyLayout(undefined);
    const params = new URLSearchParams(location.search);
    this.setLayoutCheck(params.get("layoutcheck") === "1");

    // The profile and the check view follow the show's settings live.
    hub.on("message", (msg) => {
      if (msg.t === "settings") this.applyLayout(msg.settings?.layout);
      else if (msg.t === "layoutCheck") this.setLayoutCheck(!!msg.on);
      else if (msg.t === "giftGuide") this.setGiftGuide(msg);
      else if (msg.t === "eventQueue") this.setEventQueue(msg);
      else if (msg.t === "meter") this.setMeterKind(msg.kind);
      else if (msg.t === "state") {
        // What a newly opened window needs to catch up: the meter's kind, the guide, the queue.
        if (msg.meter) this.setMeterKind(msg.meter.kind);
        if (msg.giftGuide) this.setGiftGuide(msg.giftGuide);
        if (msg.eventQueue) this.setEventQueue(msg.eventQueue);
      }
    });
    hub.on("ready", ({ ctx }) => {
      ctx.layout = this.layout;
    });
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => this.applyLayout(s.layout))
      .catch(() => {});
  }

  // --- Safe areas -----------------------------------------------------------------------
  applyLayout(settingsLayout) {
    const next = resolveLayout(settingsLayout || {});
    const key = JSON.stringify(next);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.layout.profile = next.profile;
    this.layout.label = next.label;
    this.layout.estimate = true;
    this.layout.captionLines = next.captionLines;
    this.layout.tiktok ||= {};
    this.layout.regions ||= {};
    for (const k of TIKTOK_KEYS) Object.assign((this.layout.tiktok[k] ||= {}), next.tiktok[k]);
    for (const k of TIKTOK_EDGES) this.layout.tiktok[k] = next.tiktok[k];
    for (const k of REGION_KEYS) Object.assign((this.layout.regions[k] ||= {}), next.regions[k]);
    this.captionLines = next.captionLines;
    const s = this.stage.style;
    const { info, captions } = next.regions;
    s.setProperty("--info-x", pct(info.x));
    s.setProperty("--info-y", pct(info.y));
    s.setProperty("--info-w", pct(info.w));
    s.setProperty("--cap-x", pct(captions.x));
    s.setProperty("--cap-y", pct(captions.y));
    s.setProperty("--cap-w", pct(captions.w));
    s.setProperty("--cap-lines", String(next.captionLines));
    this.lineHeightPx = 0;
    this.drawLayoutCheck();
    hub.emit("layout", this.layout);
  }

  fitInfo() {
    const limit = this.layout.regions.info.h * this.stage.clientHeight;
    if (!limit) return;
    // Give way one step at a time, least important first, until the block fits; cards that
    // gave way come back as soon as there is room for them again.
    for (const [item] of this.slotSteps) item.classList.remove("squeezed", "slim");
    for (const [item, how] of this.slotSteps) {
      if (this.zone.scrollHeight <= limit + 1) break;
      if (item.classList.contains("show")) item.classList.add(how);
    }
  }

  // The layout-check view: labelled translucent boxes for the estimated TikTok zones and for the
  // protected regions, to compare with TikTok LIVE Studio's LIVE and For You previews.
  setLayoutCheck(on) {
    this.checking = !!on;
    this.drawLayoutCheck();
  }

  drawLayoutCheck() {
    if (!this.checking) {
      this.checkLayer?.remove();
      this.checkLayer = null;
      return;
    }
    this.checkLayer?.remove();
    const layer = (this.checkLayer = el("div", "layout-check", this.stage));
    const box = (rect, cls, label) => {
      const b = el("div", `lc-box ${cls}`, layer);
      b.style.left = pct(rect.x);
      b.style.top = pct(rect.y);
      b.style.width = pct(rect.w);
      b.style.height = pct(rect.h);
      el("span", "lc-label", b).textContent = label;
    };
    for (const k of TIKTOK_KEYS) box(this.layout.tiktok[k], "lc-tiktok", TIKTOK_SHORT[k]);
    for (const k of REGION_KEYS) box(this.layout.regions[k], `lc-region lc-${k}`, REGION_LABELS[k]);
    el("div", "lc-note", layer).textContent = `Layout check (${this.layout.label}): estimated zones, not official. Compare with TikTok LIVE Studio's LIVE and For You previews.`;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.lineHeightPx = 0;
  }

  // The community storm meter fills from likes (a free meter); an older server's fills from coins.
  setMeterKind(kind) {
    this.meterLabel.textContent = METER_LABELS[kind] || METER_LABELS.coins;
  }

  setMeter(value, max, kind) {
    if (kind) this.setMeterKind(kind);
    const share = Math.max(0, Math.min(100, (value / max) * 100));
    this.meterFill.style.width = `${share}%`;
    this.meterPct.textContent = `${Math.round(share)}%`;
    this.meter.classList.toggle("hot", share > 75);
    this.meter.classList.add("show");
  }

  announce(title, subtitle, tone = "") {
    clearTimeout(this.announceTimer);
    this.announcement.replaceChildren();
    this.announcement.className = `announce slot-item glass ${tone}`;
    el("div", "announce-title", this.announcement).textContent = title;
    if (subtitle) el("div", "announce-sub", this.announcement).textContent = subtitle;
    appear(this.announcement);
    this.zone.classList.add("announcing"); // the audience card steps aside for a title card
    this.announceTimer = setTimeout(() => {
      vanish(this.announcement);
      this.zone.classList.remove("announcing");
    }, 4200);
  }

  clearTopGifter() {
    this.top.classList.remove("show");
    this.top.replaceChildren();
  }

  setTopGifter(entry) {
    if (!entry) return;
    this.top.replaceChildren();
    this.top.append(avatar(entry.user));
    const text = el("div", "who", this.top);
    // Only this LIVE counts (the ledger starts fresh each stream). The amount is shown only when
    // the server sends it verified, with its unit; a gift whose value is still pending shows the name alone.
    el("div", "label", text).textContent = "Top supporter · This LIVE";
    const line = el("div", "nameline", text);
    el("span", "name", line).textContent = clampText(entry.user?.nick, 16);
    const amount = supporterAmount(entry);
    if (amount) el("span", "amount", line).textContent = `· ${amount}`;
    this.top.classList.add("show");
  }

  // --- Halloween events: the gift guide and the queue line ---------------------------------
  // The server decides when the guide is compact, full or hidden ({ mode, tiers: [{ id, name,
  // minCoins, maxCoins, available }], unit? }). Names and value ranges come from the message, so
  // the guide always shows what the show really does; events that are unavailable are paused in
  // the full guide and left out of the compact one. The guide steps aside for anything else in
  // the event slot (a gift alert, a title card, a vote) and never covers the face, hands or captions.
  setGiftGuide(msg) {
    const mode = ["compact", "full"].includes(msg?.mode) ? msg.mode : "hidden";
    const tiers = (Array.isArray(msg?.tiers) ? msg.tiers : [])
      .filter((t) => t && t.name && Number.isFinite(Number(t.minCoins)))
      .slice(0, 6)
      .map((t) => ({ id: t.id, name: String(t.name), minCoins: Number(t.minCoins), maxCoins: t.maxCoins ?? null, available: t.available !== false }));
    const unit = typeof msg?.unit === "string" ? [...msg.unit.trim()].slice(0, 10).join("") : "";
    this.guide = { mode: tiers.length ? mode : "hidden", tiers, unit, at: performance.now() };
    this.renderGuide();
    this.syncGuide();
  }

  renderGuide() {
    const { tiers, unit } = this.guide;
    const live = tiers.filter((t) => t.available);
    // Compact: the title and the five thresholds, then the instruction.
    this.guideCompact.replaceChildren();
    const top = el("div", "gg-line", this.guideCompact);
    el("b", "gg-title", top).textContent = GUIDE_TITLE;
    el("span", "gg-steps", top).textContent = live.map((t, i) => (i === live.length - 1 && t.maxCoins == null ? `${number(t.minCoins)}+` : number(t.minCoins))).join(" · ") + (unit ? ` ${unit}` : "");
    el("div", "gg-line gg-dim", this.guideCompact).textContent = GUIDE_INSTRUCTION;
    // Full: every event with its value range, then the rules.
    this.guideFull.replaceChildren();
    const head = el("div", "gg-head", this.guideFull);
    el("b", "gg-title", head).textContent = GUIDE_TITLE;
    if (unit) el("span", "gg-unit", head).textContent = `value in ${unit}`;
    const list = el("div", "gg-list", this.guideFull);
    list.style.setProperty("--rows", String(Math.ceil(tiers.length / 2) || 1));
    for (const t of tiers) {
      const row = el("div", `gg-row${t.available ? "" : " off"}`, list);
      el("span", "gg-name", row).textContent = t.name;
      el("span", "gg-range", row).textContent = t.available ? tierRange(t) : "paused";
    }
    el("div", "gg-line gg-note", this.guideFull).textContent = GUIDE_NOTE;
    el("div", "gg-line gg-dim", this.guideFull).textContent = GUIDE_INSTRUCTION;
  }

  // Which guide is on screen: what the server asked for, unless the event slot is busy.
  syncGuide() {
    const busy = [this.announcement, this.banner, this.card].some((n) => n.classList.contains("show"));
    let want = busy ? "none" : this.guide.mode === "hidden" ? "none" : this.guide.mode;
    if (want === "compact" && !this.guide.tiers.some((t) => t.available)) want = "none";
    if (want === this.guideShown) return;
    if (this.guideShown === "compact") vanish(this.guideCompact);
    if (this.guideShown === "full") vanish(this.guideFull);
    if (want === "compact") appear(this.guideCompact);
    if (want === "full") appear(this.guideFull);
    this.guideShown = want;
    this.zone.classList.toggle("guide-full", want === "full"); // the full guide takes the notices row's place
  }

  // "Now: Pumpkin Whisper for ana · 2 waiting": only while there is something to say.
  setEventQueue(msg) {
    const lines = queueLines(msg);
    if (!lines) {
      vanish(this.eventStatus);
      return;
    }
    const wasShown = this.eventStatus.classList.contains("show") && !this.eventStatus.classList.contains("out");
    this.eventStatus.replaceChildren();
    const main = el("span", "es-main", this.eventStatus);
    el("b", "es-label", main).textContent = lines.label;
    main.append(` ${lines.main}`);
    if (lines.meta) el("span", "es-meta", this.eventStatus).textContent = lines.meta;
    if (!wasShown) appear(this.eventStatus);
  }

  // --- Dialogue captions -------------------------------------------------------------------
  // How many lines this text takes in the caption panel's type and width.
  lineCount(text, node = this.measure) {
    node.textContent = text;
    if (!this.lineHeightPx) {
      const style = getComputedStyle(this.measure);
      this.lineHeightPx = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 30) * 1.3;
      this.noteHeightPx = parseFloat(getComputedStyle(this.measureNote).lineHeight) || this.lineHeightPx;
    }
    const height = node.offsetHeight;
    const line = node === this.measure ? this.lineHeightPx : this.noteHeightPx;
    if (!height) return Math.ceil(text.length / (node === this.measure ? 38 : 60)); // not laid out yet
    return Math.max(1, Math.round(height / line));
  }

  // The longest start of `text` (whole words) that fits `maxLines`, ending with an ellipsis.
  fitText(text, maxLines, node = this.measure) {
    const clean = shortenWords(text);
    if (this.lineCount(clean, node) <= maxLines) return clean;
    const words = clean.split(" ");
    let lo = 1;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.lineCount(`${words.slice(0, mid).join(" ")}…`, node) <= maxLines) lo = mid;
      else hi = mid - 1;
    }
    return `${words.slice(0, lo).join(" ").replace(/[\s,.;:!?-]+$/, "")}…`;
  }

  // His reply as captions: phrases of about 100-140 characters at most, each cut so it fits the
  // panel (two lines when it can be, three at the most) without shrinking the type or breaking a word.
  paginate(text) {
    const maxLines = this.captionLines;
    const queue = phraseChunks(shortenWords(text), 130);
    const pages = [];
    while (queue.length) {
      const chunk = queue.shift();
      const lines = this.lineCount(chunk);
      let halves = null;
      if (lines > maxLines) halves = splitAtClause(chunk, 12) || splitAtMiddle(chunk);
      else if (lines > 2) {
        // Prefer two lines when a clause break gives two comfortable halves.
        const clause = splitAtClause(chunk);
        if (clause && clause.every((half) => this.lineCount(half) <= 2)) halves = clause;
      }
      if (halves && halves[0] && halves[1]) queue.unshift(...halves);
      else pages.push(chunk);
    }
    // A caption of a couple of words reads better with its neighbour, if the two fit.
    const merged = [];
    for (const page of pages) {
      const prev = merged[merged.length - 1];
      if (prev && (page.length < 14 || prev.length < 14) && this.lineCount(`${prev} ${page}`) <= maxLines) merged[merged.length - 1] = `${prev} ${page}`;
      else merged.push(page);
    }
    return merged;
  }

  // The viewer's message goes in the caption first, under their name, while it is read out;
  // his answer then takes over the same place. Comments in other languages get a small English
  // line underneath. Calling it again (when the translation arrives) refreshes it in place.
  showViewerLine({ user, text, translation }) {
    const refresh = this.caption.classList.contains("viewer") && this.caption.classList.contains("show");
    clearTimeout(this.swapTimer);
    this.chunks = [];
    this.captionText.classList.remove("swap");
    this.caption.classList.add("viewer");
    this.captionName.textContent = clampText(user?.nick, 20);
    const note = translation ? this.fitText(`${clampText(translation.language, 14)} · ${translation.english}`, 1, this.measureNote) : "";
    this.captionNote.textContent = note;
    // Two lines of the message when there is an English line underneath, three otherwise.
    this.captionText.textContent = this.fitText(text, translation ? Math.min(2, this.captionLines) : this.captionLines);
    if (!refresh) this.handover();
    this.caption.classList.add("show");
    this.captionTouched = performance.now();
    return ++this.captionId;
  }

  // One phrase on screen at a time, each for its share of the audio (longer phrases and
  // punctuation pauses get more time), so the caption follows what he is saying.
  showSubtitle(text, seconds) {
    const showing = this.caption.classList.contains("show");
    if (this.caption.classList.contains("viewer")) {
      this.caption.classList.remove("viewer");
      this.captionName.textContent = "The Creature";
      this.captionNote.textContent = "";
      this.handover();
    }
    this.chunks = this.paginate(text);
    const weight = (c) => c.length + (c.match(/[,.!?;:]/g)?.length || 0) * 6;
    const total = this.chunks.reduce((sum, c) => sum + weight(c), 0) || 1;
    let start = 0;
    this.chunkTimes = this.chunks.map((c) => {
      const span = (weight(c) / total) * Math.max(0.8, seconds);
      const range = [start, start + span];
      start += span;
      return range;
    });
    this.captionClock = 0;
    // His next sentence cross-fades in like the next phrase; a fresh caption just appears.
    this.shownChunk = showing && !this.handingOver ? -2 : -1;
    this.handingOver = false;
    this.caption.classList.add("show");
    this.captionTouched = performance.now();
    this.updateCaption(0);
    return ++this.captionId;
  }

  // A short fade as the caption changes hands between the viewer and him.
  handover() {
    this.caption.classList.remove("handover");
    void this.caption.offsetWidth; // restart the animation
    this.caption.classList.add("handover");
    this.handingOver = true;
  }

  hideSubtitle(id) {
    if (id === this.captionId) {
      this.caption.classList.remove("show");
      this.chunks = [];
    }
  }

  updateCaption(dt) {
    if (!this.chunks.length) return;
    this.captionClock += dt;
    let i = this.chunkTimes.findIndex(([, end]) => this.captionClock < end);
    if (i < 0) i = this.chunks.length - 1;
    if (i === this.shownChunk) return;
    const first = this.shownChunk === -1;
    this.shownChunk = i;
    if (first) {
      this.captionText.textContent = this.chunks[i];
      return;
    }
    // A quick cross-fade between phrases.
    this.captionText.classList.add("swap");
    clearTimeout(this.swapTimer);
    this.swapTimer = setTimeout(() => {
      this.captionText.textContent = this.chunks[this.shownChunk] || "";
      this.captionText.classList.remove("swap");
    }, 160);
  }

  // --- Gift alerts ---------------------------------------------------------------------------
  // Gift alerts queue up (at most four) and repeats merge: the same viewer's streak updates the
  // alert on screen, and a burst beyond the queue becomes one "and N more" alert.
  gift({ user, gift, total = 0, streaking = false }) {
    const key = `${user?.id || user?.nick}|${gift?.name}`;
    const merge = (item) => {
      item.gift = { ...item.gift, count: Math.max(item.gift.count || 1, gift.count || 1) };
      if (!streaking) item.total = Math.max(item.total || 0, total);
      item.streaking = streaking;
    };
    if (this.giftShowing?.key === key) {
      merge(this.giftShowing);
      this.renderGift(this.giftShowing);
      this.giftTimer = Math.max(this.giftTimer, streaking ? 4 : 3);
      return;
    }
    const queued = this.giftQueue.find((q) => q.key === key);
    if (queued) return merge(queued);
    if (this.giftQueue.length >= GIFT_QUEUE_LIMIT) {
      const last = this.giftQueue[this.giftQueue.length - 1];
      if (last.summary) {
        last.n++;
        last.total += total;
      } else this.giftQueue.push({ summary: true, key: "summary", n: 1, total });
      return;
    }
    this.giftQueue.push({ key, user, gift: { ...gift }, total, streaking });
  }

  renderGift(item) {
    this.banner.replaceChildren();
    if (item.summary) {
      const body = el("div", "body", this.banner);
      el("div", "name", body).textContent = `And ${item.n} more gift${item.n === 1 ? "" : "s"}`;
      el("div", "what", body).textContent = item.total ? `${item.total.toLocaleString()} coins` : "Thank you, everyone";
      return;
    }
    this.banner.append(avatar(item.user));
    const body = el("div", "body", this.banner);
    el("div", "name", body).textContent = clampText(item.user?.nick, 18);
    el("div", "what", body).textContent = `sent ${clampText(item.gift?.name, 16)}${item.total ? ` · ${item.total.toLocaleString()} coins` : ""}`;
    if (item.gift?.image) {
      const img = el("img", "gift", this.banner);
      img.referrerPolicy = "no-referrer";
      img.src = item.gift.image;
      img.alt = "";
    }
    if ((item.gift?.count || 1) > 1) el("div", "count", this.banner).textContent = `×${item.gift.count}`;
  }

  toast(text) {
    const t = el("div", "toast", this.toasts);
    t.textContent = clampText(text, 36);
    setTimeout(() => t.remove(), 3300);
    while (this.toasts.children.length > 2) this.toasts.firstChild.remove();
  }

  // --- The audience card: a vote or a wish, with real counts and the time left ------------------
  // choice: { id, question, hint, options: [{ n, label, count, pct }], leftMs }
  showChoice(choice) {
    this.beginCard("choice", choice.id, choice.leftMs);
    const head = el("div", "ec-head", this.card);
    el("div", "ec-title", head).textContent = clampText(choice.question, 34);
    this.cardMeta = el("div", "ec-meta", head);
    this.cardHint = choice.hint || "";
    const grid = el("div", "ec-opts", this.card);
    grid.style.setProperty("--n", String(choice.options.length));
    this.cardRows = choice.options.map((o) => {
      const row = el("div", "ec-opt", grid);
      const line = el("div", "ec-line", row);
      el("span", "ec-n", line).textContent = String(o.n);
      el("span", "ec-label", line).textContent = clampText(o.label, 12);
      const share = el("span", "ec-pct", line);
      const fill = el("div", "ec-fill", el("div", "ec-track", row));
      return { n: o.n, row, fill, share };
    });
    this.updateChoice(choice);
    this.tickCard(true);
  }

  updateChoice({ id, options, leftMs }) {
    if (id !== this.cardId || this.cardKind !== "choice") return;
    if (Number.isFinite(leftMs)) this.cardEndsAt = performance.now() + leftMs;
    for (const o of options) {
      const r = this.cardRows?.find((x) => x.n === o.n);
      if (!r) continue;
      r.fill.style.width = `${o.pct}%`;
      r.share.textContent = `${o.pct}%`;
    }
  }

  // The vote is over: the winner lights up and stays a few seconds so the outcome is clear.
  closeChoice({ id, options, winner, how }) {
    if (id !== this.cardId || this.cardKind !== "choice") return;
    this.updateChoice({ id, options });
    for (const r of this.cardRows || []) r.row.classList.toggle("win", r.n === winner?.n);
    this.card.classList.add("closed");
    this.cardEndsAt = 0;
    const lead = how === "none" ? "No votes, so he chose" : how === "tie" ? "A tie, so fate chose" : "Chat chose";
    this.card.querySelector(".ec-title").textContent = lead;
    this.cardMeta.textContent = clampText(winner?.label, 18);
    this.endCardSoon(5.5, id);
  }

  // A free surprise that asks for a typed word, e.g. wishing on a shooting star.
  showWish({ id, title, hint, leftMs, count = 0 }) {
    this.beginCard("wish", id, leftMs);
    const head = el("div", "ec-head", this.card);
    el("div", "ec-title", head).textContent = clampText(title, 30);
    this.cardMeta = el("div", "ec-meta", head);
    this.cardHint = "";
    const body = el("div", "ec-wish", this.card);
    el("span", "", body).textContent = clampText(hint, 34);
    this.wishCount = el("span", "ec-count", body);
    this.updateWish({ id, count });
    this.tickCard(true);
  }

  updateWish({ id, count, leftMs }) {
    if (id !== this.cardId || this.cardKind !== "wish") return;
    if (Number.isFinite(leftMs)) this.cardEndsAt = performance.now() + leftMs;
    this.wishCount.textContent = count === 1 ? "1 wish" : `${count} wishes`;
  }

  closeWish({ id, count }) {
    if (id !== this.cardId || this.cardKind !== "wish") return;
    this.updateWish({ id, count });
    this.cardEndsAt = 0;
    this.cardMeta.textContent = count ? "Wishes made" : "";
    this.endCardSoon(count ? 3.5 : 0.1, id);
  }

  beginCard(kind, id, leftMs) {
    clearTimeout(this.cardTimer);
    this.card.replaceChildren();
    this.card.classList.remove("closed");
    this.card.dataset.kind = kind;
    this.cardKind = kind;
    this.cardId = id;
    this.cardEndsAt = performance.now() + (leftMs || 0);
    appear(this.card);
  }

  endCardSoon(seconds, id) {
    clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => {
      if (this.cardId === id) this.hideCard(id);
    }, seconds * 1000);
  }

  hideCard(id) {
    if (id != null && id !== this.cardId) return;
    clearTimeout(this.cardTimer);
    vanish(this.card);
    this.cardId = null;
    this.cardEndsAt = 0;
  }

  tickCard(force) {
    if (!this.cardId || !this.cardEndsAt || !this.cardMeta) return;
    const now = performance.now();
    if (!force && now - this.cardTick < 250) return;
    this.cardTick = now;
    const left = Math.max(0, Math.ceil((this.cardEndsAt - now) / 1000));
    this.cardMeta.textContent = `${this.cardHint ? `${this.cardHint} · ` : ""}${left}s`;
  }

  // Title cards for the biggest moments; smaller effects happen in the 3D scene itself.
  effect(name) {
    if (name === "legend") this.announce("A legend rises", "The whole graveyard comes alive", "gold");
    else if (name === "storm") this.announce("It's alive", "The storm answers");
  }

  bolt() {}

  heartsBurst() {}

  update(dt) {
    this.updateCaption(dt);
    this.tickCard(false);
    // A full guide that was never ended falls back to the compact one; the guide also steps
    // aside whenever a gift alert, title card or vote is on screen.
    if (this.guide.mode === "full" && performance.now() - this.guide.at > FULL_GUIDE_MAX_MS) this.guide.mode = "compact";
    this.syncGuide();
    // A caption nobody dismissed (a line that never finished) does not stay up for ever.
    if (this.caption.classList.contains("show") && performance.now() - this.captionTouched > 45_000) {
      this.caption.classList.remove("show");
      this.chunks = [];
    }
    if (this.giftShowing) {
      this.giftTimer -= dt;
      if (this.giftTimer <= 0) {
        vanish(this.banner);
        this.giftShowing = null;
        this.giftGap = 0.4;
      }
    } else if ((this.giftGap -= dt) <= 0 && this.giftQueue.length) {
      this.giftShowing = this.giftQueue.shift();
      this.renderGift(this.giftShowing);
      appear(this.banner);
      this.giftTimer = this.giftQueue.length > 1 ? 2.4 : 3.4;
    }
  }
}
