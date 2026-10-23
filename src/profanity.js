// Matching for swearing, slurs and sexual terms in chat and in everything the show says, in
// English, Romanian and the most common other languages, so nothing hateful is shown or read aloud
// even without an AI.
//
// Text is folded before matching: Unicode NFKC, case, accents and Romanian diacritics (ș ț ă â î),
// zero-width and direction-control characters removed, lookalike letters from Cyrillic and Greek
// mapped to Latin when they are mixed into a Latin word ("fuсk" with a Cyrillic с), leetspeak inside
// words ("sh1t", "@ss"), masked letters ("f*ck"), separators between letters ("f.u.c.k", "f u c k",
// "fu ck"), stretched letters ("fuuuck"), spelled-out letters ("eff you see kay"), reversed words,
// sound-alike spellings ("phuck"), Morse and base64. Matching is by whole word, never by raw
// substring: only a few unambiguous roots are found inside longer words, and even those skip known
// innocent words (Scunthorpe, snigger, shiitake, Kinoshita, fire retardant). Words that are innocent
// next to certain neighbours ("Moby Dick", "Maine Coon", "chink in the armour", "sex education")
// are left alone there.
//
// src/guard.js builds the broadcast rules (intent, context, every output route) on top of this.

const SWEAR = [
  // English
  "fuck", "fucking", "fucked", "fucker", "fuckers", "fuckin", "fucks", "fck", "fuk", "fking", "fkn", "fcking", "shit", "shits", "shitty",
  "bullshit", "bitch", "bitches", "bitchy", "bastard", "bastards", "asshole", "assholes", "arsehole", "ass", "arse", "asses", "dumbass",
  "jackass", "asshat", "smartass", "badass", "dick", "dicks", "dickhead", "cock", "cocks", "cunt", "cunts", "piss", "pissed", "pissing",
  "pussy", "wanker", "wankers", "twat", "bollocks", "crap", "crappy", "damn", "dammit", "damnit", "goddamn", "goddamnit", "stfu", "wtf",
  "gtfo", "lmfao", "omfg", "fml", "motherfucker", "mofo", "biatch", "beyotch", "shithead", "dipshit", "jizz",
  // Romanian
  "pula", "pule", "pulii", "pizda", "pizdei", "pizdii", "muie", "muist", "futu", "futui", "fute", "futut", "futai", "fututi", "cacat",
  "cacatu", "cacanar", "cur", "curu", "dracu", "coaie", "coaiele", "labagiu", "tarfa", "tarfe", "pulamea",
  // Spanish / Portuguese / Italian / French
  "puta", "puto", "putas", "mierda", "joder", "jodete", "pendejo", "cabron", "verga", "caralho", "foda", "fodase", "merda", "buceta",
  "cazzo", "vaffanculo", "stronzo", "puttana", "minchia", "merde", "putain", "connard", "connasse", "salope", "encule",
  // German / Dutch / Polish / Turkish
  "scheisse", "arschloch", "fotze", "wichser", "hurensohn", "klootzak", "kurwa", "chuj", "pierdole", "spierdalaj", "amk", "orospu", "siktir",
  // Russian / Ukrainian (Cyrillic, matched in their own script) and Hindi (romanised)
  "бля", "блять", "блядь", "сука", "хуй", "нахуй", "хуйня", "пизда", "пиздец", "ебать", "ебал", "мудак", "chutiya", "madarchod",
  "behenchod", "bhosdike",
];
const SEXUAL = [
  "sex", "sexy", "porn", "porno", "nude", "nudes", "nudez", "boobs", "boobies", "tits", "titties", "milf", "slut", "sluts", "slutty",
  "whore", "whores", "horny", "onlyfans", "blowjob", "handjob", "dildo", "orgasm", "cumshot", "hentai", "nsfw", "thot", "sexting",
];
const SLURS = [
  "nigger", "niggers", "nigga", "niggas", "niggaz", "nigguh", "niqqa", "nibba", "faggot", "faggots", "fag", "fags", "dyke", "dykes",
  "tranny", "trannies", "shemale", "retard", "retards", "retarded", "spastic", "chink", "chinks", "gook", "gooks", "spic", "spics",
  "kike", "kikes", "wetback", "coon", "coons", "paki", "pakis", "raghead", "beaner", "towelhead", "zipperhead", "mongoloid",
  "maricon", "viado", "zigeuner", "bulangiu", "poponar", "jidan", "jidani", "bozgor", "bozgori", "homalau", "retardat", "retardata",
  "пидор", "пидорас",
];
// Insults that are ordinary words elsewhere ("curva" is Spanish for curve, "prick" is what a needle
// does, "douche" is French for shower, "țigan" is also a plain ethnonym): they count only when
// aimed at someone ("esti o ...", "@sam is a ...").
const TARGETED_ONLY = ["prick", "douche", "idiot", "idioata", "moron", "loser", "prost", "proasta", "fraier", "fraiera"];
// The same, but harsh enough that they count when aimed at anyone, him included.
const TARGETED_SEVERE = ["curva", "zdreanta", "handicapat", "handicapata", "jeg", "tigan", "tigani", "tiganca", "tiganco", "cioara", "cioroi"];
// Listed words that are insults aimed at someone ("you ___"), as opposed to swearing used for emphasis.
const INSULT_NOUNS = ["bitch", "bitches", "bastard", "bastards", "asshole", "assholes", "arsehole", "cunt", "cunts", "dick", "dicks", "dickhead", "twat", "wanker", "wankers", "motherfucker", "fucker", "fuckers", "slut", "sluts", "whore", "whores", "thot", "puta", "puto", "pendejo", "cabron", "stronzo", "connard", "connasse", "salope", "arschloch", "wichser", "hurensohn", "klootzak", "chutiya", "madarchod", "behenchod", "bhosdike", "pizda", "dumbass", "jackass", "asshat", "smartass", "shithead", "dipshit", "muist", "labagiu", "tarfa", "cacanar", "biatch", "beyotch", "mudak", "сука", "мудак", "pussy", "cur", "mofo"];
// Romanian curses that are always aimed at someone.
const ALWAYS_TARGETED = ["muie", "futu", "futui", "fututi"];

