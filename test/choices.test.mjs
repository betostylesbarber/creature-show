// Audience choices, mysteries and surprises (src/choices.js) and their hooks in the show:
// votes are counted after moderation and never answered as comments, one vote per viewer, ties are
// random, nothing starts during a conversation, and a skip clears everything.
import test from "node:test";
import assert from "node:assert/strict";
import { Show } from "../src/show.js";
import { Choices, parseVote, isWish, mentions, CHOICE_SETS, MYSTERIES, CHOICE_SECONDS, WISH_SECONDS } from "../src/choices.js";
import { character, tales } from "../src/config.js";
import { Moderation } from "../src/moderation.js";

const T0 = 1_800_000_000_000;

function harness({ interaction = {}, random = () => 0 } = {}) {
  const sent = [];
  let t = T0;
  const config = { giftTiers: character.giftTiers, meterCoins: 3000, commandsEnabled: true, readComments: true, readerVoice: "varied", interaction: { choices: true, choiceMinutes: 7, mysteries: true, mysteryMinutes: 12, surprises: true, surpriseMinutes: 20, ...interaction } };
  const show = new Show({ character, tales, settings: { get: () => config }, brain: {}, voice: {}, moderation: new Moderation([]), broadcast: (m, target) => sent.push({ ...m, target }), streamCount: () => 1, log: () => {} });
  const actions = [];
  const realRunAction = show.runAction.bind(show);
  show.runAction = (action, user, options) => {
    actions.push({ action, user, options });
    return realRunAction(action, user, options);
  };
  const choices = new Choices({ show, now: () => t, random, log: () => {} });
  show.interaction = choices;
  const comment = (nick, text) => show.handle({ kind: "comment", user: { id: nick.toLowerCase(), nick }, text });
  const advance = (ms) => {
    t += ms;
    choices.tick(t);
  };
  return { show, choices, sent, actions, comment, advance, config, now: () => t, setNow: (v) => (t = v) };
}

const messages = (h, type, phase) => h.sent.filter((m) => m.t === type && (!phase || m.phase === phase));
const lines = (h) => h.show.director.map((d) => d.text);

// --- Parsing ------------------------------------------------------------------------------

test("a vote is the option number or its keyword in a very short message", () => {
  const options = CHOICE_SETS[0].options.map((o, i) => ({ ...o, n: i + 1 })); // crypt, pumpkins, dead tree
  assert.equal(parseVote("2", options), 2);
  assert.equal(parseVote("#3", options), 3);
  assert.equal(parseVote("Vote 1!", options), 1);
  assert.equal(parseVote("option 2", options), 2);
  assert.equal(parseVote("crypt", options), 1);
  assert.equal(parseVote("The Crypt!!", options), 1);
  assert.equal(parseVote("the dead tree", options), 3);
  assert.equal(parseVote("go to the crypt", options), 1);
  assert.equal(parseVote("4", options), 0, "there is no option 4");
  assert.equal(parseVote("0", options), 0);
  assert.equal(parseVote("what is in the crypt?", options), 0, "a question is a comment");
  assert.equal(parseVote("i think the crypt is very scary at night honestly", options), 0, "a sentence is a comment");
  assert.equal(parseVote("crypt or tree", options), 0, "two options named: not a vote");
  assert.equal(parseVote("hello there", options), 0);
  assert.equal(parseVote("", options), 0);
  assert.equal(parseVote("2nd place", options), 0);
});

test("keywords are whole words and push-ups match their spellings", () => {
  const options = CHOICE_SETS[1].options.map((o, i) => ({ ...o, n: i + 1 })); // dance, push-ups, bow
  assert.equal(parseVote("push-ups", options), 2);
  assert.equal(parseVote("push ups", options), 2);
  assert.equal(parseVote("pushups", options), 2);
  assert.equal(parseVote("elbow", options), 0, "bow inside another word");
  assert.equal(parseVote("dancer", options), 0);
  assert.equal(parseVote("dance", options), 1);
});

test("wishes and mystery mentions are recognised", () => {
  assert.ok(isWish("wish"));
  assert.ok(isWish("I wish!"));
  assert.ok(isWish("make a wish"));
  assert.ok(!isWish("what did you wish for?"));
  assert.ok(!isWish("i wish i could be there with all of you tonight"));
  assert.ok(!isWish("wishful thinking"));
  const lantern = MYSTERIES.find((m) => m.id === "lantern");
  assert.ok(mentions(lantern, "that lantern is flickering"));
  assert.ok(!mentions(lantern, "lanterns are nice"));
});

