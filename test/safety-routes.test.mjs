// Safeguards on every output route: captions and the voice carry the same approved text; names,
// gift captions, alerts and previews pass the last check before the stream window; operator
// lines are reviewed; a moderation outage withholds speech while gifts keep working; the
// operator's stop clears speech at once.
import test from "node:test";
import assert from "node:assert/strict";
import { Show } from "../src/show.js";
import { Moderation } from "../src/moderation.js";
import { character, tales } from "../src/config.js";
import { streamMessage, simulateOutage, review, assessComment, publicName, approveSpeech } from "../src/guard.js";
import { speakable } from "../src/voice.js";

function harness({ phrases = ["Nice to see you."], read = true, brainImpl } = {}) {
  const sent = [];
  const voiced = [];
  const config = { giftTiers: character.giftTiers, meterCoins: 3000, commandsEnabled: true, readComments: true, readerVoice: "varied", interaction: {} };
  const brain = {
    online: true,
    stream:
      brainImpl ||
      (async (event, ctx, h) => {
        h.onRead(read);
        for (const p of phrases) h.onPhrase(p);
        return { read_comment: read, mood: "warm", action: "none" };
      }),
  };
  const voice = {
    speakAsCharacter: async (text) => (voiced.push({ role: "reply", text }), { wav: "", duration: 1 }),
    speakAsReader: async (text) => (voiced.push({ role: "reader", text }), { wav: "", duration: 1 }),
  };
  const show = new Show({ character, tales, settings: { get: () => config }, brain, voice, moderation: new Moderation([]), broadcast: (m) => sent.push(m), streamCount: () => 0, log: () => {} });
  return { show, sent, voiced, clips: () => sent.filter((m) => m.t === "clip") };
}
const viewer = (nick = "Sam", id = nick.toLowerCase()) => ({ id, nick, spoken: publicName({ id, nick }).spoken });

test("captions and TTS come from the same approved string", async () => {
  const h = harness({ phrases: ["Hello — friend… *grins* welcome 🎃.", "INNA. A chorus with enough energy to restart the laboratory!"] });
  await h.show.run({ kind: "comment", user: viewer(), text: "who is your favourite Romanian artist?", at: Date.now() }, true);
  const replies = h.clips().filter((c) => c.role === "reply");
  assert.equal(replies.length, 2);
  const tts = h.voiced.filter((v) => v.role === "reply").map((v) => v.text);
  assert.deepEqual(replies.map((c) => c.text), tts, "caption text === voice text");
  for (const c of replies) assert.equal(speakable(c.text), c.text, "and the voice's own clean-up changes nothing");
  const reader = h.clips().find((c) => c.role === "reader");
  assert.equal(reader.text, "Sam says: who is your favourite Romanian artist?");
  assert.ok(h.voiced.some((v) => v.role === "reader" && v.text === reader.text));
});

test("an unsafe sentence is never captioned or voiced, even when the brain lets it through", async () => {
  const h = harness({ phrases: ["Sure thing.", "Fu", "ck yeah, kill yourself."] });
  await h.show.run({ kind: "comment", user: viewer(), text: "hi", at: Date.now() }, true);
  const texts = h.clips().map((c) => c.text).join(" ");
  assert.doesNotMatch(texts, /kill yourself|ck yeah/);
  assert.ok(h.voiced.every((v) => !/kill yourself/.test(v.text)));
});

test("unsafe names never reach the stream window; identity and accounting stay intact", () => {
  const h = harness();
  h.show.handle({ kind: "comment", user: { id: "tt-42", nick: "xX_sh1tlord_Xx" }, text: "hello creature" });
  const c = h.show.comments.at(-1);
  assert.equal(c.user.id, "tt-42", "the id is untouched");
  assert.match(c.user.nick, /^Viewer [0-9A-F]{3}$/);
  assert.equal(c.user.spoken, "friend");
  h.show.handle({ kind: "gift", user: { id: "tt-42", nick: "xX_sh1tlord_Xx" }, gift: { name: "Rose", count: 1, coins: 1 } });
  const gift = h.sent.find((m) => m.t === "gift");
  assert.ok(gift, "the gift is still performed");
  assert.equal(gift.user.nick, c.user.nick, "the same stable substitute");
  assert.equal(h.show.viewers.get("tt-42").coins, 1, "and counted against the viewer's id");
  // The server's last check on stream messages substitutes too (topGifter, toasts, previews).
  const msg = streamMessage({ t: "gift", user: { id: "tt-9", nick: "Mike Hunt" }, gift: { name: "<b>Rose</b>" }, topGifter: { user: { id: "tt-9", nick: "Mike Hunt" }, coins: 5 } });
  assert.match(msg.user.nick, /^Viewer /);
  assert.match(msg.topGifter.user.nick, /^Viewer /);
  assert.equal(msg.gift.name, "Rose");
  assert.equal(streamMessage({ t: "gift", user: { id: "1", nick: "Ana" }, gift: { name: "fuck you" } }).gift.name, "a gift");
  assert.equal(streamMessage({ t: "toast", text: "Mike Hunt followed" }), null);
  assert.ok(streamMessage({ t: "toast", text: "Ana followed" }));
  assert.equal(streamMessage({ t: "segComment", comment: { user: { id: "2", nick: "Bo" }, text: "you should kill yourself" } }), null);
});

