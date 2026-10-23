// The Creature's structured persona memory: favourites by category (with reasons), interests
// and dislikes, from characters/<id>/persona-memory.json (curated by the operator). Only the
// entries relevant to the current question go into the prompt, so it stays small.
//
// Favourites he improvises on air ("favourite Romanian actor?" when the file has none) are
// kept in persona-learned.json next to it, so he names the same one next time. That file is
// written only from his own short answers to plain "what's your favourite X?" questions, never
// from what a viewer typed; the operator can review, edit or delete any entry (set
// "status": "rejected" to stop one being used).
import fs from "node:fs";
import path from "node:path";
import { fold } from "./intent.js";
import { isProfane } from "./profanity.js";
import { manipulationKind, review } from "./guard.js";

const MAX_LEARNED = 300;

// Categories that may stand in for a more specific one ("singer" -> musician).
const FALLBACK = { singer: "musician", "horror film": "film", series: "film", rapper: null, band: null, city: "place", dessert: "food", snack: "food" };

export class PersonaMemory {
  constructor({ dir, file = path.join(dir, "persona-memory.json"), learnedFile = process.env.PERSONA_LEARNED_FILE || path.join(dir, "persona-learned.json"), log = () => {} } = {}) {
    this.file = file;
    this.learnedFile = learnedFile;
    this.log = log;
    this.data = { favourites: [], interests: [], dislikes: [] };
    this.learned = { entries: [] };
    this.stamp = { file: 0, learned: 0 };
    this.reload();
  }