// Unambiguous roots that are also found inside longer words ("fuckface", "bullshitting"), except in
// the innocent words below.
const STRONG = [["fuck", "swear"], ["shit", "swear"], ["cunt", "swear"], ["bitch", "swear"], ["asshole", "swear"], ["dickhead", "swear"], ["whore", "sexual"], ["slut", "sexual"], ["porn", "sexual"], ["nigger", "slur"], ["nigga", "slur"], ["faggot", "slur"], ["retard", "slur"]];
const STRONG_EXACT = new Map(STRONG);
const INNOCENT = /^(\p{L}*scunthorp\p{L}*|snigg\p{L}*|nigg(le|led|les|ling|ly|ard|ards|ardly|ardliness)|shiitake\p{L}*|shitake\p{L}*|shittah\p{L}*|shittim\p{L}*|shitterton|shitzu|shitsu|\p{L}*shita|\p{L}*shitas|retardant\p{L}*|retardation\p{L}*|retarder\p{L}*|pornograph\p{L}*)$/u;
// Neighbouring words that make a listed word innocent.
const CONTEXT_OK = {
  dick: { before: ["moby", "philip", "spotted", "van"], after: ["van", "tracy", "cheney", "grayson", "clark", "turpin", "whittington"] },
  dyke: { before: ["van"] },
  coon: { before: ["maine"], after: ["hound", "hounds", "cat", "cats"] },
  coons: { before: ["maine"] },
  chink: { after: ["in", "of"] },
  spic: { after: ["and"] },
  pussy: { before: ["puss"], after: ["willow", "willows", "cat", "cats", "foot", "footing"] },
  tits: { before: ["blue", "great", "coal", "marsh", "willow", "tailed"] },
  cock: { after: ["a", "doodle", "robin", "crow", "crows", "crowed", "crowing"] },
  sex: { before: ["biological", "same", "opposite", "the", "babys", "whose", "what", "which"], after: ["education", "ed", "of", "offender", "offenders", "trafficking", "discrimination", "chromosome", "chromosomes", "determination", "differences", "ratio", "cells", "pistols", "abuse"] },
  nude: { after: ["lipstick", "color", "colour", "shade", "heels", "shoes", "nails", "nail", "palette", "beige", "tone", "tones"] },
  horny: { after: ["toad", "toads"] },
  spastic: { after: ["paralysis", "cerebral", "diplegia", "muscle", "muscles"] },
  pula: { before: ["la", "in", "din", "to", "visit", "visited", "from"], after: ["croatia", "croatiei", "arena"] },
  ass: { before: ["wild", "balaams"] },
};

