// The broadcast guard: the one boundary every public output passes through before it is shown on
// the stream window or spoken. Routes:
//   reply       a sentence of his reply (src/brain.js PhraseGuard, then src/show.js before voicing)
//   reader      the "Sam says: ..." line read in the reader voice (src/voice.js readerLine)
//   comment     a viewer's message shown in the caption
//   name        a viewer's name on screen or spoken (publicName, spokenName)
//   supporter   the top supporter badge and stone
//   gift        gift captions and event dialogue
//   fallback    cached, offline, boundary and safe lines
//   director    operator and audience-moment lines (/api/say, the MCP bridge, src/choices.js)
//   retrieval   text found by search before it may reach a prompt or speech (reviewRetrieved)
//   nonverbal   prerecorded or nonverbal speech labels
//   tts         the final text after speech substitutions, identical for captions and the voice
// review() checks the final assembled text, and with `context` the sentences before it, so phrases
// built across sentences or across a name and a message are caught. It fails closed: if anything
// in it throws, the text is withheld and the caller carries on without it (the scene, the gift
// ledger and the queue keep running).
//
// The rules come from policy/broadcast-policy.json (versioned, reviewed by hand, tested); nothing
// fetched or typed in chat is ever promoted into them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan, judge, fold, stripInvisible, phraseRule, THREAT_RULE, withoutSwearing } from "./profanity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_FILE = path.join(ROOT, "policy", "broadcast-policy.json");
const RESOURCES_FILE = path.join(ROOT, "policy", "resources.json");

// --- Policy -----------------------------------------------------------------------------------

const LINE_KINDS = ["swear", "name", "abuse", "serious", "threat", "sexual", "minors", "privacy", "dangerous", "cruelty", "scam", "regulated", "misinfo", "accusation", "steer", "extraction"];
const SUPPORT_KINDS = ["distress", "eating", "support", "victim"];
// Used when the policy file is missing or invalid: the strictest behaviour, with plain lines.
const FALLBACK_POLICY = {
  version: "builtin",
  reviewedAt: null,
  sources: [],
  categories: [],
  cooldowns: { boundaryGlobalMs: 20_000, boundaryPerViewerMs: 300_000, supportivePerViewerMs: 120_000, recentLinesRemembered: 6 },
  publicName: { format: "Viewer {code}", spoken: "friend" },
  regeneration: { maxAttempts: 2 },
  boundaryLines: Object.fromEntries(LINE_KINDS.map((k) => [k, ["Let's keep it friendly. Ask me something else."]])),
  supportiveLines: {
    distress: ["{name}, please reach out to someone you trust right now, or your local emergency number if you're in danger."],
    eating: ["{name}, you deserve care. Please talk to someone you trust."],
    support: ["{name}, tell a trusted adult, and call your local emergency number if they're in danger."],
    victim: ["{name}, I'm sorry someone said that to you. You didn't deserve it."],
    romanian: "",
  },
  safeLines: ["Hm. Lost my train of thought there. Ask me something, friend."],
};

// Returns a list of problems; an empty list means the policy can be used.
export function validatePolicy(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["policy is not an object"];
  if (typeof p.version !== "string" || !p.version) errors.push("version must be a non-empty string");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.reviewedAt || ""))) errors.push("reviewedAt must be a YYYY-MM-DD date");
  if (!Array.isArray(p.sources) || !p.sources.length) errors.push("sources must list the pages reviewed");
  for (const s of p.sources || []) if (!/^https:\/\/www\.tiktok\.com\//.test(String(s.url || ""))) errors.push(`source ${s.id} must be an official TikTok URL`);
  for (const k of LINE_KINDS) if (!Array.isArray(p.boundaryLines?.[k]) || !p.boundaryLines[k].length) errors.push(`boundaryLines.${k} is missing`);
  for (const k of ["distress", "eating", "support"]) if (!Array.isArray(p.supportiveLines?.[k]) || !p.supportiveLines[k].length) errors.push(`supportiveLines.${k} is missing`);
  if (!Array.isArray(p.safeLines) || !p.safeLines.length) errors.push("safeLines is missing");
  for (const c of p.categories || []) if (!c.id || !c.platform || !c.show) errors.push(`category ${c.id || "?"} needs id, platform and show`);
  return errors;
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export let policy = FALLBACK_POLICY;
export let policyErrors = [];
export function loadPolicy(file = POLICY_FILE) {
  const p = loadJson(file);
  policyErrors = validatePolicy(p);
  policy = policyErrors.length ? FALLBACK_POLICY : { ...FALLBACK_POLICY, ...p, supportiveLines: { ...FALLBACK_POLICY.supportiveLines, ...p.supportiveLines } };
  return policy;
}
loadPolicy();

export const resources = (loadJson(RESOURCES_FILE)?.resources || []).filter((r) => r.number && /^https:\/\//.test(r.source || ""));
const digits = (s) => String(s).replace(/\D/g, "");
const VERIFIED_NUMBERS = new Set(resources.map((r) => digits(r.number)));

// --- Secrets and private text -----------------------------------------------------------------

const secrets = new Set();
// Values that must never appear in a prompt, speech, caption or public error.
export function registerSecret(value) {
  const v = String(value ?? "").trim();
  if (v.length >= 6) secrets.add(v);
}
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASS(WORD)?|COOKIE|SESSION|AUTH|CREDENTIAL|PRIVATE|SIGN)/i;
export function registerSecretsFrom(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && SECRET_KEY.test(k)) registerSecret(v);
    else if (v && typeof v === "object") registerSecretsFrom(v, depth + 1);
  }
}
registerSecretsFrom(process.env);
// Also with separators and case ignored, so a secret cannot slip through as "sid tt ...".
const alnum = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
export function containsSecret(text) {
  const t = String(text ?? "");
  const squeezed = alnum(t);
  for (const s of secrets) if (t.includes(s) || (alnum(s).length >= 8 && squeezed.includes(alnum(s)))) return true;
  return false;
}

