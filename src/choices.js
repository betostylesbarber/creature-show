// Audience choices, small environmental mysteries and free surprises.
//
// Three kinds of short interactive moment, all optional (settings.interaction), all rare, and all
// gated on a quiet show: nothing starts while comments are waiting, while he is speaking, within
// 45 s of answering a viewer, or right after a gift. A skip ("Unstick") clears whatever is running.
//
//  - A choice: a 35 s vote with two or three options. Viewers type the option's number or keyword;
//    one vote each, their latest counts. Votes are taken after the usual moderation and are not
//    answered as comments. When it closes the winner visibly happens and he says so.
//  - A mystery: a clue in the scene (a lantern flickering, knocking from the crypt ...). If chat
//    mentions it, or he is sent to the spot by a chat command or a vote, he walks over and the
//    payoff happens. With no takers it fades quietly.
//  - A surprise: a shooting star. Viewers who type "wish" within ten seconds make him do
//    something fun. Never tied to gifts, never a request for them.
//
// This file only decides and tells the stream window (messages "choice", "mystery", "surprise",
// "scene"); drawing is in public/stream/choices.js and overlay.js.

export const CHOICE_SECONDS = 35;
const RESULT_HOLD_MS = 7_000; // the result stays on the card, and nothing new starts, this long
const QUIET_AFTER_ANSWER_MS = 45_000; // not within this long of answering a viewer
const QUIET_AFTER_GIFT_MS = 30_000; // nor right after a gift (its performance and thank-you)
const MIN_GAP_MS = 90_000; // at least this long between any two of these moments
const MYSTERY_CLUE_MS = 80_000; // how long a clue waits to be noticed
const MYSTERY_WALK_MS = 18_000; // give up waiting for him to arrive and play the payoff anyway
const MYSTERY_HOLD_MS = 8_000;
export const WISH_SECONDS = 10;
const MAX_VOTERS = 20_000;
const UPDATE_EVERY_MS = 600;

// Where he can be sent to walk. A vote about walking uses three of these; if a mystery is waiting
// to be noticed, its spot is always one of them, so the vote can pick it.
const WALK_OPTIONS = [
  { label: "The crypt", words: ["crypt", "tomb", "mausoleum"], action: "walk_crypt", result: "The crypt, then. Do not follow too closely." },
  { label: "Pumpkins", words: ["pumpkin", "pumpkins", "patch"], action: "walk_pumpkins", result: "The pumpkins. They were my idea, I think." },
  { label: "Dead tree", words: ["tree", "dead tree"], action: "walk_tree", result: "The dead tree. It is shy, so be kind." },
  { label: "Old graves", words: ["grave", "graves", "old graves"], action: "walk_left_graves", result: "The old graves. I felt a draught." },
];

export const CHOICE_SETS = [
  {
    id: "walk",
    question: "Where should I walk?",
    ask: "Chat, where should I walk? Type one, two or three.",
    mood: "thoughtful",
    options: WALK_OPTIONS.slice(0, 3),
  },
  {
    id: "stunt",
    question: "What should I do?",
    ask: "What shall I do for you, chat? One, two or three.",
    mood: "amused",
    options: [
      { label: "A dance", words: ["dance", "dancing"], action: "dance", result: "A dance. I practised in the crypt." },
      { label: "Push-ups", words: ["pushup", "pushups", "push up", "push ups", "push-up", "push-ups"], action: "pushups", result: "Push-ups. My arms were not built for this." },
      { label: "A bow", words: ["bow", "bows"], action: "bow", result: "A bow. Elegant, and no cardio." },
    ],
  },
  {
    id: "night",
    question: "What should the night do?",
    ask: "What should the night do? Type one, two or three.",
    mood: "delighted",
    options: [
      { label: "Storm", words: ["storm", "thunder", "lightning", "rain"], scene: "storm", result: "The storm it is. Hold on to your hats." },
      { label: "Calm", words: ["calm", "quiet", "peace", "peaceful"], scene: "pumpkins", result: "Calm, then. The pumpkins will keep us company." },
      { label: "Ghosts", words: ["ghost", "ghosts", "spirits"], scene: "ghosts", result: "Ghosts. Be polite, they were here first." },
    ],
  },
];

