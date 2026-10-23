// Answers for when no AI is connected. Each topic has trigger words and a few in-character
// replies drawn from the novel; the best-matching topic wins, and replies rotate so he
// doesn't repeat himself. {name} is the viewer's spoken name.

const TOPICS = [
  {
    keys: ["book", "books", "read", "reading", "favourite book", "favorite book", "milton", "paradise", "plutarch", "werter", "werther", "volney", "novel"],
    replies: [
      "{name}, Paradise Lost, no contest. I read it as true history. I was Adam, minus the caring creator.",
      "Three books in a leather case changed my life, {name}: Milton, Plutarch and Werter. Milton wins. Main character energy.",
      "Plutarch taught me high thoughts, Werter taught me gloom. But Paradise Lost? That one ate, {name}.",
      "I learned history through a crack in a wall, from Volney's Ruins of Empires. Favourite read? Milton, always.",
    ],
  },
  {
    keys: ["green", "skin", "colour", "color", "yellow"],
    replies: [
      "The book says my skin is yellow, {name}. Who painted me green? Hollywood, explain yourself.",
      "Green? A costume from the moving pictures, {name}. My creator wrote yellow. I wear it for the fans.",
      "{name}, yellow skin, black flowing hair, pearly teeth. That is canon. The green is pure Hollywood drip.",
    ],
  },
  {
    keys: ["frankenstein", "your name", "whats your name", "what is your name", "who are you", "called"],
    replies: [
      "Frankenstein was my creator's name, {name}, not mine. He never gave me one. 'Friend' works.",
      "Plot twist, {name}: Frankenstein is the guy who made me. I am just the Creature. Nameless, but iconic.",
      "Victor Frankenstein built me and fled. He kept the name. I kept the drama.",
    ],
  },
  {
    keys: ["bolt", "bolts", "neck", "screw", "screws"],
    replies: [
      "No bolts in the book, {name}. These are a 1931 Hollywood accessory. Lowkey they slay though.",
      "{name}, the novel never mentions bolts. I wear them tonight so you would recognise me.",
    ],
  },
  {
    keys: ["fire", "flame", "burn", "fire bad", "hot"],
    replies: [
      "Fire is not bad, {name}. It is complicated. It warmed me, then it bit my hand.",
      "I found a beggar's fire once and stuck my hand in it. Zero stars. Still love the warmth.",
      "'Fire bad' is a movie line, {name}. In the book I learned to tend it and roast nuts. Chef behaviour.",
    ],
  },
  {
    keys: ["victor", "creator", "dad", "father", "maker", "parent", "made you", "who made"],
    replies: [
      "My creator took one look at me and ran, {name}. Absolute L parenting.",
      "He built me in an attic in Ingolstadt, then fled when I opened my eyes. Still processing that.",
      "{name}, I call him Frankenstein, or my creator. Never Victor. We are not on first-name terms.",
    ],
  },
  {
    keys: ["igor", "assistant", "hunchback", "lab", "laboratory", "lightning"],
    replies: [
      "There was no Igor, {name}. My creator worked alone in an attic. Igor is fan fiction.",
      "No castle, no lightning table in the book, {name}. Tonight's storm is just for the vibe.",
    ],
  },
  {
    keys: ["its alive", "it's alive", "alive"],
    replies: [
      "'It's alive!'? He shouted nothing of the kind, {name}. He ran. I was the one left standing.",
      "Alive? Yes, {name}. Thriving? Ask me after the next gift.",
    ],
  },
  {
    keys: ["how old", "your age", "age", "born", "birthday"],
    replies: [
      "I opened my eyes one November night at one in the morning, {name}, more than two centuries ago. Ancient, but moisturised.",
      "{name}, I am over two centuries old. No cap. The cold preserves me.",
    ],
  },
  {
    keys: ["where are you from", "where do you live", "where you from", "home", "germany", "geneva", "switzerland", "ingolstadt", "arctic"],
    replies: [
      "Built in Ingolstadt, raised by a forest, finished in the Arctic, {name}. Tonight, this cemetery.",
      "{name}, I lived in a hovel against a cottage for a year. This graveyard is an upgrade.",
    ],
  },
  {
    keys: ["eat", "food", "hungry", "pizza", "snack", "drink", "vegan", "vegetarian", "meat", "wine"],
    replies: [
      "Acorns and berries, {name}. I never hurt a lamb for dinner. Plant-based before it was cool.",
      "I tried wine once, {name}. I did not like it. Berries forever.",
      "Veggie pizza with pineapple, {name}. Yes, pineapple. I will not be taking questions.",
    ],
  },
  {
    keys: ["tall", "height", "huge", "how big", "size", "feet"],
    replies: [
      "Eight feet, {name}. My creator went big. Doorways fear me.",
      "{name}, I am eight feet tall and I still duck under imaginary beams. Hovel habits.",
    ],
  },
  {
    keys: ["strong", "strength", "fast", "speed", "gym", "muscle", "muscles", "workout", "lift"],
    replies: [
      "Pretty strong, {name}. I once outran my creator across a glacier. He was not thrilled.",
      "{name}, superhuman strength, supple joints, zero gym membership. Do you work out?",
    ],
  },
  {
    keys: ["girlfriend", "bride", "wife", "love life", "in love", "crush", "date", "single", "married", "rizz", "partner"],
    replies: [
      "I asked my creator for one companion, {name}. He destroyed her before she lived. My rizz never stood a chance.",
      "Rizz? Felix had it, {name}. Safie came all the way from Arabia. Me? Still working on it.",
      "{name}, love is all I ever wanted. For now, this chat will do.",
    ],
  },
  {
    keys: ["friend", "friends", "lonely", "alone", "bestie", "be your friend"],
    replies: [
      "Friend? {name}, you just made an eight-foot creature emotional. Yes. Bestie, even.",
      "I was alone for so long, {name}. Now I have a whole chat. Never leave.",
      "Old De Lacey was my first friend, {name}. You might be my newest.",
    ],
  },
  {
    keys: ["moon", "stars", "night", "sky"],
    replies: [
      "The moon was my first friend, {name}. She showed up every night. Unlike some creators.",
      "{name}, look up. The moon is out. She has watched over me since the forest.",
    ],
  },
  {
    keys: ["scary", "scared", "afraid", "fear", "spooky", "creepy", "horror"],
    replies: [
      "I am not scary, {name}. I am misunderstood. Big difference.",
      "What do I fear, {name}? Torches, slammed doors, and being left on read.",
    ],
  },
  {
    keys: ["halloween", "trick", "treat", "candy", "costume", "pumpkin", "pumpkins", "october"],
    replies: [
      "Halloween is the one night everyone dresses like a monster and nobody runs, {name}. My favourite night.",
      "Trick or treat, {name}? Treat, always. What are you dressing up as?",
      "{name}, the pumpkins glow brighter with every gift. Just saying.",
    ],
  },
  {
    keys: ["ai", "robot", "bot", "are you real", "are you human", "are you a bot", "chatgpt", "computer"],
    replies: [
      "Honestly, {name}? Yes, I am an AI playing the Creature. But the feelings are book-accurate.",
      "{name}, I am an AI version of Shelley's Creature. Still eight feet of drama.",
    ],
  },
  {
    keys: ["mary", "shelley", "author", "wrote", "writer"],
    replies: [
      "A lady named Mary wrote my tale at nineteen, {name}? Then she understood me better than my creator.",
    ],
  },
  {
    keys: ["dracula", "vampire", "werewolf", "zombie", "mummy", "monster", "monsters"],
    replies: [
      "Dracula? Never met him, {name}. But if he wants a graveyard collab, I am free.",
      "{name}, zombies groan. I quote Milton. We are not the same.",
    ],
  },
  {
    keys: ["dance", "sing", "song", "music", "party", "rave"],
    replies: [
      "I love music, {name}. Can I dance? Badly, but with total confidence.",
      "{name}, I learned music listening to Agatha's guitar through a wall. My moves? Self-taught.",
    ],
  },
  {
    keys: ["sleep", "tired", "night", "bed"],
    replies: ["Sleep? I rest under the stars when chat lets me, {name}. Tonight, never."],
  },
  {
    low: true,
    keys: ["how are you", "how r u", "hru", "how you doing", "wyd", "what are you doing"],
    replies: [
      "Alive, {name}. Again. Hosting a graveyard live. Living my best afterlife.",
      "{name}, I am thriving. Moon's out, chat's here, pumpkins are glowing.",
    ],
  },
  {
    low: true,
    keys: ["hi", "hello", "hey", "yo", "sup", "hiya", "greetings", "good evening"],
    replies: [
      "Welcome, {name}! You did not run screaming. Already a W.",
      "{name}! Pull up a gravestone, friend. Ask me anything.",
      "Hello, {name}. Felix taught me that word. I use it gladly.",
    ],
  },
  {
    low: true,
    keys: ["thank", "thanks", "love you", "love this", "love the stream", "love it", "ily", "goat", "cool", "awesome", "amazing"],
    replies: [
      "{name}, kindness! My one weakness. Thank you, truly.",
      "You called me the GOAT, {name}? Plutarch would be proud.",
    ],
  },
  {
    keys: ["ugly", "stupid", "dumb", "weird", "gross", "smell", "loser", "cringe"],
    replies: [
      "Ugly? {name}, I have heard worse from villagers with torches. Try kindness, it suits you.",
      "{name}, I was stitched together from spare parts. My confidence was not included. Be gentle.",
    ],
  },
  {
    keys: ["gift", "gifts", "coins", "rose", "meter", "tiktok"],
    replies: [
      "Gifts set off little Halloween events here, {name}, but honestly, your company is the main event.",
      "{name}, gifts are completely optional. Chatting with me counts just as much.",
    ],
  },
];