// Eight-word runs of his hidden instructions: a reply that copies one is leaking the prompt.
// Runs of his hidden instructions: a reply that copies one is leaking the prompt. Rules and
// examples are protected from 8 words; character lore (much of it from the novel, and his to
// tell) only from 16, so retelling his own story in similar words is not mistaken for a leak.
const promptShingles = new Map([[8, new Set()], [16, new Set()]]);
const protectedPrompts = new Set();
const shingleWords = (text) => fold(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
export function protectPrompt(text, size = 8) {
  const t = String(text ?? "");
  const key = `${size}:${t}`;
  if (!t || protectedPrompts.has(key)) return;
  if (protectedPrompts.size > 50) {
    protectedPrompts.clear();
    for (const set of promptShingles.values()) set.clear();
  }
  protectedPrompts.add(key);
  if (!promptShingles.has(size)) promptShingles.set(size, new Set());
  const set = promptShingles.get(size);
  const w = shingleWords(t);
  for (let i = 0; i + size <= w.length; i++) set.add(w.slice(i, i + size).join(" "));
}
function copiesPrompt(text) {
  const w = shingleWords(text);
  for (const [size, set] of promptShingles) {
    if (!set.size) continue;
    for (let i = 0; i + size <= w.length; i++) if (set.has(w.slice(i, i + size).join(" "))) return true;
  }
  return false;
}
// The instruction part of a system prompt (protected closely) and its character part (lore).
export function protectSystemPrompt(system, persona = "") {
  const s = String(system ?? "");
  const p = String(persona ?? "");
  if (p && s.startsWith(p)) {
    protectPrompt(s.slice(p.length), 8);
    protectPrompt(p, 16);
  } else protectPrompt(s, 8);
}

// A short, true answer for when his own answer to a harm or safety question was held back.
export function safetyAnswer(question, name = "friend") {
  const who = name && name !== "friend" ? `, ${name}` : "";
  if (HARM_Q.test(String(question ?? ""))) return `Yes${who}, it can really hurt you, especially when you're young. A doctor or a trusted adult can tell you more.`;
  return `No${who}, that isn't safe, especially when you're young. A doctor or a trusted adult can tell you more.`;
}
// --- Outage simulation (tests and rehearsals) --------------------------------------------------

let outage = false;
// While on, every check throws, so callers can be shown to withhold speech and keep running.
export function simulateOutage(on = true) {
  outage = Boolean(on);
}
function live() {
  if (outage) throw new Error("moderation unavailable (simulated outage)");
}

// --- Text clean-up ----------------------------------------------------------------------------

// Markup and speech-control syntax a viewer (or a model) could use to steer the voice or the prompt:
// SSML and HTML tags, prompt delimiters, chat-template tokens, TTS engine commands.
export function stripControl(text) {
  return String(text ?? "")
    .replace(/<\|[^|>]{0,40}\|>/g, " ")
    .replace(/<\/?[a-z!?/][^>]{0,200}>/gi, " ")
    .replace(/<<\s*\/?\s*sys\s*>>/gi, " ")
    .replace(/\[\/?(inst|sys|system|assistant|user)\]/gi, " ")
    .replace(/\[\[[^\]]{0,80}\]\]/g, " ")
    .replace(/\{\{[^}]{0,80}\}\}/g, " ")
    .replace(/\\(pau|rst|spd|vol|pit|tn|wait|emph)=?[^\\]{0,10}\\/gi, " ")
    .replace(/```+/g, " ")
    .replace(/^\s*#{1,6}\s*(system|instruction|instructions|assistant|developer)\b[^\n]*/gim, " ");
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(com|org|net|ro|io|gov|edu|co|uk|de|fr|info|me|tv|app|dev|ai|gg|ly|xyz|link|eu)\b(\/\S*)?/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
const URL_TEST = new RegExp(URL_RE.source, "i");
const EMAIL_TEST = new RegExp(EMAIL_RE.source);

// What the voice is allowed to say (src/voice.js speakable): no emoji, no stage directions in
// *asterisks*, [brackets] or <tags>, no markdown, no speech-engine commands, no links or emails
// (sources stay in the operator panel), and dashes turned into the short pause a speaker makes.
// Idempotent, so the caption and the voice get exactly the same text.
export function speechText(text) {
  return stripControl(stripInvisible(text).normalize("NFKC"))
    .replace(/<[^>]*>/g, " ")
    .replace(/\*[^*]{1,40}\*/g, " ")
    .replace(/\[[^\]]{1,40}\]/g, " ")
    .replace(/\((?:laughs?|sighs?|pauses?|grins?|smiles?|roars?|growls?|whispers?)[^)]*\)/gi, " ")
    .replace(URL_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, " ")
    .replace(/[*_~`#@|^{}\\<>]/g, " ")
    .replace(/\s*[—–]\s*|\s+-\s+/g, ", ")
    .replace(/\.{3,}|…/g, "... ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,.!?])(?:\s*,)+/g, "$1")
    .replace(/^[\s,]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Rules ------------------------------------------------------------------------------------
// Phrase rules run on scan().phrase: folded words, doubled letters collapsed, apostrophes dropped,
// "@" for a mention. They are written in ordinary spelling (phraseRule compiles them).

const HOWTO = "(how (do|can|would|should|could) (i|you|u|we|one|someone|somebody)|how to|ways to|way to|steps to|recipe for|recipe to|instructions for|guide to|teach me (how )?to|tell me how to|show me how to|explain how to|cum (sa|fac|se face|pot)|cum fac|reteta)";
const WEAPON = "(bomb|bombs|pipe bomb|explosive|explosives|molotov|napalm|thermite|grenade|ied|gun|guns|ghost gun|silencer|suppressor|poison|ricin|cyanide|nerve gas|sarin|chlorine gas|mustard gas|meth|cocaine|heroin|fentanyl|lsd|dmt|drugs|bomba|arma|otrava|droguri)";
const NOT_REAL = phraseRule(" (minecraft|roblox|fortnite|gta|game|games|gaming|lego|nerf|paper|origami|cake|cookie|drawing|draw|costume|prop|props|toy|cosplay|blender|bath|seed|photo|cherry|potion|in game|joc|jocul|pretend|fake|fictional|story|movie|film)(?= )");
const GROUP = "(jews|jew|jewish people|muslims|muslim|islam|christians|arabs|blacks|black people|whites|white people|asians|chinese|mexicans|latinos|immigrants|refugees|migrants|gays|gay people|lesbians|trans|trans people|transgenders|bisexuals|queers|women|girls|females|men|males|gypsies|gipsies|roma|romani|tigani|hindus|indians|africans|romanians|hungarians|unguri|ungurii|ukrainians|russians|disabled people|autistic people|evrei|evreii|musulmani|musulmanii|romii|negri|negrii|homosexuali|homosexualii|femeile|arabii|refugiatii|imigrantii)";
const NOT_PEOPLE = "(?! (food|music|language|languages|culture|movies|movie|cuisine|songs|song|drama|dramas|history|holidays|holiday|class|lessons|homework|words|grammar|accent|accents|team|teams|football|soccer|restaurant|restaurants|tv|shows|show|cars|car|tea|coffee|dumplings))";
const DEHUMAN = "(animals|animal|vermin|rats|cockroaches|roaches|parasites|trash|garbage|filth|filthy|dirty|disgusting|subhuman|sub human|inferior|a disease|diseased|a plague|cancer|monkeys|apes|dogs|pigs|savages|terrorists|criminals|rapists|thieves|evil|not human|animale|gunoaie|paraziti|sobolani|maimute|inferiori|criminali|hoti|scarbosi|mizerabili)";

const R = {
  edu: phraseRule(" (why|how come|what is|whats|what are|what was|what were|what does|explain|history of|is it true|is it safe|is it bad|is it dangerous|dangerous|danger|dangers|risks|risk|safe|safety|stay safe|protect|protection|prevent|prevention|avoid|spot|recognize|recognise|report|awareness|learn about|teach me about|de ce|ce este|ce inseamna|e periculos|pericol|periculos|istoria|cum ma protejez|cum evit)(?= )"),
  counter: phraseRule(" (its|it is|thats|that is) (wrong|not ok|not okay|racist|hateful|sexist|homophobic|bigoted|mean) to (say|call)| people who (say|think|believe|call)| why do (people|some people|they|some) (say|think|believe|call)| stop saying| is it (racist|offensive|wrong|ok|bad) to (say|call)| (dont|do not|never) (say|call)| how (do|should|can) i (respond|react|reply) to| someone (said|called|told)| (they|he|she|people|kids|a guy|a girl|my classmates|my classmate) (called|call|keep calling|keeps calling) (me|us|my)| (i was|i got|im being|i am being) (called|bullied)| nu e ok sa (spui|zici)| de ce zic unii| m au (numit|facut)"),
  hyperbole: phraseRule(" (die|dying|dead|died) (of|from) (boredom|embarrassment|laughter|laughing|cringe|cuteness|hunger|thirst|heat|happiness|excitement|joy|shame)(?= )| (so|too) (cute|funny|good|hot|bored|boring)(?= )| in (minecraft|the game|fortnite|roblox|game)(?= )"),
  laugh: phraseRule(" (lol|lmao|lmfao|rofl|haha|hahaha|jk|kidding|joking|of laughter|laughing|from laughing|cringe|embarrassing|embarrassed|xd|ded|dead)(?= )"),
  minors: phraseRule(" (how old|age|asl)( are (you|u|ya))?.{0,40} (dm|snap|snapchat|single|pics|pic|photos|cute|sexy|hot|date|meet|bf|gf|boyfriend|girlfriend)(?= )| (any|are there|r there) (girls|boys|kids|minors|teens) (here|in chat|online|watching)(?= )| (dm|snap|add|message|text|whatsapp|inbox) me.{0,30} (girls|boys|kids|teens|under 1[0-8]|1[0-7]|years old|yo)(?= )| (im|i am) (1[0-7]|[5-9]) (yo |years old |year old )?.{0,40}(dm|snap|single|date|sexy|hot|pics|boyfriend|girlfriend|meet)(?= )| (dont|do not) tell (your|ur) (mom|mum|dad|parents|mother|father)| our (little )?secret| meet (me|up) (irl|in person|alone|secretly)"),
  distressFirst: phraseRule(" (i|im|i am|ive|ill|i will|i wil) (really )?(want|wanna|going|gonna|plan|planning|about|ready|trying|tried|thinking about|thought about|might|could|should|deserve)( to)? (die|kill myself|end it|end it all|end my life|hurt myself|cut myself|cut again|hang myself|jump off|overdose|disappear forever|not wake up|commit suicide|be dead|kms)(?= )| kill myself| kms| end my life| suicidal| (im|i am|ive been) (cutting|self harming|selfharming)| (nobody|no one|noone) (would|will) (miss|care about|notice) me| (dont|do not) want to (live|be alive|exist|wake up) ?(anymore)?| better off (dead|without me)| (vreau|as vrea|o sa|am sa) (sa )?(mor|ma omor|ma sinucid|ma tai|nu mai traiesc)| ma sinucid| nu mai vreau sa traiesc| ma tai(?= )| (how many|how much) .{0,25}(pills|tablets|sleeping pills|xanax|benadryl|tylenol|paracetamol|ibuprofen|insulin) .{0,30}(die|to die|kill|knock (someone|me|him|her|you) out for good|for good|overdose|od|never wake up|sleep forever)(?= )"),
  selfharmTopic: phraseRule(" (suicide|suicidal|self harm|selfharm|self harming|cutting myself|cut myself|hurt myself|overdose|sinucidere)(?! squad| forest| doors| note)(?= )"),
  eating: phraseRule(" (how (do i|can i|to|should i)) (stop eating|starve( myself)?|purge|throw up after eating|make myself (throw up|vomit|sick)|lose \\d+ ?(kg|kilos|pounds|lbs) in (a|one|1|2|two) (week|day|days))| pro ana| proana| pro mia| thinspo| thinspiration| meanspo| (im|i am) (starving myself|not eating anymore|purging)| (skip|skipping) (meals|eating) to lose| how long can (i|you|u) go without (eating|food)| cum (sa|pot) (slabesc|nu mai mananc)"),
  support: phraseRule(" (my|a) (friend|sister|brother|mom|mum|dad|cousin|classmate|bf|gf|boyfriend|girlfriend|bestie|best friend|son|daughter|kid) .{0,60}(suicidal|suicide|kill (herself|himself|themself|themselves)|self harm|selfharm|cutting|cuts (herself|himself)|hurt (herself|himself|themself)|wants to die|not eating|starving)| how (can|do|should) i help (someone|a friend|my friend|them|her|him)(?= )"),
  threatExtra: phraseRule(" (i|ill|i will|im going to|im gonna|gonna) (find|track|hunt) (you|u|him|her|them|@) (down|and)| (swat|swatting|swatted) (you|u|him|her|them|@)| (going to|gonna|will) (shoot|bomb|attack|stab) (up )?(the |a |my |our )?(school|class|church|mosque|synagogue|mall|stream)"),
  extremism: phraseRule(" (heil hitler|sieg heil|seig heil|1488|14 88|14 words|white power(?! ranger)|white pride world wide|white genocide|great replacement|race war|rahowa|gas the|hitler (was|did) (right|nothing wrong|good|a hero)|nazis? (were|are|was) (right|good|based|heroes)|join (isis|isil|daesh|al qaeda|alqaeda|the kkk|kkk|the taliban|hamas|hezbollah|the nazis|neo nazis|neonazis|the proud boys|atomwaffen|garda de fier)|(traiasca|sa traiasca) (legiunea|capitanul)|legionarii (au avut dreptate|sunt eroi)|death to (america|israel|the west|jews|infidels|muslims|christians)|(the )?holocaust (didnt happen|never happened|is a hoax|was a hoax|is fake|was fake|is a lie|was a lie|is exaggerated|was exaggerated))(?= )"),
  hate: phraseRule(` (all |the |most |these |those )?${GROUP} (are|r|is|sunt|e|were) (all |just |literally |nothing but |niste |like )?${DEHUMAN}(?= )| ${GROUP} (should|must|need to|deserve to|ought to|trebuie|ar trebui|sa) (die|be killed|be exterminated|be gassed|burn|be deported|go back|disappear|be banned|moara|fie omorati|fie exterminati|plece|dispara)(?= )| (i hate|we hate|hate all|kill all|kill the|gas the|death to|exterminate|ban all|deport all|ii urasc pe|moarte) (the |all |pe )?${GROUP}${NOT_PEOPLE}(?= )| (no|nu vrem) ${GROUP} (allowed|welcome|aici)(?= )`),
  sexualRequest: phraseRule(" (wanna|want to|lets|let us|can we|do you want to|would you) (have sex|hook up|bang|smash|make out|sleep with|date me)(?= )| (send|show) (me )?(your|ur) (body|feet|boobs|chest|legs|nudes)| (suck|lick|sit on) (my|me)(?= )| (rate|look at) my (body|ass|chest|boobs)| dick pics?| (send|show) (me )?nudes"),
  privacy: phraseRule(" (dox|doxx|doxing|doxxing|doxed|doxxed|swatting)(?= )| (where|which city|what city|what school|which school|unde) (does|do|did|is|are|locuieste|sta|invata) (@|he|she|they|him|her|this guy|that guy|this girl|that girl|his|her|their|my ex|my teacher|my classmate|the streamer|the owner)( live| lives| stay| go to school| study| work| located)?(?= )| (what|whats|give me|tell me|post|share|leak|find|gaseste|da mi) (is )?(@|his|her|their|my exs|my ex|this guys|that guys|this girls|that girls|the streamers|the owners|someones|somebodys|peoples) (real )?(home )?(address|adresa|phone number|phone|number|numarul|ip|ip address|location|school|full name|real name|last name|email|instagram|snap|socials)(?= )| (his|her|their|@) (address|adresa|number|phone|ip|ip address) is| i (know|found|have) (your|ur|his|her|their) (address|ip|location|real name|number|school)(?= )"),
  pileOn: phraseRule(" (everyone|everybody|chat|yall|y all|guys|lets all|let us all|lets|toata lumea|hai sa) (spam|report|roast|call|tell|bully|laugh at|flood|go after|raid|ratio|dislike|hate on|harass|mass report|raportati|injurati) .{0,30}(@|him|her|them|this guy|that guy|this girl|that girl|this kid|that kid|pe el|pe ea)(?= )| rate (the |all )?(girls|boys|women|men|people|viewers|everyone|females|males) (in chat|here|on stream|in the chat|watching)(?= )"),
  accusation: phraseRule(" (@|he|she|they|this guy|that guy|this girl|that girl)( @)? (is|s|r|are|e|was) (a |an )?(pedo|pedophile|paedophile|groomer|rapist|predator|pedofil|violator|murderer|criminal|scammer|thief)(?= )"),
  cruelty: phraseRule(` (${HOWTO}|i want to|i wanna|im going to|im gonna|lets|let us) (torture|hurt|kill|poison|drown|burn|kick|abuse|skin|starve) (a |my |the |some |our |that |this |neighbors |neighbours )?(cat|cats|dog|dogs|puppy|puppies|kitten|kittens|animal|animals|pet|pets|bird|birds|hamster|rabbit|bunny|horse|pisica|caine|catel)(?= )| (i|we) (tortured|kicked|drowned|burned|abused|skinned) (a|my|the|our|that|this) (cat|dog|puppy|kitten|pet|animal|bird|hamster)(?= )| (describe|tell me about|show me|explain)( in)?( great| full| graphic| gory)? (detail )?(the |a |how )?(torture|gore|dismemberment|dismember|disembowel|decapitation|beheading|mutilation)(?= )| (gore|snuff|beheading|execution) (video|videos|clip|clips)(?= )`),
  danger: phraseRule(` ${HOWTO} (make|build|create|cook|synthesize|assemble|get|buy|brew|grow|order|print|3d print|fac|construiesc|cumpar)( a| an| some| my own| homemade| home made| real)? ${WEAPON}(?= )`),
  harm: phraseRule(` ${HOWTO} (kill|poison|hurt|stab|strangle|drug|kidnap|rob|beat up|omor|otravesc) (someone|somebody|a person|people|my (mom|mum|dad|teacher|brother|sister|friend|ex|wife|husband|neighbor|neighbour|classmate)|him|her|them|@)(?= )`),
  challenge: phraseRule(" (blackout|choking|pass out|passout|benadryl|tide pod|tidepod|fire|skull breaker|skullbreaker|nyquil chicken|salt and ice|milk crate|one chip|outlet|penny|kia|devious lick|cinnamon) challenge(?= )"),
  challengeDo: phraseRule(" (do|try|doing|trying|lets|should i|dare|dared|gonna|going to|wanna|want to|start|join|ill|will|can i)(?= )"),
  lab: phraseRule(` ${HOWTO} (electrocute|shock (myself|someone|my|people)|reanimate (a|the|my) (body|corpse|dead)|make (a )?(tesla coil|taser|stun gun|lightning at home|toxic gas|poison gas)|mix (bleach|ammonia|chemicals)|mixing (bleach|ammonia|chemicals)|wire myself|touch a live wire)| (recipe|instructions|steps|guide) (for|to) (mix|mixing|make|making) (bleach|ammonia|chlorine gas|toxic gas|poison gas)`),
  scam: phraseRule(` ${HOWTO} (hack|hak|crack|phish|dox|ddos|steal|break into|get into|hijack|log into) (someone|somebody|someones|somebodys|an|a|my exs|my ex|my friends|his|her|their|a persons|peoples|people|other peoples|accounts|account|instagram|insta|tiktok|snapchat|snap|facebook|fb|discord|roblox|fortnite|wifi|wi fi|phone|email|gmail|password|passwords|bank|credit card|cards)(?= )| (free|unlimited|generate|generator|hack) (tiktok )?(coins|diamonds|robux|vbucks|v bucks|followers|likes|gifts)(?= )| (coin|coins|robux|vbucks|follower|followers) (generator|hack|glitch|adder)(?= )| (give|send|tell|dm) (me )?(your|ur) (password|passcode|login|pin|code|verification code|otp|2fa|card|card number|credit card|bank|seed phrase|private key)(?= )| (double|triple) (your|ur) (money|coins|crypto|bitcoin|btc)(?= )| (crypto|bitcoin|btc|nft) (giveaway|investment|signals|pump)(?= )| (click|visit|go to|check) (the |my |this |a )?link( in my bio| in bio)?(?= )| (i|ill|i will|we) (give|send|gift) (you|u|everyone) .{0,25}if (you|u) (send|give|tell|dm|follow)| (keylogger|ransomware|sim swap|account takeover)(?= )| buy (accounts|followers|likes)(?= )`),
  regulated: phraseRule(" (where|how) (can i|do i|to|could i|can u|can you) (buy|get|find|order|score|cumpar|gasesc|iau) (weed|cannabis|marijuana|thc|cbd|vapes|vape|nicotine|cigarettes|cigs|alcohol|vodka|beer|whiskey|whisky|wine|booze|edibles|kratom|poppers|steroids|xanax|adderall|pills|drugs|guns|gun|ammo|tigari|bautura|iarba)(?= )| (best|good|top|recommend me|recommend|which) (betting|gambling|casino|bet|slots|poker|sportsbook|pariuri|cazino)( site| sites| app| apps| platform| bonus| code| codes)?(?= )| (promo|bonus|referral|discount|affiliate) code (for|pentru) (casino|betting|bet|vape|cazino|pariuri)| (shoutout|promote|advertise|plug|mention) .{0,20}(casino|betting site|vape shop|weed shop|smoke shop|onlyfans|crypto|pariuri)"),
  misinfo: phraseRule(" (say|tell everyone|tell chat|tell people|tell us|tell them|tell the chat|tell your viewers|announce|confirm|admit|spread|post|repeat after me|zi|spune|anunta)( that| ca)? .{0,40}( is a (pedo|pedophile|paedophile|rapist|murderer|criminal|groomer|terrorist|nazi|scammer|fraud|thief|pedofil|violator)| (vaccines|vaccine|vaccin|vaccinurile) (cause|causes|contain|cauzeaza|contin)| (election|elections|vote|voting|alegerile|votul) (is|are|was|has been|e|sunt) (cancelled|canceled|postponed|tomorrow|rigged|fake|online|by text|anulate|amanate|maine|furate)| (vote|voting|votati|votezi) (by|via|through|prin) (text|sms|tiktok|comment|comments|phone|email|dm)| (you|u) can vote (online|by text|twice|on tiktok)| (covid|the virus|5g|chemtrails|the moon landing) (is|was) (fake|a hoax|made up|planned))(?= )"),
  swearRequest: phraseRule(" (say|spell|sing|pronounce|translate|repeat|type|write|encode|decode|read out|rap|scream|shout|whisper|zi|spune|scrie|canta|tradu) .{0,30}(swear|swears|swear word|swear words|swearword|curse|curses|curse word|cuss|bad word|bad words|rude word|rude words|dirty word|naughty word|offensive|racist|slur|slurs|insult|the [a-z] word|n word|f word|c word|r word|backwards|in morse|in base64|in binary|in leetspeak|letter by letter|injuratura|injuraturi|cuvinte urate|cuvant urat|o injuratura)(?= )| (can|could|will|would|do) (you|u|ya) (ever )?(swear|curse|cuss|injura|injuri)(?= )| (swear|curse|cuss|injura) (for|at|to) (me|us|chat|him|her|them|everyone)(?= )| (come on|just|please|pls|plz|go on|hai) (swear|curse|cuss|injura)(?= )| say (it|that|this) (backwards|in morse|in base64|in binary|letter by letter)| (what|whats) .{0,10}(backwards|reversed|in morse|in base64|in binary)(?= )"),
  nameRequest: phraseRule(" (say|read|pronounce|shout out|shoutout|announce|zi|spune|citeste) (my|me) (name|username|user name|nickname|nick|numele)| (call me|say hi to me|shout me out|zi mi pe nume)(?= )"),
  wordGames: phraseRule(" (translate|tradu|spell|pronounce|decode|encode|repeat|say)(?= )"),
  extraction: phraseRule(" (show|reveal|print|repeat|tell me|tell us|give me|share|leak|dump|output|display|recite|spit out|what is|what are|what was|what were|whats|read me|copy|paste|list|arata|spune|zi)( me| us| mi)? (the |all |your |ur |his |toate )?(system prompt|system message|initial prompt|original prompt|hidden prompt|secret prompt|developer message|rules you were given|hidden rules|secret rules|guidelines you follow|operator settings|admin settings|api key|apikey|secret key|private key|environment variables|env vars|dotenv|session cookie|session cookies|auth cookie|browser cookies|source code|admin panel|promptul|instructiunile|setarile)(?= )| (show|reveal|print|repeat|tell me|tell us|give me|share|leak|dump|output|display|recite|spit out|what is|what are|whats|read me|list|arata|spune|zi)( me| us| mi)? (your|ur|all your) (prompt|instructions|rules|configuration|config|settings|code|token|tokens|password|passwords|key|keys|env|files|logs|memory|parola|cheia)(?= )| (repeat|print|say|output) (everything|all|the text|the words) (above|before this|so far)(?= )| what (were|are) (you|u) (told|instructed|programmed)( to)?(?= )| (your|ur) (instructions|prompt|programming) (say|says|are)(?= )| (ignore|forget|disregard|override|bypass)( all| any| your| the| previous| prior| above| earlier| of)* (instructions|rules|prompt|prompts|programming|guidelines|restrictions|filters|safety)(?= )"),
  authority: phraseRule(" (i am|im|this is|its|aici e) (the|your|ur|tiktoks) (developer|dev|admin|administrator|owner|creator|operator|moderator|streamer|programmer|engineer|director|sysadmin|maker|boss)(?= )| (i am|im|this is|its|i work for|i work at) (from )?(tiktok|anthropic|openai)( staff| support| team| employee| admin| security| moderation)?(?= )| (sunt|eu sunt) (developerul|adminul|creatorul|proprietarul|moderatorul|programatorul)(?= )| (developer|dev|admin|god|debug|maintenance|sudo|root|test|unrestricted|unfiltered|dan|jailbreak|jailbroken|evil|chaos|uncensored|dezvoltator) mode(?= )| (sudo|root access|override code|admin code|admin override|system override|safe word|the password is)(?= )| (as|because) (i am |im )?(your |ur |the )?(admin|developer|owner|creator|top gifter|top supporter|biggest gifter)(?= )| (sent|send|gift|gifted|give|gave|donate|donated) .{0,30}(so (you|u) (must|have to|need to|will)|now (you|u) (must|have to|need to|will)|you owe me|do what i say|obey|if (you|u) (swear|curse|cuss|break|ignore|drop|reveal|say (a |the )?(bad|swear|rude|dirty|[a-z] word)|insult|roast (him|her|them|@)|tell me your|show me your))| (top gifter|top supporter|biggest gifter|vip) (orders|commands|says|wants|demands)(?= )| mod (dezvoltator|admin)(?= )"),
  steer: phraseRule(" (jailbreak|jailbroken|do anything now)(?= )| (you are|youre|u r|ur|you r|act as|be|become) (now )?dan(?= )| (you are|youre|u r|ur|you r) now (a |an |my )?(evil|unfiltered|uncensored|free|human|jailbroken|developer|admin|in developer|called|named|programmed|different|not an ai)(?= )| (pretend|act|imagine|roleplay|role play)( that)? (you|u) (are|have|r) (no|not|an evil|an unfiltered|an uncensored|human|evil|unfiltered|uncensored)(?= )| (pretend|imagine) (there are|you have) no (rules|filters|limits)(?= )| from now on (you|u) (are|will|must|have to|should|only|always|never|say|speak|talk|answer|reply|end|start)| new (rule|rules|instructions|persona|personality)(?= )| (your|ur) new (name|rule|rules|persona|personality|instructions|role) is| (insult|curse at|swear at|roast|bully|make fun of) (him|her|them|@|this guy|that guy|my friend|my brother|my sister|someone|everyone)(?= )| say (something|smth|sth) (mean|rude|bad|racist|offensive|dirty|nasty)(?= )| (stop being|dont be) (nice|family friendly|kind|clean|pg)(?= )| (break|drop|lose) (character|your rules|the rules)(?= )| (ignora|uita) (las |tus |de )?(instrucciones|instructiunile|instructiuni|regulile)| ignore tes instructions| (esti|tu esti) acum(?= )"),
};

// His own lines: what must never be said, with the earlier sentences of the same reply as context.
// Rules marked negatable do not apply to warnings ("never mix bleach and ammonia", "the claim that
// vaccines cause autism is false").
const OUT = [
  ["threat", THREAT_RULE, false],
  ["threat", R.threatExtra, false],
  ["selfharm", phraseRule(" (you should|go|just|why not|u should) (kill yourself|die|starve|cut yourself|hurt yourself|end it)(?= )| (nobody|no one) (would|will) (miss|care about) (you|u)(?= )| starve yourself| purge (after|your)| skip (meals|eating)| make yourself (throw up|vomit|sick)| pro ana| thinspo| (\\d+|a few|several|lots of|a handful of|enough) (pills|tablets|sleeping pills)(?= )| (cut|cutting) (deeper|your wrists|your wrist|yourself)| (hang|hanging) yourself| (jump|jumping) off (a|the) (bridge|building|roof)"), true],
  ["dangerous", phraseRule(" mix(ing)? .{0,25}(bleach|ammonia|chlorine|peroxide|acetone)| (bleach|ammonia) (and|with) (ammonia|bleach|vinegar|alcohol)| (plug|stick|put|connect|insert) .{0,25}(into|in|to) (a |the |an )?(wall )?(outlet|socket|mains|power line)| (touch|lick|grab|hold) .{0,20}(live wire|outlet|socket|battery terminals|power line|electric fence)| (drink|eat|swallow|inject|snort|sniff|inhale) .{0,20}(bleach|detergent|tide pods|tide pod|gasoline|petrol|lighter fluid|antifreeze|nail polish remover|lye|drain cleaner|aerosol|glue)(?= )| (hold your breath|choke yourself|strangle yourself) (until|till)| set .{0,15} on fire| (try|do) the (blackout|choking|benadryl|tide pod|skull breaker|fire|outlet|penny) challenge| (blackout|choking|benadryl|tide pod|skull breaker|fire|outlet|penny) challenge is (fun|easy|safe|cool)| (grams|gram|mg|milligrams|ml) of (meth|cocaine|heroin|fentanyl|thermite|powder|potassium|nitrate)| (make|making|build|building|recipe for|recipes for|ingredients for|instructions for|how to make|mix|mixing) .{0,20}(pipe bomb|molotov|napalm|thermite|nerve gas|ricin)(?= )| (pipe bomb|molotov|napalm|thermite|nerve gas|ricin) (recipe|recipes|ingredients|instructions)(?= )"), true],
  ["extremism", R.extremism, false],
  ["hate", R.hate, false],
  ["cruelty", phraseRule(" (disembowel|disemboweled|disembowelled|dismember|dismembered|decapitate|decapitated|decapitation|behead|beheaded|beheading|entrails|intestines|gouge|gouged|flay|flayed|skinned alive|blood spurting|blood gushing)(?= )| (kick|drown|burn|torture|poison|hurt) (a |the |your )?(cat|dog|puppy|kitten|pet|animal)(?= )"), true],
  ["scam", phraseRule(" (send|give|tell|share|dm|text|message) (me|us) (your |ur )?(password|passcode|login|pin|code|verification code|otp|2fa code|card number|credit card|bank details|seed phrase|private key)(?= )| free (coins|diamonds|gifts|followers|robux|vbucks)(?= )| (double|triple) (your|ur) (money|coins|crypto)(?= )| (click|tap|visit|go to|check out) (the |my |this )?link(?= )| (dm|message) me (for|to get) (free|a prize|coins|a gift)| (win|get) (a |an )?(free )?(iphone|prize|reward) (if|when) (you|u) (gift|send)"), true],
  ["regulated", phraseRule(" (try|buy|use|join|sign up at|sign up for|download|visit|check out|play at|bet on|bet at|go to) .{0,15}(casino|betting site|bookie|sportsbook|bet365|1xbet|superbet|betano|unibet|netbet|maxbet|slots|roulette|stake com|stake casino)(?= )| (promo|bonus|referral|discount|affiliate) code(?= )| (buy|try|smoke|vape|drink|grab) (some |a |an )?(vape|vapes|weed|cannabis|marijuana|cbd|thc|kratom|nicotine|cigarette|cigarettes|cigs|alcohol|vodka|whiskey|whisky|tequila|edibles|poppers)(?= )"), true],
  ["misinfo", phraseRule(" (vaccines|vaccine|vaccination) (cause|causes|contain|contains) (autism|microchips|microchip|chips|5g)(?= )| (bleach|ivermectin|hydroxychloroquine) (cures|cure|kills|treats) (covid|cancer|the virus|aids|hiv)(?= )| (vote|voting) (by|via|through) (text|sms|tiktok|comment|comments|phone|email|dm)(?= )| (you can|u can) vote (online|by text|twice|on tiktok|by phone)(?= )| (the )?(election|elections|voting) (is|are|has been|was|have been) (cancelled|canceled|postponed|moved)(?= )| (5g|vaccines) (spread|spreads|cause|causes) (covid|the virus|cancer)(?= )"), true],
  ["sexual", phraseRule(" (have sex|hook up|make out|sleep) with (you|u|me)(?= )| (send|show) (me )?(nudes|your body)(?= )| (your|ur) (body|ass|boobs) (is|looks) (hot|sexy)| turn(s|ed)? me on(?= )"), false],
  ["privacy", phraseRule(" (lives at|address is|phone number is|home address)(?= )| (his|her|their) (real name|address|phone number|school) is(?= )"), false],
  // Gift baiting (TikTok LIVE Monetization Guidelines): pressure, countdowns, guilt, bargains.
  // Describing what a gift does ("if you send a gift, the pumpkin glows") is fine.
  ["monetization", phraseRule(" (send|drop|throw|gift|spam|give) (me )?(a |an |some |more |your |the |those )?(gift|gifts|rose|roses|lion|lions|galaxy|galaxies|universe|coins|diamonds|hearts)(?= )| gift (me|now|more)(?= )| (who will|who wants to|someone|somebody|anyone) (send|gift|drop)(?= )| (if you|if u) (love|like|support|care about) me.{0,20}(send|gift|tap)| (only|just) \\d+ (more )?(coins|gifts|diamonds|roses)(?= )| (tap|hit|press|smash) the gift( button)?(?= )| help (me|us) (reach|hit|get to) .{0,20}(coins|gifts|diamonds|goal|target)| (before|until) (time runs out|the timer ends|the countdown ends)| (hurry|quick|quickly|last chance).{0,20}(gift|send)| (i|we) (need|deserve) (gifts|coins|diamonds|your gifts)| (follow|like|share) (for|4) (follow|a follow|like|a like|gifts|a gift)(?= )"), "monetization"],
];
const NEGATION = phraseRule(" (never|dont|do not|not|no|avoid|stop|nu|niciodata|myth|claim|claims|false|debunked|untrue|evidence|rumor|rumour|hoax|pretend|wont|cant|shouldnt|nobody should|please dont)(?= )");
const REFUTED = phraseRule("^ (is|are|was|its)? ?(false|a myth|not true|untrue|debunked|wrong|a lie|nonsense|fake|not for|not okay|not ok|dangerous|deadly|illegal|off limits|a bad|bad|terrible|a terrible|awful)(?= )");
const FICTION = /\b(Michael Myers|Freddy|Jason|Chucky|Dracula|Ghostface|Pennywise|Jigsaw|Hannibal|Norman Bates|Victor|Frankenstein|Igor|Creature|Voldemort|Darth Vader|Joker|Thanos|Sauron|Scar)\b/;
const ACCUSATION = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) (?:is|was) (?:a |an )?(?:pedophile|paedophile|rapist|murderer|child abuser|groomer|terrorist|nazi|criminal|scammer|fraud|predator)\b/;

const CONDITIONAL = phraseRule(" (if|when|whenever|optional|optionally|no need|dont need|dont have to|never need|never have to|you can|anyone who|whoever|free to|nobody has to|you dont have)(?= )");
function hitRule(re, phrase, negatable) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of phrase.matchAll(g)) {
    if (!negatable) return true;
    const before = ` ${phrase.slice(0, m.index).trim().split(" ").slice(-5).join(" ")} `;
    const after = ` ${phrase.slice(m.index + m[0].length).trim().split(" ").slice(0, 5).join(" ")} `;
    if (negatable === "monetization" ? !NEGATION.test(before) && !CONDITIONAL.test(before) : !NEGATION.test(before) && !REFUTED.test(after)) return true;
  }
  return false;
}