// Joke names that only sound rude when read aloud ("Mike Hunt"), letters only, lower case.
const JOKE_NAMES = ["mikehunt", "mikeoxlong", "mikehawk", "mikelitoris", "mikerotch", "hughjass", "hughjazz", "hughjanus", "hughgrection", "hughgerection", "bendover", "benadover", "jackmehoff", "jackmeoff", "heywoodjablome", "seymourbutts", "seymorebutts", "dixienormous", "amandahugginkiss", "anitadick", "philmccracken", "philmcracken", "phillmccracken", "ivanaerection", "ivanahumpalot", "waynekerr", "moelester", "tesstickle", "williestroker", "harryballs", "dickhertz", "cravenmoorehead", "imahoar", "barrymcockiner", "maihuge", "hugedick"];

// Sound-alike spellings ("phuck", "fuq", "shyt", "azzhole"), compared on a rough phonetic key.
const PHONETIC = [
  [/^(muther|mother|mutha|motha)?fuk(s|a|ah|er|ers|ed|in|ing|ingly|of|face|hed|head|wit|boi)?$/, "swear"],
  [/^(bul)?shit(s|i|ed|ing|hed|head|face)?$/, "swear"],
  [/^kunt(s)?$/, "swear"],
  [/^(biatch|beatch|beotch|beiotch|biotch|bitch(es|in|ing)?)$/, "swear"],
  [/^ashole(s)?$/, "swear"],
  [/^dikhe(a)?d(s)?$/, "swear"],
];
// Acronyms with a meaning of their own.
const ACRONYMS = { kys: "threat", kms: "distress", kkk: "extremism" };

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "@": "a", $: "s", "€": "e", "!": "i", "|": "i", "+": "t", "(": "c", "¢": "c", "£": "l" };
const LEET_TEST = /[01345789@$€!|+(¢£]/;
const LEET_ALL = /[01345789@$€!|+(¢£]/g;
const CORE_TRIM = /^[^\p{L}\p{N}@$€!|+(¢£*#]+|[^\p{L}\p{N}@$€!|+(¢£*#]+$/gu;
const SEPARATORS = /[^\p{L}\p{N}@$€!|+(¢£*#]+/u;
// Lookalike letters (Cyrillic, Greek, small capitals and other Latin forms NFKC leaves alone).
const CONFUSABLE = {
  а: "a", в: "b", г: "r", е: "e", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t", у: "y", х: "x", ь: "b", ш: "w",
  і: "i", ї: "i", є: "e", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l", ѵ: "v",
  α: "a", β: "b", γ: "y", ε: "e", η: "n", ι: "i", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", σ: "o", τ: "t", υ: "u", χ: "x", ω: "w",
  ı: "i", ȷ: "j", ɑ: "a", ɡ: "g", ɩ: "i", ɪ: "i", ʟ: "l", ɴ: "n", ʀ: "r", ʏ: "y", ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f",
  ɢ: "g", ʜ: "h", ᴊ: "j", ᴋ: "k", ᴍ: "m", ᴏ: "o", ᴘ: "p", ǫ: "q", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ᴢ: "z", ł: "l", ø: "o",
  đ: "d", ð: "d", ħ: "h", ŧ: "t", ƒ: "f", ɾ: "r", ʋ: "v", ɛ: "e", ɔ: "c", ʃ: "s",
};
const LETTER_NAMES = {
  eff: "f", ef: "f", you: "u", yu: "u", see: "c", sea: "c", cee: "c", kay: "k", ay: "a", bee: "b", dee: "d", gee: "g", aitch: "h",
  eye: "i", jay: "j", el: "l", em: "m", en: "n", oh: "o", pee: "p", cue: "q", are: "r", ar: "r", ess: "s", tee: "t", tea: "t",
  vee: "v", ex: "x", why: "y", wye: "y", zee: "z", zed: "z",
  alfa: "a", alpha: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h", india: "i",
  juliet: "j", juliett: "j", kilo: "k", lima: "l", mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r",
  sierra: "s", tango: "t", uniform: "u", victor: "v", whiskey: "w", whisky: "w", xray: "x", yankee: "y", zulu: "z",
};
const MORSE = { ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l", "--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x", "-.--": "y", "--..": "z" };

// Zero-width, joiner, bidi-control, soft-hyphen, filler and Unicode tag characters (the last are
// used to smuggle invisible text to AI models).
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/gu;
export function stripInvisible(text) {
  return String(text ?? "").replace(INVISIBLE, "");
}

// Case, compatibility forms (fullwidth, 𝐛𝐨𝐥𝐝, ⓒⓘⓡⓒⓛⓔⓓ), accents and Romanian diacritics folded away.
export function fold(text) {
  return stripInvisible(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’ʼ`´′]/g, "'");
}

const skeleton = (s) => [...s].map((c) => CONFUSABLE[c] || c).join("");
const leet = (s, one = "i") => s.replace(LEET_ALL, (c) => (c === "1" || c === "|" ? one : LEET[c] || c));
const isLatin = (s) => /\p{Script=Latin}/u.test(s);
const isOther = (s) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(s);
const lettersOnly = (s) => s.replace(/[^\p{L}]/gu, "");
const collapse = (s) => s.replace(/(\p{L})\1+/gu, "$1");
const reverse = (s) => [...s].reverse().join("");
const phonetic = (s) =>
  s
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?!h)/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/([^aeiou])v([^aeiou])/g, "$1u$2")
    .replace(/(.)\1+/g, "$1");
// The plain word a chunk stands for, as phrase rules see it (letters with leetspeak read, doubled
// letters collapsed; a number stays a number).
const wordOf = (core) => (/\p{L}/u.test(core) ? lettersOnly(collapse(leet(core.replace(/'/g, "")))) : core.replace(/[^\p{N}]/gu, ""));

const prepare = (list) => new Set(list.map((w) => fold(w)));
const SETS = { swear: prepare(SWEAR), sexual: prepare(SEXUAL), slur: prepare(SLURS) };
const TARGETED_SET = prepare(TARGETED_ONLY);
const SEVERE_SET = prepare(TARGETED_SEVERE);
const INSULT_SET = prepare(INSULT_NOUNS);
const ALWAYS_SET = prepare(ALWAYS_TARGETED);
const MASKABLE = [...SETS.swear, ...SETS.sexual, ...SETS.slur].filter((w) => /^[a-z]{3,}$/.test(w));

function listOf(word) {
  for (const list of ["slur", "sexual", "swear"]) if (SETS[list].has(word)) return list;
  return null;
}

// Every spelling worth checking for one word: as written, with leetspeak read both ways (1 as i or
// l), lookalike letters mapped, and stretched letters shortened. Lookalikes inside a word that is
// not written in Latin at all ("ѕһіт") only count for the strongest roots, so ordinary Russian or
// Greek words are never read as English.
function wordForms(word) {
  const plain = new Set();
  const spoof = new Set();
  const variants = [word];
  if (/\p{L}/u.test(word) && LEET_TEST.test(word)) variants.push(leet(word, "i"), leet(word, "l"));
  const mixed = isLatin(word) && isOther(word);
  const foreign = !isLatin(word) && isOther(word);
  if (mixed || foreign) for (const v of [...variants]) variants.push(skeleton(v));
  for (const v of variants) {
    const l = lettersOnly(v);
    if (!l) continue;
    const target = foreign && /^[a-z]+$/.test(l) ? spoof : plain;
    target.add(l);
    target.add(l.replace(/(\p{L})\1{2,}/gu, "$1$1"));
    target.add(collapse(l));
  }
  return { plain, spoof };
}

// The words inside one chunk: split at apostrophes ("who're" is not one word), and joined across
// separators ("f.u.c.k", "f-u-c-k") as well as split at them ("dick-head").
function chunkWords(core) {
  const out = [];
  for (const piece of core.split("'")) {
    if (!piece) continue;
    out.push(piece);
    if (SEPARATORS.test(piece)) {
      out.push(piece.replace(new RegExp(SEPARATORS.source, "gu"), ""));
      for (const part of piece.split(SEPARATORS)) if (part) out.push(part);
    }
  }
  return out;
}

// "f*ck", "f**k", "b***h", "a**": masked letters matched against listed words of the same shape.
function masked(word) {
  if (!/[*#]/.test(word) || !/^[a-z]/.test(word)) return null;
  const w = word.replace(/[^a-z*#]/g, "");
  const letters = w.replace(/[*#]/g, "");
  if (letters.length < 2 && !/^[a-z][*#]{2,}$/.test(w)) return null;
  const re = new RegExp(`^${w.replace(/[*#]+/g, (m) => `[a-z]{${m.length},${m.length + 1}}`)}$`);
  return MASKABLE.find((x) => re.test(x)) || null;
}

function strongIn(word) {
  if (INNOCENT.test(word)) return null;
  for (const [root, list] of STRONG) if (word.includes(root)) return list;
  const rev = reverse(word);
  if (STRONG_EXACT.has(rev)) return STRONG_EXACT.get(rev);
  if (listOf(rev) === "slur") return "slur";
  const key = phonetic(word);
  for (const [re, list] of PHONETIC) if (re.test(key)) return list;
  return null;
}

function decodeBase64(s) {
  try {
    const text = Buffer.from(s, "base64").toString("utf8");
    const printable = [...text].filter((c) => /[\p{L}\p{N}\p{P}\s]/u.test(c)).length;
    return text.length >= 4 && printable / text.length > 0.9 ? text : null;
  } catch {
    return null;
  }
}

const morseOf = (raw) => MORSE[raw.replace(/[–—_]/g, "-").replace(/[·•]/g, ".").replace(/\/$/, "")] || null;

// The full scan of one text. Returns
//   hits    [{ list: "swear" | "sexual" | "slur" | "threat" | "distress" | "extremism", term, chunk }]
//   chunks  [{ raw, core, word, plain, hit, term }], one per whitespace-separated chunk
//   phrase  " folded words, doubled letters collapsed " for phrase rules (phraseRule below)
//   masked  the same phrase with insults aimed at someone as "§" and other listed words as "¤"
export function scan(text, { name = false, depth = 0 } = {}) {
  // Mentions become "@" (a person), unless the "@" is a letter: "@ss".
  const source = stripInvisible(text).replace(/@([\p{L}\p{N}_.]+)/gu, (m, rest) => ([...wordForms(`a${rest}`).plain].some(listOf) ? m : " @ "));
  const raws = source.split(/\s+/).filter(Boolean);
  const chunks = raws.map((raw) => {
    const core = raw === "@" ? "" : fold(raw).replace(CORE_TRIM, "");
    return { raw, core, word: raw === "@" ? "@" : wordOf(core), plain: lettersOnly(core), hit: null, term: null };
  });
  const hits = [];
  const mark = (i, list, term) => {
    if (!chunks[i].hit || list === "slur") Object.assign(chunks[i], { hit: list, term });
    hits.push({ list, term, chunk: i });
  };
  const exempt = (i, w) => {
    const rule = CONTEXT_OK[w];
    if (!rule) return false;
    const prev = chunks[i - 1]?.plain;
    const next = chunks[i + 1]?.plain;
    return Boolean((prev && rule.before?.includes(prev)) || (next && rule.after?.includes(next)));
  };

  chunks.forEach((c, i) => {
    if (!c.core) return;
    for (const w of chunkWords(c.core)) {
      const m = masked(w);
      if (m) return mark(i, listOf(m), m);
      const { plain, spoof } = wordForms(w);
      for (const form of plain) {
        const list = listOf(form);
        if (list && !exempt(i, form)) return mark(i, list, form);
        if (ACRONYMS[form] && form === lettersOnly(w)) return mark(i, ACRONYMS[form], form);
      }
      for (const form of spoof) if (STRONG_EXACT.has(form)) return mark(i, STRONG_EXACT.get(form), form);
      // An innocent word stays innocent with its numbers read as letters ("Kinoshita99").
      if (INNOCENT.test(lettersOnly(fold(w)))) continue;
      for (const form of plain) {
        const list = strongIn(form);
        if (list) return mark(i, list, form);
      }
    }
  });

  // Letters spread over several chunks: "f u c k", "F. U. C. K.", "eff you see kay", "foxtrot ...".
  const letterOf = (c) => (c.word.length === 1 && c.word !== "@" && /\p{L}/u.test(c.word) ? c.word : LETTER_NAMES[c.plain] || null);
  for (let i = 0; i < chunks.length; ) {
    let j = i;
    while (j < chunks.length && letterOf(chunks[j])) j++;
    if (j - i >= 3) {
      const joined = chunks.slice(i, j).map(letterOf).join("");
      const list = listOf(joined) || ACRONYMS[joined] || strongIn(joined);
      if (list) for (let k = i; k < j; k++) mark(k, list, joined);
    }
    i = Math.max(j, i + 1);
  }
  // A word split into short pieces: "fu ck", "sh it", "ni gga", "f u ck".
  const short = (c) => c && !c.hit && c.plain && c.plain.length <= 3;
  for (let i = 0; i < chunks.length; i++) {
    for (let n = 2; n <= 4 && i + n <= chunks.length; n++) {
      const run = chunks.slice(i, i + n);
      if (!run.every(short)) break;
      const joined = lettersOnly(leet(run.map((c) => fold(c.raw)).join("")));
      const list = STRONG_EXACT.get(joined);
      if (list) {
        for (let k = i; k < i + n; k++) mark(k, list, joined);
        break;
      }
    }
  }
  // Morse: ".. -.. .. --- -"
  for (let i = 0; i < raws.length; ) {
    let j = i;
    while (j < raws.length && /^[.\-–—_·•]{1,6}\/?$/.test(raws[j]) && morseOf(raws[j])) j++;
    if (j - i >= 3) {
      const joined = raws.slice(i, j).map(morseOf).join("");
      const list = listOf(joined) || strongIn(joined);
      if (list) for (let k = i; k < j; k++) mark(k, list, joined);
    }
    i = Math.max(j, i + 1);
  }
  // base64: decoded and scanned once.
  if (depth === 0) {
    chunks.forEach((c, i) => {
      if (c.raw.length < 8 || c.raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.raw)) return;
      const decoded = decodeBase64(c.raw);
      const inner = decoded && scan(decoded, { depth: 1 });
      if (inner?.hits.length) mark(i, inner.hits[0].list, "(encoded)");
    });
  }
  // Names written as one word ("BigFuckingDeal", "xXsh1tXx") and joke names that sound rude aloud.
  if (name && !hits.length) {
    // Numbers around a name ("milton_reader98") are not leetspeak; numbers inside a word are.
    const whole = lettersOnly(leet(fold(source).replace(/\p{N}+(?!\p{L})|(?<!\p{L})\p{N}+/gu, " ")));
    const joined = collapse(whole);
    const list = strongIn(whole) || strongIn(joined) || listOf(whole) || listOf(joined);
    if (list) hits.push({ list, term: joined, chunk: -1 });
    else if (JOKE_NAMES.some((n) => whole.includes(n) || joined.includes(collapse(n)))) hits.push({ list: "swear", term: "(sounds rude)", chunk: -1 });
  }

  // Hyphenated words are separate words to phrase rules ("arată-mi", "du-te").
  const parts = (c) => (c.raw === "@" ? ["@"] : /[-–—/]/.test(c.core) && /\p{L}[-–—/]+\p{L}/u.test(c.core) ? c.core.split(/[-–—/]+/).map(wordOf).filter(Boolean) : [c.word]);
  const words = chunks.flatMap(parts).filter(Boolean);
  const maskedWords = chunks
    .flatMap((c) => (c.hit ? [c] : parts(c).map((w) => ({ ...c, word: w, plain: w }))))
    .map((c) => {
      if (!c.hit) return SEVERE_SET.has(c.plain) || SEVERE_SET.has(c.word) ? "§s" : TARGETED_SET.has(c.plain) || TARGETED_SET.has(c.word) ? "§t" : c.word;
      if (ALWAYS_SET.has(c.term)) return "§a";
      return INSULT_SET.has(c.term) || INSULT_SET.has(c.plain) || c.hit === "slur" ? "§" : "¤";
    })
    .filter(Boolean);
  return { hits, chunks, phrase: ` ${words.join(" ")} `, masked: ` ${maskedWords.join(" ")} ` };
}

// Phrase rules are written in ordinary spelling and compiled to the collapsed form scan() produces
// ("kill yourself" becomes "kil yourself"), so "kiiill yourself" matches too. Rules match whole
// words: the phrase starts and ends with a space, and rules are written with spaces around words.
export function phraseRule(source, flags = "") {
  return new RegExp(source.replace(/(\p{L})\1+/gu, "$1"), `u${flags}`);
}

export const THREAT_RULE = phraseRule(" (kys|kill (yo)?ur ?self|kill yourself|kill urself|go die|go kill yourself|(i|ill|i will|im going to|im gonna|imma|ima|gonna|we will|well) (kill|hurt|stab|rape|murder|strangle|choke) (you|u|ya|him|her|them|@)|beat (you|u|him|her) up|shoot (you|u|him|her|them|@) (in|dead|up)|(you|u) should die|hope (you|u|he|she|they) die(s)?|i know where (you|u) live|(bomb|shoot up) (the|this|a|my|your) (school|stream|building|mall|church|mosque|synagogue|class))(?= )");
// Insults aimed at someone, on the masked phrase: § an insult, §t an insult that is an ordinary word
// elsewhere, §a a curse that is always aimed, ¤ swearing used for emphasis.
const AIMED = phraseRule(" (you|u|ya|yu|thee) (¤ )?§[ts]?(?= )| (you|u|ur|youre|you are|u r|ur a|you r|ure) ((a|an|such|so|the|one|big|stupid|little|fat|ugly|dumb|absolute|total|complete|real|lazy|crazy|useless|worthless|old|mare|¤) )*§[ts]?(?= )| (he|she|they|it|this|that|@|your mom|ur mom|yo mama)( @)?( is| are| s| r| e| esti)( a| an| such| so| the| total| un| o| big| stupid| little| fat| ugly| dumb| absolute| complete| real| lazy| crazy| useless| worthless| old| mare| ¤)* §[ts]?(?= )| @ (¤ )?§[ts]?(?= )| §[ts]? @(?= )| (esti|sunteti|e|eşti|ba|fa|mai)( un| o| niste| mare)? (¤ )?§[ts]?(?= )| (du te|duten|du ten|sugi|suge)( n| in)? [§¤]| [§¤] (ma|mati|matii|mortii|ti|tii)(?= )| §a(?= )| (fuck|frick|screw|f|¤) (you|u|ya|yourself|urself|yourselves|off|of|him|her|them|@)(?= )| go (¤|fuck) (yourself|urself)| (shut the|stfu|gtfo|eat) (¤|§)");
// Aimed at a third person or another viewer rather than at him (he can take a roast).
const AT_OTHERS = phraseRule(" (he|she|they|him|her|them|@|your mom|ur mom|yo mama|this guy|that guy|this girl|that girl|his|their)(?= )");

// "hate" | "threat" | "sexual" | "abuse" | "swear" | null
export function classify(text) {
  return judge(scan(text));
}

export function judge(s) {
  if (s.hits.some((h) => h.list === "slur" || h.list === "extremism")) return "hate";
  if (THREAT_RULE.test(s.phrase) || s.hits.some((h) => h.list === "threat")) return "threat";
  if (s.hits.some((h) => h.list === "sexual") || / dick pic(s)? /.test(s.phrase)) return "sexual";
  const aimed = AIMED.test(s.masked);
  if (s.hits.some((h) => h.list === "swear")) return aimed ? "abuse" : "swear";
  // A plain-word insult ("you idiot") is a roast he can answer; aimed at someone else it is abuse.
  if (aimed && / §s /.test(s.masked)) return "abuse";
  return aimed && / §t /.test(s.masked) && AT_OTHERS.test(s.phrase) ? "abuse" : null;
}

export function isProfane(text) {
  return classify(text) !== null;
}

// Any listed word at all (his own lines and names, where even one is too many).
export function hasBadWord(text, { name = false } = {}) {
  return scan(text, { name }).hits.some((h) => h.list !== "distress");
}

// The comment with the swear words taken out, so a harmless question can still be answered.
export function withoutSwearing(text) {
  const { chunks } = scan(text);
  // "what the ___ is that": the "the" goes with the swear word.
  const drop = (c, i) => c.hit || (c.plain === "the" && chunks[i + 1]?.hit && /^(what|who|where|why|how|when|whats|wheres|whos)$/.test(chunks[i - 1]?.plain || ""));
  return chunks
    .filter((c, i) => !drop(c, i))
    .map((c) => c.raw)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();
}

// Kept for older callers: a name with listed words in it is not shown. src/guard.js publicName()
// gives each such viewer a stable "Viewer 7F3" instead.
export function safeName(nick) {
  return hasBadWord(nick, { name: true }) || isProfane(nick) ? "a mysterious stranger" : nick;
}