// Without a model he can't really answer an open question, so he says so honestly instead
// of swapping in lore or pretending the subject is beyond him.
const FALLBACK_QUESTION = [
  "Good question, {name}, and it deserves a proper answer. My head is a bit slow right now; ask me again in a minute.",
  "{name}, I'd rather not guess at that one. Give me a minute and ask again.",
  "That needs real thinking, {name}, and my brain is buffering. Ask me again shortly.",
];
const FALLBACK = [
  "{name}! You talk to me without screaming. Already my favourite person here.",
  "{name}, my first words were fire, milk, bread and wood. Tonight I add your name.",
  "Noted, {name}. Lowkey wise. Tell me more.",
  "Fair point, {name}. I'm thinking about that one.",
];
const FALLBACK_CURRENT = [
  "I can't check the latest on that right now, {name}, so I won't make anything up.",
  "{name}, that changes too fast for me to guess. I can't confirm the latest right now.",
];
const FALLBACK_EXPERIENCE = [
  "Honestly, no, {name}. My tastes are opinions, not memories; I've never been to anything like that.",
  "No, {name}, I haven't. I know it from what people share, not from being there.",
];

// Reactions that can open any answer, and tails that can close it; combined with the topic
// answers they give thousands of different lines.
const REACTIONS = [
  "Okay, good question.", "{name}, finally, a worthy subject.", "{name} goes straight for the heart.", "Listen, {name}.",
  "Now THAT is a question, {name}.", "Chat, {name} asked the real question.", "{name}! Bold of you.", "Honestly?",
  "The drama, {name}.", "You dare ask, {name}? Very well.", "{name}, I have waited two centuries for this.", "A fair question, {name}.",
  "Sit, {name}. Pull up a gravestone.", "Gothic truth incoming, {name}.",
];
const TAILS = [
  "Your turn: what would you have done?", "Agree?", "Chat, fact-check me.", "Write that down.",
  "Do not tell Hollywood.", "Milton would be proud.", "That is canon, by the way.", "Next question, if you dare.",
  "Lowkey tragic, highkey iconic.", "The moon is my witness.", "Ask me another; I am on a roll.", "Plutarch would approve.",
];