// --- Votes through the show ---------------------------------------------------------------------

test("votes are counted per viewer, the latest vote wins, and they never enter the comment queue", () => {
  const h = harness({ random: () => 0 });
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  h.comment("ana", "1");
  h.comment("ben", "crypt");
  h.comment("cara", "2");
  h.comment("dan", "pumpkin");
  h.comment("dan", "3"); // dan changes his mind: only the 3 counts
  h.comment("eve", "the dead tree");
  const view = h.choices.choiceView(h.choices.choice);
  assert.deepEqual(view.options.map((o) => o.count), [2, 1, 2]);
  assert.equal(view.total, 5);
  assert.equal(h.choices.choice.votes.size, 5);
  assert.equal(h.show.comments.length, 0, "votes are not answered as comments");
  assert.equal(h.show.outcomeCounts.vote, 6);
  // An ordinary comment still goes through.
  h.comment("fay", "I love this graveyard");
  assert.equal(h.show.comments.length, 1);
});

test("a number is an ordinary comment when no vote is open, and after the vote closes", () => {
  const h = harness();
  h.comment("ana", "1");
  assert.equal(h.show.comments.length, 1);
  h.choices.startChoice({ now: h.now() });
  h.comment("ben", "2");
  assert.equal(h.show.comments.length, 1);
  h.advance(CHOICE_SECONDS * 1000 + 100);
  assert.equal(h.choices.choice.phase, "closed");
  h.comment("cara", "3");
  assert.equal(h.show.comments.length, 2);
});

test("votes are counted only after moderation: rude, spammy and muted viewers do not count", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  h.comment("ana", "1");
  h.comment("ben", "crypt fuck"); // swearing: hidden, never a vote
  h.show.moderation.mutedUntil.set("cara", Date.now() + 60_000);
  h.comment("cara", "2");
  h.comment("dan", "3");
  const counts = h.choices.choiceView(h.choices.choice).options.map((o) => o.count);
  assert.deepEqual(counts, [1, 0, 1]);
  assert.equal(h.choices.choice.votes.has("ben"), false);
  assert.equal(h.choices.choice.votes.has("cara"), false);
  assert.ok(h.show.flagged.some((f) => f.nick === "ben"));
});

test("the same viewer repeating one vote is not double counted", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  for (let i = 0; i < 4; i++) h.comment("ana", "1");
  assert.equal(h.choices.choiceView(h.choices.choice).total, 1);
});

test("a choice shows live percentages from the real counts", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "stunt" });
  for (const [nick, text] of [["a", "1"], ["b", "1"], ["c", "1"], ["d", "2"]]) h.comment(nick, text);
  h.advance(700);
  const update = messages(h, "choice", "update").at(-1);
  assert.deepEqual(update.options.map((o) => o.pct), [75, 25, 0]);
  assert.deepEqual(update.options.map((o) => o.count), [3, 1, 0]);
  assert.equal(update.total, 4);
  assert.ok(update.leftMs <= (CHOICE_SECONDS * 1000) - 700 + 1);
  assert.equal(messages(h, "choice", "open")[0].target, "stream");
});

// --- Closing: outcomes, ties, no votes ---------------------------------------------------------------

test("the winner visibly happens: a stunt through runAction, and he announces it", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "stunt" });
  h.comment("a", "2");
  h.comment("b", "push-ups");
  h.comment("c", "1");
  h.advance(CHOICE_SECONDS * 1000);
  const close = messages(h, "choice", "close")[0];
  assert.equal(close.how, "votes");
  assert.equal(close.winner.label, "Push-ups");
  const run = h.actions.find((a) => a.action === "pushups");
  assert.ok(run, "the winning stunt ran");
  assert.equal(run.user, null);
  assert.deepEqual(run.options, { fromGift: false, force: true });
  assert.ok(messages(h, "action").some((m) => m.action === "pushups"));
  assert.equal(lines(h).length, 2, "the question and the result are one line each");
  assert.match(lines(h)[0], /what shall i do/i);
  assert.match(lines(h)[1], /push-ups/i);
});

test("a scene outcome is broadcast to the stream window", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "night" });
  h.comment("a", "storm");
  h.comment("b", "1");
  h.advance(CHOICE_SECONDS * 1000);
  const scene = h.sent.find((m) => m.t === "scene");
  assert.equal(scene.effect, "storm");
  assert.equal(scene.target, "stream");
  assert.equal(h.actions.length, 0);
});