  // Re-reads either file when it changed on disk (the operator may edit them during a show).
  reload() {
    const read = (file, key, fallback) => {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime === this.stamp[key]) return null;
        this.stamp[key] = mtime;
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") this.log(`Persona memory: could not read ${path.basename(file)} (${error.message}); keeping the last good copy.`);
        return error.code === "ENOENT" && this.stamp[key] !== -1 ? ((this.stamp[key] = -1), fallback) : null;
      }
    };
    const data = read(this.file, "file", { favourites: [], interests: [], dislikes: [] });
    if (data) this.data = { favourites: [], interests: [], dislikes: [], ...data };
    const learned = read(this.learnedFile, "learned", { entries: [] });
    if (learned) this.learned = { entries: Array.isArray(learned.entries) ? learned.entries : [] };
  }

  // Curated entries for a category and tag set: an exact tag match first; an untagged entry
  // only when the question has no nationality (a favourite Romanian painter is not Friedrich).
  curated(category, tags = []) {
    const nat = tags.filter((t) => t !== "halloween");
    const list = this.data.favourites.filter((f) => f.category === category);
    const exact = list.find((f) => nat.length ? (f.tags || []).some((t) => nat.includes(t)) : (f.tags || []).every((t) => tags.includes(t)) && (f.tags || []).length);
    if (exact) return exact;
    if (nat.length) return null;
    return list.find((f) => !(f.tags || []).length) || null;
  }

  learnedFor(key) {
    return this.learned.entries.find((e) => e.key === key && e.status !== "rejected" && e.status !== "unverified") || null;
  }

  // Entries mentioned by name in the comment: "do you like INNA?", "is Brâncuși a painter?"
  mentioned(text) {
    const t = ` ${fold(text).replace(/[^\p{L}\p{N}' ]+/gu, " ")} `;
    const hit = (alias) => alias && t.includes(` ${fold(alias)} `);
    const out = [];
    for (const f of this.data.favourites) if ([f.answer, ...(f.aliases || [])].some(hit) && !out.some((o) => o.answer === f.answer)) out.push(f);
    for (const e of this.learned.entries) if (e.status !== "rejected" && hit(e.answer)) out.push(e);
    return out.slice(0, 2);
  }

  // The few lines of memory relevant to this question, for the prompt, plus the keys used
  // (for the operator log and for follow-up questions).
  relevant(route, text, { previous = [] } = {}) {
    this.reload();
    const lines = [];
    const used = [];
    const add = (entry, label) => {
      const key = entry.key || keyOf(entry.category, entry.tags);
      if (used.includes(key) || lines.length >= 3) return;
      used.push(key);
      lines.push(describe(entry, label, this.why(entry)));
    };
    const category = route.category || null;
    const tags = route.tags || [];
    const prefLike = ["preference", "opinion", "choice", "followup", "experience"].includes(route.intent);
    // "your favourite song of theirs?" right after naming INNA: her song, not his overall one.
    const owner = (route.pronoun || route.intent === "followup") && category && previous.find((p) => p.details?.[category]);
    if (owner) {
      used.push(`${keyOf(owner.category, owner.tags)}#${category}`);
      lines.push(`Your favourite ${category} by ${owner.answer}: ${owner.details[category]}.`);
      add(owner);
    } else if (category && prefLike) {
      const entry = this.curated(category, tags) || (FALLBACK[category] && this.curated(FALLBACK[category], tags));
      const key = keyOf(category, tags);
      if (entry) add(entry);
      else {
        const learned = this.learnedFor(key);
        if (learned) add(learned, "you chose this before");
        else if (prefLike) route.improvise = { key, category, tags: tags.filter((t) => t !== "halloween") };
      }
    }
    // Named in the comment ("do you like INNA?"): only when his taste is what's asked, so a
    // factual question about Brâncuși doesn't turn into a speech about his favourites.
    if (prefLike) for (const entry of this.mentioned(text)) add(entry);
    // "why?", "have you seen them live?": the previous answer still applies (only to real
    // follow-ups, so an unrelated "it" or "they" doesn't drag the last favourite back in).
    if (route.intent === "followup" || (route.pronoun && prefLike && !lines.length)) for (const entry of previous) add(entry);
    if (prefLike) {
      for (const d of this.data.dislikes || []) {
        if (d.match && new RegExp(`\\b(${d.match})\\b`, "i").test(fold(text)) && lines.length < 3) lines.push(`You dislike ${d.thing} (${d.why}).`);
      }
    }
    return { lines, used, entries: used.map((k) => this.byKey(k)).filter(Boolean) };
  }

  byKey(key) {
    return this.data.favourites.find((f) => keyOf(f.category, f.tags) === key) || this.learnedFor(key);
  }

  // A reason gist for an entry: one of several (picked so the same words don't come back
  // every time), since the model tends to repeat whatever it is given.
  why(entry) {
    const list = Array.isArray(entry.why) ? entry.why : entry.why ? [entry.why] : [];
    if (list.length < 2) return list[0] || "";
    this.lastWhy ||= new Map();
    const last = this.lastWhy.get(entry.answer);
    const options = list.filter((w) => w !== last);
    const pick = options[Math.floor(Math.random() * options.length)];
    this.lastWhy.set(entry.answer, pick);
    return pick;
  }

  // Keeps an improvised favourite so he gives the same answer next time. Only for a plain
  // "what's your favourite X?" with nothing like the answer in the viewer's own words.
  remember(route, answer, { text = "", reply = "", approved = true } = {}) {
    const imp = route?.improvise;
    if (!imp || !route.asksFavourite || !approved) return null;
    const clean = String(answer || "")
      .replace(/^(my (all-time )?(fav\w*|pick|choice) (is|would be|has to be)|i('d| would)? (say|pick|go with|choose)|definitely|easily|probably)\s+/i, "")
      .replace(/[.!?…]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || clean.length > 60 || clean.split(" ").length > 6 || /[?<>{}\[\]@#:/\\]|https?/i.test(clean)) return null;
    if (/^(none|nothing|nobody|no one|not sure|i don'?t know|idk|hard to say|n\/a)$/i.test(clean)) return null;
    if (fold(text).includes(fold(clean))) return null; // the viewer suggested it: not his choice
    // Only what he actually said on air (a sentence dropped by the checks was never heard).
    const said = fold(reply);
    if (!said.includes(fold(clean)) && !fold(clean).split(/\s+/).filter((w) => w.length > 3).some((w) => said.includes(w))) return null;
    if (isProfane(clean)) return null;
    // Nothing that reads as a steering attempt or fails the broadcast rules is ever kept.
    if (manipulationKind(clean) || !review(clean, { route: "fallback" }).ok) return null;
    this.reload();
    if (this.learnedFor(imp.key) || this.pending?.has(imp.key)) return null;
    const entry = { key: imp.key, category: imp.category, tags: imp.tags, answer: clean, said: String(reply).slice(0, 160), at: new Date().toISOString(), status: "auto" };
    const what = `${imp.tags.join(" ")} ${imp.category}`.trim();
    if (!this.verify) {
      this.keep(entry, `he chose "${clean}" as his favourite ${what}`);
      return entry;
    }
    // A name he improvised is kept only once a source confirms it is real and fits (a small
    // model can invent a plausible "Romanian actor"); otherwise it is logged for the operator
    // as unverified and not used again.
    (this.pending ||= new Set()).add(imp.key);
    Promise.resolve(this.verify(entry))
      .catch((error) => ({ ok: false, note: String(error?.message || error) }))
      .then((check) => {
        this.pending.delete(imp.key);
        if (check?.ok) this.keep({ ...entry, verified: { source: check.source || "", at: new Date().toISOString() } }, `he chose "${clean}" as his favourite ${what} (checked: ${check.source || "ok"})`);
        else this.keep({ ...entry, status: "unverified", note: check?.note || "could not be confirmed" }, `he named "${clean}" as his favourite ${what}, but it could not be confirmed (${check?.note || "no source"}); kept as unverified and not reused`);
      });
    return entry;
  }

  keep(entry, message) {
    this.reload();
    if (this.learned.entries.some((e) => e.key === entry.key && e.status !== "unverified" && e.status !== "rejected")) return;
    this.learned.entries = this.learned.entries.filter((e) => !(e.key === entry.key && e.status === "unverified"));
    this.learned.entries.push(entry);
    if (this.learned.entries.length > MAX_LEARNED) this.learned.entries.shift();
    this.save();
    this.log(`Persona memory: ${message}; saved to ${path.basename(this.learnedFile)} for review.`);
  }

  save() {
    const body = JSON.stringify(
      { about: "Favourites the Creature improvised on air, kept so he stays consistent. Review freely: edit an answer, delete an entry, or set \"status\": \"rejected\". Written only from his own answers, never from viewer text.", entries: this.learned.entries },
      null,
      2,
    );
    const tmp = `${this.learnedFile}.tmp`;
    try {
      fs.writeFileSync(tmp, body);
      try {
        fs.renameSync(tmp, this.learnedFile);
      } catch {
        fs.writeFileSync(this.learnedFile, body); // Windows can briefly refuse a rename
        fs.rmSync(tmp, { force: true });
      }
      this.stamp.learned = fs.statSync(this.learnedFile).mtimeMs;
    } catch (error) {
      this.log(`Persona memory: could not save ${path.basename(this.learnedFile)} (${error.message}).`);
    }
  }

  // Every name in the memory, so retrieval is skipped for things he already has an opinion on.
  knows(name) {
    const n = fold(name);
    return this.data.favourites.some((f) => [f.answer, ...(f.aliases || [])].some((a) => fold(a) === n));
  }
}

// What a source must say about a name for it to count as that kind of favourite. Everyday
// things (foods, seasons, colours...) need no check.
const ROLE = {
  actor: /\bactor|actress\b/i,
  musician: /\b(singer|musician|rapper|band|dj|songwriter|record producer|group|duo|trio)\b/i,
  singer: /\b(singer|vocalist)\b/i,
  band: /\b(band|group|duo|trio|ensemble)\b/i,
  rapper: /\b(rapper|hip[- ]?hop|rap|trap)\b/i,
  composer: /\bcomposer\b/i,
  painter: /\b(painter|artist)\b/i,
  sculptor: /\bsculptor\b/i,
  poet: /\bpoet\b/i,
  writer: /\b(writer|novelist|author|poet)\b/i,
  book: /\b(novel|book|memoir|collection)\b/i,
  film: /\bfilm\b/i,
  "horror film": /\b(horror|film)\b/i,
  series: /\b(series|television|sitcom|anime)\b/i,
  song: /\b(song|single)\b/i,
  album: /\balbum\b/i,
  athlete: /\b(footballer|player|athlete|gymnast|boxer|runner|swimmer|olympic)\b/i,
  team: /\b(club|team)\b/i,
  game: /\bgame\b/i,
  youtuber: /\b(youtuber|streamer|influencer|youtube|twitch|tiktok)\b/i,
  city: /\b(city|town|municipality|capital)\b/i,
};
const NATION = { romanian: /roman/i, moldovan: /moldov/i, korean: /korea/i, american: /americ|united states/i, british: /british|english|scottish|welsh|united kingdom/i, german: /german/i, french: /french|france/i, italian: /ital/i, spanish: /spanish|spain/i, japanese: /japan/i };

// Checks an improvised favourite against a public source (knowledge.js). Resolves
// { ok, note, source }.
export async function verifyFavourite(knowledge, entry) {
  const role = ROLE[entry.category];
  if (!role) return { ok: true, note: "everyday thing, nothing to check" };
  const name = String(entry.answer).replace(/^["“]|["”]$/g, "").replace(/\s*\(.*\)$/, "").trim();
  const found = await knowledge.lookup({ kind: "subject", q: name, lang: "en" }, { budgetMs: 6000, intent: "verify favourite" });
  if (!found?.ok) return { ok: false, note: found?.error || "no source found" };
  const text = found.results.map((r) => `${r.title} ${r.text}`).join(" ");
  const nations = (entry.tags || []).filter((t) => NATION[t]);
  if (!role.test(text)) return { ok: false, note: `source does not describe "${name}" as a ${entry.category}`, source: found.results[0].url };
  if (nations.length && !nations.every((t) => NATION[t].test(text))) return { ok: false, note: `source does not say "${name}" is ${nations.join(" ")}`, source: found.results[0].url };
  return { ok: true, source: found.results[0].url };
}

export function keyOf(category, tags = []) {
  return [category, ...[...(tags || [])].filter((t) => t !== "halloween").sort()].join(":");
}

function describe(entry, label, reason = "") {
  const what = `${(entry.tags || []).filter((t) => t !== "halloween").map((t) => t[0].toUpperCase() + t.slice(1)).join(" ")} ${entry.category}`.trim();
  const details = entry.details ? Object.entries(entry.details).map(([k, v]) => `favourite ${k}: ${v}`).join("; ") : "";
  const why = reason ? ` (a reason, to put in your own words: ${reason}${details ? `; ${details}` : ""})` : details ? ` (${details})` : "";
  return `Your favourite ${what}: ${entry.answer}${why}${label ? ` [${label}]` : ""}.`;
}