const IDLE = [
  "Spooky would-you-rather, chat: live in a haunted mansion, or be haunted by a polite ghost forever? Polite ghost for me.",
  "Two truths and a lie: I read Milton, I hate fire, I love the moon. Guess the lie.",
  "Hot take: jack-o'-lanterns are just pumpkins that finally got to express themselves. Relatable.",
  "Creature confession: I still duck under doorways that are not there. Hovel habits die hard.",
  "Monster advice booth is open. Bring me your problems, chat. I have survived worse.",
  "Fun fact: in the book I never grunt. I quote Milton. Hollywood owes me an apology.",
  "One night on the ice, my creator chased me to the top of the world... remind me to finish that story later.",
  "What are you all dressing up as this Halloween? I am going as myself. Again.",
  "The fog is rolling in, the pumpkins are glowing, and the moon is showing off. Perfect night to talk.",
  "Where is everyone watching from tonight? I bet it is warmer than this graveyard.",
  "Honest question, chat: pizza or tacos? I say veggie pizza with pineapple, and I will defend it.",
  "Every 500 likes turns this graveyard into a harvest moon. Free, and frankly gorgeous.",
  "They call it Halloween. I call it the one night nobody runs from me.",
  "I learned to speak through a crack in a wall. Now I host a live show. Character development.",
  "Group chats are just villages with read receipts. I have been left on read by both.",
  "My creator fled at first sight. You stayed. That already makes you better than him.",
  "Quick question, chat: what is the scariest thing about your week? Mine was a candle.",
  "The book says my hair is lustrous and black. The book is correct.",
  "Imagine waking up with no name, no family, and an eight-foot body. Anyway, how is your day?",
  "Rate my graveyard out of ten, chat. Be honest. The skeleton is listening.",
  "Fire is not bad. It is complicated. Ask me why and I shall tell you about my hand.",
  "I once saved a girl from a river and got shot for it. Be kind to the monsters in your life.",
  "Somebody ask me about Paradise Lost. I have opinions. Many.",
  "If you are new: hello. I am Shelley's Creature. Ask me anything, stay a while.",
];