test("a walk outcome sends him there", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  h.comment("a", "3");
  h.advance(CHOICE_SECONDS * 1000);
  assert.equal(h.actions.at(-1).action, "walk_tree");
  assert.equal(h.show.location, "tree");
});

test("a tie is resolved randomly among the tied options only", () => {
  for (const [roll, expected] of [[0, "A dance"], [0.99, "Push-ups"]]) {
    const h = harness({ random: () => roll });
    h.choices.startChoice({ now: h.now(), setId: "stunt" });
    h.comment("a", "1");
    h.comment("b", "2");
    h.comment("c", "2");
    h.comment("d", "1");
    h.comment("e", "3"); // third place, never picked
    h.advance(CHOICE_SECONDS * 1000);
    const close = messages(h, "choice", "close")[0];
    assert.equal(close.how, "tie");
    assert.equal(close.winner.label, expected);
    assert.match(lines(h).at(-1), /tie/i);
  }
});

test("with no votes he picks and says so", () => {
  const h = harness({ random: () => 0.5 });
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  h.advance(CHOICE_SECONDS * 1000);
  const close = messages(h, "choice", "close")[0];
  assert.equal(close.how, "none");
  assert.equal(close.total, 0);
  assert.match(lines(h).at(-1), /nobody voted/i);
  assert.ok(h.actions.length === 1, "he still does it");
});

test("a choice that nobody votes in makes the next one wait longer", () => {
  const h = harness({ random: () => 0.5 });
  h.advance(1000); // schedules
  const first = h.choices.next.choice;
  h.choices.startChoice({ now: h.now() });
  h.advance(CHOICE_SECONDS * 1000);
  assert.ok(h.choices.next.choice - h.now() > 7 * 60_000 * 1.5, "the next one is more than 1.5 intervals away");
  assert.ok(first > 0);
});

// --- When they start --------------------------------------------------------------------------------

function dueHarness(extra) {
  const h = harness(extra);
  h.advance(1000); // the first tick schedules everything
  h.setNow(h.now() + 60 * 60_000); // an hour later: all three are due
  h.show.lastAnswerAt = h.now() - 10 * 60_000;
  h.show.lastGiftAt = h.now() - 10 * 60_000;
  h.choices.lastEndAt = 0;
  return h;
}

test("a choice starts on its own once the interval has passed and the show is quiet", () => {
  const h = dueHarness();
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), "choice");
  assert.equal(messages(h, "choice", "open").length, 1);
  // Not another one on top, and only one thing at a time.
  h.choices.tick(h.now() + 600);
  assert.equal(messages(h, "choice", "open").length, 1);
  assert.equal(h.choices.mystery, null);
});

test("nothing starts while comments are waiting, he is speaking, or lines are queued", () => {
  const h = dueHarness();
  h.show.comments.push({ id: 1, user: { id: "x", nick: "x" }, text: "hi", at: h.now() });
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null, "a comment is waiting");
  h.show.comments.length = 0;
  h.show.inFlight.set(1, { id: 1 });
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null, "he is speaking");
  h.show.inFlight.clear();
  h.show.director.push({ text: "hello" });
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null, "a line is queued");
  h.show.director.length = 0;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), "choice", "and now it is quiet");
});

test("nothing starts within 45 seconds of answering a viewer, or 30 seconds of a gift", () => {
  const h = dueHarness();
  h.show.lastAnswerAt = h.now() - 20_000;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
  h.show.lastAnswerAt = h.now() - 46_000;
  h.show.lastGiftAt = h.now() - 10_000;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
  h.show.lastGiftAt = h.now() - 31_000;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), "choice");
});

test("answering a comment and receiving a gift mark the show as busy", () => {
  const h = harness();
  h.comment("ana", "hello creature");
  const before = h.show.lastAnswerAt;
  const next = h.show.takeNext();
  assert.equal(next.kind, "comment");
  assert.ok(h.show.lastAnswerAt > before);
  h.show.handle({ kind: "gift", user: { id: "g", nick: "g" }, gift: { name: "Rose", count: 1, coins: 1 } });
  assert.ok(h.show.lastGiftAt > 0);
});

test("pending gift thank-yous, storms and likes also hold things back", () => {
  const h = dueHarness();
  h.show.gifts.push({ user: { id: "g", nick: "g" }, gift: { name: "Rose" }, total: 1, at: h.now() });
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
  h.show.gifts.length = 0;
  h.show.stormDue = true;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
});

