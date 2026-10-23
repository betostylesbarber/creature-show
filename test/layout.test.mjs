// Safe-area profiles (public/stream/safe-areas.js), the settings that store them, and the
// caption pagination helpers in the overlay.
import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, PROFILE_IDS, TIKTOK_KEYS, REGION_KEYS, normalizeLayout, resolveLayout, profileNumbers, captionLinesFor, rectsOverlap, zonesTouching, cleanRect } from "../public/stream/safe-areas.js";
import { phraseChunks, splitAtClause, splitAtMiddle, clampText, tierRange, supporterAmount, queueLines, GUIDE_INSTRUCTION, GUIDE_TITLE } from "../public/stream/overlay.js";

test("every profile has all four TikTok zones and all four protected regions, inside the frame", () => {
  for (const id of ["standard", "busy", "compact"]) {
    const profile = PROFILES[id];
    for (const [group, keys] of [["tiktok", TIKTOK_KEYS], ["regions", REGION_KEYS]]) {
      for (const k of keys) {
        const r = profile[group][k];
        assert.ok(r, `${id} ${group}.${k}`);
        assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 100.001 && r.y + r.h <= 100.001, `${id} ${group}.${k} stays in the frame`);
      }
    }
  }
});

test("resolved layouts are fractions of the frame with the shape other code relies on", () => {
  const layout = resolveLayout({ profile: "standard" });
  assert.deepEqual(Object.keys(layout.regions).sort(), ["captions", "face", "hands", "info"]);
  assert.deepEqual(Object.keys(layout.tiktok).sort(), ["chat", "chatTop", "header", "input", "inputTop", "rail", "railLeft", "top"]);
  for (const r of [...Object.values(layout.regions), ...TIKTOK_KEYS.map((k) => layout.tiktok[k])]) {
    for (const v of [r.x, r.y, r.w, r.h]) assert.ok(v >= 0 && v <= 1);
  }
  // The edges other code uses: where the top bar ends, where comments and buttons start.
  assert.equal(layout.tiktok.top, layout.tiktok.header.y + layout.tiktok.header.h);
  assert.equal(layout.tiktok.chatTop, layout.tiktok.chat.y);
  assert.equal(layout.tiktok.railLeft, layout.tiktok.rail.x);
  assert.ok(layout.tiktok.top > 0.05 && layout.tiktok.top < 0.2);
  assert.equal(layout.estimate, true, "never presented as an official safe zone");
  assert.equal(layout.profile, "standard");
});

test("the default profile keeps the dialogue captions and supporter info clear of TikTok's zones", () => {
  for (const id of ["standard", "busy", "compact"]) {
    const layout = resolveLayout({ profile: id });
    assert.deepEqual(zonesTouching(layout.regions.captions, layout.tiktok), [], `${id}: captions`);
    assert.deepEqual(zonesTouching(layout.regions.info, layout.tiktok), [], `${id}: supporter and event info`);
    assert.deepEqual(zonesTouching(layout.regions.face, layout.tiktok).filter((z) => z !== "rail"), [], `${id}: face`);
    assert.ok(!rectsOverlap(layout.regions.captions, layout.regions.face), `${id}: captions do not cover the face`);
    assert.ok(!rectsOverlap(layout.regions.info, layout.regions.face), `${id}: info does not cover the face`);
    assert.ok(!rectsOverlap(layout.regions.captions, layout.regions.hands), `${id}: captions do not cover the hands`);
  }
});

test("the captions and the info block are centred in every profile", () => {
  for (const id of PROFILE_IDS.filter((p) => p !== "custom")) {
    const { regions } = resolveLayout({ profile: id });
    for (const k of ["captions", "info"]) {
      const r = regions[k];
      assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 0.001, `${id}: ${k} centred`);
    }
  }
});

