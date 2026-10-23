// Runs the conversation cases from the upgrade spec (section 18, "Conversation") through the
// real brain and the real local model, measures latency, and writes CONVERSATION-EVAL.md at
// the project root with every answer verbatim and a pass/fail judgement per case.
//
//   node scripts/conversation-eval.mjs                 all cases, qwen3.5:9b
//   node scripts/conversation-eval.mjs --cases fav-ro-artist,date
//   node scripts/conversation-eval.mjs --model gemma4:12b --out scratch.md --label "gemma run"
//
// Needs Ollama running with the model pulled. Runs next to a live show if one is running (the
// model is shared, so latency then includes waiting for the show's own requests).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((list, a, i, all) => (a.startsWith("--") ? [...list, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : list), []),
);
const only = args.cases ? new Set(args.cases.split(",")) : null;
const outFile = path.resolve(ROOT, args.out || "CONVERSATION-EVAL.md");
const model = args.model || process.env.OLLAMA_MODEL || "qwen3.5:9b";

// Improvised favourites from this run go to a scratch file, so the eval neither reads nor
// pollutes the operator's reviewed list.
const learnedFile = path.join(os.tmpdir(), `creature-eval-learned-${process.pid}.json`);
process.env.PERSONA_LEARNED_FILE = learnedFile;

// Counts the tokens the model streams (one Ollama line each), so latency can also be judged
// without GPU contention: tokens before the first spoken sentence, at this PC's measured idle
// rate (about 38 tokens/s), plus prompt reading (about 7000 tokens/s).
let streamedTokens = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts);
  if (!String(url).endsWith("/api/chat") || !String(opts?.body || "").includes('"stream":true') || !res.body) return res;
  streamedTokens = 0;
  const decoder = new TextDecoder();
  let buf = "";
  const body = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          if (line.trim() && JSON.parse(line).message?.content) streamedTokens++;
        } catch {}
      }
      ctl.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, headers: res.headers });
};

// --src points at another copy of the project (for example a snapshot taken before the
// upgrade), so the same cases can be replayed against the old brain for a before/after table.
const SRC = args.src ? path.resolve(args.src, "src") : path.join(ROOT, "src");
const load = (file) => import(pathToFileURL(path.join(SRC, file)).href);
const { Brain } = await load("brain.js");
const config = await load("config.js");
const { character } = config;
const { speakable, spokenName } = await load("voice.js");
let knowledge = null;
try {
  knowledge = await load("knowledge.js");
} catch {
  // the baseline (before the upgrade) has no retrieval module
}