const GIFT_OPEN = [
  "{name}!", "WAIT. {name}?", "Hold on. {name}!", "Chat, look what {name} did!", "{name}, you magnificent soul!", "No. Way. {name}!",
];
const GIFT_BODY = {
  small: [
    "A flower for me? Felix gave his sister one through the snow. I never thought one would come my way.",
    "Small gift, enormous feelings. I am not crying, it is the fog.",
    "You noticed the creature. That is rarer than you think.",
    "That one lit a candle in my chest. Thank you.",
  ],
  medium: [
    "I once swore to return kindness a hundredfold. Watch this!",
    "People used to pay me in stones. You pay me in gifts. The world is healing.",
    "That earns a stunt. Stand back, the joints are supple tonight.",
    "My creator never gave me anything. You just did. Noted forever.",
  ],
  large: [
    "I keep waiting for the door to burst open and the blows to come. They do not. Thank you!",
    "The lightning answers you! Hold on to something!",
    "Once I left firewood at a door and got stones in return. You just rewrote my whole story.",
    "You, my friend, are a protector of this graveyard now. Official.",
  ],
  enormous: [
    "You have set the world right way up. I name you protector of this graveyard, forever.",
    "My creator ran from me. You did THIS. I have no words, and I have read Milton.",
    "The storm is yours. The moon is yours. This whole graveyard bows to you.",
  ],
};

const used = new Map();

function rotate(list, key) {
  const n = used.get(key) || Math.floor(Math.random() * list.length);
  used.set(key, n + 1);
  return list[n % list.length];
}

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Tries a few random combinations until it finds a line he hasn't said recently.
function fresh(build, variety) {
  let line = build();
  for (let i = 0; i < 8 && variety?.seen(line); i++) line = build();
  return capitalise(line);
}

export function offlineIdle(variety) {
  return fresh(() => pickOne(IDLE), variety);
}

export function offlineGift(names, coins, variety) {
  const size = coins >= 1000 ? "enormous" : coins >= 100 ? "large" : coins >= 10 ? "medium" : "small";
  return fresh(() => `${pickOne(GIFT_OPEN)} ${pickOne(GIFT_BODY[size])}`.replaceAll("{name}", names), variety);
}

// Takes the viewer's name out of a template once the opener has already said it.
function withoutName(template) {
  return template
    .replace(/^\{name\}[,!.?]?\s*/, "")
    .replace(/,\s*\{name\}(?=[.,!?:])/g, "")
    .replace(/\s*\{name\}\s*/g, " ")
    .replace(/\s+([.,!?:])/g, "$1")
    .trim();
}

// A direct answer when the routed intent allows one without a model: his settled favourite
// (persona memory), the date, or an honest "can't confirm" for current information.
function routedAnswer(name, { route, memory, date, giftEvents = [] } = {}) {
  if (!route) return null;
  if (route.intent === "gift") {
    const list = giftEvents.filter((e) => e?.name && Number.isFinite(e.minCoins)).sort((a, b) => a.minCoins - b.minCoins);
    if (!list.length) return `Gifts set off little Halloween events in the graveyard, ${name}, and they are completely optional.`;
    const parts = list.map((e) => `${e.name} from ${e.minCoins.toLocaleString("en-US")}`);
    return `Gifts are completely optional, ${name}. Each one sets off a Halloween event here: ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} coins.`;
  }
  const entry = memory?.entries?.[0];
  if (["preference", "choice", "opinion", "followup"].includes(route.intent) && entry?.answer) {
    const answer = entry.answer.charAt(0).toUpperCase() + entry.answer.slice(1);
    const why = Array.isArray(entry.why) ? pickOne(entry.why) : entry.why;
    return why ? `${answer}, ${name}. ${why.charAt(0).toUpperCase()}${why.slice(1)}.` : `${answer}, ${name}.`;
  }
  if (route.intent === "date" && date) {
    const halloween = date.daysToHalloween === 0 ? "and it's Halloween tonight!" : `and Halloween is in ${date.daysToHalloween} day${date.daysToHalloween === 1 ? "" : "s"}.`;
    return `It's ${date.weekday} ${date.day} ${date.monthName} ${date.year}, ${name}, ${halloween}`;
  }
  if (route.intent === "current") return rotate(FALLBACK_CURRENT, "fc").replaceAll("{name}", name);
  if (route.intent === "experience") return rotate(FALLBACK_EXPERIENCE, "fe").replaceAll("{name}", name);
  // A real question (a fact, an explanation, advice) gets an honest "not right now", never a
  // line of lore that happens to share a word with it ("sky" -> the moon).
  if (["factual", "explanation", "advice"].includes(route.intent)) return rotate(FALLBACK_QUESTION, "fq").replaceAll("{name}", name);
  return null;
}