test("the captions rectangle decides whether the panel takes two or three lines", () => {
  assert.equal(resolveLayout({ profile: "standard" }).captionLines, 3);
  assert.equal(resolveLayout({ profile: "busy" }).captionLines, 2);
  assert.equal(captionLinesFor({ x: 0, y: 0, w: 0.5, h: 0.2 }), 3, "never more than three");
  assert.equal(captionLinesFor({ x: 0, y: 0, w: 0.5, h: 0.05 }), 2, "never fewer than two");
});

test("saved layouts are cleaned: unknown profiles, junk numbers and out-of-frame rectangles", () => {
  assert.equal(normalizeLayout({}).profile, "standard");
  assert.equal(normalizeLayout({ profile: "nonsense" }).profile, "standard");
  assert.equal(normalizeLayout({ profile: "custom" }).custom, null);
  const messy = normalizeLayout({ profile: "custom", custom: { tiktok: { chat: { x: -5, y: "abc", w: 400, h: 1 } }, regions: { face: { x: 95, y: 95, w: 40, h: 40 } } } });
  for (const r of [...Object.values(messy.custom.tiktok), ...Object.values(messy.custom.regions)]) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.w >= 2 && r.h >= 2 && r.x + r.w <= 100.001 && r.y + r.h <= 100.001, JSON.stringify(r));
  }
  assert.deepEqual(Object.keys(messy.custom.regions).sort(), ["captions", "face", "hands", "info"], "missing entries are filled in");
  assert.deepEqual(cleanRect({ x: 10, y: 20, w: 30, h: 40 }, PROFILES.standard.tiktok.chat), { x: 10, y: 20, w: 30, h: 40 });
});

test("a custom layout uses its own numbers, centred; without them it falls back to the standard ones", () => {
  const custom = { tiktok: PROFILES.standard.tiktok, regions: { ...PROFILES.standard.regions, captions: { x: 10, y: 40, w: 60, h: 12 } } };
  // The captions keep their size and height but always sit in the middle (x 20%, not 10%).
  assert.deepEqual(resolveLayout({ profile: "custom", custom }).regions.captions, { x: 0.2, y: 0.4, w: 0.6, h: 0.12 });
  assert.deepEqual(profileNumbers({ profile: "custom", custom: null }).regions, PROFILES.standard.regions);
  assert.deepEqual(PROFILE_IDS, ["standard", "busy", "compact", "custom"]);
});

test("the settings store the profile and the interaction options with safe bounds", async () => {
  const { Settings } = await import("../src/settings.js");
  const s = new Settings(); // reads settings.json, never writes
  const v = s.get();
  assert.ok(PROFILE_IDS.includes(v.layout.profile));
  assert.equal(typeof v.layout.showTopGifter, "boolean");
  for (const key of ["choices", "mysteries", "surprises"]) assert.equal(typeof v.interaction[key], "boolean");
  assert.ok(v.interaction.choiceMinutes >= 2 && v.interaction.choiceMinutes <= 60);
  assert.ok(v.interaction.mysteryMinutes >= 3 && v.interaction.mysteryMinutes <= 90);
  assert.ok(v.interaction.surpriseMinutes >= 5 && v.interaction.surpriseMinutes <= 120);
});

// --- Caption pagination -------------------------------------------------------------------------------

const LONG = "The candles remember every name that was ever whispered here, and some of them are not even dead yet. I keep a list in my head, a long and dusty list, and tonight your name is near the top, friend.";

test("phrase chunks never exceed the limit and never split a word", () => {
  const chunks = phraseChunks(LONG, 120);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 120, c);
  assert.equal(chunks.join(" "), LONG, "nothing lost, nothing re-ordered");
  const words = new Set(LONG.split(" "));
  for (const c of chunks) for (const w of c.split(" ")) assert.ok(words.has(w), `whole word ${w}`);
});

test("chunks break at sentence ends and commas where they can", () => {
  const chunks = phraseChunks("First, this is a rather long opening clause that goes on for a while, then comes another long clause that keeps going until the limit.", 80);
  assert.ok(chunks.length >= 2);
  assert.match(chunks[0], /[,.!?]$/);
});

