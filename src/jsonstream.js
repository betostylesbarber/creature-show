// Reads a flat JSON object (string, boolean and number values) as it streams in from a model,
// reporting each field the moment its value is complete, and the text of chosen string fields
// as it grows. This is what lets the show speak the first sentence of a reply while the model
// is still writing the second.
export class JsonFieldStream {
  constructor({ onField = () => {}, onText = () => {}, streamed = [] } = {}) {
    this.onField = onField;
    this.onText = onText; // (key, textSoFar) for keys in `streamed`
    this.streamed = new Set(streamed);
    this.state = "start"; // start | key | colon | value | string | literal | after
    this.key = "";
    this.value = "";
    this.escape = null; // null | "" (after backslash) | "uXXXX" in progress
    this.fields = {};
  }

  push(chunk) {
    for (const ch of chunk) this.char(ch);
  }

  char(ch) {
    switch (this.state) {
      case "start":
        if (ch === "{") this.state = "after";
        return;
      case "after": // expecting a key, a comma or the end
        if (ch === '"') {
          this.state = "key";
          this.key = "";
        }
        return;
      case "key":
        if (ch === '"') this.state = "colon";
        else this.key += ch;
        return;
      case "colon":
        if (ch === ":") this.state = "value";
        return;
      case "value":
        if (/\s/.test(ch)) return;
        if (ch === '"') {
          this.state = "string";
          this.value = "";
        } else {
          this.state = "literal";
          this.value = ch;
        }
        return;
      case "string":
        if (this.escape !== null) return this.escapeChar(ch);
        if (ch === "\\") {
          this.escape = "";
          return;
        }
        if (ch === '"') return this.finish(this.value);
        this.value += ch;
        if (this.streamed.has(this.key)) this.onText(this.key, this.value);
        return;
      case "literal":
        if (ch === "," || ch === "}" || /\s/.test(ch)) {
          const raw = this.value.trim();
          this.finish(raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw));
          return;
        }
        this.value += ch;
        return;
    }
  }

  escapeChar(ch) {
    if (this.escape === "") {
      const map = { n: "\n", t: "\t", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" };
      if (ch === "u") {
        this.escape = "u";
        return;
      }
      this.value += map[ch] ?? ch;
      this.escape = null;
    } else {
      this.escape += ch;
      if (this.escape.length === 5) {
        this.value += String.fromCharCode(parseInt(this.escape.slice(1), 16) || 32);
        this.escape = null;
      } else return;
    }
    if (this.streamed.has(this.key)) this.onText(this.key, this.value);
  }

  finish(value) {
    this.fields[this.key] = value;
    this.state = "after";
    this.onField(this.key, value);
  }
}

// A full stop after these is not the end of a sentence ("Dr. Smith", "St. Louis", "vs. Chucky").
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "prof", "mt", "ft", "vol", "approx", "dept", "gen", "gov", "sen", "capt", "lt", "col", "sgt", "e.g", "i.e", "cf"]);

// Splits growing text into finished sentences: everything up to the last sentence end that is
// followed by more text (or by the end of the field) counts as done. Abbreviations and initials
// ("J. R. R. Tolkien", "No. 1") don't end a sentence, so a name is never cut across two clips.
export class SentenceSplitter {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.emitted = 0;
  }

  static boundary(rest, m) {
    if (m[0][0] !== "." || /^\.{2,}/.test(m[0])) return true; // "!", "?", "..." always end
    const word = /([\p{L}.]+)$/u.exec(rest.slice(0, m.index))?.[1] || "";
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    if (/^\p{Lu}$/u.test(word) && word !== "I") return false; // an initial (but "So do I." ends)
    const next = rest.charAt(m.index + m[0].length);
    if (/^(no|nr)$/i.test(word) && (/\d/.test(next) || next === "")) return false; // "No. 1"
    return true;
  }

  update(text, final = false) {
    const rest = text.slice(this.emitted);
    const re = /[.!?…]+["')”]?\s+/g;
    let m;
    let end = 0;
    while ((m = re.exec(rest))) if (SentenceSplitter.boundary(rest, m)) end = m.index + m[0].length;
    if (final) end = rest.length;
    if (end > 0) {
      const done = rest.slice(0, end).trim();
      this.emitted += end;
      if (done) this.onSentence(done);
    }
  }
}
