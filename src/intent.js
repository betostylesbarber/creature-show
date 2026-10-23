// Works out what a viewer wants before the model sees the comment: his preference, an
// explanation, a fact, current information, advice, the date, something about himself, or just
// fun. Pure local heuristics (English and Romanian, with or without diacritics, plus the usual
// code-switching), so routing costs microseconds and never delays a reply. The route decides
// which persona memory is injected, whether fresh information is worth fetching, and the one
// line of guidance the model gets about the kind of answer wanted.

import { choiceOptions } from "./offline.js";

// "Brâncuși" -> "brancusi": matching ignores case and diacritics (ş/ș and ţ/ț included).
export const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’`´]/g, "'")
    .toLowerCase();

const words = (folded) => folded.replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

// Words that are (almost) only Romanian, and common English function words.
const RO = new Set(
  "si sau cine ce cum unde cand cat cati cate este sunt esti tu eu meu mea mele mei tau tale tai preferat preferata preferatul preferati preferi place plac iti imi mai cel cea cei cele buna bune tare frate salut mersi multumesc multam foarte mult putin acum azi astazi maine ieri despre din pentru fara sa ma il parere stii stiu vreau poti poate fost faci face romanesc romaneasca pictor pictorul pictura cantaret cantareata trupa trupei melodie melodia piesa muzica manele asta acesta aceasta adica nimic ceva vorbesti intelegi ei ele noi voi lor dar deci iar inca nici chiar asa bine rau hai haide".split(" "),
);
const EN = new Set(
  "the is are you your yours u ur what whats what's who whos who's it's that's don't i'm how why when where do does did can could would should will favourite favorite fav fave best like love think know have has was were this that it its of to and for with my me i an on at about from right now today week new latest any tips please tell which or than more most really just".split(" "),
);

// { lang: "en" | "ro" | "mixed" | "other", plainEnglish } — plainEnglish is a conservative
// "certainly English" (plain ASCII, English words, no Romanian ones), used to skip the
// translation fields and save the model a dozen tokens.
export function language(text) {
  const w = words(fold(text));
  const ro = w.filter((x) => RO.has(x)).length;
  const en = w.filter((x) => EN.has(x)).length;
  const diacritics = /[ăâîșşțţ]/i.test(String(text || ""));
  let lang = "other";
  // Diacritics alone don't make a comment Romanian: "why did Brâncuși paint..." is English.
  if ((ro >= 2 || (ro >= 1 && diacritics)) && en <= 1) lang = "ro";
  else if (ro >= 1 && en >= 2) lang = "mixed";
  else if (ro >= 1 && en === 0) lang = "ro";
  else if (en >= 1 && ro === 0 && (!diacritics || en >= 2)) lang = "en";
  const ascii = /^[\x20-\x7E\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]*$/u.test(String(text || ""));
  const plainEnglish = lang === "en" && ascii && (en >= 2 || (en >= 1 && w.length <= 3));
  return { lang, plainEnglish };
}

// --- categories of things he can have a favourite of ------------------------------------
// Most specific first. `domain` groups them for reading ambiguous words from context.
const CATEGORIES = [
  ["horror film", "film", /\b(horror|scary) (movie|film|flick)s?\b|\bfilm(e|ul)? de groaza\b|\bhorror\b/],
  ["series", "film", /\b(tv )?(series|show|sitcom|anime)s?\b|\bserial(ul|e)?\b/],
  ["film", "film", /\b(movie|film|flick|cinema)s?\b|\bfilm(e|ul)?\b/],
  ["actor", "film", /\b(actor|actress|actrita|actorul)s?\b/],
  ["rapper", "music", /\b(rapper|rappers|rap|hip[- ]?hop|trap)\b/],
  ["band", "music", /\b(band|bands|group|groups|trupa|trupe|trupei|formatie|formatia)\b/],
  ["composer", "music", /\b(composer|compozitor\w*|classical (music|piece|composer))\b/],
  ["song", "music", /\b(song|songs|track|tune|banger|melodie|melodia|melodii|piesa|piese|cantec\w*|hit)\b/],
  ["album", "music", /\b(album|albums|albumul|record)\b/],
  ["musician", "music", /\b(singer|singers|musician|musicians|vocalist|dj|cantaret\w*|cantareata|solist\w*|muzician\w*|artist(ul|a)? (de )?muzica)\b/],
  ["painter", "visual", /\b(painter|painters|painting|paintings|pictor\w*|pictur\w*|tablou\w*)\b/],
  ["sculptor", "visual", /\b(sculptor|sculptors|sculpture|sculptures|statue|sculptur\w*|statui\w*)\b/],
  ["poet", "books", /\b(poet|poets|poem|poems|poetry|poezi\w*|poet(ul|a)?)\b/],
  ["writer", "books", /\b(author|authors|writer|writers|novelist|scriitor\w*|autor(ul)?)\b/],
  ["book", "books", /\b(book|books|novel|novels|carte|cartea|carti)\b/],
  ["youtuber", "internet", /\b(youtuber|streamer|tiktoker|influencer|content creator|creator de continut)s?\b/],
  ["athlete", "sport", /\b(footballer|football player|soccer player|athlete|player|gymnast|tennis player|fotbalist\w*|jucator\w*|sportiv\w*|gimnast\w*)\b/],
  ["team", "sport", /\b(team|club|echipa|echipe)\b/],
  ["sport", "sport", /\b(sport|sports|sporturi)\b/],
  ["game", "games", /\b(video ?game|game|games|joc|jocul|jocuri)\b/],
  ["dessert", "food", /\b(dessert|cake|pie|desert(ul)?|prajitur\w*)\b/],
  ["snack", "food", /\b(snack|candy|sweets|chocolate|bomboan\w*|dulciur\w*)\b/],
  ["drink", "food", /\b(drink|beverage|soda|coffee|tea|bautur\w*)\b/],
  ["food", "food", /\b(food|dish|meal|eat|cuisine|pizza|mancare|mancarea|fel de mancare|preparat\w*)\b/],
  ["city", "places", /\b(city|cities|town|oras\w*)\b/],
  // Not the Romanian verb: "îți place", "îmi place" mean "you like", "I like".
  ["place", "places", /\b((?<!\b(?:iti|imi|ii|ne|va|le|ti|mi|nu-mi|nu-ti|ti-ar|mi-ar|iti mai|imi mai)\s)place|places|country|countries|destination|loc(ul)?|tara|tari)\b/],
  ["season", "time", /\b(season|anotimp\w*)\b/],
  ["holiday", "time", /\b(holiday|holidays|sarbatoare\w*)\b/],
  ["decade", "time", /\b(decade|era|deceniu\w*)\b/],
  ["animal", "animals", /\b(animal|animals|pet|pets|animalul)\b/],
  ["colour", "colour", /\b(colou?r|colou?rs|culoare\w*)\b/],
  ["monster", "horror", /\b(monster|monsters|villain|villains|horror icon|monstru\w*)\b/],
  ["subject", "school", /\b(school subject|subject|materie|materia)\b/],
  ["word", "language", /\b(word|cuvant\w*)\b/],
];
const ARTIST = /\b(artist|artists|artistul|artista|artisti)\b/;

const DOMAIN_WORDS = {
  music: /\b(music|song|songs|singer|sing|sings|album|band|concert|pop|rap|rapper|hip hop|manele|chorus|playlist|spotify|track|dj|radio|eurovision|listen(ing)?|melodi\w*|piesa|piese|muzica|cantec\w*|trupa|cantaret\w*|asculta\w*)\b/,
  visual: /\b(paint\w*|museum|gallery|exhibition|sculpt\w*|statue|canvas|drawing|muzeu\w*|pictur\w*|pictor\w*|tablou\w*|expozitie|galerie|statui\w*)\b/,
};

// Nationalities and scenes a favourite can be "of".
const TAGS = [
  // Folded "român"/"românesc" becomes "roman"/"romanesc"; in a question about favourites that
  // means Romanian far more often than "novel".
  ["romanian", /\b(romanian|romanians|romania'?s?|roman(a|ia|iei|esc|easca|esti|ul|ca|i)?|din romania|ro)\b/],
  ["moldovan", /\b(moldovan|moldova|moldovenesc\w*)\b/],
  ["korean", /\b(korean|k-?pop|k-?drama|coreean\w*)\b/],
  ["american", /\b(american|usa|us)\b/],
  ["british", /\b(british|uk|english band|english singer)\b/],
  ["german", /\b(german|germany|german(a|ia))\b/],
  ["french", /\b(french|france|francez\w*)\b/],
  ["italian", /\b(italian|italy|italian\w*)\b/],
  ["spanish", /\b(spanish|spain|latin|spaniol\w*)\b/],
  ["japanese", /\b(japanese|japan|anime|japonez\w*)\b/],
  ["halloween", /\b(halloween|spooky|scary)\b/],
];

// --- intents --------------------------------------------------------------------------------
const ABOUT_HIM = /\b(how old (are|r) (you|u)|your (age|name|birthday|height|creator|maker)|where (are|r) (you|u) from|where do (you|u) live|(are|r) (you|u) (real|an? ai|a bot|a robot|human|alive|single|ok|okay|scared|cold|tired|lonely)|do (you|u) (sleep|eat|dream|breathe|feel|have (a )?(girlfriend|wife|bride|friends?|name|family|tiktok|heart))|who (made|built|created) (you|u)|what are (you|u)\b|who (are|r) (you|u)\b|why are (you|u) (green|so tall|here)|how tall (are|r) (you|u)|ce varsta ai|cati ani ai|cum te (cheama|numesti)|de unde esti|esti (real|om|robot)|cine (esti|te-a facut))\b/;
const DATE = /\b(what('?s| is)? (the )?(date|day)( is it| today)?|what day is (it|today)|what (day|year|month|time) it is|(today'?s|the) date|what year is it|what month is it|what time is it|is it (halloween|friday|saturday|sunday|monday|tuesday|wednesday|thursday)( today)?|how (many|long) (days |weeks )?(un)?til(l)? halloween|days (left )?(un)?til(l)? halloween|when is halloween|ce (zi|data) (e|este|avem)( azi| astazi)?|in ce zi (suntem|e)|ce an (e|este|avem)|in ce an (suntem|e)|cat e ceasul|ce ora e|cate zile (mai sunt )?pana la halloween|cand e halloween)\b/;
const CHART = /\b(charts?|chart-topping|top (10|ten|40|forty|50|100|5|five)|number (one|1)|no\.? ?1|#1|trending|viral right now|billboard|spotify top|topul|clasament\w*|pe primul loc|locul (1|unu|intai))\b/;
const LIVE_ONLY = /\b(weather|forecast|temperature outside|price of|how much (is|does|are) (a |an |the )?\w+ (cost|now|today)|exchange rate|stock price|bitcoin|crypto price|score|scores|who won (last night|yesterday|today|the game|the match)|live score|headlines|breaking news|news today|vremea|meteo|pretul|cat costa|cursul|scorul|stiri(le)? de azi)\b/;
const CURRENT = /\b(right now|currently|current|at the moment|nowadays|these days|this (week|month|year|season)|latest|newest|most recent|recently|just (released|dropped|came out)|new (album|song|single|ep|movie|film|season|episode|record|track|music|video)|(came out|dropped|released) (this|last) (week|month|year)|news|schedule|fixtures?|when is the next|next (match|game|concert|album|tour|season|episode|election)|release date|still (alive|together|the|president|king|playing|married)|acum|in prezent|momentan|actual(ul|a|mente)?|saptamana (asta|aceasta)|luna (asta|aceasta)|anul (asta|acesta)|ultimul|ultima|cel mai nou|cea mai noua|recent|stiri(le)?|program(ul)?|cand e urmatorul)\b/;
const OFFICE = /\b(president|prime minister|pm|chancellor|king|queen|pope|mayor|ceo|governor|head coach|coach|manager|captain|minister|leader|presedinte(le)?|prim[- ]?ministru(l)?|premier(ul)?|primar(ul)?|antrenor(ul)?|selectioner(ul)?|cancelar(ul)?|rege(le)?|regina|papa)\b/;
const PRESENT_WHO = /\b(who('?s| is| are)|whos|who runs|who leads|cine (e|este|conduce))\b/;
const PREF = /\b(fav(ou?rite|orite|e|s)?|faves?|favourites|favorites|do (you|u) (like|love|enjoy|prefer|rate|listen to|watch|play)|(you|u) (like|love|prefer)|would (you|u) rather|(which|what|who) (do|would) (you|u) (like|prefer|pick|choose|listen|watch)|your (top|pick|go-to|type)|best (\w+ )?(ever|of all time)|(who|what|which)('?s| is| are) (the )?(best|greatest|goat)|is (\w+ )?better|which is better|preferat\w*|preferi|iti (place|plac)|ti-ar placea|iubesti|cel mai (bun|tare|frumos|misto)|cea mai (buna|tare|frumoasa|misto)|cei mai buni)\b/;
const OPINION = /\b(what do (you|u) think (of|about)|thoughts on|your (opinion|thoughts) (on|of|about)|how do (you|u) feel about|ce parere ai (de|despre)|cum ti se pare|ce zici de)\b/;
const VIEWER_SHARES = /\b(my (fav|fave|favou?rite)|i (love|like|prefer)|preferat(ul|a) (meu|mea)|imi place)\b/;
const ADVICE = /\b(should i|shall i|any tips|tips (for|on|to)|advice|how (can|do|should) i\b(?! look)|what should i|help me|how to (get|make|stop|deal|study|learn|be|become|find|talk|ask|fix|improve|beat|win|pass)|best way to|ce sa fac|ce ar trebui|sfat\w*|ar trebui sa|cum pot|cum sa (fac|invat|trec|scap)|ma ajuti|ajuta-ma)\b/;
const EXPLAIN = /\b(why (is|are|do|does|did|was|were|can'?t|don'?t|would|does)|how (does|do|did|is|are|can|come|would)\b(?! (you|u)\b)|explain|what (is|are) (a|an|the)? ?\w+|what('?s| does) .{1,40} mean|what happens|what causes|de ce|cum functioneaza|cum merge|explica\w*|ce inseamna|ce e (un|o)|ce este (un|o)|cum se (face|formeaza))\b/;
const FACTUAL = /\b(who (was|wrote|painted|sang|sings|invented|discovered|made|directed|created|won|founded|built|is)|whos|when (did|was|is|were|will)|where (is|was|are|were|do)|which (country|city|year|team|one)|what year|how (many|much|old is|old was|tall is|far|long|big is)|capital of|cine (e|este|a fost|a scris|a pictat|a cantat|a inventat|a castigat)|cand (a|e|este|s-a)|unde (e|este|se afla)|cati|cate|in ce an|care e capitala)\b/;
const PLAYFUL = /\b(joke|make me laugh|something funny|pun|roast|rate me|lol|lmao|haha|hehe|xd|hi|hello|hey|yo|sup|hiya|salut|buna|servus|noroc|hola|ola|ciao|bonjour|gm|gn|6\s*-?\s*7|six seven|love you|ily|you'?re (cool|funny|the best|awesome|goated)|esti (tare|cel mai tare|smecher|amuzant)|bravo)\b/;

// "who is X", "what do you think of X", "have you heard of X", "cine e X", "ce părere ai de X".
const SUBJECT = /(?:who(?:'s| is| was)|whos|what do (?:you|u) think (?:of|about)|thoughts on|have (?:you|u) (?:ever )?heard (?:of|about)?|do (?:you|u) know|ever heard of|how do (?:you|u) feel about|(?:do|did) (?:you|u) (?:like|hear|listen to)|cine (?:e|este|a fost)|ce p[aă]rere ai (?:de|despre)|ce zici de|(?:[iî]l|o) [sș]tii pe|ai auzit de|[iî][tț]i place(?: de)?)\s+(.{2,60}?)\s*[?!.]*$/i;
const NOT_A_NAME = /^(you|u|me|him|her|them|it|this|that|those|these|there|he|she|we|they|everyone|anyone|someone|ur|your|yourself|my|mine|halloween|tonight|today|life|love|school|music|art|pizza|dogs?|cats?|people|humans?|chat|tiktok|the (best|worst|president|prime minister|king|queen|pope|mayor)|el|ea|asta|ala|aia|tu|eu|noi|ei)\b/i;

const STOP = new Set(
  "what whats what's who whos who's when where why how which is are was were the a an of on in at to for and or right now currently current at moment this week month year today latest newest new most recent recently just please tell me do you u know think about any can could would should will does did has have hey hi bro lol fr ngl rn pls plz yo cine ce care e este acum azi in prezent momentan ultimul ultima cel cea mai nou noua recent si sau de la din pe cu pentru frate bro stii zi spune-mi spune know's".split(" "),
);

const OFFICE_EN = [
  [/presedinte|president/, "President"],
  [/prim[- ]?ministru|premier|prime minister|\bpm\b/, "Prime Minister"],
  [/primar|mayor/, "Mayor"],
  [/cancelar|chancellor/, "Chancellor"],
  [/rege|\bking\b/, "King"],
  [/regina|\bqueen\b/, "Queen"],
  [/\bpapa\b|\bpope\b/, "Pope"],
  [/selectioner|antrenor|head coach|\bcoach\b|manager/, "Head coach"],
];
const COUNTRY_EN = [
  [/romaniei|romania|romanian|\bro\b/, "Romania"],
  [/moldovei|moldova/, "Moldova"],
  [/\b(usa|us|america|americii|united states|sua)\b/, "the United States"],
  [/\b(uk|britain|marii britanii|anglia|england|united kingdom)\b/, "the United Kingdom"],
  [/frantei|franta|france/, "France"],
  [/germaniei|germania|germany/, "Germany"],
  [/italiei|italia|italy/, "Italy"],
  [/spaniei|spania|spain/, "Spain"],
  [/ucrainei|ucraina|ukraine/, "Ukraine"],
  [/ungariei|ungaria|hungary/, "Hungary"],
];

function categoryOf(t, history) {
  for (const [name, domain, re] of CATEGORIES) if (re.test(t)) return { category: name, domain };
  if (ARTIST.test(t)) {
    // "artist" means whatever the conversation is about; in a music chat, a musician.
    const here = DOMAIN_WORDS.visual.test(t) ? "visual" : DOMAIN_WORDS.music.test(t) ? "music" : null;
    const recent = fold((history || []).slice(-6).join(" \n "));
    const visual = (recent.match(new RegExp(DOMAIN_WORDS.visual.source, "g")) || []).length;
    const music = (recent.match(new RegExp(DOMAIN_WORDS.music.source, "g")) || []).length;
    const domain = here || (visual > music ? "visual" : music > visual ? "music" : null);
    if (domain === "visual") return { category: "painter", domain, artist: "visual", fromContext: !here };
    return { category: "musician", domain: "music", artist: domain ? "music" : "assumed music", fromContext: !here && Boolean(domain) };
  }
  return { category: null, domain: null };
}

function tagsOf(t) {
  return TAGS.filter(([, re]) => re.test(t)).map(([tag]) => tag);
}

// The named person or thing a question is about, if it looks like a real name.
function subjectOf(raw) {
  const m = SUBJECT.exec(String(raw || "").trim());
  if (!m) return null;
  let s = m[1]
    // "Zorblax Quentino's new album" -> "Zorblax Quentino"; "Carla's Dreams" stays whole.
    .replace(/['’]s\s+(new|newest|latest|last|recent|old|first|best|music|songs?|albums?|single|movies?|films?|videos?|shows?|tour|concert|style|voice|lyrics)\b.*$/i, "")
    .replace(/['’]s$/i, "")
    .replace(/\b(new|latest|newest|last) (album|song|single|movie|film|ep|video|track|music)\b.*$/i, "")
    .replace(/\s+(music|songs|album|lately|now|right now|anymore|tho|though|bro|fr|acum|frate|lol)\b.*$/i, "")
    .replace(/^(the|a|an|pe|de|despre)\s+/i, "")
    .replace(/[?!.,"“”]+$/g, "")
    .trim();
  if (!s || s.split(/\s+/).length > 5 || NOT_A_NAME.test(fold(s))) return null;
  // Proper-looking: starts with a capital (or is written with diacritics) and has no small
  // linking words, so "Nicușor Dan" counts but "first president of Romania" does not.
  const proper = (/^\p{Lu}/u.test(s) || /^[\p{L}]*[^\x00-\x7F]/u.test(s)) && !/\s(of|the|in|on|for|and|de|din|al|ale)\s/i.test(` ${s} `);
  return { name: s, proper };
}

// Capitalised names in the text, skipping the first word and everyday capitals.
const COMMON_CAPS = new Set("i i'm i've i'd the creature halloween romanian romania english english, ok okay lol bro hey hi why what who how when where which is are do does did can and but so".split(" "));
function namesIn(raw) {
  const out = [];
  const re = /(?:^|[\s"“(])((?:[\p{Lu}][\p{L}'’.&-]+)(?:\s+[\p{Lu}][\p{L}'’.&-]+){0,3})/gu;
  let m;
  while ((m = re.exec(String(raw || "")))) {
    const name = m[1].replace(/['’]s$/, "");
    if (m.index === 0 && !/^[\p{Lu}]{2,}/u.test(name) && name.split(/\s+/).length === 1) continue; // sentence-initial word
    if (!COMMON_CAPS.has(fold(name))) out.push(name);
  }
  return out;
}

// The last person or work named in the recent show, for "her latest single" and "theirs".
// Viewers' own lines come first: his replies can mention other names in passing.
function recentName(history) {
  const lines = [...(history || [])].reverse().slice(0, 6);
  const his = (line) => /^(The Creature|Creature)\b[^:]{0,20}:/i.test(String(line));
  for (const line of [...lines.filter((l) => !his(l)), ...lines.filter(his)]) {
    const text = String(line).replace(/^[^:]{1,40}:\s*/, "");
    const names = namesIn(text).filter((n) => !/^(The Creature|Halloween)$/i.test(n));
    if (names.length) return names[names.length - 1];
  }
  return null;
}

function officeQuery(t) {
  const office = OFFICE_EN.find(([re]) => re.test(t))?.[1];
  if (!office) return null;
  const country = COUNTRY_EN.find(([re]) => re.test(t))?.[1];
  const of = /\bof ([a-z ]{3,30})$/.exec(t.replace(/[?!.]+$/, "").replace(/\b(right now|currently|now|today|at the moment)\b/g, "").trim());
  if (country) return `${office} of ${country}`;
  return of ? `${office} of ${of[1].trim()}` : null;
}

function keywords(raw, max = 6) {
  const list = String(raw || "")
    .replace(/https?:\/\/\S+|\S+@\S+|@\S+|\b\d{5,}\b/g, " ") // never send links, handles or long numbers
    .replace(/[^\p{L}\p{N}'’ -]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(fold(w)) && !CURRENT.test(fold(w)) && w.length > 1);
  return list.slice(0, max).join(" ");
}

// Builds the search used for fresh information: an office holder, an artist's releases, the
// chart a question is about, or the named subject; plain keywords otherwise.
function retrievalQuery(raw, t, { tags, subject, chart, history, pronoun }) {
  if (OFFICE.test(t)) {
    const q = officeQuery(t);
    if (q) return { q, kind: "office" };
  }
  if (chart) {
    const q = tags.includes("romanian") ? "Airplay 100" : tags.includes("british") ? "UK Singles Chart" : tags.includes("korean") ? "Circle Chart" : "Billboard Hot 100";
    return { q, kind: "chart" };
  }
  const release = /\b(album|albums|song|single|ep|record|track|melodie|piesa|albumul)\b/.test(t);
  const by =
    /(?:by|from|de la|lui)\s+([\p{Lu}][\p{L}\p{N}'’.&-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’.&-]*){0,3})/u.exec(raw)?.[1] ||
    /([\p{Lu}][\p{L}\p{N}'’.&-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’.&-]*){0,3})(?:'s|’s)?\s+(?:new|newest|latest|last|recent)\b/u.exec(raw)?.[1] ||
    /(?:newest|latest|new|recent|last)\s+([\p{Lu}][\p{L}\p{N}'’.&-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’.&-]*){0,3})\s+(?:album|song|single|ep|record|track)/u.exec(raw)?.[1] ||
    (pronoun ? recentName(history) : null);
  if (release && by) return { q: `${by.trim()} discography`, kind: "release", subject: by.trim() };
  if (subject?.proper) return { q: subject.name, kind: "subject", subject: subject.name };
  const names = namesIn(raw);
  // Plain keywords only help when they contain a name; "what's new lately" finds nothing useful.
  if (!names.length) return null;
  return { q: keywords(raw), kind: "keywords" };
}

// "Why did Brâncuși paint the Mona Lisa?", "when did INNA win Eurovision?": a named person and
// an event. The question's own words make a good search, and the result settles the premise.
const EVENT = /\b(win|won|wins|release[sd]?|paint(ed|s)?|wrote|write|sang|sing|play(ed)? for|join(ed)?|leave|left|marr(y|ied)|die[sd]?|born|invent(ed)?|discover(ed)?|direct(ed)?|star(red)? in|compete[sd]?|represent(ed)?|castigat|a castigat|a pictat|a scris|a cantat|a murit|s-a nascut|a jucat)\b/;

// The route for one viewer comment. `history` is the recent show ("name: text" lines), used
// to read ambiguous words ("artist") from the conversation.
// Questions about what gifts do on this stream ("what happens if I send a rose?", "ce fac
// cadourile?"): answered from the configured event list, never improvised.
const GIFT = /\b(gifts?|rose|roses|galaxy|lion|coins?|diamonds?|donat\w*|tikto?k gifts?|cadou\w*|reanimation meter|the meter|gift guide|what happens (if|when) i send|bolt spark|pumpkin whisper|haunted gate|laboratory surge|grand reanimation)\b/;
const GIFT_QUESTION = /\?|\b(what|how|which|why|when|do|does|is|are|can|ce|cum|care|cat|cate|cand)\b/;

// "have you been to one of their concerts?": things he would have had to do himself.
const EXPERIENCE = /\b(have|did|do|were) (you|u) (ever )?(been to|go to|went to|go see|see (her|him|them) live|seen (her|him|them|it) live|meet|met|attend(ed)?|visit(ed)?|travel(l?ed)? to|hear (it|her|his|their|the new)|heard (it|her|his|their|the new)|listen(ed)? to (it|her|his|their|the new)|watch(ed)? (it|the new))\b|\bai fost (la|in)\b|\bai (vazut|intalnit|cunoscut|ascultat|auzit) (concert|piesa|melodia|albumul|noul|noua|pe)\b/;
// Short follow-ups that only make sense with the previous turn: "why?", "și de ce?", "really?"
const FOLLOWUP = /^(and |si |dar |but |ok |so )?(why|why not|how come|really|for real|which one|what about (it|her|him|them)|tell me more|de ce|de ce nu|serios|pe bune|adica|cum asa|si)\s*[?!.]*$/;
const PRONOUN = /\b(her|his|their|theirs|them|she|he|they|its|ei|lui|lor)\b/;
const MATH = /\d\s*(x|×|\*|times|plus|minus|\/|÷|divided by|\+|-)\s*\d/;

export function routeComment(text, history = []) {
  const raw = String(text || "");
  const t = fold(raw).trim();
  const { lang, plainEnglish } = language(raw);
  const cat = categoryOf(t, history);
  const tags = tagsOf(t);
  const subject = subjectOf(raw);
  const pronoun = PRONOUN.test(t);
  const route = { intent: "chat", lang, plainEnglish, category: cat.category, domain: cat.domain, artist: cat.artist || null, tags, subject: subject?.name || null, pronoun, retrieve: null, liveOnly: false };

  const shares = VIEWER_SHARES.test(t) && !/\?|\b(you|u|your|ur|tau|ta|iti)\b/.test(t);
  const chart = CHART.test(t);
  const officeNow = OFFICE.test(t) && PRESENT_WHO.test(t) && !/\b(first|former|last|previous|was|were|a fost|primul|fostul)\b/.test(t);
  const choice = choiceOptions(raw);
  const pref = !shares && (PREF.test(t) || OPINION.test(t) || Boolean(choice && !MATH.test(t)));

  if (DATE.test(t)) route.intent = "date";
  else if (GIFT.test(t) && GIFT_QUESTION.test(t) && !PREF.test(t)) route.intent = "gift";
  else if (LIVE_ONLY.test(t)) {
    route.intent = "current";
    route.liveOnly = true; // nothing keyless answers live prices, weather or scores
  } else if (chart || officeNow) route.intent = "current";
  else if (FOLLOWUP.test(t)) route.intent = "followup";
  else if (EXPERIENCE.test(t) && !/\b(heard|hear) (of|about)\b/.test(t)) route.intent = "experience";
  else if (ABOUT_HIM.test(t) && !pref) route.intent = "persona";
  else if (pref) route.intent = OPINION.test(t) && subject ? "opinion" : choice && !PREF.test(t) ? "choice" : "preference";
  else if (CURRENT.test(t) && /\?|\b(what|whats|who|which|when|is|are|did|has|have|ce|cine|care|cand)\b/.test(t)) route.intent = "current";
  else if (MATH.test(t)) route.intent = "factual";
  else if (ADVICE.test(t)) route.intent = "advice";
  else if (FACTUAL.test(t) && subject?.proper && /\b(who|whos|cine)\b/.test(t)) route.intent = "factual";
  else if (EXPLAIN.test(t)) route.intent = "explanation";
  else if (FACTUAL.test(t)) route.intent = "factual";
  else if (shares) route.intent = "chat";
  else if (PLAYFUL.test(t)) route.intent = "playful";
  else if (subject && /\?/.test(raw)) route.intent = "factual";
  if (route.intent === "choice") route.options = choice;
  // "remind me, which band did you say?": the earlier pick, repeated, not a new one.
  if (route.intent === "preference" && /\b(remind me|did (you|u) say|you said|u said|what was (your|ur)|which (one )?did (you|u)|again\b|ce ziceai|ai zis|ziceai)\b/.test(t)) route.recall = true;
  if (route.intent === "date") route.dateAsk = /halloween/.test(t) ? "halloween" : /\b(year|an|anul)\b/.test(t) ? "year" : /\b(time|ceasul|ora)\b/.test(t) ? "time" : /\b(month|luna)\b/.test(t) ? "month" : /\b(day|zi|weekday)\b/.test(t) && !/\bdate|data\b/.test(t) ? "day" : "date";

  // He is being asked to name his own favourite (not told one, not asked about a named thing).
  if (route.intent === "preference") {
    const asks = /\?|\b(what|whats|who|whos|which|tell|name|care|cine|ce|ai|zi)\b/.test(t);
    const named = /\b(is|e|este) (your|ur|tau|ta) (fav\w*|preferat\w*) \S+\??$/.test(t);
    route.asksFavourite = asks && !named && !(route.subject && /\b(do|did) (you|u) (like|love|enjoy|prefer)\b|\biti place\b/.test(t));
  }

  // Fresh information is fetched only where it changes the answer: current questions, named
  // people or works the model might otherwise guess about, and named events (premise checks).
  const names = namesIn(raw);
  if (route.intent === "current" && !route.liveOnly) route.retrieve = retrievalQuery(raw, t, { tags, subject, chart, history, pronoun });
  else if (route.intent === "experience" && CURRENT.test(t)) route.retrieve = retrievalQuery(raw, t, { tags, subject, chart, history, pronoun });
  else if (subject?.proper && ["factual", "opinion", "chat"].includes(route.intent) && !EVENT.test(t)) route.retrieve = { q: subject.name, kind: "subject", subject: subject.name };
  else if (names.length && EVENT.test(t) && ["factual", "explanation", "chat"].includes(route.intent)) route.retrieve = { q: keywords(raw), kind: "premise", subject: names[0], names: names.slice(0, 2) };
  if (route.retrieve && !route.retrieve.q) route.retrieve = null;
  if (route.retrieve) route.retrieve.lang = lang === "ro" ? "ro" : "en";
  return route;
}