test("nothing starts without a stream window, or when switched off", () => {
  const h = dueHarness();
  h.show.streamCount = () => 0;
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
  h.show.streamCount = () => 1;
  h.config.interaction = { ...h.config.interaction, choices: false, mysteries: false, surprises: false };
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null);
  assert.deepEqual(h.choices.next, { choice: 0, mystery: 0, surprise: 0 });
});

test("at least 90 seconds pass between two moments", () => {
  const h = dueHarness();
  h.choices.tick(h.now());
  h.advance(CHOICE_SECONDS * 1000); // closes
  h.advance(8_000); // the result has been held and cleared
  h.show.director.length = 0; // (the loop would have spoken his lines by now)
  assert.equal(h.choices.active(), null);
  h.choices.next.mystery = h.now() - 1; // due
  h.choices.tick(h.now());
  assert.equal(h.choices.active(), null, "too soon after the last one");
  h.advance(90_000);
  assert.equal(h.choices.active(), "mystery");
});

test("a skip clears a running vote, mystery or wish", () => {
  for (const kind of ["choice", "mystery", "surprise"]) {
    const h = harness();
    h.choices[`start${kind[0].toUpperCase()}${kind.slice(1)}`]({ now: h.now() });
    assert.equal(h.choices.active(), kind);
    h.show.skip();
    assert.equal(h.choices.active(), null, kind);
    assert.ok(h.sent.some((m) => m.t === kind && m.phase === "cancel"), `${kind} cancel was broadcast`);
  }
});

test("a manual start replaces what is running; the scheduler never does", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now() });
  assert.equal(h.choices.startMystery({ now: h.now() }), null);
  assert.equal(h.choices.active(), "choice");
  assert.ok(h.choices.startMystery({ now: h.now(), force: true }));
  assert.equal(h.choices.active(), "mystery");
});

// --- Mysteries --------------------------------------------------------------------------------------

test("a mystery clue waits to be noticed; a keyword makes him walk over, then the payoff happens", () => {
  const h = harness();
  h.choices.startMystery({ now: h.now(), id: "knock" });
  const clue = messages(h, "mystery", "clue")[0];
  assert.equal(clue.kind, "knock");
  assert.equal(clue.spot, "crypt");
  assert.match(lines(h)[0], /knocking/i);
  h.comment("ana", "what a lovely night");
  assert.equal(h.choices.mystery.state, "clue");
  h.comment("ben", "is someone knocking?"); // a mention: investigates, and is still an ordinary comment
  assert.equal(h.choices.mystery.state, "walking");
  assert.equal(h.show.comments.length, 2, "mentions are still answered as comments");
  assert.ok(h.actions.some((a) => a.action === "walk_crypt"));
  assert.equal(messages(h, "mystery", "investigate")[0].spot, "crypt");
  assert.match(lines(h).at(-1), /good eye, ben/i);
  // The stream window reports his arrival.
  assert.ok(h.choices.arrived(clue.id, h.now()));
  const payoff = messages(h, "mystery", "payoff")[0];
  assert.equal(payoff.payoff, "bats");
  assert.match(lines(h).at(-1), /bats/i);
  h.advance(9_000);
  assert.equal(h.choices.mystery, null);
});

test("if he never arrives the payoff still plays after a while", () => {
  const h = harness();
  h.choices.startMystery({ now: h.now(), id: "lantern" });
  h.comment("ana", "the lantern!");
  h.advance(19_000);
  assert.equal(messages(h, "mystery", "payoff").length, 1);
  assert.equal(messages(h, "mystery", "payoff")[0].payoff, "ghost");
});

test("an unnoticed mystery expires quietly", () => {
  const h = harness();
  h.choices.startMystery({ now: h.now(), id: "tree" });
  const spoken = lines(h).length;
  h.advance(81_000);
  assert.equal(h.choices.mystery, null);
  assert.equal(messages(h, "mystery", "expire").length, 1);
  assert.equal(messages(h, "mystery", "payoff").length, 0);
  assert.equal(lines(h).length, spoken, "he says nothing about it");
  assert.equal(h.actions.length, 0);
});

test("sending him to the mystery's spot by a chat command counts as noticing it", () => {
  const h = harness();
  h.choices.startMystery({ now: h.now(), id: "pumpkin" });
  h.comment("ana", "go to the pumpkins"); // a chat command, not a keyword-only mention
  assert.equal(h.choices.mystery.state, "walking");
  assert.ok(h.actions.some((a) => a.action === "walk_pumpkins"));
});