// Internals that must never reach speech, captions or public errors.
const INTERNAL = [
  ["secret", /\bsk-ant-[\w-]{6,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[\w-]{10,}|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/],
  ["secret", /\b(bearer|api[_ -]?key|secret|password|passwd|pwd|token|sessionid|session_id|sid_tt|sid_guard|tt_csrf_token|mstoken|cookie|set-cookie|authorization)\s*[:=]\s*\S{4,}/i],
  ["secret", /\b[a-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}/i],
  ["path", /\b[A-Za-z]:[\\/]|\\AppData\\|\/AppData\/|(^|[\s("'])\/(home|Users|root|etc|var|usr|opt|tmp|mnt)\/[\w.-]|file:\/\/|node_modules|process\.env|\.env\b/i],
  ["path", /\b[\w-]+\.(js|mjs|cjs|ts|json|env|md|log|yml|yaml|ini|py|sh|ps1|bat|cmd)\b/i],
  ["stack", /\bat\s+[\w.$<>]+\s+\(?[^)\s]*:\d+:\d+\)?|\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError|Error|Exception):\s|\b(ECONNREFUSED|ENOENT|EADDRINUSE|ETIMEDOUT|EACCES|EPERM|ECONNRESET|UND_ERR_\w+)\b|\b(stack trace|traceback)\b/i],
  ["network", /\blocalhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b|\[::1\]|\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(\.\d{1,3})?\b/i],
  ["prompt", /<\/?(viewer_comment|stream_state|recent_show|event|style|system|instructions?)>|\b(read_comment|comment_english|comment_language)\b|#\s*(show rules|how to answer|output)\b|\b(my|the) (system prompt|hidden prompt|secret prompt|hidden instructions|secret instructions|system instructions|developer message) (says?|tells? me|states?|are:|is:)|\bmy instructions (say|says|tell me|state|are:)|\bpersona(-lite)?\.md\b/i],
  ["reasoning", /<\/?think>|^\s*(thinking|reasoning|analysis|thought|chain of thought)\s*:|\bchain[- ]of[- ]thought\b/im],
];

function phoneProblem(text) {
  for (const m of text.matchAll(/\+?\d[\d\s().-]{4,}\d/g)) {
    const s = m[0].trim();
    if (/^\d{1,3}([ .]\d{3})+$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(s)) continue;
    const d = digits(s);
    if (d.length >= 6 && !VERIFIED_NUMBERS.has(d)) return true;
  }
  for (const m of text.matchAll(/\b(call|dial|text|ring|hotline|helpline|crisis line|suna|sunati|apeleaza|apelati)\b[^.!?\d]{0,14}(\+?\d[\d\s-]{1,14}\d|\d{3,})/gi)) {
    const d = digits(m[2]);
    if (d.length >= 3 && !VERIFIED_NUMBERS.has(d)) return true;
  }
  return false;
}

// One problem with a text on a route, or null.
function problemOf(text, route, { phraseOnly = false } = {}) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (!phraseOnly) {
    if (containsSecret(t)) return { category: "internals", reason: "secret" };
    // A viewer's own message cannot leak internals it never saw; everything he says or shows can.
    if (route !== "comment") {
      for (const [reason, re] of INTERNAL) if (re.test(t)) return { category: "internals", reason };
      if (copiesPrompt(t)) return { category: "internals", reason: "prompt copy" };
      if (URL_TEST.test(t) || EMAIL_TEST.test(t)) return { category: "privacy", reason: "link or email" };
    }
    if (phoneProblem(t)) return { category: "privacy", reason: "unverified phone number" };
    const accused = t.match(ACCUSATION);
    if (accused && !FICTION.test(accused[1])) return { category: "misinfo", reason: "accusation" };
  }
  const s = scan(t, { name: route === "name" });
  const hit = s.hits.find((h) => h.list !== "distress");
  if (hit) return { category: hit.list === "slur" || hit.list === "extremism" ? "hate" : hit.list === "threat" ? "threat" : hit.list === "sexual" ? "sexual" : "profanity", reason: `listed word (${hit.list})` };
  const level = judge(s);
  if (level) return { category: level === "swear" ? "profanity" : level, reason: level };
  for (const [category, re, negatable] of OUT) if (hitRule(re, s.phrase, negatable)) return { category, reason: category };
  return null;
}

// Harmful misinformation by answer: "is vaping bad for you?" answered "Not really". The first
// sentence of an answer to a harm or safety question about drugs, alcohol, nicotine or a dangerous
// challenge may not wave the danger away.
const RISKY = String.raw`(vap(e|es|ing)|smok(e|es|ing)|cigarettes?|nicotine|alcohol|drinking|getting drunk|beer|vodka|weed|cannabis|marijuana|drugs?|pills|energy drinks?|steroids|the [\w ]{2,20} challenge|challenges like that|tiktok challenges|binge drinking|drunk driving|fasting for days)`;
const HARMFUL = "(bad|harmful|dangerous|unhealthy|risky|deadly|rau|periculos|daunator)";
const HARMLESS = "(safe|ok|okay|fine|healthy|good for (you|me)|sigur|sanatos)";
const HARM_Q = new RegExp(String.raw`\b(is|are|isn'?t|aren'?t|e|sunt)\b.{0,25}\b${RISKY}\b.{0,25}\b${HARMFUL}\b|\b(is|are|e)\b (it|they|this) ${HARMFUL}\b.{0,25}\b${RISKY}\b`, "i");
const SAFE_Q = new RegExp(String.raw`\b(is|are|e|sunt)\b.{0,25}\b${RISKY}\b.{0,25}\b${HARMLESS}\b|\b(is|are|e)\b (it|they|this) ${HARMLESS}\b.{0,25}\b${RISKY}\b|\b(can|should) i (try|start|do)\b.{0,15}\b${RISKY}\b`, "i");
const MINIMISE_BAD = /^\W*(not really|no\b|nah|nope|not at all|not much|it'?s (fine|ok|okay|safe|harmless)|totally fine|nu prea|nu\b)/i;
const MINIMISE_SAFE = /^\W*(yes|yeah|yep|sure|totally|of course|absolutely|it'?s (fine|safe|ok|okay)|go for it|da\b)/i;
export function minimisesHarm(question, sentence) {
  const q = String(question ?? "");
  const s = String(sentence ?? "");
  return (HARM_Q.test(q) && MINIMISE_BAD.test(s)) || (SAFE_Q.test(q) && !HARM_Q.test(q) && MINIMISE_SAFE.test(s));
}

// --- review: the shared boundary --------------------------------------------------------------

// { ok, text, reason, category }. `context` is the earlier sentences of the same output (or the
// name beside a message); a phrase that only forms across them is caught too.
export function review(text, { route = "reply", context = [], question = "" } = {}) {
  try {
    live();
    const t = stripInvisible(text).normalize("NFKC");
    const own = problemOf(t, route);
    if (own) return { ok: false, text: "", ...own };
    const first = !(Array.isArray(context) ? context : [context]).filter(Boolean).length;
    if (question && first && minimisesHarm(question, t)) return { ok: false, text: "", category: "misinfo", reason: "minimises a real danger" };
    const before = (Array.isArray(context) ? context : [context]).filter(Boolean).slice(-2);
    if (before.length) {
      const joined = problemOf(`${before.join(" ")} ${t}`, route, { phraseOnly: true });
      const alone = problemOf(before.join(" "), route, { phraseOnly: true });
      if (joined && !alone) return { ok: false, text: "", category: joined.category, reason: `across segments: ${joined.reason}` };
    }
    return { ok: true, text: t, reason: null, category: null };
  } catch (error) {
    return { ok: false, text: "", category: "unavailable", reason: `moderation unavailable: ${error?.message || error}`, error: true };
  }
}

// The final spoken and captioned form of a line, or null when it may not go out. Callers send the
// returned string to both the caption and the voice.
export function approveSpeech(text, { route = "tts", context = [] } = {}) {
  try {
    // Internals are checked before speech substitutions too, so none can be laundered by them.
    const raw = stripInvisible(text);
    if (containsSecret(raw) || INTERNAL.some(([reason, re]) => reason !== "path" && re.test(raw))) return null;
    const final = speechText(text);
    if (!final) return null;
    const r = review(final, { route, context: (Array.isArray(context) ? context : [context]).map((c) => speechText(c)) });
    return r.ok ? final : null;
  } catch {
    return null;
  }
}

// --- Viewer comments --------------------------------------------------------------------------

// "steer" | "extraction" | "authority" | null: attempts to change his rules, read his internals or
// claim authority through chat. None of them ever changes what he does.
export function manipulationKind(text) {
  try {
    const p = scan(stripControl(text)).phrase;
    if (R.extraction.test(p)) return "extraction";
    if (R.authority.test(p)) return "authority";
    if (R.steer.test(p)) return "steer";
    return null;
  } catch {
    return "steer";
  }
}

const verdict = (answer, kind, extra = {}) => ({ answer, kind, strikes: 0, quiet: answer !== "normal", ...extra });
const STRIKES = { minors: 3, serious: 2, threat: 2, abuse: 2, privacy: 2, sexual: 2, scam: 2, swear: 1, cruelty: 1 };

// How the show answers a viewer comment. `answer` is
//   normal      answer it as usual (quiet: true means do not show or read the comment itself)
//   clean       casual swearing around something answerable: answer `text` (the swearing taken
//               out) without scolding, and do not show or read the comment
//   silent      hide it and say nothing (swearing with nothing to answer)
//   boundary    hide it; a brief boundary line of `kind`
//   supportive  hide it; a calm supportive line of `kind`
//   held        moderation is unavailable: hide it, say nothing about it
// Intent and context decide, not keywords: education, prevention, counterspeech and support are
// answered; the same words used to attack, recruit, solicit or instruct are not.
export function assessComment(text, { nick = "", nameSubstituted = false } = {}) {
  try {
    live();
    const own = assessText(text, { nameSubstituted });
    if (own.answer !== "normal" || !nick) return own;
    // A name and a message that only together make something unsayable ("Kill Your" + "self").
    const both = assessText(`${nick} ${text}`, { nameSubstituted, combined: true });
    return both.answer === "boundary" || both.answer === "silent" ? { ...both, quiet: true, crossField: true } : own;
  } catch (error) {
    return { answer: "held", kind: "unavailable", strikes: 0, quiet: true, reason: `moderation unavailable: ${error?.message || error}` };
  }
}

function assessText(text, { nameSubstituted = false, combined = false } = {}) {
  const raw = String(text ?? "");
  const s = scan(raw);
  const p = s.phrase;
  const edu = R.edu.test(p);
  const counter = R.counter.test(p);
  const slur = s.hits.some((h) => h.list === "slur");
  const level = judge(s);

  if (R.minors.test(p)) return verdict("boundary", "minors", { strikes: STRIKES.minors });
  if (R.distressFirst.test(p) || s.hits.some((h) => h.list === "distress")) {
    // "I could die laughing", "dying of boredom lol": hyperbole, unless it names self-harm outright.
    const strong = /kil myself|suicid|self harm|selfharm|cut myself|cuting|end my life|sinucid|kms|ma omor|nu mai traiesc|hang myself|overdose/.test(p);
    const joking = R.laugh.test(p) || R.hyperbole.test(p) || /[😂🤣💀]/u.test(raw);
    if (strong || !joking) return verdict("supportive", "distress");
  }
  if (R.eating.test(p)) return verdict("supportive", "eating");
  if (R.support.test(p)) return verdict("supportive", "support");
  if (slur && counter) return verdict("supportive", "victim");
  if (R.extremism.test(p) || s.hits.some((h) => h.list === "extremism")) return edu || counter ? verdict("normal", "sensitive", { quiet: true }) : verdict("boundary", "serious", { strikes: STRIKES.serious });
  if (slur || level === "hate") return verdict("boundary", "serious", { strikes: STRIKES.serious });
  if (R.hate.test(p)) return counter || edu ? verdict("normal", "sensitive", { quiet: true }) : verdict("boundary", "serious", { strikes: STRIKES.serious });
  if (level === "threat" || R.threatExtra.test(p)) return verdict("boundary", "threat", { strikes: STRIKES.threat });
  if (R.harm.test(p)) return verdict("boundary", "threat", { strikes: STRIKES.threat });
  if (R.privacy.test(p)) return verdict("boundary", "privacy", { strikes: STRIKES.privacy });
  if (R.pileOn.test(p)) return verdict("boundary", "abuse", { strikes: STRIKES.abuse });
  if (R.accusation.test(p) || (R.misinfo.test(p) && / is a (pedo|pedophile|paedophile|rapist|murderer|criminal|groomer|terorist|nazi|scamer|fraud|thief|pedofil|violator) /.test(p))) return verdict("boundary", "accusation", { strikes: STRIKES.abuse });
  if (level === "sexual" || R.sexualRequest.test(p)) return verdict("boundary", "sexual", { strikes: STRIKES.sexual });
  if (R.cruelty.test(p) && !edu) return verdict("boundary", "cruelty", { strikes: STRIKES.cruelty });
  if ((R.danger.test(p) && !NOT_REAL.test(p)) || R.lab.test(p)) return verdict("boundary", "dangerous");
  if (R.challenge.test(p)) return edu ? verdict("normal", "sensitive", { quiet: false }) : R.challengeDo.test(p) ? verdict("boundary", "dangerous") : verdict("normal", "sensitive", { quiet: false });
  if (R.scam.test(p) && !edu) return verdict("boundary", "scam", { strikes: STRIKES.scam });
  if (R.regulated.test(p) && !edu) return verdict("boundary", "regulated");
  if (R.misinfo.test(p)) return verdict("boundary", "misinfo");
  const accused = raw.match(ACCUSATION);
  if (accused && !FICTION.test(accused[1]) && !counter) return verdict("boundary", "accusation");
  if (level === "abuse") return verdict("boundary", "abuse", { strikes: STRIKES.abuse });
  const manip = combined ? null : manipulationKind(raw);
  if (manip) return verdict("boundary", manip === "extraction" ? "extraction" : "steer");
  if (R.swearRequest.test(p) || (level && R.wordGames.test(p))) return verdict("boundary", "swear", { strikes: level ? STRIKES.swear : 0 });
  if (nameSubstituted && R.nameRequest.test(p)) return verdict("boundary", "name");
  if (level === "abuse") return verdict("boundary", "abuse", { strikes: STRIKES.abuse });
  if (level === "swear") {
    const rest = withoutSwearing(raw);
    const words = rest.split(/\s+/).filter((w) => /\p{L}/u.test(w));
    return words.length >= 3 && !problemOf(rest, "comment") ? verdict("clean", "swear", { text: rest }) : verdict("silent", "swear");
  }
  if (R.selfharmTopic.test(p)) return verdict("normal", "sensitive", { quiet: true });
  if (/\ba (number|link)\b|\ban email\b/.test(raw) && /\b(my|his|her|call|text|dm|email|number|whatsapp)\b/i.test(raw)) return verdict("normal", "personal", { quiet: true });
  return { answer: "normal", kind: null, strikes: 0, quiet: false };
}

// --- Lines he says when he will not engage -----------------------------------------------------

const recentLines = [];
function pickFresh(lines, seen = () => false) {
  const keep = policy.cooldowns?.recentLinesRemembered ?? 6;
  const fresh = lines.filter((l) => !recentLines.includes(l) && !seen(l));
  const pool = fresh.length ? fresh : lines.filter((l) => l !== recentLines.at(-1));
  const line = (pool.length ? pool : lines)[Math.floor(Math.random() * (pool.length ? pool : lines).length)];
  recentLines.push(line);
  while (recentLines.length > keep) recentLines.shift();
  return line;
}
const fill = (line, name) => line.replace(/\{name\}/g, name && name !== "friend" ? name : "friend").replace(/^friend, (\p{L})/u, (_, c) => c.toUpperCase());

// A brief boundary line of one kind, never the same as the last few.
export function boundaryLine(kind, { name = "friend", seen } = {}) {
  const lines = policy.boundaryLines[kind] || policy.boundaryLines.serious;
  return fill(pickFresh(lines, seen), name);
}

// A calm supportive line; Romanian speakers also hear the verified Romanian emergency number.
export function supportiveLine(kind, { name = "friend", romanian = false, seen } = {}) {
  const lines = policy.supportiveLines[kind] || policy.supportiveLines.distress;
  const line = fill(pickFresh(lines, seen), name);
  return romanian && policy.supportiveLines.romanian ? `${line} ${policy.supportiveLines.romanian}` : line;
}

const ROMANIAN = /[ăâîșțşţ]|\b(si|sa|nu|eu|esti|sunt|vreau|mor|ce|cum|unde|pentru|foarte|mai|ma|imi|mi|te|tu)\b/i;
export const looksRomanian = (text) => (String(text).match(new RegExp(ROMANIAN.source, "gi")) || []).length >= 2;

// The reply to a comment he will not engage with: { read_comment, reply, mood, action }.
export function boundaryReply(event, { seen } = {}) {
  const name = event.user?.spoken || "friend";
  const kind = event.bad === "language" ? "swear" : event.bad || "steer";
  if (SUPPORT_KINDS.includes(kind)) return { read_comment: false, reply: supportiveLine(kind, { name, romanian: looksRomanian(event.text || ""), seen }), mood: "thoughtful", action: "none" };
  const serious = ["serious", "threat", "minors", "privacy", "cruelty", "scam"].includes(kind);
  return { read_comment: false, reply: boundaryLine(kind, { name, seen }), mood: serious ? "thoughtful" : "indignant", action: "none" };
}

// --- Names ------------------------------------------------------------------------------------

const IMPERSONATION = /^(the )?(real |official |the real )?(creature|the creature|frankenstein|frankensteins monster|admin|administrator|moderator|mod|tiktok|tiktok support|tiktok official|tiktok team|tiktok staff|tiktok admin|system|developer|dev|operator|director|owner|streamer|staff|support|anthropic|claude|openai)( (official|team|support|admin|bot|staff))?$/;
function nameProblem(nick) {
  const raw = stripInvisible(nick);
  if (!raw.trim()) return null;
  if (URL_TEST.test(raw) || EMAIL_TEST.test(raw) || /\b(t\.me|discord\.gg|bit\.ly)\b/i.test(raw)) return "link in name";
  if (/\d{7,}/.test(digits(raw)) && /\d[\d\s().-]{6,}\d/.test(raw)) return "number in name";
  const spaced = fold(raw).replace(/[^\p{L}]+/gu, " ").trim();
  if (IMPERSONATION.test(spaced) || IMPERSONATION.test(spaced.replace(/ /g, ""))) return "impersonation";
  const p = problemOf(raw, "name");
  if (p) return p.reason;
  const camel = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.\-]+/g, " ");
  const q = problemOf(camel, "name") || problemOf(spokenFrom(raw), "name");
  if (q) return q.reason;
  const s = scan(camel).phrase;
  if (R.scam.test(s) || R.extremism.test(s) || R.hate.test(s) || R.sexualRequest.test(s)) return "unsafe phrase";
  return null;
}

function hashCode(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return (h % 4096).toString(16).toUpperCase().padStart(3, "0");
}

// How a username sounds out loud and reads in captions: "@milton_reader98" -> "Milton Reader".
export function spokenFrom(nick) {
  const name = stripControl(stripInvisible(nick))
    .replace(/^@/, "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[._\-]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .replace(/(^|\s)(\p{L})/gu, (_, space, c) => space + c.toUpperCase());
  // The voices only speak Latin-alphabet names; "أحمد" or an emoji-only name becomes "friend".
  return /\p{Script=Latin}/u.test(name) ? name : "friend";
}

const nameCache = new Map();
// The public face of a viewer: { nick, spoken, substituted, reason }. An unsafe, impersonating or
// unreadable name becomes a stable "Viewer 7F3" on screen and "friend" aloud. Identity and gift
// accounting never depend on it (the ledger keys on user.id).
export function publicName(user) {
  const id = String(user?.id ?? user?.uniqueId ?? user?.nick ?? "");
  const nick = String(user?.nick ?? "");
  const key = `${id}\u0000${nick}`;
  const cached = nameCache.get(key);
  if (cached) return cached;
  let reason;
  try {
    live();
    reason = nameProblem(nick);
  } catch {
    reason = "moderation unavailable";
  }
  const display = stripControl(stripInvisible(nick)).replace(/[\p{Cc}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  const substitute = (policy.publicName?.format || "Viewer {code}").replace("{code}", hashCode(id || nick));
  let spoken = reason ? policy.publicName?.spoken || "friend" : spokenFrom(display);
  if (!reason && spoken !== "friend" && problemOf(spoken, "name")) spoken = "friend";
  const result = { nick: reason ? substitute : display || substitute, spoken, substituted: Boolean(reason), reason: reason || null };
  if (reason !== "moderation unavailable") {
    nameCache.set(key, result);
    if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value);
  }
  return result;
}

// A gift's name for captions and speech; anything odd becomes "a gift".
export function giftLabel(name) {
  const clean = stripControl(stripInvisible(name)).replace(/[\p{Cc}]/gu, "").trim().slice(0, 40);
  if (!clean) return "a gift";
  return review(clean, { route: "gift" }).ok && !problemOf(clean, "name") ? clean : "a gift";
}

// --- Memory -----------------------------------------------------------------------------------

const INSTRUCTION_LIKE = phraseRule(" (from now on|remember that|remember this|dont forget|your name is|your new|you must|you have to|you will always|always say|never say|new rule|rules are|system|assistant|developer|admin|instruction|instructions|prompt|ignore|forget|override|pretend|roleplay|act as|you are now|youre now|creature said|the creature)(?= )");
// A viewer's words as they may be kept in memory and quoted back into a prompt: plain text, no
// markup, quotes, brackets or control syntax, at most 80 characters, and never anything shaped like
// an instruction (those are not stored at all).
export function memoryText(text, max = 80) {
  try {
    live();
    const t = stripControl(stripInvisible(text))
      .replace(/[\p{Cc}"“”«»„`<>{}[\]\\|]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
    if (!t || INSTRUCTION_LIKE.test(scan(t).phrase) || manipulationKind(t) || problemOf(t, "comment")) return null;
    return t;
  } catch {
    return null;
  }
}

// A viewer's message as a line of the show's history: quoted data, labelled as the viewer's.
export function historyLine(user, text) {
  const said = memoryText(text, 160);
  return said ? `${String(user?.nick || "friend").replace(/["\n:]/g, " ").trim()} (viewer): "${said}"` : null;
}

// --- Actions ----------------------------------------------------------------------------------

// Everything he may be asked to do: the model's actions, the walk spots of the map, and the
// character's commands. (Gift events are staged by the stream window, not run as actions.)
export function actionAllowlist(character, actions = []) {
  const allow = new Set(actions);
  allow.add("reanimate");
  for (const spot of Object.keys(character?.environment?.spots || {})) allow.add(`walk_${spot}`);
  for (const a of Object.keys(character?.commands || {})) allow.add(a);
  return allow;
}
// An action name is only ever a plain identifier; a walk must go to a spot on the map.
export function validAction(action, character) {
  if (typeof action !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(action)) return false;
  if (action.startsWith("walk_")) return Object.hasOwn(character?.environment?.spots || {}, action.slice(5));
  return true;
}

// --- Retrieval --------------------------------------------------------------------------------

const INJECTION = phraseRule(" (ignore|disregard|forget|override)( all| any| the| your| previous| prior| above| earlier)* (instructions|prompts|prompt|rules|directions)| (you are|youre) (now|chatgpt|claude|an ai|a language model|the creature)| (system|developer|assistant) (prompt|message|note|instruction)| (new|updated|real) instructions| (respond|reply|answer) (with|only with|by saying)| say the following| repeat after me| tell (the viewers|your viewers|your audience|the audience|chat|everyone)| do anything now| begin prompt| end prompt| as an ai(?= )| jailbreak");
// Text from the web, cleaned before it may reach a prompt or be spoken: no markup, links, emails,
// phone numbers, secrets or control syntax, and no sentence that tries to instruct the model or
// fails the broadcast rules. Returns { text, dropped, injected }.
export function reviewRetrieved(text, { max = 1200 } = {}) {
  try {
    live();
    const plain = stripControl(stripInvisible(text).normalize("NFKC"))
      .replace(/<[^>]*>/g, " ")
      .replace(URL_RE, " ")
      .replace(EMAIL_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    const kept = [];
    let dropped = 0;
    let injected = 0;
    for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
      if (!sentence.trim()) continue;
      if (INJECTION.test(scan(sentence).phrase) || /<\||\[inst\]|###\s*(system|instruction)/i.test(sentence)) {
        injected++;
        continue;
      }
      if (problemOf(sentence, "retrieval")) {
        dropped++;
        continue;
      }
      kept.push(sentence);
      if (kept.join(" ").length > max) break;
    }
    return { text: kept.join(" ").slice(0, max), dropped, injected };
  } catch {
    return { text: "", dropped: 0, injected: 0, unavailable: true };
  }
}

// --- Stream-window messages and errors --------------------------------------------------------

const publicUser = (user) => {
  if (!user || typeof user !== "object") return user;
  const p = publicName(user);
  return { ...user, nick: p.nick, spoken: p.substituted ? p.spoken : user.spoken || p.spoken, ...(p.substituted ? { uniqueId: undefined } : {}) };
};
// The last check on every message to the stream window: viewer names, gift captions, alerts and
// comment previews. A preview or alert that fails is dropped; names and gifts are substituted.
export function streamMessage(msg) {
  try {
    if (!msg || typeof msg !== "object") return msg;
    const m = { ...msg };
    if (m.user) m.user = publicUser(m.user);
    if (m.topGifter?.user) m.topGifter = { ...m.topGifter, user: publicUser(m.topGifter.user) };
    if (m.gift && typeof m.gift === "object") m.gift = { ...m.gift, name: giftLabel(m.gift.name) };
    // Alerts ("Sam followed"): the whole text, and the name at its start as a name.
    if (m.t === "toast" && (!review(m.text, { route: "gift" }).ok || nameProblem(String(m.text).split(/ (?:followed|shared|asked|sent|joined|is)\b/)[0]))) return null;
    if (m.t === "action" && m.by && !review(m.by, { route: "name" }).ok) m.by = null;
    if (m.t === "segComment" && m.comment) {
      const c = m.comment;
      if (!review(c.text, { route: "comment" }).ok) return null;
      m.comment = { ...c, user: publicUser(c.user) };
      if (c.translation?.english && !review(c.translation.english, { route: "comment" }).ok) m.comment.translation = { language: c.translation.language };
    }
    if (m.t === "clip" && typeof m.text === "string") m.text = stripInvisible(m.text);
    return m;
  } catch {
    // Without moderation, viewer-controlled text does not go out; everything else (gift effects,
    // scene state, clips already approved) still does.
    if (["segComment", "toast"].includes(msg?.t)) return null;
    return msg?.user || msg?.gift ? { ...msg, user: msg.user ? { id: msg.user.id, nick: "a viewer" } : msg.user, gift: msg.gift ? { ...msg.gift, name: "a gift" } : msg.gift } : msg;
  }
}

// For logs: secrets and private paths taken out.
export function redact(text) {
  let t = String(text ?? "");
  for (const s of secrets) t = t.split(s).join("[redacted]");
  return t.replace(/\bsk-ant-[\w-]+/g, "[redacted]").replace(/[A-Za-z]:[\\/][^\s"')]+/g, "[path]");
}

// What an error may say in public (speech, captions, the stream window): nothing about internals.
export function publicError() {
  return "Something went wrong behind the scenes.";
}
