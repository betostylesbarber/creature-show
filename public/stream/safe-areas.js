// Safe-area profiles for the 9:16 stream: where TikTok's own LIVE interface sits over the picture,
// and the protected regions our overlays and cameras keep to.
//
// IMPORTANT: every number in the profiles below is an ESTIMATE made from how the viewer-side LIVE
// screen generally looks. They are not official TikTok safe zones. TikTok's interface changes
// between app versions, phones and the LIVE / For You views, so check each profile in TikTok LIVE
// Studio's LIVE and For You previews (and on a real phone where possible) and adjust it with the
// "Custom" profile. This file has no browser code so the server, the panel and the stream window
// share one definition.
//
// Rectangles are stored in the settings as percentages of the frame ({ x, y, w, h }, 0..100) and
// handed to other code (hub.ctx.layout) as fractions (0..1). x and y are the top left corner.

export const PROFILE_IDS = ["standard", "busy", "compact", "custom"];
export const DEFAULT_PROFILE = "standard";
export const TIKTOK_KEYS = ["header", "chat", "rail", "input"];
export const REGION_KEYS = ["face", "hands", "captions", "info"];

export const TIKTOK_LABELS = {
  header: "TikTok top bar (host, viewers, close)",
  chat: "TikTok comments",
  rail: "TikTok like, gift and share buttons",
  input: "TikTok comment box and gift button",
};
// Short names for the layout-check view, where space is tight.
export const TIKTOK_SHORT = { header: "TikTok top bar", chat: "TikTok comments", rail: "TikTok buttons", input: "TikTok comment box" };
export const REGION_LABELS = {
  face: "Face and mouth",
  hands: "Hand gestures",
  captions: "Dialogue captions",
  info: "Supporter and event information",
};

const r = (x, y, w, h) => ({ x, y, w, h });

export const PROFILES = {
  standard: {
    label: "Standard LIVE feed",
    note: "Estimate for the normal LIVE view: a slim top bar, comments over the lower third on the left, buttons down the right edge.",
    tiktok: { header: r(0, 0, 100, 11), chat: r(0, 67, 78, 25), rail: r(85, 50, 15, 42), input: r(0, 92, 100, 8) },
    regions: { info: r(4.5, 11.8, 91, 19.2), face: r(30, 31.2, 40, 14.8), hands: r(8, 46, 76, 9), captions: r(15.5, 55, 69, 11.8) },
  },
  busy: {
    label: "Busy chat (comments reach higher)",
    note: "Estimate for a lively room where the comment list grows up to about 40% of the height: captions move up and shrink to two lines.",
    tiktok: { header: r(0, 0, 100, 12), chat: r(0, 60, 80, 32), rail: r(83, 46, 17, 46), input: r(0, 92, 100, 8) },
    regions: { info: r(4.5, 12.6, 91, 19.2), face: r(30, 31.8, 40, 11.2), hands: r(8, 43, 74, 7.6), captions: r(17.5, 50.6, 65, 9.4) },
  },
  compact: {
    label: "Compact (For You style)",
    note: "Estimate for a lighter interface: a shorter top bar, fewer comments, narrower buttons. Gives the picture more room.",
    tiktok: { header: r(0, 0, 100, 9), chat: r(0, 70, 76, 22), rail: r(86, 52, 14, 40), input: r(0, 92, 100, 8) },
    regions: { info: r(4.5, 9.8, 91, 19.2), face: r(30, 29.2, 40, 16.8), hands: r(8, 46, 77, 10), captions: r(14.5, 58, 71, 11.8) },
  },
};

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
const round1 = (v) => Math.round(v * 10) / 10;

// A rectangle that stays inside the frame and is at least 2% each way.
export function cleanRect(raw, fallback) {
  const f = fallback;
  const w = clamp(raw?.w, 2, 100, f.w);
  const h = clamp(raw?.h, 2, 100, f.h);
  return { x: round1(clamp(raw?.x, 0, 100 - w, Math.min(f.x, 100 - w))), y: round1(clamp(raw?.y, 0, 100 - h, Math.min(f.y, 100 - h))), w: round1(w), h: round1(h) };
}