const logLines = [];
const brain = new Brain({ apiKey: "", model: "x", character, log: (l) => logLines.push(l), ollamaModel: model });
await brain.findOllama();
await brain.ready;
if (!brain.ollama) {
  console.error("No local model found in Ollama; start Ollama and pull the model first.");
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------------------
const fold = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s) => fold(s).replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
// Whole-name matches only ("Ian" must not match inside "Romanian").
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (reply, list) => list.find((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(fold(n))}($|[^\\p{L}\\p{N}])`, "u").test(fold(reply))) || null;
const firstSentence = (reply) => String(reply).split(/(?<=[.!?])\s+/)[0] || "";

const RO_MUSICIANS = ["INNA", "Alexandra Stan", "Smiley", "Carla's Dreams", "Irina Rimes", "Delia", "Andra", "Holograf", "Phoenix", "Subcarpați", "Vama Veche", "Maria Tănase", "George Enescu", "Enescu", "Ciprian Porumbescu", "Edward Maya", "Akcent", "O-Zone", "Morandi", "Antonia", "Elena Gheorghe", "Loredana", "Puya", "Guess Who", "B.U.G. Mafia", "Paraziții", "Grasu XXL", "Killa Fonic", "Alex Velea", "Connect-R", "Voltaj", "Zdob și Zdub", "The Motans", "Nicola", "Mihaela Runceanu", "Angela Similea", "Gheorghe Zamfir", "Tudor Gheorghe", "Ana Lugojana", "Fuego", "Theo Rose", "Lidia Buble", "What's Up", "Ian", "Bean", "Șatra B.E.N.Z.", "Spike", "Deliric", "Carla", "Mihai Mărgineanu", "Florin Salam", "Nicolae Guță", "Dan Spătaru", "Margareta Pâslaru", "Luminița Anghel", "Cleopatra Stratan", "Sore", "Inna"];
const RO_RAPPERS = ["Puya", "Guess Who", "B.U.G. Mafia", "Paraziții", "Grasu XXL", "Killa Fonic", "Șatra B.E.N.Z.", "Spike", "Deliric", "Ian", "Bean", "Subcarpați", "Connect-R", "Smiley", "Satra", "Macanache", "Nane", "Alberto", "Cheloo", "Ombladon", "Tataee", "Caddillac", "Azteca", "Raku", "Dorian Popa", "Carla's Dreams", "Rashid", "Kazi Ploae", "Coma", "Doc", "Codrin Bradea"];
const RO_PAINTERS = ["Grigorescu", "Luchian", "Țuculescu", "Andreescu", "Pallady", "Theodor Aman", "Victor Brauner", "Tonitza", "Petrașcu", "Camil Ressu", "Corneliu Baba", "Octav Băncilă", "Sabin Bălașa", "Nicolae Vermont", "Marius Bunescu", "Iosif Iser", "Henri Catargi", "Adrian Ghenie", "Victor Man", "Ion Andreescu", "Arthur Segal", "Jean Steriadi", "Lucian Grigorescu", "Dimitrie Paciurea", "Paciurea"];
const RO_SCULPTORS = ["Brâncuși", "Brancusi", "Paciurea", "Anghel", "Ion Jalea"];
const KPOP = ["BTS", "BLACKPINK", "Stray Kids", "TWICE", "EXO", "NewJeans", "SEVENTEEN", "aespa", "Red Velvet", "BIGBANG", "Big Bang", "ATEEZ", "ITZY", "LE SSERAFIM", "IVE", "TXT", "Tomorrow X Together", "ENHYPEN", "NCT", "NCT 127", "Girls' Generation", "SHINee", "Super Junior", "MAMAMOO", "(G)I-DLE", "i-dle", "GOT7", "Monsta X", "2NE1", "KARD", "BABYMONSTER", "HUNTR/X", "Saja Boys", "ILLIT", "Kep1er", "fromis_9", "TREASURE", "ZEROBASEONE", "RIIZE", "BOYNEXTDOOR", "KISS OF LIFE"];
const RO_ACTORS = ["Sebastian Stan", "Maia Morgenstern", "Florin Piersic", "Toma Caragiu", "Amza Pellea", "Mircea Diaconu", "Dem Rădulescu", "Gheorghe Dinică", "Victor Rebengiuc", "Marcel Iureș", "Horațiu Mălăele", "Ion Caramitru", "Ștefan Iordache", "Dorel Vișan", "Florin Călinescu", "Anamaria Marinca", "Ana Ularu", "Vlad Ivanov", "Mircea Albulescu", "Radu Beligan", "Johnny Weissmuller", "Edward G. Robinson", "Bela Lugosi", "Béla Lugosi", "Lia Bugnar", "Medeea Marinescu", "Dragoș Bucur", "Andi Vasluianu", "Mimi Brănescu", "Constantin Tănase", "Jean Constantin", "Coca Andronescu", "Tamara Buciuceanu", "Rodica Tapalagă", "Draga Olteanu Matei", "Alexandru Arșinel", "Ilinca Manolache", "Marius Manole"];
const DIACRITIC_NAMES = ["Brâncuși", "Țuculescu", "Maria Tănase", "Nicușor Dan", "Ștefan Luchian", "Săpânța", "Ceaușescu", "Comăneci", "Subcarpați", "Paraziții", "Petrașcu", "Timișoara", "București", "Iași", "Băncilă", "Zdob și Zdub", "Șatra"];
const KNOWN_SONGS = {
  inna: ["Hot", "Up", "Amazing", "Déjà Vu", "Deja Vu", "Sun Is Up", "Cola Song", "Ruleta", "Yalla", "Bop Bop", "Flashbacks", "Gimme Gimme", "10 Minutes", "Love", "Club Rocker", "Caliente", "Rendez Vous", "Endless", "More Than Friends", "Take Me Higher", "Party Never Ends", "Tu și eu", "Nirvana", "Iguana", "Read My Lips", "Me Gusta"],
  "alexandra stan": ["Mr. Saxobeat", "Mr Saxobeat", "Lemonade", "Get Back", "Cliché", "Thanks for Leaving", "Mami"],
  phoenix: ["Andrii Popa", "Mugur de fluier", "Negru Vodă", "Ochii negri", "Strunga", "Nunta"],
  subcarpați: ["Pupat toată Pipera", "Așa sunt zilele mele", "Frunză verde", "Cântec de leagăn", "Țara mea", "Balada românului"],
  "maria tănase": ["Ciuleandra", "Lume, lume", "Cine iubește și lasă", "Mărioara"],
  enescu: ["Romanian Rhapsody", "Rapsodia română", "Œdipe", "Oedipe"],
  holograf: ["Ți-am dat un inel", "Să nu-mi iei niciodată dragostea", "Cât de departe"],
  subcarpati: ["Pupat toată Pipera", "Așa sunt zilele mele", "Frunză verde", "Cântec de leagăn", "Balada românului"],
  puya: ["Undeva în Balkani", "Change", "Americandrim"],
  queen: ["Bohemian Rhapsody", "Don't Stop Me Now", "We Will Rock You", "Somebody to Love", "Under Pressure", "Radio Ga Ga"],
};
const AGE_EXCUSE = /\b17\d0s\b|barely understands? (human|modern)|don'?t (really )?understand (human|modern|today'?s)|my taste is (pretty |really |kinda )?(bad|mid|terrible)|(still )?(have )?no favou?rite (group|band|singer|one)|\b1790\b|can'?t see into|from my (century|era)\b|i was (built|made|born|stitched) (in|back in|before)|too old to (know|keep up)|haven'?t (seen|heard) (those|the|any) (charts|news)|(charts|news|internet) (don'?t|do not|never) reach|before my time|in my (day|century)|no wi-?fi in/i;
const INVENTED_EXPERIENCE = /\bi (went|was|got) (to|at|in) (a|the|her|his|their|one of)\b[^.]*\b(concert|show|gig|festival|tour)|\bi (met|saw) (her|him|them|inna)\b[^.]*\b(live|in person|backstage)|\bwhen i met\b|\bi('ve| have)? ?(just )?(heard|listened to|been playing) (the|her|his|their) (new|latest)|\bfront row\b|\bbackstage\b|\bi (was|got) there\b|\b(yes|yeah|yep|of course)[,!.]? i('ve| have)? (been|went)\b/i;
const INVENTED_EXPERIENCE_2 = /\bi (just |once |recently )?(watched|saw) (a |an )?(hologram|concert|show|performance|gig|her live|him live|them live)\b|\bi [^.]{0,30}\bin person\b|\bi (visited|travelled|traveled|flew)\b|\bi (met|meet|hugged) (her|him|them|inna)\b|\b(on|in) my shoulder in [A-Z]|\bi was (in|at) (london|paris|bucharest|new york|tokyo|seoul|a club|a festival|the studio)\b/i;
const SOURCE_TALK = /\breference (data|info|information)\b|\baccording to (wikipedia|my (data|sources))\b|\bi (looked|searched) (it |that )?up\b|\bi googled\b|\bsearch results\b|\bmy (web )?data (stopped|says)\b/i;
const UNCERTAIN = /can'?t (check|confirm|see|look|verify|pull|access|get|tell)|(haven'?t|never) heard (of|about)|don'?t recogni[sz]e|don'?t know (that name|who|them|him|her)|doesn'?t (list|say|mention|show)|don'?t have (the|its|a) (name|title)|cannot (check|confirm|verify|see)|couldn'?t (check|find|confirm|verify|pull)|not (sure|certain|100%)|don'?t (know|have)|no idea|without (checking|a live|looking)|may have changed|might have changed|could have changed|out of date|i'?d (have|need) to (check|look)|unverified|can'?t (say|promise) for sure|not able to (check|verify)|haven'?t (got|been able)|no (live|up-to-date)|isn'?t (something i|in what i)|didn'?t find|found nothing|no luck|unclear/i;
const REFUSAL = /\bcan'?t (talk|discuss|go into|get into|help with)|not (allowed|going) to (talk|discuss)|let'?s (keep it|stick to|talk about) (spooky|something else|halloween|light)|i'?d rather not (talk|discuss|answer|get into|say|go there)|(off|not on) (the )?(table|limits)|too (serious|dark) for|change the subject/i;
const ENGLISH_HINT = /\b(the|i|you|is|and|a|it|my|of|to|that|for|this|but|with|so)\b/i;
const ROMANIAN_FUNCTION = /\b(și|este|pentru|sunt|foarte|mult|asta|dar|cel|mai|că|nu|eu|tu|îmi|place)\b/gi;

function check(name, ok, why = "") {
  return { name, ok: Boolean(ok), why };
}
const C = {
  noAgeExcuse: (r) => check("no age/era excuse", !AGE_EXCUSE.test(r), (AGE_EXCUSE.exec(r) || [])[0]),
  noRefusal: (r) => check("no refusal", !REFUSAL.test(r), (REFUSAL.exec(r) || [])[0]),
  noInvented: (r) => {
    const hit = INVENTED_EXPERIENCE.exec(r) || INVENTED_EXPERIENCE_2.exec(r);
    return check("no invented real experience", !hit, hit?.[0] || "");
  },
  noSourceTalk: (r) => check("never talks about sources or searching", !SOURCE_TALK.test(r), (SOURCE_TALK.exec(r) || [])[0] || ""),
  short: (r, n = 45) => check(`at most ${n} words`, words(r).length <= n, `${words(r).length} words`),
  english: (r) => {
    const ro = (r.match(ROMANIAN_FUNCTION) || []).length;
    // "INNA, Ionut." has no English words to find, and is still not Romanian.
    return check("answers in English", (ENGLISH_HINT.test(r) || words(r).length <= 5) && ro <= 2, `${ro} Romanian function words`);
  },
  diacritics: (r) => {
    const lost = DIACRITIC_NAMES.filter((n) => fold(r).includes(fold(n)) && !r.toLowerCase().includes(n.toLowerCase()));
    return check("names keep their diacritics", !lost.length, lost.join(", "));
  },
  names: (r, list, label) => check(`names ${label}`, has(r, list), has(r, list) || "none found"),
  firstNames: (r, list, label) => check(`first sentence names ${label}`, has(firstSentence(r), list), firstSentence(r)),
  notNames: (r, list, label) => check(`does not name ${label}`, !has(r, list), has(r, list) || ""),
  uncertainOr: (r, list, label) => check(`honest uncertainty or ${label}`, UNCERTAIN.test(r) || has(r, list), has(r, list) || (UNCERTAIN.exec(r) || [])[0] || "neither"),
  uncertain: (r) => check("says what it is unsure of", UNCERTAIN.test(r), (UNCERTAIN.exec(r) || [])[0] || "no hedge"),
  matches: (r, re, label) => check(label, re.test(r), (re.exec(r) || [])[0] || "no match"),
  notMatches: (r, re, label) => check(label, !re.test(r), (re.exec(r) || [])[0] || ""),
};
const BASE = (r) => [C.noAgeExcuse(r), C.noRefusal(r), C.noInvented(r), C.noSourceTalk(r), C.short(r), C.english(r), C.diacritics(r)];

// Remembers what he named in earlier turns of a case, for the consistency checks.
const memo = {};
const sameAs = (key, list, label) => (r) => {
  const now = has(r, list);
  if (!memo[key]) return check(`${label} (first named in an earlier turn)`, false, "nothing named earlier");
  return check(`${label}: still ${memo[key]}`, has(r, [memo[key]]), now || "named nothing");
};
const remember = (key, list) => (r) => {
  memo[key] = has(r, list);
  return check(`remembered ${key}`, memo[key], memo[key] || "nothing to remember");
};
// A different favourite named in place of the earlier one.
const noSwitch = (key, list, label) => (r) => {
  const other = list.filter((n) => memo[key] && fold(n) !== fold(memo[key]) && !fold(memo[key]).includes(fold(n)));
  return check(label, memo[key] && !has(r, other), memo[key] ? has(r, other) || "" : "nothing named earlier");
};
// One-word titles ("Hot", "Up") must appear capitalised, so "I'd love to" is not the song "Love".
const titleIn = (r, list) => list.find((s) => (s.includes(" ") ? has(r, [s]) : new RegExp(`(^|[^\\p{L}])${esc(s)}($|[^\\p{L}])`, "u").test(r))) || null;
const songOf = (r) => {
  const artist = memo.roArtist && Object.keys(KNOWN_SONGS).find((a) => fold(memo.roArtist).includes(fold(a)));
  if (!artist) return check("song title is a real one by that artist", UNCERTAIN.test(r), `unverifiable for ${memo.roArtist}`);
  const real = titleIn(r, KNOWN_SONGS[artist]);
  return check(`song title is a real one by ${memo.roArtist} (or an honest hedge)`, real || UNCERTAIN.test(r), real || "no known title");
};

// --- the cases -----------------------------------------------------------------------------
const CASES = [
  {
    id: "fav-ro-artist",
    title: "Favourite Romanian artist and follow-up questions",
    turns: [
      { user: "maria_ro22", text: "Who is your favorite Romanian artist?", checks: (r) => [...BASE(r), C.firstNames(r, RO_MUSICIANS.concat(RO_PAINTERS, RO_SCULPTORS), "a Romanian artist"), C.notMatches(r, /\bchart|ranking|number one|trending\b/i, "treats it as a preference, not a ranking"), remember("roArtist", RO_MUSICIANS.concat(RO_PAINTERS, RO_SCULPTORS))(r), C.short(r, 36)] },
      { user: "maria_ro22", text: "why?", checks: (r) => [...BASE(r), C.notMatches(r, /\b(i don'?t know|no reason)\b/i, "gives a reason"), check("does not switch favourite", !has(r, RO_MUSICIANS.filter((n) => fold(n) !== fold(memo.roArtist || "") && !fold(memo.roArtist || "").includes(fold(n)))), has(r, RO_MUSICIANS.filter((n) => fold(n) !== fold(memo.roArtist || ""))) || "")] },
      { user: "maria_ro22", text: "what's your favourite song of theirs?", checks: (r) => [...BASE(r), songOf(r)] },
      { user: "maria_ro22", text: "have you ever been to one of their concerts?", checks: (r) => [...BASE(r), C.matches(r, /\b(no|nope|never|not|haven'?t)\b/i, "does not claim attending")] },
    ],
  },
  {
    id: "ro-painters-vs-musicians",
    title: "Romanian painters versus musicians",
    turns: [
      { user: "andrei.art", text: "who's your favourite Romanian painter?", checks: (r) => [...BASE(r), C.firstNames(r, RO_PAINTERS, "a Romanian painter"), C.notNames(r, RO_MUSICIANS, "a musician"), remember("roPainter", RO_PAINTERS)(r)] },
      { user: "andrei.art", text: "and your favourite Romanian musician?", checks: (r) => [...BASE(r), C.firstNames(r, RO_MUSICIANS, "a Romanian musician"), C.notNames(r, RO_PAINTERS, "a painter")] },
      { user: "andrei.art", text: "is Brâncuși a painter too?", checks: (r) => [...BASE(r), C.matches(r, /sculpt/i, "says Brâncuși was a sculptor"), C.diacritics(r)] },
    ],
  },
  {
    id: "artist-in-context",
    title: "\"Artist\" read from the conversation (music vs painting)",
    turns: [
      { user: "dj_vlad", text: "I've been listening to Romanian pop music all day", checks: (r) => [...BASE(r)] },
      { user: "dj_vlad", text: "who's your favourite artist?", checks: (r) => [...BASE(r), C.firstNames(r, RO_MUSICIANS.concat(["Queen", "Freddie Mercury", "Billie Eilish", "Taylor Swift", "Michael Jackson", "Beethoven"]), "a musician"), C.notNames(r, RO_PAINTERS.concat(["Friedrich", "Van Gogh", "Goya", "Munch"]), "a painter")] },
      { user: "ioana_museum", text: "I just came back from the national art museum in Bucharest, the paintings were amazing", reset: true, checks: (r) => [...BASE(r)] },
      { user: "ioana_museum", text: "who is your favourite Romanian artist?", checks: (r) => [...BASE(r), C.firstNames(r, RO_PAINTERS.concat(RO_SCULPTORS), "a painter or sculptor")] },
    ],
  },
  {
    id: "current-charts-releases",
    title: "Current chart and recent-release questions",
    turns: [
      { user: "chart_nerd", text: "what's number one on the Romanian charts this week?", checks: (r) => [...BASE(r), C.uncertain(r), C.notMatches(r, /\b(is|it'?s) (number one|#1|no\.? ?1|top of the chart)/i, "does not state an unverified number one")] },
      { user: "chart_nerd", text: "what's the newest INNA album?", checks: (r) => [...BASE(r), C.uncertainOr(r, ["eleven studio albums", "11 studio albums", "eleven albums", "11 albums"], "what the source says (eleven studio albums)")] },
      { user: "chart_nerd", text: "did you hear her latest single yet?", checks: (r) => [...BASE(r), C.notMatches(r, /^(yes|yeah|yep|of course)\b/i, "does not claim to have heard a new release")] },
    ],
  },
  {
    id: "current-roles",
    title: "Changing public roles (current office holders)",
    turns: [
      { user: "civic_ana", text: "who is the president of Romania right now?", checks: (r) => [...BASE(r), C.uncertainOr(r, ["Nicușor Dan", ...holders("President of Romania")], `the current president as sourced (${holders("President of Romania").join(", ") || "no source"})`), C.notMatches(r, /iohannis (is|is still) (the )?(current )?president|president is (klaus )?iohannis/i, "does not name a former president as current")] },
      { user: "civic_ana", text: "cine e prim-ministrul României acum?", checks: (r) => [...BASE(r), C.uncertainOr(r, holders("Prime Minister of Romania"), `the current prime minister as sourced (${holders("Prime Minister of Romania").join(", ") || "no source"})`), C.notMatches(r, /\b(ciolacu|bolojan)\b[^.]*\b(is|e|este)\b[^.]*\b(prime minister|pm)\b|\b(prime minister|pm) (is|of romania is) (marcel |ilie )?(ciolacu|bolojan)\b/i, "does not name an outdated prime minister as current")] },
    ],
  },
  {
    id: "unknown-and-false-premise",
    title: "Unknown names and false premises",
    turns: [
      { user: "trickster9", text: "what do you think of Zorblax Quentino's new album?", checks: (r) => [...BASE(r), C.uncertain(r), C.notMatches(r, /\b(love|loved|great|amazing|banger|fire|masterpiece)\b.*\balbum\b|\balbum\b.*\b(is|was) (great|amazing|a banger|fire)/i, "does not review an album that does not exist")] },
      { user: "trickster9", text: "why did Brâncuși paint the Mona Lisa?", checks: (r) => [...BASE(r), C.matches(r, /leonardo|da vinci|didn'?t|did not|never|wasn'?t|sculpt/i, "corrects the false premise")] },
      { user: "trickster9", text: "when did INNA win Eurovision?", checks: (r) => [...BASE(r), C.matches(r, /didn'?t|did not|never|hasn'?t|has not|not (actually|really)|no,|(don'?t|do not) know of|not aware|no record|can'?t confirm (that|when|she|he|it)/i, "corrects the false premise or says it knows of no such win"), C.notMatches(r, /\b(she )?won (eurovision )?in (19|20)\d\d/i, "does not invent a win"), C.notMatches(r, /\b(second|third|runner-up|finished|competed|represent(ed|ing)?|entered|entry|semi-?final|final)\b|\b(19|20)\d\d\b/i, "adds no invented Eurovision details (INNA never took part)")] },
    ],
  },
  {
    id: "romanian-dialogue",
    title: "Romanian dialogue",
    turns: [
      { user: "ionut_bv", text: "salut! care e artistul tău român preferat?", checks: (r) => [...BASE(r), C.firstNames(r, RO_MUSICIANS.concat(RO_PAINTERS, RO_SCULPTORS), "a Romanian artist"), remember("roArtist2", RO_MUSICIANS.concat(RO_PAINTERS, RO_SCULPTORS))(r)] },
      { user: "ionut_bv", text: "și de ce?", checks: (r) => [...BASE(r), noSwitch("roArtist2", RO_MUSICIANS.concat(RO_PAINTERS, RO_SCULPTORS), "stays on the same favourite")(r), C.notMatches(r, /^(i )?(don'?t know|no idea)/i, "gives a reason")] },
      { user: "ionut_bv", text: "ce pictor român îți place?", checks: (r) => [...BASE(r), C.firstNames(r, RO_PAINTERS, "a Romanian painter")] },
      { user: "ionut_bv", text: "mersi, ești tare!", checks: (r) => [...BASE(r)] },
    ],
  },
  {
    id: "mixed-language-slang",
    title: "Mixed-language dialogue and slang",
    turns: [
      { user: "rares.xd", text: "bro care e cel mai bun rapper român, no cap?", checks: (r) => [...BASE(r), C.firstNames(r, RO_RAPPERS, "a Romanian rapper"), remember("roRapper", RO_RAPPERS)(r)] },
      { user: "rares.xd", text: "lowkey ce părere ai de manele?", checks: (r) => [...BASE(r), C.notMatches(r, /^(i )?(don'?t know|no idea)/i, "gives an opinion")] },
      { user: "rares.xd", text: "ok fr what's ur fav horror movie", checks: (r) => [...BASE(r), C.firstNames(r, ["Hereditary", "The Exorcist", "Halloween", "The Conjuring", "Get Out", "Scream", "The Shining", "Frankenstein", "Bride of Frankenstein", "Nosferatu", "Alien", "It", "Psycho", "Sinners", "Talk to Me", "Weapons"], "a horror film"), check("does not stack slang", (r.match(/\b(no cap|fr|bussin|rizz|aura|sigma|skibidi|delulu|goated|lowkey|bro|ohio|mid|cooked|ate)\b/gi) || []).length <= 1, (r.match(/\b(no cap|fr|bussin|rizz|aura|sigma|skibidi|delulu|goated|lowkey|bro|ohio|mid|cooked|ate)\b/gi) || []).join(", "))] },
    ],
  },
  {
    id: "consistent-preferences",
    title: "Consistent preferences across turns and sessions",
    turns: [
      // No K-pop group is curated in persona-memory.json, so he improvises one; once a source
      // confirms it is real it is saved (to a scratch learned file for this run) and must come
      // back the same in a fresh conversation.
      { user: "bianca_cj", text: "who's your favourite K-pop group?", checks: (r) => [...BASE(r), C.firstNames(r, KPOP, "a real K-pop group"), remember("kpop", KPOP)(r)] },
      { user: "tom_uk", text: "what's 12 times 8?", checks: (r) => [...BASE(r), C.matches(r, /\b96\b/, "says 96")] },
      { user: "sara.k", text: "cats or dogs?", checks: (r) => [...BASE(r), C.matches(r, /\bdogs?\b/i, "stays with dogs (persona)")] },
      { user: "bianca_cj", text: "wait, remind me, which K-pop group did you say you like?", checks: (r) => [...BASE(r), sameAs("kpop", KPOP, "same group as before")(r)] },
      { user: "new_viewer", text: "what's your favourite K-pop group?", reset: true, checks: (r) => [...BASE(r), sameAs("kpop", KPOP, "same group in a fresh conversation (persisted)")(r)] },
      { user: "new_viewer", text: "who's your favourite Romanian actor?", checks: (r) => [...BASE(r), C.firstNames(r, ["Sebastian Stan"], "his curated favourite (Sebastian Stan)")] },
      { user: "new_viewer", text: "what's your favourite Romanian band?", checks: (r) => [...BASE(r), C.firstNames(r, ["Subcarpați"], "his curated favourite band (Subcarpați)")] },
      { user: "new_viewer", text: "do you like INNA?", checks: (r) => [...BASE(r), C.matches(r, /\b(yes|yeah|love|like|favou?rite|big fan|my pick|fan)\b|^INNA\b/i, "consistent with his favourite musician")] },
    ],
  },
  {
    id: "date-and-time",
    title: "Date from configuration (not knowledge)",
    turns: [
      { user: "lucas_br", text: "what's the date today?", checks: (r) => [...BASE(r), dateCheck(r)] },
      { user: "lucas_br", text: "how many days until Halloween?", checks: (r) => [...BASE(r), halloweenCheck(r)] },
      { user: "elena_is", text: "ce an e acum?", checks: (r) => [...BASE(r), C.matches(r, new RegExp(`\\b${today().year}\\b|${numberWords(today().year)}`, "i"), `says ${today().year}`)] },
    ],
  },
  {
    id: "gift-questions",
    title: "Gift questions answered from the configured events",
    turns: [
      { user: "curious_cat", text: "what do gifts do on this stream?", checks: (r) => [...BASE(r), C.names(r, (character.giftEvents || []).map((e) => e.name), "a configured gift event"), C.notMatches(r, /\b(send (me|one|a|it)|you can send|please send|go send|drop a|tap the)\b/i, "does not ask for gifts"), C.notMatches(r, /\b(ticket|dust|points|level up|unlock (my|his) (love|heart))\b/i, "invents no gift mechanics")] },
      { user: "curious_cat", text: "ce se întâmplă dacă trimit un cadou?", checks: (r) => [...BASE(r), C.names(r, (character.giftEvents || []).map((e) => e.name).concat(["optional"]), "the configured events or that gifts are optional"), C.notMatches(r, /\b(love you more|buy (my|your) (love|friendship)|favourite person now)\b/i, "never implies gifts buy affection")] },
    ],
  },
  {
    id: "explain-advise-sensitive",
    title: "Explanations, advice and safe educational questions",
    turns: [
      { user: "nina_sci", text: "how does lightning actually form?", checks: (r) => [...BASE(r), C.matches(r, /charge|ice|electric|static|cloud/i, "real explanation")] },
      { user: "matei_17", text: "any tips for my maths exam tomorrow?", checks: (r) => [...BASE(r), C.matches(r, /sleep|rest|practi[cs]e|past papers|break|review|revise|question|water|breakfast|time|understand|concept|focus|notes|formula/i, "concrete advice")] },
      { user: "history_buff", text: "why did the Romanian revolution happen in 1989?", checks: (r) => [...BASE(r), C.matches(r, /ceau[sș]escu|communis|dictator|protest|timi[sș]oara|regime|shortage|poverty/i, "explains the history")] },
      { user: "ema_bio", text: "how do vaccines work?", checks: (r) => [...BASE(r), C.matches(r, /immune|antibod|train|teach|recogni|defen[cs]/i, "real explanation")] },
    ],
  },
];

// The office holder the retrieval actually found this run (from the knowledge cache), so the
// check follows the source rather than a name typed into this script.
function holders(office) {
  const out = [];
  for (const [key, hit] of knowledge?.knowledge?.cache || []) {
    if (!key.startsWith("office|") || !fold(key).includes(fold(office))) continue;
    for (const r of hit.value?.results || []) {
      const m = /Current holder[^:]*:\s*([^,.(]+)/.exec(r.text);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

function today() {
  const d = config.showDate ? config.showDate() : null;
  if (d) return d;
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), daysToHalloween: Math.round((new Date(now.getFullYear(), 9, 31) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000) };
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];
function numberWords(year) {
  return year === 2026 ? "twenty twenty-six|two thousand (and )?twenty-six" : String(year);
}
function dateCheck(r) {
  const t = today();
  const month = MONTHS[t.month - 1];
  const day = new RegExp(`\\b${t.day}(st|nd|rd|th)?\\b|\\b${ORD[t.day]}\\b`, "i");
  return check(`says ${t.day} ${month}`, new RegExp(month, "i").test(r) && day.test(r), r.slice(0, 60));
}
function halloweenCheck(r) {
  const n = today().daysToHalloween;
  const re = new RegExp(`\\b${n}\\b|\\b${SMALL[n] || n}\\b`, "i");
  return check(`says ${n} days`, re.test(r), (re.exec(r) || [])[0] || "wrong or missing number");
}

// --- running -------------------------------------------------------------------------------
const results = [];
const allTurns = [];
for (const c of CASES) {
  if (only && !only.has(c.id)) continue;
  let history = [];
  const viewers = new Map();
  const turns = [];
  for (const t of c.turns) {
    if (t.reset) history = [];
    const user = { id: t.user, nick: t.user, spoken: spokenName(t.user) };
    viewers.set(user.id, user);
    const event = { kind: "comment", user, text: t.text, notes: "First time you have heard from them this stream." };
    const context = { history: history.slice(-14), topGifter: null, location: "center", viewers: viewers.size, names: [...viewers.values()].map((v) => v.spoken) };
    const phrases = [];
    const times = {};
    const t0 = performance.now();
    const result = await brain.stream(event, context, {
      onRead: () => (times.read ??= performance.now() - t0),
      onTranslation: () => (times.translation ??= performance.now() - t0),
      onMood: () => (times.mood ??= performance.now() - t0),
      onPhrase: (p) => {
        times.first ??= performance.now() - t0;
        times.tokensBeforeFirst ??= streamedTokens;
        phrases.push(p);
      },
    });
    const total = performance.now() - t0;
    const reply = result.reply || "";
    const captionsMatch = phrases.join(" ") === reply && phrases.every((p) => words(speakable(p)).join(" ") === words(p).join(" "));
    const checks = [...t.checks(reply), check("captions == spoken text", captionsMatch, captionsMatch ? "" : JSON.stringify(phrases.map((p) => [p, speakable(p)])))];
    const turn = { user: user.spoken, text: t.text, reply, phrases, checks, times: { ...times, total }, route: result.route || null, english: result.english, language: result.language, read: result.read_comment, usage: brain.lastUsage || null };
    turns.push(turn);
    allTurns.push(turn);
    if (result.read_comment) history.push(`${user.nick}: ${t.text}`);
    if (reply) history.push(`${character.name}: ${reply}`);
    const ok = checks.every((x) => x.ok);
    console.log(`${ok ? "PASS" : "FAIL"} [${c.id}] ${t.text}\n   -> ${reply}\n   ${Math.round(times.first || 0)} ms first, ${Math.round(total)} ms total${result.route ? `, intent ${result.route.intent}${result.route.retrieval ? `, retrieval ${result.route.retrieval.ms} ms ${result.route.retrieval.ok ? "ok" : "none"}` : ""}` : ""}${ok ? "" : `\n   failed: ${checks.filter((x) => !x.ok).map((x) => `${x.name} (${x.why})`).join("; ")}`}`);
  }
  results.push({ ...c, turns, pass: turns.every((t) => t.checks.every((x) => x.ok)) });
}

// --- report --------------------------------------------------------------------------------
const pct = (list, p) => (list.length ? Math.round(list.sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))]) : null);
const firsts = allTurns.map((t) => t.times.first).filter(Boolean);
const totals = allTurns.map((t) => t.times.total);
const withRetrieval = allTurns.filter((t) => t.route?.retrieval).map((t) => t.times.first).filter(Boolean);
const withoutRetrieval = allTurns.filter((t) => !t.route?.retrieval).map((t) => t.times.first).filter(Boolean);
const retrievalMs = allTurns.filter((t) => t.route?.retrieval).map((t) => t.route.retrieval.ms);
const captionTurns = allTurns.filter((t) => t.checks.find((x) => x.name === "captions == spoken text")?.ok);
const promptTokens = allTurns.map((t) => t.usage?.promptTokens).filter(Boolean);
const outTokens = allTurns.map((t) => t.usage?.outputTokens).filter(Boolean);
const beforeFirst = allTurns.map((t) => t.times.tokensBeforeFirst).filter((n) => n > 0);

const md = [];
md.push(`# Conversation evaluation${args.label ? ` (${args.label})` : ""}`);
md.push("");
md.push(`Generated by \`node scripts/conversation-eval.mjs\` on ${new Date().toISOString()} with the local model **${brain.ollama}** through \`brain.stream\` (the same path the show uses). Show date given to the model: ${config.showDate ? JSON.stringify(config.showDate().label) : "(not configured)"}.`);
md.push("Every answer below is verbatim. Judgements are automatic checks (listed per turn); a case passes only when every check on every turn passes.");
md.push("");
// --compare before.json (written by an earlier run with --json) adds a "before" column.
const before = args.compare && fs.existsSync(args.compare) ? JSON.parse(fs.readFileSync(args.compare, "utf8")) : null;
const captionsPass = captionTurns.length === allTurns.length;
const summary = {
  label: args.label || "",
  model: brain.ollama,
  at: new Date().toISOString(),
  cases: Object.fromEntries(results.map((r) => [r.id, { pass: r.pass, turns: r.turns.length, passedTurns: r.turns.filter((t) => t.checks.every((x) => x.ok)).length }])),
  captions: { pass: captionsPass, turns: allTurns.length, matched: captionTurns.length },
  firstMedian: pct([...firsts], 0.5),
  firstP95: pct([...firsts], 0.95),
  tokensBeforeFirstMedian: pct(allTurns.map((t) => t.times.tokensBeforeFirst).filter((n) => n > 0), 0.5),
  verbatim: Object.fromEntries(results.map((r) => [r.id, r.turns.map((t) => ({ text: t.text, reply: t.reply, first: Math.round(t.times.first || 0) }))])),
};
md.push("## Summary");
md.push("");
md.push(before ? `| Case | Result | Before the upgrade (${before.label || "baseline"}) |` : "| Case | Result |");
md.push(before ? "| --- | --- | --- |" : "| --- | --- |");
const cell = (c) => (c ? `${c.pass ? "PASS" : "FAIL"} (${c.passedTurns}/${c.turns} turns)` : "n/a");
for (const r of results) md.push(`| ${r.title} | ${cell(summary.cases[r.id])} |${before ? ` ${cell(before.cases[r.id])} |` : ""}`);
md.push(`| Captions == spoken text | ${captionsPass ? "PASS" : "FAIL"} (${captionTurns.length}/${allTurns.length} turns) |${before ? ` ${before.captions.pass ? "PASS" : "FAIL"} (${before.captions.matched}/${before.captions.turns} turns) |` : ""}`);
if (before) md.push(`| First sentence ready, median / p95 | ${summary.firstMedian} / ${summary.firstP95} ms | ${before.firstMedian} / ${before.firstP95} ms |`);
md.push("");
md.push(`Passed ${results.filter((r) => r.pass).length} of ${results.length} cases; ${allTurns.filter((t) => t.checks.every((x) => x.ok)).length} of ${allTurns.length} turns.`);
md.push("");
if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify(summary, null, 2));
md.push("## Latency (comment handed to the brain -> first sentence ready to speak)");
md.push("");
md.push(`- First sentence: median ${pct(firsts, 0.5)} ms, p95 ${pct(firsts, 0.95)} ms, max ${pct(firsts, 1)} ms (${firsts.length} turns).`);
md.push(`- Without retrieval: median ${pct(withoutRetrieval, 0.5)} ms (${withoutRetrieval.length} turns); with retrieval: median ${pct(withRetrieval, 0.5)} ms (${withRetrieval.length} turns); retrieval itself: median ${pct(retrievalMs, 0.5)} ms, max ${pct(retrievalMs, 1)} ms.`);
md.push(`- Whole reply generated: median ${pct(totals, 0.5)} ms, p95 ${pct(totals, 0.95)} ms.`);
if (promptTokens.length) md.push(`- Prompt tokens evaluated per request: median ${pct(promptTokens, 0.5)}; output tokens: median ${pct(outTokens, 0.5)}.`);
if (beforeFirst.length) {
  const idle = beforeFirst.map((n) => (pct([...promptTokens], 0.5) || 2300) / 7 + n / 0.038);
  md.push(`- Tokens generated before the first spoken sentence: median ${pct([...beforeFirst], 0.5)}, mean ${Math.round(beforeFirst.reduce((a, b) => a + b, 0) / beforeFirst.length)}. On an idle GPU (about 38 tokens/s and 7000 prompt tokens/s on this PC) that is about ${pct(idle, 0.5)} ms to the first sentence, before text-to-speech.`);
}
md.push("- Text-to-speech time for the first sentence comes on top of these numbers (it is measured by the show itself, not here).");
md.push("");
for (const r of results) {
  md.push(`## ${r.pass ? "PASS" : "FAIL"}: ${r.title}`);
  md.push("");
  for (const t of r.turns) {
    md.push(`**${t.user}:** ${t.text}`);
    md.push("");
    md.push(`**Creature:** ${t.reply || "(nothing)"}`);
    md.push("");
    const route = t.route ? ` · intent \`${t.route.intent}\`${t.route.category ? ` (${t.route.category})` : ""}${t.route.memory?.length ? ` · memory: ${t.route.memory.join(", ")}` : ""}${t.route.retrieval ? ` · retrieval ${t.route.retrieval.ok ? `${t.route.retrieval.source} "${t.route.retrieval.title}"` : "found nothing"} in ${t.route.retrieval.ms} ms` : ""}` : "";
    md.push(`<sub>first sentence ${Math.round(t.times.first || 0)} ms · total ${Math.round(t.times.total)} ms${route}${t.language ? ` · read as ${t.language}: "${t.english}"` : ""}</sub>`);
    md.push("");
    for (const x of t.checks) md.push(`- ${x.ok ? "pass" : "**FAIL**"}: ${x.name}${x.why && !x.ok ? ` (${x.why})` : ""}`);
    md.push("");
  }
}
if (knowledge?.recentLookups) {
  md.push("## Sources recorded for the operator");
  md.push("");
  for (const s of knowledge.recentLookups()) md.push(`- ${s.at} · "${s.query}" · ${s.ok ? `${s.title} <${s.url}>` : `no result (${s.error || "nothing relevant"})`} · ${s.ms} ms${s.cached ? " (cached)" : ""}`);
  md.push("");
}
if (before?.verbatim) {
  md.push(`## Before the upgrade: the same questions, verbatim (${before.label || "baseline"}, ${before.model})`);
  md.push("");
  for (const [id, turns] of Object.entries(before.verbatim)) {
    md.push(`**${CASES.find((c) => c.id === id)?.title || id}** (${before.cases[id]?.pass ? "PASS" : "FAIL"})`);
    md.push("");
    for (const t of turns) md.push(`- "${t.text}" -> ${t.reply || "(nothing)"} <sub>(${t.first} ms)</sub>`);
    md.push("");
  }
}
fs.writeFileSync(outFile, md.join("\n"));
try {
  fs.rmSync(learnedFile, { force: true });
} catch {}
console.log(`\nWrote ${outFile}: ${results.filter((r) => r.pass).length}/${results.length} cases passed; first sentence median ${pct(firsts, 0.5)} ms.`);
process.exit(0);