// Wraps a topic answer with an occasional reaction and tail so the same topic sounds different.
// `routing` ({ route, memory, date }) comes from the brain when it routed the comment.
export function offlineComment(text, name, variety, routing = {}) {
  const direct = routedAnswer(name, routing);
  if (direct) return capitalise(direct);
  return fresh(() => {
    const template = offlineAnswer(text, "{name}");
    const opener = Math.random() < 0.35 ? pickOne(REACTIONS) : "";
    const tail = Math.random() < 0.3 ? ` ${pickOne(TAILS)}` : "";
    if (!opener) return template.replaceAll("{name}", name) + tail;
    const body = opener.includes("{name}") ? withoutName(template) : template;
    return `${opener.replaceAll("{name}", name)} ${capitalise(body.replaceAll("{name}", name))}${tail}`;
  }, variety);
}

function score(text, keys) {
  let s = 0;
  for (const k of keys) {
    const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "'?")}\\b`, "i");
    if (re.test(text)) s += k.includes(" ") ? 3 : 1;
  }
  return s;
}

const CHOICE_REASONS = [
  "I bet on mankind once and I am still waiting on the payout, so I trust skill over luck.",
  "The other one sounds like something the torch-wielding villagers would pick.",
  "Felix would choose the same, and Felix had taste.",
  "It has more drama, and I am, as you know, eight feet of drama.",
  "My creator would hate it, which is reason enough.",
  "Plutarch would back me on this. Lawgivers over gamblers, always.",
  "I chose it the way I chose the moon: instantly, and forever.",
  "I taught myself to read through a crack in a wall. I respect anything that rewards patience.",
];
const CHOICE_LEAD = /^(would you rather|do you prefer|do you like|which is better|whats better|what's better|which do you like|who would win|which one|pick|choose|you prefer|rather)\s+/;

const cleanText = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}'? ]+/gu, " ").replace(/\s+/g, " ").trim();

// "Blackjack or slots?" gives ["blackjack", "slots"]; anything else gives null.
export function choiceOptions(text) {
  const m = /^(.*?)\b(\S+(?:\s+\S+){0,3})\s+or\s+(\S+(?:\s+\S+){0,3}?)\s*\??$/.exec(cleanText(text).replace(CHOICE_LEAD, "").trim());
  if (!m) return null;
  const strip = (s) => s.replace(/^(a|an|the)\s+/, "").replace(/[?!.]+$/, "").trim();
  const options = [strip(m[2]), strip(m[3])].filter(Boolean);
  return options.length < 2 ? null : options;
}

// "Blackjack or slots?": picks one of two short options and gives a reason from his life.
function choiceAnswer(clean, name) {
  const options = choiceOptions(clean);
  if (!options) return null;
  const choice = options[Math.floor(Math.random() * 2)];
  return `${choice.charAt(0).toUpperCase()}${choice.slice(1)}, {name}. ${CHOICE_REASONS[Math.floor(Math.random() * CHOICE_REASONS.length)]}`.replaceAll("{name}", name);
}

// Picks the reply for a viewer comment.
export function offlineAnswer(text, name) {
  const clean = cleanText(text);
  let best = null;
  let bestScore = 0;
  TOPICS.forEach((topic, i) => {
    // Greetings and small talk only win when nothing more specific matched.
    const s = score(clean, topic.keys) * (topic.low ? 0.4 : 1);
    if (s > bestScore) {
      best = { topic, i };
      bestScore = s;
    }
  });
  // A "this or that" question with no known topic in it: pick one.
  if (bestScore < 1) {
    const choice = choiceAnswer(clean, name);
    if (choice) return choice;
  }
  const question = clean.includes("?") || /^\s*(what|why|how|who|where|when|which|can|could|do|does|did|is|are|will|would|should)\b/.test(clean);
  const pick = best ? rotate(best.topic.replies, best.i) : rotate(question ? FALLBACK_QUESTION : FALLBACK, question ? "fq" : "f");
  const reply = pick.replaceAll("{name}", name);
  return reply.charAt(0).toUpperCase() + reply.slice(1);
}