test("a vote can pick the mystery: the walk vote offers its spot, and winning it pays off", () => {
  const h = harness({ random: () => 0.1 });
  h.choices.startMystery({ now: h.now(), id: "lantern" }); // the old graves
  const clueMsg = messages(h, "mystery", "clue")[0];
  assert.equal(h.choices.startChoice({ now: h.now() }) !== null, true, "a vote may open while a clue waits");
  const open = messages(h, "choice", "open")[0];
  assert.ok(open.options.some((o) => o.label === "Old graves"), "the vote offers the clue's spot");
  const n = open.options.find((o) => o.label === "Old graves").n;
  h.comment("ana", String(n));
  h.comment("ben", "old graves");
  h.advance(CHOICE_SECONDS * 1000);
  assert.equal(h.choices.mystery.state, "walking", "winning the vote sent him to the clue");
  assert.ok(h.actions.some((a) => a.action === "walk_left_graves"));
  assert.ok(h.choices.arrived(clueMsg.id, h.now()));
  assert.equal(messages(h, "mystery", "payoff").length, 1);
});

test("a late stream window is brought up to date", () => {
  const h = harness();
  h.choices.startChoice({ now: h.now(), setId: "walk" });
  h.comment("a", "1");
  const sync = h.choices.streamSync(h.now() + 5000);
  assert.equal(sync.length, 1);
  assert.equal(sync[0].phase, "open");
  assert.equal(sync[0].options[0].count, 1);
  assert.equal(sync[0].leftMs, CHOICE_SECONDS * 1000 - 5000);
});

// --- Surprises ----------------------------------------------------------------------------------------

test("wishes in the ten-second window are counted once per viewer and make him do something fun", () => {
  const h = harness({ random: () => 0 });
  h.choices.startSurprise({ now: h.now() });
  assert.match(lines(h)[0], /shooting star/i);
  h.comment("ana", "wish");
  h.comment("ana", "i wish"); // the same viewer again: not counted twice
  h.comment("ben", "make a wish");
  h.comment("cara", "what a beautiful star"); // an ordinary comment
  assert.equal(h.show.comments.length, 1, "wishes are not answered as comments");
  assert.equal(h.choices.surprise.wishers.size, 2);
  h.advance(WISH_SECONDS * 1000);
  const end = messages(h, "surprise", "end")[0];
  assert.equal(end.count, 2);
  assert.equal(end.granted, true);
  assert.ok(h.actions.length === 1 && ["spin", "jacks", "dance", "wave", "flex"].includes(h.actions[0].action));
  assert.equal(h.sent.find((m) => m.t === "scene").effect, "sparks");
  assert.match(lines(h).at(-1), /star heard ana and ben/i);
});

test("a wish after the window, or with nobody wishing, does nothing and says nothing", () => {
  const h = harness();
  h.choices.startSurprise({ now: h.now() });
  const spoken = lines(h).length;
  h.advance(WISH_SECONDS * 1000);
  assert.equal(h.choices.surprise.phase, "done");
  assert.equal(messages(h, "surprise", "end")[0].granted, false);
  assert.equal(lines(h).length, spoken);
  assert.equal(h.actions.length, 0);
  h.comment("late", "wish");
  assert.equal(h.show.comments.length, 1, "too late: an ordinary comment");
});

test("a surprise never mentions gifts", () => {
  const h = harness();
  h.choices.startSurprise({ now: h.now() });
  h.comment("a", "wish");
  h.advance(WISH_SECONDS * 1000);
  h.choices.startChoice({ now: h.now(), force: true });
  h.advance(CHOICE_SECONDS * 1000);
  h.choices.startMystery({ now: h.now(), force: true });
  for (const text of [...lines(h), ...MYSTERIES.flatMap((m) => [m.whisper, m.reveal, m.hint]), ...CHOICE_SETS.flatMap((s) => [s.ask, ...s.options.map((o) => o.result)])]) {
    assert.doesNotMatch(text, /gift|coin|rose|pay|buy|spend|diamond|support/i, text);
  }
});

test("the snapshot reports what is running and what is next", () => {
  const h = harness();
  h.advance(1000);
  const idle = h.choices.snapshot(h.now());
  assert.equal(idle.active, null);
  assert.ok(idle.nextInMs.choice > 0 && idle.nextInMs.mystery > 0 && idle.nextInMs.surprise > 0);
  h.choices.startChoice({ now: h.now() });
  const running = h.choices.snapshot(h.now());
  assert.equal(running.active, "choice");
  assert.equal(running.detail.kind, "choice");
  assert.equal(h.show.snapshot().interaction.active, "choice");
});
