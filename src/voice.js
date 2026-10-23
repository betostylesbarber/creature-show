import { Worker } from "node:worker_threads";
import { speechText, spokenFrom, approveSpeech, review, publicName } from "./guard.js";

// What the voice is allowed to say: no emoji, no stage directions in *asterisks*, [brackets] or
// <tags>, no markdown or speech-engine commands, no links or emails, and dashes turned into the
// short pause a speaker would make. The same function (src/guard.js speechText) makes the caption,
// so captions and the voice always carry identical text; it is idempotent.
export function speakable(text) {
  return speechText(text);
}
const VOICE_TIMEOUT_MS = 20_000;

function hash(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// How a username sounds out loud and reads in captions: "@milton_reader98" -> "Milton Reader".
// A name that only sounds rude once read aloud ("Mike_Hunt99") is said as "friend".
export function spokenName(nick) {
  const name = spokenFrom(nick);
  return name === "friend" || publicName({ id: `spoken:${nick}`, nick: name }).substituted ? "friend" : name;
}
const SCRIPTS = [
  ["Arabic", /\p{Script=Arabic}/u], ["Japanese", /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ["Korean", /\p{Script=Hangul}/u],
  ["Chinese", /\p{Script=Han}/u], ["Russian", /\p{Script=Cyrillic}/u], ["Greek", /\p{Script=Greek}/u], ["Hebrew", /\p{Script=Hebrew}/u],
  ["Hindi", /\p{Script=Devanagari}/u], ["Thai", /\p{Script=Thai}/u], ["Bengali", /\p{Script=Bengali}/u],
];

// What the reader says for a comment. The voices only speak English, so a comment in another
// language is read as the AI's English translation ("Ana asks, in Romanian: ..."); without one,
// "مرحبا" is announced as "Ahmed says something in Arabic" instead of being read as noise.
function assembleReaderLine(name, text, { language = "", english = "" } = {}) {
  const spoken = name === "friend" ? "A viewer" : name;
  const same = (a, b) => a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (language) {
    // A "translation" that is just the original words would be read out mispronounced.
    if (english && !same(english, text)) return `${spoken} ${/\?\s*$/.test(english) ? "asks" : "says"}, in ${language}: ${english}`;
    return `${spoken} says something in ${language}.`;
  }
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (letters.length && latin / letters.length < 0.5) {
    const script = SCRIPTS.find(([, re]) => re.test(text));
    return `${spoken} says something in ${script ? script[0] : "another language"}.`;
  }
  return `${spoken} says: ${text}`;
}

// The reader line as it will be voiced and captioned, after the broadcast guard has checked the
// whole assembled line (name and message together), or null when it may not be read.
export function readerLine(name, text, options = {}) {
  const spoken = name === "friend" || !review(String(name || ""), { route: "name" }).ok ? "friend" : name;
  return approveSpeech(assembleReaderLine(spoken, String(text ?? ""), options), { route: "reader" });
}

// Kokoro text-to-speech running on the CPU, one line at a time, in a worker thread
// (voice-worker.js) so synthesis never blocks the server.
export class Voice {
  constructor({ character, settings, log }) {
    this.character = character;
    this.settings = settings;
    this.log = log;
    this.worker = null;
    this.state = "loading";
    this.chain = Promise.resolve();
    this.jobs = new Map(); // id -> resolve
    this.jobId = 0;
  }

  load() {
    return new Promise((resolve) => {
      const failed = (message) => {
        this.state = "error";
        this.log(`Voice model failed to load, the show will run with subtitles only: ${message}`);
        for (const done of this.jobs.values()) done(null);
        this.jobs.clear();
        resolve();
      };
      this.worker = new Worker(new URL("./voice-worker.js", import.meta.url));
      this.worker.on("message", (msg) => {
        if (msg.type === "progress") this.log(`Downloading voice model: ${msg.pct}%`);
        else if (msg.type === "ready") {
          this.state = "ready";
          this.log("Voice model ready.");
          resolve();
        } else if (msg.type === "error") failed(msg.message);
        else if (msg.type === "done" || msg.type === "failed") {
          const done = this.jobs.get(msg.id);
          this.jobs.delete(msg.id);
          done?.(msg.type === "done" ? { wav: msg.wav, duration: msg.duration } : new Error(msg.message));
        }
      });
      this.worker.on("error", (error) => failed(error?.message || String(error)));
      this.worker.postMessage({ type: "load" });
    });
  }

  readerVoiceFor(userId) {
    const pool = this.character.readerVoices;
    return pool[hash(userId) % pool.length];
  }

  // Resolves to { wav (base64), duration (seconds) }, or null when there is nothing to say.
  // A line that fails or takes too long comes back as null: the stream then shows it as a
  // caption with a timed mouth instead of stalling the show.
  speak(text, { voice, speed = 1, pitch = 1 }) {
    const job = this.chain.then(async () => {
      const clean = speakable(text);
      if (this.state !== "ready" || !clean) return null;
      let timer;
      try {
        const id = ++this.jobId;
        const result = await new Promise((resolve, reject) => {
          this.jobs.set(id, (r) => (r instanceof Error ? reject(r) : resolve(r)));
          timer = setTimeout(() => {
            this.jobs.delete(id);
            reject(new Error("timed out"));
          }, VOICE_TIMEOUT_MS);
          this.worker.postMessage({ type: "speak", id, text: clean, voice, speed, pitch });
        });
        return result;
      } catch (error) {
        this.log(`Voice failed for "${clean.slice(0, 40)}": ${error?.message || error}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    this.chain = job.catch(() => {});
    return job;
  }

  speakAsCharacter(text) {
    const { id, pitch, speed } = this.settings.get().voice;
    return this.speak(text, { voice: id, pitch, speed });
  }

  // Viewer comments are read in male voices only, so the reader is never mistaken for him
  // (the stream window also puts it through a thin "spirit voice" filter).
  speakAsReader(text, userId) {
    const mode = this.settings.get().readerVoice;
    if (mode === "off") return Promise.resolve(null);
    return this.speak(text, { voice: mode === "varied" ? this.readerVoiceFor(userId) : mode, speed: 1.08 });
  }
}