// Visual kinds are drawn by public/stream/choices.js; `spot` is a key of environment.spots in
// character.json and `action` the walk that takes him there.
export const MYSTERIES = [
  {
    id: "lantern",
    spot: "left_graves",
    action: "walk_left_graves",
    visual: "flicker",
    hint: "A lantern is flickering",
    whisper: "Did that lantern by the old graves just flicker on its own?",
    words: ["lantern", "lamp", "candle", "flicker", "flickering", "flame"],
    payoff: "ghost",
    payoffText: "A ghost rises from the grave",
    reveal: "A ghost, rising from the grave. We have met. It is shy.",
  },
  {
    id: "knock",
    spot: "crypt",
    action: "walk_crypt",
    visual: "knock",
    hint: "Knocking from the crypt",
    whisper: "Do you hear that knocking from the crypt?",
    words: ["knock", "knocking", "knocks", "crypt", "door", "tomb"],
    payoff: "bats",
    payoffText: "Bats burst out of the crypt",
    reveal: "Bats. Only bats. I knew that. Mostly.",
  },
  {
    id: "pumpkin",
    spot: "pumpkins",
    action: "walk_pumpkins",
    visual: "breathe",
    hint: "The pumpkins are humming",
    whisper: "The pumpkins are humming. Listen closely.",
    words: ["pumpkin", "pumpkins", "humming", "hum", "glow", "glowing"],
    payoff: "pumpkins",
    payoffText: "The pumpkins light up",
    reveal: "They light up when I come near. I did not train them.",
  },
  {
    id: "tree",
    spot: "tree",
    action: "walk_tree",
    visual: "creak",
    hint: "The dead tree is creaking",
    whisper: "The dead tree is creaking. There is no wind. Interesting.",
    words: ["tree", "creak", "creaking", "branch", "branches"],
    payoff: "lightning",
    payoffText: "Lightning splits the sky",
    reveal: "Lightning, straight through the branches. The tree approves.",
  },
];

const FUN_ACTIONS = ["spin", "jacks", "dance", "wave", "flex"];

const norm = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasWord = (normalized, word) => new RegExp(`(^|\\s)${word.replace(/[-]/g, "[- ]")}(\\s|$)`).test(normalized);