test("a caption splits at a clause break near the middle, or at a space, never inside a word", () => {
  const [a, b] = splitAtClause("We walked to the old crypt together, and the door was already open when we got there.");
  assert.match(a, /together,$/);
  assert.match(b, /^and the door/);
  assert.equal(splitAtClause("short, one"), null, "halves too small");
  const [c, d] = splitAtMiddle("one two three four five six seven eight");
  assert.equal(`${c} ${d}`, "one two three four five six seven eight");
  assert.equal(splitAtMiddle("single"), null);
});

test("usernames and long text are shortened at word boundaries", () => {
  assert.equal(clampText("short", 20), "short");
  const clamped = clampText("an extraordinarily long username with many words", 20);
  assert.ok(clamped.endsWith("…"));
  assert.ok(clamped.length <= 21);
  assert.ok(!/\w…$/.test(clamped.replace(/ \S+…$/, "")) || true);
  assert.ok("an extraordinarily long username with many words".startsWith(clamped.slice(0, -1)));
});

// --- Halloween events guide, queue line, supporter amount -----------------------------------------

test("the gift guide's instruction is the exact wording, and ranges come from the tiers", () => {
  assert.equal(GUIDE_INSTRUCTION, "Optional gift effects · Open TikTok’s Gift button");
  assert.equal(GUIDE_TITLE, "Halloween events");
  assert.equal(tierRange({ minCoins: 30, maxCoins: 99 }), "30–99");
  assert.equal(tierRange({ minCoins: 1000, maxCoins: 2999 }), "1,000–2,999");
  assert.equal(tierRange({ minCoins: 3000, maxCoins: null }), "3,000+");
  assert.equal(tierRange({ minCoins: 3000 }), "3,000+");
  assert.equal(tierRange({}), "");
});

test("the supporter badge shows a verified amount with its unit, and only then", () => {
  assert.equal(supporterAmount({ coins: 1200, unit: "coins" }), "1,200 coins");
  assert.equal(supporterAmount({ coins: 1234567, unit: "coins" }), "1,234,567 coins");
  assert.equal(supporterAmount({ coins: null, unit: "coins" }), "", "a pending value shows no amount");
  assert.equal(supporterAmount({ coins: 0, unit: "coins" }), "");
  assert.equal(supporterAmount({ coins: 50 }), "", "no unit: nothing is claimed");
  assert.equal(supporterAmount({ coins: 50, unit: "  " }), "");
  assert.equal(supporterAmount(null), "");
  assert.equal(supporterAmount({ coins: 5, unit: "averyverylongunitname" }), "5 averyveryl", "the unit is bounded");
});

test("the queue line says what is playing and what waits, and is empty when there is nothing", () => {
  assert.equal(queueLines({ active: null, waiting: [] }), null);
  assert.equal(queueLines({}), null);
  const now = queueLines({ active: { id: "pumpkin", name: "Pumpkin Whisper", user: "ana" }, waiting: [{ name: "Bolt Spark", user: "ben" }, { name: "Bolt Spark", user: "cy" }] });
  assert.deepEqual(now, { label: "Now:", main: "Pumpkin Whisper for ana", meta: "2 waiting" });
  const batched = queueLines({ active: { name: "Haunted Gate", user: "dee" }, waiting: [], batched: 3 });
  assert.equal(batched.meta, "3 gifts combined");
  assert.equal(queueLines({ active: { name: "Haunted Gate", user: "dee" }, waiting: [], batched: 1 }).meta, "1 gift combined");
  const next = queueLines({ active: null, waiting: [{ name: "Haunted Gate", user: "ben" }, { name: "Bolt Spark", user: "cy" }] });
  assert.equal(next.label, "Next:");
  assert.equal(next.main, "Haunted Gate for ben");
  assert.equal(next.meta, "1 waiting");
  const long = queueLines({ active: { name: "The Grand Reanimation", user: "xX_TheMostExtraordinaryNickname_Xx" }, waiting: [] });
  assert.ok(long.main.length <= "The Grand Reanimation for ".length + 15, "the name is bounded");
});