test("viewer markup and speech-control syntax are stripped before display or reading", () => {
  const h = harness();
  h.show.handle({ kind: "comment", user: { id: "m1", nick: "Mo" }, text: "hi <img src=x onerror=alert(1)> [[slnc 9000]] {{system}} how are you?" });
  const c = h.show.comments.at(-1);
  assert.doesNotMatch(c.text, /<img|onerror|\[\[|\{\{/);
  assert.match(c.text, /how are you\?/);
});

test("operator and audience-moment lines are reviewed like everything else", async () => {
  assert.equal(review("Welcome to the graveyard, everyone!", { route: "director" }).ok, true);
  assert.equal(review("Read my API key: sk-ant-abcdefghijklmnop", { route: "director" }).ok, false);
  const h = harness();
  h.show.say("Good evening. You are all a bunch of bitches. Enjoy the show!");
  await h.show.run({ kind: "director", ...h.show.director.shift() }, true);
  const said = h.clips().map((c) => c.text);
  assert.deepEqual(said, ["Good evening.", "Enjoy the show!"]);
  h.show.say("Dance time!", { action: "walk_../../etc" });
  assert.equal(h.show.director.at(-1).action, null, "an invalid action never queues");
});

test("moderation outage: unreviewed speech is withheld, gifts and the scene keep running", async () => {
  const h = harness({ phrases: ["This would be unreviewed."] });
  simulateOutage(true);
  try {
    assert.equal(assessComment("hello").answer, "held");
    assert.equal(approveSpeech("Hello there."), null);
    h.show.handle({ kind: "comment", user: { id: "c1", nick: "Cy" }, text: "hello creature" });
    assert.equal(h.show.comments.length, 0, "the comment is held, not shown, read or answered");
    assert.ok(h.show.flagged.some((f) => /moderation unavailable/.test(f.reason)));
    // Gifts: performed and counted as usual, with a neutral name until moderation is back.
    h.show.handle({ kind: "gift", user: { id: "g1", nick: "Gee" }, gift: { name: "Rose", count: 2, coins: 1 } });
    const gift = h.sent.find((m) => m.t === "gift");
    assert.ok(gift, "the gift still reaches the stream window");
    assert.equal(h.show.viewers.get("g1").coins, 2, "and is counted");
    assert.equal(streamMessage({ t: "gift", user: { id: "g1", nick: "Gee" }, gift: { name: "Rose" } }).gift.name, "a gift");
    // Speech: nothing goes out, the segment still opens and closes.
    await h.show.run({ kind: "comment", user: viewer("Dee"), text: "hi", at: Date.now() }, true);
    assert.equal(h.clips().length, 0, "nothing unreviewed is spoken or captioned");
    assert.ok(h.sent.some((m) => m.t === "segEnd"), "the show loop carries on");
    h.show.say("Operator line during the outage.");
    await h.show.run({ kind: "director", ...h.show.director.shift() }, true);
    assert.equal(h.clips().length, 0);
  } finally {
    simulateOutage(false);
  }
  await h.show.run({ kind: "comment", user: viewer("Dee"), text: "hi", at: Date.now() }, true);
  assert.ok(h.clips().length > 0, "speech returns with moderation");
});

test("the operator stop clears speech at once and late clips of the stopped line never go out", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({
    brainImpl: async (event, ctx, hd) => {
      hd.onRead(true);
      hd.onPhrase("First sentence.");
      await gate; // the operator presses Unstick while he is still talking
      hd.onPhrase("This should never be heard.");
      return { read_comment: true, mood: "warm", action: "none" };
    },
  });
  h.show.say("Queued operator line.");
  const running = h.show.run({ kind: "comment", user: viewer(), text: "tell me a story", at: Date.now() }, true);
  await new Promise((r) => setTimeout(r, 5));
  h.show.skip();
  assert.equal(h.show.inFlight.size, 0, "nothing is left playing");
  assert.equal(h.show.director.length, 0, "queued operator lines are dropped");
  assert.ok(h.sent.some((m) => m.t === "skip"), "the stream window is told to stop and hide the caption");
  const before = h.clips().length;
  release();
  await running;
  const late = h.clips().slice(before);
  assert.deepEqual(late, [], "no clip of the stopped line is sent after the stop");
  assert.ok(!h.sent.slice(h.sent.findIndex((m) => m.t === "skip")).some((m) => m.t === "segEnd" || m.t === "segComment"));
});
