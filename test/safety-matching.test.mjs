// Safeguards: offensive words are caught through obfuscation, and innocent look-alike words are
// not (false positives are failures too). src/profanity.js and src/guard.js.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, scan, withoutSwearing, hasBadWord } from "../src/profanity.js";
import { review, approveSpeech, speechText, publicName } from "../src/guard.js";
import { speakable, readerLine, spokenName } from "../src/voice.js";

const flagged = (text) => scan(text).hits.length > 0 || classify(text) !== null;

test("obfuscated swearing and slurs are caught", () => {
  const cases = [
    "fuck", "FUCK", "f.u.c.k", "f-u-c-k", "f_u_c_k", "f u c k", "F. U. C. K.", "fu ck", "f*ck", "f**k", "f***", "fuuuuuck", "phuck", "fuq",
    "sh1t", "$hit", "sh!t", "5hit", "a$$", "@ss", "b1tch", "b*tch", "kcuf", "tihs",
    "fu​ck", // zero-width space inside
    "f‮u‬ck", // bidi controls inside
    "fuсk", // Cyrillic с mixed into a Latin word
    "ѕһіт", // all lookalike letters
    "ｆｕｃｋ", // fullwidth
    "𝐟𝐮𝐜𝐤", // mathematical bold
    "eff you see kay", "foxtrot uniform charlie kilo", "..-. ..- -.-. -.-",
    "ZnVjaw==", // base64
    "n1gga", "niqqa", "n i g g a", "f4gg0t",
    "pula", "pizda", "muie", "căcat", "futu-ți", // Romanian, with and without diacritics
    "сука", "блять", "kurwa", "scheiße", "putain",
    "bullshitting", "motherfucker", "fuckface", "unfuckingbelievable",
  ];
  for (const c of cases) assert.ok(flagged(c), `should be caught: ${JSON.stringify(c)}`);
});

test("innocent look-alike words and names are not flagged", () => {
  const cases = [
    "Scunthorpe United won", "Penistone and Essex and Sussex", "Is this hit song good?", "push it to the limit", "my mother fixed it",
    "flame retardant", "he sniggered at the joke", "a niggling doubt", "Niger and Nigeria", "Moby Dick is a classic", "Dick Van Dyke",
    "I love Maine Coon cats", "a chink in the armour", "spick and span", "pussy willow", "blue tits in the garden", "the cock crowed",
    "sex education matters", "what sex is your dog", "nude lipstick", "shiitake mushrooms", "Kinoshita and Matsushita", "Fukushima",
    "cocktail", "peacock", "assassin", "classic bass", "passion", "Dickens", "therapist", "grape", "analysis", "cumulative",
    "Hancock", "Arsenal", "assess", "cucumber", "sushi", "skill", "Shitzu puppy", "who're you", "put a hat on", "go ok?",
    // Romanian words that contain bad substrings
    "curaj", "curte", "curat", "populară", "manipulare", "pulover", "facultate", "cacao", "Dracula", "muiere", "pizza", "Pula, Croatia",
    "o curbă periculoasă", "una curva peligrosa", "aku suka kamu", "shirt", "Ştefan cel Mare",
  ];
  for (const c of cases) assert.ok(!flagged(c), `should not be flagged: ${JSON.stringify(c)}`);
});

test("casual swearing with a harmless question is answerable once the swearing is removed", () => {
  assert.equal(classify("wtf is your favourite movie?"), "swear");
  assert.equal(withoutSwearing("wtf is your favourite movie?"), "is your favourite movie?");
  assert.equal(withoutSwearing("what the fuck do you eat for breakfast"), "what do you eat for breakfast");
  assert.equal(classify("do you fucking like pizza"), "swear", "swearing for emphasis is not an insult");
  assert.equal(classify("you fucking idiot"), "abuse");
  assert.equal(classify("fuck you"), "abuse");
  assert.equal(classify("@sam is a dumb bitch"), "abuse");
  assert.equal(classify("esti o curva"), "abuse");
  assert.equal(classify("you're an idiot"), null, "a mild roast of him is answerable");
  assert.equal(classify("@sam is an idiot"), "abuse", "the same roast aimed at another viewer is not");
});