function cleanSet(raw, fallback, keys) {
  return Object.fromEntries(keys.map((k) => [k, cleanRect(raw?.[k], fallback[k])]));
}

// The part of the saved layout this module owns, cleaned. `custom` stays null until the operator
// first edits numbers; the panel then seeds it from the profile they were looking at.
export function normalizeLayout(raw = {}) {
  const profile = PROFILE_IDS.includes(raw.profile) ? raw.profile : DEFAULT_PROFILE;
  const custom = raw.custom && typeof raw.custom === "object"
    ? { tiktok: cleanSet(raw.custom.tiktok, PROFILES.standard.tiktok, TIKTOK_KEYS), regions: cleanSet(raw.custom.regions, PROFILES.standard.regions, REGION_KEYS) }
    : null;
  return { profile, custom };
}

// Percent rectangle sets for a layout (the custom one when "custom" is chosen and filled in).
export function profileNumbers(layout = {}) {
  const { profile, custom } = normalizeLayout(layout);
  if (profile === "custom") return custom || { tiktok: PROFILES.standard.tiktok, regions: PROFILES.standard.regions };
  return PROFILES[profile];
}

const frac = (rect) => ({ x: rect.x / 100, y: rect.y / 100, w: rect.w / 100, h: rect.h / 100 });
// The captions and the info block always sit in the middle of the frame, whatever x a custom
// layout has: only their width, height and height position are the operator's to set. (The
// profiles' widths keep them clear of TikTok's buttons on the right while centred.)
const centred = (rect) => ({ ...rect, x: Math.round(((1 - rect.w) / 2) * 1000) / 1000 });
const CENTRED = new Set(["captions", "info"]);

// Em measures of the caption panel (see stream.css): padding and name line, and one line of text.
export const CAPTION_CHROME_EM = 2.1;
export const CAPTION_LINE_EM = 1.17;
const FRAME_EM_HEIGHT = 48; // a 1920 px frame at the 40 px stage font

// How many lines of text the captions rectangle has room for: two or three.
export function captionLinesFor(captionRect) {
  const heightEm = captionRect.h * FRAME_EM_HEIGHT;
  return Math.min(3, Math.max(2, Math.floor((heightEm - CAPTION_CHROME_EM) / CAPTION_LINE_EM + 0.05)));
}

export const TIKTOK_EDGES = ["top", "chatTop", "railLeft", "inputTop"];

// Everything the stream window and other code need, as fractions of the frame:
// { profile, label, estimate,
//   tiktok: { header, chat, rail, input,            the estimated zones, each { x, y, w, h }
//             top, chatTop, railLeft, inputTop },   and their edges: where the top bar ends (from the
//                                                   top), where the comments start (from the top),
//                                                   where the buttons start (from the left), where the comment box starts
//   regions: { face, hands, captions, info },       protected rectangles { x, y, w, h }
//   captionLines }                                  2 or 3: how many lines the caption panel has room for
export function resolveLayout(layout = {}) {
  const { profile } = normalizeLayout(layout);
  const numbers = profileNumbers(layout);
  const meta = PROFILES[profile];
  const zones = Object.fromEntries(TIKTOK_KEYS.map((k) => [k, frac(numbers.tiktok[k])]));
  return {
    profile,
    label: meta ? meta.label : "Custom",
    estimate: true, // never an official TikTok safe zone
    tiktok: { ...zones, top: zones.header.y + zones.header.h, chatTop: zones.chat.y, railLeft: zones.rail.x, inputTop: zones.input.y },
    regions: Object.fromEntries(REGION_KEYS.map((k) => [k, CENTRED.has(k) ? centred(frac(numbers.regions[k])) : frac(numbers.regions[k])])),
    captionLines: captionLinesFor(frac(numbers.regions.captions)),
  };
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Which TikTok zones a rectangle touches (for warnings in the panel and tests).
export function zonesTouching(rect, tiktok) {
  return TIKTOK_KEYS.filter((k) => rectsOverlap(rect, tiktok[k]));
}