// Which option (1-based) a comment votes for, or 0. A vote is the number ("2", "#2", "vote 2")
// or, in a very short message that is not a question, one option's keyword ("crypt!", "the dead
// tree"). A longer sentence that mentions a keyword is just a comment. Keywords that fit two
// options count for neither.
export function parseVote(text, options) {
  const t = norm(text);
  if (!t) return 0;
  const num = t.match(/^(?:(?:i vote|my vote is|vote|option|number|choice|pick)\s+)?#?\s*(\d)$/);
  if (num) {
    const n = Number(num[1]);
    return n >= 1 && n <= options.length ? n : 0;
  }
  if (String(text).includes("?") || t.split(" ").length > 4) return 0;
  const hits = options.filter((o) => o.words.some((w) => hasWord(t, w)));
  return hits.length === 1 ? hits[0].n : 0;
}

// "wish", "i wish", "make a wish" (short, and not a question).
export function isWish(text) {
  const t = norm(text);
  return t.split(" ").length <= 4 && !String(text).includes("?") && /(^|\s)(wish|wishes|wishing)(\s|$)/.test(t);
}

// Does a message mention something a mystery is about?
export function mentions(mystery, text) {
  const t = norm(text);
  return !!t && mystery.words.some((w) => hasWord(t, w));
}

const pickOne = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

export class Choices {
  constructor({ show, now = Date.now, random = Math.random, log = () => {} }) {
    this.show = show;
    this.now = now;
    this.random = random;
    this.log = log;
    this.choice = null;
    this.mystery = null;
    this.surprise = null;
    this.next = { choice: 0, mystery: 0, surprise: 0 }; // when each is due (0 = not scheduled)
    this.lastEndAt = 0;
    this.lastSet = null;
    this.lastMystery = null;
    this.emptyStreak = 0;
    this.seq = 0;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.log(`Audience moments hit a problem: ${error?.message || error}`);
      }
    }, 500);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  get config() {
    return this.show.settings.get().interaction || {};
  }

  active() {
    if (this.choice) return "choice";
    if (this.mystery) return "mystery";
    if (this.surprise) return "surprise";
    return null;
  }

  // A clue nobody has noticed yet does not stop a vote from starting: the vote can send him there.
  waitingClue() {
    return !this.choice && !this.surprise && this.mystery?.state === "clue";
  }

  // Makes room for a new moment. A manual start replaces what is running; the scheduler never does.
  claim(kind, force) {
    const busy = this.active();
    if (!busy) return true;
    if (kind === "choice" && this.waitingClue()) return true;
    if (!force) return false;
    this.cancel("replaced");
    return true;
  }

  send(message) {
    this.show.broadcast(message, "stream");
  }

  // --- When ------------------------------------------------------------------------------
  schedule(kind, now = this.now(), extra = 1) {
    const c = this.config;
    const minutes = { choice: c.choiceMinutes ?? 7, mystery: c.mysteryMinutes ?? 12, surprise: c.surpriseMinutes ?? 20 }[kind];
    this.next[kind] = now + minutes * 60_000 * extra * (0.8 + this.random() * 0.4);
  }

  // The first one of each kind comes a little sooner than the average gap, then they settle.
  firstDue(kind, now) {
    const c = this.config;
    const minutes = { choice: c.choiceMinutes ?? 7, mystery: c.mysteryMinutes ?? 12, surprise: c.surpriseMinutes ?? 20 }[kind];
    this.next[kind] = now + minutes * 60_000 * (0.5 + this.random() * 0.4);
  }

  // A good moment: nobody waiting to be answered, nothing being said or performed.
  quiet(now = this.now()) {
    const s = this.show;
    if (!(s.streamCount?.() > 0)) return false;
    if (s.comments.length || s.director.length || s.inFlight.size) return false;
    if (s.gifts.length || s.social.length || s.stormDue || s.likeMilestoneDue) return false;
    if (now - (s.lastAnswerAt || 0) < QUIET_AFTER_ANSWER_MS) return false;
    if (now - (s.lastGiftAt || 0) < QUIET_AFTER_GIFT_MS) return false;
    if (now - this.lastEndAt < MIN_GAP_MS) return false;
    return true;
  }

  tick(now = this.now()) {
    this.advance(now);
    const c = this.config;
    const on = { choice: c.choices !== false, mystery: c.mysteries !== false, surprise: c.surprises !== false };
    for (const kind of ["choice", "mystery", "surprise"]) {
      if (!on[kind]) this.next[kind] = 0;
      else if (!this.next[kind]) this.firstDue(kind, now);
    }
    const clue = this.waitingClue();
    if (this.active() && !clue) return;
    if (!this.quiet(now)) return;
    for (const kind of clue ? ["choice"] : ["choice", "mystery", "surprise"]) {
      if (!on[kind] || !this.next[kind] || now < this.next[kind]) continue;
      this.schedule(kind, now);
      if (kind === "choice") this.startChoice({ now });
      else if (kind === "mystery") this.startMystery({ now });
      else this.startSurprise({ now });
      return;
    }
  }

  // Timers of whatever is running.
  advance(now) {
    const c = this.choice;
    if (c) {
      if (c.phase === "open") {
        if (now >= c.endsAt) this.closeChoice(now);
        else if (c.dirty && now - c.sentAt >= UPDATE_EVERY_MS) this.sendChoiceUpdate(c, now);
      } else if (now - c.closedAt >= RESULT_HOLD_MS) this.finish("choice", now);
    }
    const m = this.mystery;
    if (m) {
      if (m.state === "clue" && now >= m.expiresAt) {
        this.send({ t: "mystery", phase: "expire", id: m.id });
        this.finish("mystery", now);
      } else if (m.state === "walking" && now >= m.walkUntil) this.arrived(m.id, now);
      else if (m.state === "payoff" && now - m.payoffAt >= MYSTERY_HOLD_MS) this.finish("mystery", now);
    }
    const s = this.surprise;
    if (s) {
      if (s.phase === "open") {
        if (now >= s.endsAt) this.endSurprise(now);
        else if (s.dirty && now - s.sentAt >= UPDATE_EVERY_MS) this.sendSurpriseUpdate(s, now);
      } else if (now - s.doneAt >= 5_000) this.finish("surprise", now);
    }
  }

  finish(kind, now = this.now()) {
    this[kind] = null;
    this.lastEndAt = now;
  }

  // Clears whatever is running, e.g. on a skip.
  cancel(reason = "cancel") {
    const now = this.now();
    if (this.choice) this.send({ t: "choice", phase: "cancel", id: this.choice.id });
    if (this.mystery) this.send({ t: "mystery", phase: "cancel", id: this.mystery.id });
    if (this.surprise) this.send({ t: "surprise", phase: "cancel", id: this.surprise.id });
    const any = this.active();
    this.choice = this.mystery = this.surprise = null;
    if (any) {
      this.lastEndAt = now;
      this.log(`Audience moment cancelled (${reason}).`);
    }
    return !!any;
  }

  // --- Choices ---------------------------------------------------------------------------
  startChoice({ now = this.now(), force = false, setId = null } = {}) {
    if (!this.claim("choice", force)) return null;
    const clue = this.mystery?.state === "clue" ? this.mystery : null;
    let set;
    if (clue) {
      // Offer the walk that leads to the waiting clue, with two other places beside it.
      const here = WALK_OPTIONS.find((o) => o.action === clue.def.action);
      const others = WALK_OPTIONS.filter((o) => o !== here).sort(() => this.random() - 0.5).slice(0, 2);
      set = { ...CHOICE_SETS[0], options: here ? [here, ...others].sort((a, b) => WALK_OPTIONS.indexOf(a) - WALK_OPTIONS.indexOf(b)) : CHOICE_SETS[0].options };
    } else {
      const pool = CHOICE_SETS.filter((s) => s.id !== this.lastSet);
      set = (setId && CHOICE_SETS.find((s) => s.id === setId)) || pickOne(pool.length ? pool : CHOICE_SETS, this.random);
    }
    this.lastSet = set.id;
    const options = set.options.map((o, i) => ({ ...o, n: i + 1, count: 0 }));
    this.choice = { id: ++this.seq, set, options, votes: new Map(), startedAt: now, endsAt: now + CHOICE_SECONDS * 1000, phase: "open", dirty: false, sentAt: now };
    if (clue) clue.expiresAt = Math.max(clue.expiresAt, this.choice.endsAt + 15_000); // the clue outlasts the vote
    this.send({ t: "choice", phase: "open", ...this.choiceView(this.choice, now) });
    this.show.say(set.ask, { mood: set.mood });
    this.show.remember?.(`[A vote started: ${set.question} ${options.map((o) => `${o.n} ${o.label}`).join(", ")}]`);
    this.log(`Audience choice started: ${set.question}`);
    return this.choice;
  }

  choiceView(c, now = this.now()) {
    const total = c.options.reduce((sum, o) => sum + o.count, 0);
    return {
      id: c.id,
      setId: c.set.id,
      question: c.set.question,
      hint: `Type ${c.options.map((o) => o.n).join(", ").replace(/, (\d)$/, " or $1")}`,
      total,
      leftMs: Math.max(0, c.endsAt - now),
      options: c.options.map((o) => ({ n: o.n, label: o.label, count: o.count, pct: total ? Math.round((o.count * 100) / total) : 0 })),
    };
  }

  sendChoiceUpdate(c, now) {
    c.dirty = false;
    c.sentAt = now;
    this.send({ t: "choice", phase: "update", ...this.choiceView(c, now) });
  }

  // One vote per viewer; voting again moves their vote.
  vote(user, n, now = this.now()) {
    const c = this.choice;
    if (!c || c.phase !== "open") return false;
    const before = c.votes.get(user.id);
    if (before === n) return true;
    if (before == null && c.votes.size >= MAX_VOTERS) return true; // a flood of strangers is not counted, but not answered as chat either
    if (before != null) c.options[before - 1].count--;
    c.votes.set(user.id, n);
    c.options[n - 1].count++;
    c.dirty = true;
    return true;
  }

  closeChoice(now = this.now()) {
    const c = this.choice;
    if (!c || c.phase !== "open") return null;
    const top = Math.max(...c.options.map((o) => o.count));
    const total = c.options.reduce((sum, o) => sum + o.count, 0);
    let pool = c.options.filter((o) => o.count === top);
    const how = total === 0 ? "none" : pool.length > 1 ? "tie" : "votes";
    if (total === 0) pool = c.options;
    const winner = pickOne(pool, this.random);
    c.phase = "closed";
    c.closedAt = now;
    c.winner = winner;
    c.how = how;
    this.emptyStreak = total === 0 ? this.emptyStreak + 1 : 0;
    if (total === 0) this.schedule("choice", now, Math.min(3, 1 + this.emptyStreak)); // nobody is voting: ask less often
    const view = this.choiceView(c, now);
    this.send({ t: "choice", phase: "close", ...view, how, winner: { n: winner.n, label: winner.label } });
    // He says what was chosen, and it visibly happens: a stunt or walk through the show, a
    // scene effect on the stream window. (The line is queued first so it comes before anything
    // the outcome sets off, such as a waiting mystery.)
    const lead = how === "none" ? "Nobody voted, so I choose. " : how === "tie" ? "A tie! The graveyard decides. " : "";
    this.show.say(`${lead}${winner.result}`, { mood: c.set.mood });
    if (winner.action) this.show.runAction(winner.action, null, { fromGift: false, force: true });
    if (winner.scene) this.send({ t: "scene", effect: winner.scene, source: "choice" });
    this.show.remember?.(`[The chat ${how === "votes" ? "voted for" : "left it to chance:"} ${winner.label}]`);
    this.log(`Audience choice closed: ${winner.label} (${how}, ${total} vote${total === 1 ? "" : "s"}).`);
    return { winner, how, total };
  }

  // --- Mysteries -------------------------------------------------------------------------
  startMystery({ now = this.now(), force = false, id = null } = {}) {
    if (!this.claim("mystery", force)) return null;
    const pool = MYSTERIES.filter((m) => m.id !== this.lastMystery);
    const def = (id && MYSTERIES.find((m) => m.id === id)) || pickOne(pool.length ? pool : MYSTERIES, this.random);
    this.lastMystery = def.id;
    this.mystery = { id: ++this.seq, def, state: "clue", startedAt: now, expiresAt: now + MYSTERY_CLUE_MS };
    this.send({ t: "mystery", phase: "clue", ...this.mysteryView(this.mystery, now) });
    this.show.say(def.whisper, { mood: "thoughtful" });
    this.log(`Mystery started: ${def.hint}`);
    return this.mystery;
  }

  mysteryView(m, now = this.now()) {
    const d = m.def;
    return { id: m.id, kind: d.id, visual: d.visual, spot: d.spot, hint: d.hint, payoff: d.payoff, payoffText: d.payoffText, leftMs: Math.max(0, m.expiresAt - now) };
  }

  // Someone noticed (a message, a chat command or a vote sent him there): he walks over.
  investigate({ user = null, now = this.now() } = {}) {
    const m = this.mystery;
    if (!m || m.state !== "clue") return false;
    m.state = "walking";
    m.walkUntil = now + MYSTERY_WALK_MS;
    m.by = user?.nick || null;
    this.send({ t: "mystery", phase: "investigate", id: m.id, kind: m.def.id, spot: m.def.spot });
    this.show.runAction(m.def.action, null, { fromGift: false, force: true });
    this.show.say(user?.spoken ? `Good eye, ${user.spoken}. Let me look.` : "Something is there. Let me look.", { mood: "thoughtful" });
    this.log(`Mystery noticed${user ? ` by ${user.nick}` : ""}: he walks to ${m.def.spot}.`);
    return true;
  }

  // The stream window says he is there (or the wait ran out): the payoff.
  arrived(id, now = this.now()) {
    const m = this.mystery;
    if (!m || m.id !== id || m.state !== "walking") return false;
    m.state = "payoff";
    m.payoffAt = now;
    this.send({ t: "mystery", phase: "payoff", id: m.id, kind: m.def.id, spot: m.def.spot, payoff: m.def.payoff, payoffText: m.def.payoffText });
    this.show.say(m.def.reveal, { mood: "delighted" });
    this.show.remember?.(`[${m.def.payoffText}]`);
    return true;
  }

  // --- Surprises -------------------------------------------------------------------------
  startSurprise({ now = this.now(), force = false } = {}) {
    if (!this.claim("surprise", force)) return null;
    this.surprise = { id: ++this.seq, kind: "star", startedAt: now, endsAt: now + WISH_SECONDS * 1000, phase: "open", wishers: new Map(), dirty: false, sentAt: now };
    this.send({ t: "surprise", phase: "start", ...this.surpriseView(this.surprise, now) });
    this.show.say("A shooting star! Make a wish, if you like.", { mood: "delighted" });
    this.log("Surprise: a shooting star.");
    return this.surprise;
  }

  surpriseView(s, now = this.now()) {
    return { id: s.id, kind: s.kind, count: s.wishers.size, seconds: WISH_SECONDS, leftMs: Math.max(0, s.endsAt - now) };
  }

  sendSurpriseUpdate(s, now) {
    s.dirty = false;
    s.sentAt = now;
    this.send({ t: "surprise", phase: "update", ...this.surpriseView(s, now) });
  }

  wish(user) {
    const s = this.surprise;
    if (!s || s.phase !== "open") return false;
    if (!s.wishers.has(user.id) && s.wishers.size < 500) {
      s.wishers.set(user.id, user.spoken || user.nick);
      s.dirty = true;
    }
    return true;
  }

  endSurprise(now = this.now()) {
    const s = this.surprise;
    if (!s || s.phase !== "open") return;
    s.phase = "done";
    s.doneAt = now;
    const n = s.wishers.size;
    const action = n ? pickOne(FUN_ACTIONS, this.random) : null;
    const effect = n >= 3 ? "fireworks" : n ? "sparks" : null;
    this.send({ t: "surprise", phase: "end", ...this.surpriseView(s, now), count: n, granted: n > 0 });
    if (n) {
      this.show.runAction(action, null, { fromGift: false, force: true });
      this.send({ t: "scene", effect, source: "wish" });
      const names = [...s.wishers.values()];
      this.show.say(n === 1 ? `The star heard ${names[0]}.` : n === 2 ? `The star heard ${names[0]} and ${names[1]}.` : "The star heard all of you.", { mood: "delighted" });
    }
    this.log(`Surprise ended: ${n} wish${n === 1 ? "" : "es"}.`);
  }

  // --- Hooks from the show -------------------------------------------------------------------
  // Called for every comment that passed moderation, before it is queued. Returns true when it
  // was a vote or a wish: those are counted and are not answered as comments.
  onComment(user, text) {
    try {
      return this.takeComment(user, text);
    } catch (error) {
      this.log(`Audience moments could not read a comment: ${error?.message || error}`);
      return false; // never let this get in the way of chat
    }
  }

  takeComment(user, text) {
    const c = this.choice;
    if (c && c.phase === "open") {
      const n = parseVote(text, c.options);
      if (n) return this.vote(user, n);
    }
    const s = this.surprise;
    if (s && s.phase === "open" && isWish(text)) return this.wish(user);
    const m = this.mystery;
    if (m && m.state === "clue" && mentions(m.def, text)) this.investigate({ user });
    return false;
  }

  // Called whenever the show runs an action: sending him to a mystery's spot (by command or vote)
  // counts as noticing it.
  onAction(action, user = null) {
    try {
      const m = this.mystery;
      if (m && m.state === "clue" && action === m.def.action) this.investigate({ user: user?.spoken ? user : null });
    } catch (error) {
      this.log(`Audience moments could not follow an action: ${error?.message || error}`);
    }
  }

  // What a stream window opened mid-moment needs to catch up.
  streamSync(now = this.now()) {
    const out = [];
    const c = this.choice;
    if (c?.phase === "open") out.push({ t: "choice", phase: "open", quiet: true, ...this.choiceView(c, now) });
    const m = this.mystery;
    if (m?.state === "clue") out.push({ t: "mystery", phase: "clue", quiet: true, ...this.mysteryView(m, now) });
    const s = this.surprise;
    if (s?.phase === "open") out.push({ t: "surprise", phase: "start", quiet: true, ...this.surpriseView(s, now) });
    return out;
  }

  snapshot(now = this.now()) {
    const c = this.config;
    const until = (kind, enabled) => (enabled && this.next[kind] ? Math.max(0, this.next[kind] - now) : null);
    const detail = this.choice
      ? { kind: "choice", question: this.choice.set.question, phase: this.choice.phase, leftMs: Math.max(0, this.choice.endsAt - now), votes: this.choice.votes.size }
      : this.mystery
        ? { kind: "mystery", what: this.mystery.def.hint, state: this.mystery.state }
        : this.surprise
          ? { kind: "surprise", wishes: this.surprise.wishers.size, phase: this.surprise.phase }
          : null;
    return {
      active: this.active(),
      detail,
      quiet: this.quiet(now),
      nextInMs: { choice: until("choice", c.choices !== false), mystery: until("mystery", c.mysteries !== false), surprise: until("surprise", c.surprises !== false) },
    };
  }
}