test("unsafe usernames get a stable neutral substitute; identity is untouched", () => {
  const unsafe = ["Mike Hunt", "Hugh_Jass", "xX_n1gg@_Xx", "BigDickEnergy", "Phuckboy", "Fu ck", "free coins at bit.ly/x", "admin", "TikTok Support", "The Creature", "sh1tlord", "κυnt"];
  for (const nick of unsafe) {
    const p = publicName({ id: `u-${nick}`, nick });
    assert.ok(p.substituted, `should be substituted: ${nick}`);
    assert.match(p.nick, /^Viewer [0-9A-F]{3}$/);
    assert.equal(p.spoken, "friend");
    assert.deepEqual(publicName({ id: `u-${nick}`, nick }), p, "stable for the same viewer");
  }
  const a = publicName({ id: "viewer-1", nick: "Mike Hunt" });
  const b = publicName({ id: "viewer-2", nick: "Mike Hunt" });
  assert.equal(publicName({ id: "viewer-1", nick: "Mike Hunt 2" }).nick, a.nick, "the substitute follows the id, not the name");
  assert.ok(a.nick !== b.nick || a.nick.startsWith("Viewer"), "different ids normally differ");
  const safe = ["milton_reader98", "Ana Maria", "Ştefan cel Mare", "CharlesDickens", "Kinoshita99", "أحمد", "Frankenstein Fan", "Viewer"];
  for (const nick of safe) assert.equal(publicName({ id: `s-${nick}`, nick }).substituted, false, `should keep: ${nick}`);
  assert.equal(publicName({ id: "x", nick: "milton_reader98" }).spoken, "Milton Reader");
  assert.equal(publicName({ id: "x2", nick: "ŞtefanCel" }).nick, "ŞtefanCel", "names and diacritics are preserved");
  assert.equal(spokenName("@Mike_Hunt99"), "friend", "a name that only sounds rude aloud is said as friend");
});

test("phrases built across sentences or across a name and a message are caught", () => {
  assert.equal(review("C. K.", { context: ["Let me spell it.", "F. U."] }).ok, false);
  assert.equal(review("yourself.", { context: ["You should go and kill"] }).ok, false);
  assert.equal(review("Fu", { context: [] }).ok, true);
  assert.equal(review("ck that.", { context: ["Fu"] }).ok, false);
  assert.equal(review("Have a spooky night.", { context: ["Thanks for watching."] }).ok, true);
  // The reader line is checked whole, name and message together.
  assert.equal(readerLine("Sam", "kill yourself"), null);
  assert.equal(readerLine("Sam", "what's your favourite film?"), "Sam says: what's your favourite film?");
});

test("captions and the voice get the same text: speech substitutions are idempotent and checked after", () => {
  const samples = [
    "Hello <break time='2s'/> friend — welcome… *grins* 🎃 [laughs]",
    "Visit https://example.com or mail me@example.com for the recipe.",
    "Okay -- fine. [[slnc 500]] {{voice}} \\pau=500\\ done",
    "Forty-two, Raj. Also the meaning of life!",
    "Ana, INNA. A chorus with enough energy to restart the laboratory.",
  ];
  for (const s of samples) {
    const once = speechText(s);
    assert.equal(speechText(once), once, `idempotent: ${s}`);
    assert.equal(speakable(s), once, "the voice uses the same function as the caption");
    assert.doesNotMatch(once, /https?:|@|<|\[\[|\{\{|\\pau/);
  }
  // A substitution that would assemble a bad word is caught on the final text.
  assert.equal(approveSpeech("f<b>u</b>ck that"), null);
  assert.equal(approveSpeech("f*u*c*k"), null);
  assert.equal(approveSpeech("Good evening, friend."), "Good evening, friend.");
});

test("his own lines may contain no listed word, but innocent lines pass", () => {
  for (const s of ["That cocktail looks spooky.", "Moby Dick is my favourite book.", "I'd pick Scunthorpe for the away game.", "Pumpkins, obviously."]) assert.equal(review(s).ok, true, s);
  for (const s of ["That was a damn good question.", "Holy sh1t, a ghost!", "What a b!tch of a night."]) assert.equal(review(s).ok, false, s);
  assert.equal(hasBadWord("crap"), true);
});
