import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const characterId = process.env.CHARACTER || "creature";
const characterDir = path.join(ROOT, "characters", characterId);

export const character = {
  id: characterId,
  dir: characterDir,
  ...JSON.parse(fs.readFileSync(path.join(characterDir, "character.json"), "utf8")),
  persona: fs.readFileSync(path.join(characterDir, "persona.md"), "utf8").trim(),
};
// Small local models get lost in a long character bible; persona-lite.md is the short version.
const liteFile = path.join(characterDir, "persona-lite.md");
character.personaLite = fs.existsSync(liteFile) ? fs.readFileSync(liteFile, "utf8").trim() : character.persona;

// Short tales he tells as a reward for big gifts, one "Title | text" per line in tales.md.
const talesFile = path.join(characterDir, "tales.md");
export const tales = fs.existsSync(talesFile)
  ? fs
      .readFileSync(talesFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [title, ...rest] = line.split("|");
        return { title: title.trim(), text: rest.join("|").trim() };
      })
  : [];

export const settings = {
  port: Number(process.env.PORT) || 3000,
  tiktokUsername: process.env.TIKTOK_USERNAME || "",
  eulerApiKey: process.env.EULER_API_KEY || undefined,
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
};

// The show's date and local time, given to the AI with every request so "what day is it?" and
// "how long until Halloween?" are answered from the calendar, not from the model's training.
// SHOW_TIMEZONE names the show's time zone (default: this PC's); SHOW_DATE pins the date for
// tests or rehearsals ("2026-10-31" keeps the real time of day, "2026-10-31T21:30" pins both).
export const clock = {
  timeZone: validTimeZone(process.env.SHOW_TIMEZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  fixed: process.env.SHOW_DATE || "",
};

function validTimeZone(zone) {
  if (!zone) return "";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "";
  }
}

// { iso: "2026-10-23", year, month, day, weekday, time: "18:40", timeZone, daysToHalloween, label }
export function showDate(now = new Date(), { timeZone = clock.timeZone, fixed = clock.fixed } = {}) {
  const parts = (date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
  const p = parts(now);
  let [year, month, day] = [Number(p.year), Number(p.month), Number(p.day)];
  let time = `${p.hour}:${p.minute}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(fixed);
  if (m) {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) time = `${m[4]}:${m[5]}`;
  }
  const noon = Date.UTC(year, month - 1, day, 12);
  const weekday = m ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(noon) : p.weekday;
  const monthName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" }).format(noon);
  let halloween = Date.UTC(year, 9, 31, 12);
  if (halloween < noon) halloween = Date.UTC(year + 1, 9, 31, 12);
  const daysToHalloween = Math.round((halloween - noon) / 86_400_000);
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const label = `${weekday} ${day} ${monthName} ${year}, ${time} (${timeZone} time)`;
  return { iso, year, month, day, weekday, monthName, time, timeZone, daysToHalloween, label };
}

// Words in blocklist.txt (one per line, # for comments) are never read aloud.
export function loadBlocklist() {
  const file = path.join(ROOT, "blocklist.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"));
}

// What the stream window needs to know about the character. Re-read on every request so
// edits to character.json show up after a page reload, without restarting the server.
export function publicCharacter() {
  const fresh = JSON.parse(fs.readFileSync(path.join(characterDir, "character.json"), "utf8"));
  const { name, model, modelScale, environment, giftEvents } = fresh;
  return { name, model, modelScale, environment, giftEvents };
}
