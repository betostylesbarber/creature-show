import { scan, stripInvisible } from "./profanity.js";
import { stripControl } from "./guard.js";

// Cheap checks that run before anything reaches the AI or gets read aloud.
export class Moderation {
  constructor(blocklist) {
    this.blocklist = blocklist;
    this.recent = new Map(); // userId -> [{ text, at }]
    this.mutedUntil = new Map(); // userId -> timestamp
    this.strikes = new Map(); // userId -> flagged comment count
  }

  // Viewer text as plain data: invisible and direction-control characters, markup, prompt
  // delimiters and speech-engine commands removed; links, emails and phone numbers replaced, so
  // nobody's details are shown or read; floods of one letter shortened; at most 200 characters.
  clean(text) {
    return stripControl(stripInvisible(String(text ?? "")).normalize("NFC"))
      .replace(/[\p{Cc}\p{Co}]/gu, " ")
      .replace(/https?:\/\/\S+|www\.\S+/gi, "a link")
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "an email")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "a number")
      .replace(/(.)\1{4,}/gu, "$1$1$1")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  // The operator's own list (blocklist.txt): whole words and phrases, matched the same way as the
  // built-in lists (spacing, lookalike letters, leetspeak), never as raw substrings, so "kill" in
  // the list does not hide "skill".
  isBlocked(text) {
    if (!this.blocklist?.length) return false;
    if (this.blockCache?.list !== this.blocklist) {
      const phrases = this.blocklist.map((w) => scan(w).phrase.trim()).filter(Boolean);
      this.blockCache = { list: this.blocklist, phrases };
    }
    const s = scan(text);
    // Letters typed one by one ("n i g g a") count as the word they spell.
    const runs = s.chunks.map((c) => (c.word.length === 1 ? c.word : "|")).join("").split("|").filter((r) => r.length >= 3).map((r) => r.replace(/(\p{L})\1+/gu, "$1"));
    return this.blockCache.phrases.some((p) => s.phrase.includes(` ${p} `) || (!p.includes(" ") && runs.includes(p)));
  }

  isIgnored(userId) {
    if ((this.strikes.get(userId) || 0) >= 3) return true;
    return (this.mutedUntil.get(userId) || 0) > Date.now();
  }

  // Returns false for spam: repeats and floods mute the viewer for a minute.
  accept(userId, text) {
    if (this.isIgnored(userId)) return false;
    const now = Date.now();
    const history = (this.recent.get(userId) || []).filter((m) => now - m.at < 20_000);
    const repeated = history.some((m) => m.text === text);
    history.push({ text, at: now });
    this.recent.set(userId, history);
    if (history.length > 4) {
      this.mutedUntil.set(userId, now + 60_000);
      return false;
    }
    return !repeated;
  }

  // Called when a comment is flagged; three strikes and the viewer is ignored for the session.
  strike(userId, count = 1) {
    this.strikes.set(userId, (this.strikes.get(userId) || 0) + count);
  }
}
