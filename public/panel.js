import { PROFILES, PROFILE_IDS, TIKTOK_KEYS, REGION_KEYS, TIKTOK_LABELS, REGION_LABELS, profileNumbers, resolveLayout, zonesTouching } from "/stream/safe-areas.js";

const $ = (id) => document.getElementById(id);
const NAMES = ["night_owl", "elizabeth_l", "clerval_fan", "safie22", "ingolstadt_kid", "geneva.girl", "arctic_walker", "milton_reader"];

let socket = null;
let settings = null;
let actions = [];

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --- Tabs ---
document.querySelectorAll("[role=tab]").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  };
});

// --- Status ---
function pill(id, text, good) {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${good ? "good" : "warn"}`;
}

function showStatus(s) {
  $("brain-status").textContent = s.brainOnline
    ? `He is thinking with ${s.brain}. Replies are written fresh for every comment.`
    : "No AI connected: he can only use built-in lines and won't truly understand chat. Add a Claude key or start Ollama.";
  $("brain-card").classList.toggle("warn-card", !s.brainOnline);
  const tk = s.tiktok;
  const verified = tk.state === "connected" && tk.health?.events === "verified";
  pill("pill-tiktok", tk.state === "connected" ? `TikTok: @${tk.username}${tk.health && !verified ? " (no events yet)" : ""}` : `TikTok: ${tk.state.replace("_", " ")}`, tk.state === "connected");
  pill("pill-brain", s.brain.startsWith("Claude") ? "Brain: Claude" : "Brain: offline lines", s.brain.startsWith("Claude"));
  pill("pill-voice", `Voice: ${{ loading: "loading…", ready: "ready", error: "failed" }[s.voice] || s.voice}`, s.voice === "ready");
  pill("pill-streams", `Stream windows: ${s.streams}`, s.streams > 0);
  $("tiktok-status").textContent = tiktokText(tk);
  renderFlagged(s.show.flagged || []);
}

const seconds = (ms) => `${Math.max(0, Math.ceil((ms || 0) / 1000))} s`;

// One line for the Go live card, per connection state.
function tiktokText(tk) {
  const retry = tk.retry ? ` Next try in ${seconds(tk.retry.inMs ?? tk.retry.nextAt - Date.now())}.` : "";
  switch (tk.state) {
    case "connected": {
      const h = tk.health;
      if (!h) return `Connected to @${tk.username}'s LIVE. Chat and gifts now drive the show.`;
      if (h.events === "verified") return `Connected to @${tk.username}'s LIVE. Events arriving (last ${seconds(h.msSinceLastEvent)} ago). Chat and gifts now drive the show.`;
      if (h.events === "silent") return `Socket open to @${tk.username}'s LIVE, but nothing received for ${seconds(h.msSinceLastEvent)}. Is the LIVE still running?`;
      return `Socket open to @${tk.username}'s LIVE; waiting for the first event.`;
    }
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Connection lost (${tk.error || "network"}). Reconnecting automatically.${retry}`;
    case "rate_limited":
      return `The sign server is rate limiting new connections.${retry} An EULER_API_KEY in .env raises the limit.`;
    case "offline":
      return `@${tk.username} is not live right now. Start the LIVE on TikTok; the show checks again automatically.${retry}`;
    case "ended":
      return `@${tk.username}'s LIVE ended. Press connect when you go live again.`;
    case "auth_failed":
      return `Sign or authentication failure: ${tk.error}. Check EULER_API_KEY in .env, then press connect.`;
    case "error":
      return `Could not connect: ${tk.error}. Make sure the LIVE has started and the username is right.`;
    default:
      return "Start your LIVE on TikTok first, then press the button. Chat and gifts are only read, nothing is posted.";
  }
}

function addLine(list, { who, text, cls, at }) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  const time = document.createElement("time");
  time.textContent = new Date(at || Date.now()).toLocaleTimeString();
  li.append(time);
  if (who) {
    const b = document.createElement("b");
    b.textContent = `${who}: `;
    li.append(b);
  }
  li.append(document.createTextNode(text));
  list.prepend(li);
  while (list.children.length > 200) list.lastChild.remove();
}

function renderFlagged(items) {
  const list = $("flagged");
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "Nothing hidden so far.";
    list.append(li);
  }
  for (const f of items) addLine(list, { who: `${f.nick} (${f.reason})`, text: f.text, at: f.at });
}

// --- Settings ---
const debounce = (fn, ms = 250) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};
const saveSettings = debounce((patch) => post("/api/settings", patch).then(applySettings));

function bindRange(id, read, write) {
  const input = $(id);
  const out = input.parentElement.querySelector("output");
  input.oninput = () => {
    out.textContent = input.value;
    saveSettings(write(Number(input.value)));
  };
  return (s) => {
    input.value = read(s);
    out.textContent = input.value;
  };
}

const ranges = [
  bindRange("musicVolume", (s) => s.music.volume, (v) => ({ music: { volume: v } })),
  bindRange("voicePitch", (s) => s.voice.pitch, (v) => ({ voice: { pitch: v, preset: "custom" } })),
  bindRange("voiceSpeed", (s) => s.voice.speed, (v) => ({ voice: { speed: v, preset: "custom" } })),
];

$("voicePreset").onchange = () => {
  const preset = $("voicePreset").value;
  if (preset !== "custom") saveSettings({ voice: { preset } });
};
$("voiceTest").onclick = () => post("/api/say", { text: "Hear my tale, friend. It is long and strange, but I promise it slaps.", mood: "amused" });
$("readerVoice").onchange = () => saveSettings({ readerVoice: $("readerVoice").value });

for (const [id, key] of [["readComments", "readComments"], ["commandsEnabled", "commandsEnabled"]]) {
  $(id).onchange = () => saveSettings({ [key]: $(id).checked });
}
$("showTopGifter").onchange = () => saveSettings({ layout: { showTopGifter: $("showTopGifter").checked } });

// --- Layout and safe areas ---
// The profile menu, the table of numbers (always showing the profile in force; editing it makes a
// Custom profile that starts from it), a warning list, and the layout-check switch.
const RECT_FIELDS = ["x", "y", "w", "h"];
const rectInputs = {}; // "tiktok.chat" -> { x, y, w, h } inputs

$("layoutProfile").replaceChildren(
  ...PROFILE_IDS.map((id) => Object.assign(document.createElement("option"), { value: id, textContent: id === "custom" ? "Custom (your own numbers)" : `${PROFILES[id].label}${id === "standard" ? " (default)" : ""}` })),
);

function buildRectTable() {
  const rows = [];
  const group = (text) => {
    const tr = document.createElement("tr");
    tr.className = "group";
    const td = Object.assign(document.createElement("td"), { colSpan: 5, textContent: text });
    tr.append(td);
    rows.push(tr);
  };
  const row = (path, label) => {
    const tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), { textContent: label }));
    rectInputs[path] = {};
    for (const f of RECT_FIELDS) {
      const input = Object.assign(document.createElement("input"), { type: "number", min: 0, max: 100, step: 0.5, ariaLabel: `${label} ${f}` });
      // The captions and the info block are always centred, so their left edge follows the width.
      if (f === "x" && (path === "regions.captions" || path === "regions.info")) {
        input.readOnly = true;
        input.title = "Always centred: the left edge follows the width.";
      }
      input.oninput = saveCustomRects;
      rectInputs[path][f] = input;
      tr.append(Object.assign(document.createElement("td"), {}));
      tr.lastChild.append(input);
    }
    rows.push(tr);
  };
  group("TikTok interface (estimated)");
  for (const k of TIKTOK_KEYS) row(`tiktok.${k}`, TIKTOK_LABELS[k]);
  group("Protected regions");
  for (const k of REGION_KEYS) row(`regions.${k}`, REGION_LABELS[k]);
  $("rectRows").replaceChildren(...rows);
}
function readRects() {
  const out = { tiktok: {}, regions: {} };
  for (const [path, inputs] of Object.entries(rectInputs)) {
    const [group, key] = path.split(".");
    out[group][key] = Object.fromEntries(RECT_FIELDS.map((f) => [f, Number(inputs[f].value)]));
  }
  return out;
}

const saveCustomRects = debounce(() => saveSettings({ layout: { profile: "custom", custom: readRects() } }), 400);
buildRectTable();
$("layoutProfile").onchange = () => {
  const profile = $("layoutProfile").value;
  // Choosing Custom for the first time starts from the numbers on screen.
  if (profile === "custom" && !settings?.layout?.custom) saveSettings({ layout: { profile, custom: readRects() } });
  else saveSettings({ layout: { profile } });
};

function renderLayout(layout) {
  $("layoutProfile").value = layout.profile;
  $("profileNote").textContent = layout.profile === "custom" ? "Your own numbers, edited below." : PROFILES[layout.profile].note;
  if (!$("rectRows").contains(document.activeElement)) {
    const numbers = profileNumbers(layout);
    for (const [path, inputs] of Object.entries(rectInputs)) {
      const [group, key] = path.split(".");
      for (const f of RECT_FIELDS) inputs[f].value = inputs[f].readOnly ? Math.round((100 - numbers[group][key].w) * 5) / 10 : numbers[group][key][f];
    }
  }
  // Where the dialogue and supporter regions run into the estimated TikTok zones.
  const resolved = resolveLayout(layout);
  const names = { header: "top bar", chat: "comments", rail: "buttons", input: "comment box" };
  const warnings = ["captions", "info", "face", "hands"].flatMap((k) => {
    const touching = zonesTouching(resolved.regions[k], resolved.tiktok);
    return touching.length ? [`${REGION_LABELS[k]} overlaps TikTok's ${touching.map((z) => names[z]).join(" and ")}.`] : [];
  });
  $("layoutWarnings").textContent = warnings.length ? `Heads up: ${warnings.join(" ")}` : "No region overlaps an estimated TikTok zone.";
}

let layoutCheckOn = false;
function showLayoutCheck(on) {
  layoutCheckOn = on;
  $("layoutCheck").textContent = on ? "Hide layout check" : "Show layout check on the stream";
  $("layoutCheck").classList.toggle("primary", on);
  $("layoutCheckState").textContent = on ? "ON: boxes are visible on the stream window. Turn it off before going live." : "";
}
$("layoutCheck").onclick = () => post("/api/layout-check", { on: !layoutCheckOn }).then((r) => showLayoutCheck(r.on));

// --- Audience moments ---
const interactionFields = [
  ["choicesOn", "choices", "checkbox"],
  ["choiceMinutes", "choiceMinutes", "number"],
  ["mysteriesOn", "mysteries", "checkbox"],
  ["mysteryMinutes", "mysteryMinutes", "number"],
  ["surprisesOn", "surprises", "checkbox"],
  ["surpriseMinutes", "surpriseMinutes", "number"],
];
for (const [id, key, kind] of interactionFields) {
  $(id).onchange = () => saveSettings({ interaction: { [key]: kind === "checkbox" ? $(id).checked : Number($(id).value) } });
}
for (const [id, action] of [["startChoice", "choice"], ["startMystery", "mystery"], ["startSurprise", "surprise"], ["cancelInteraction", "cancel"]]) {
  $(id).onclick = () => post("/api/interaction", { action }).then(showInteraction).catch((err) => alert(err.message));
}

const minutesText = (ms) => (ms == null ? "off" : ms < 60_000 ? "under a minute" : `about ${Math.round(ms / 60_000)} min`);
function showInteraction(i) {
  if (!i) return;
  const d = i.detail;
  let text;
  if (d?.kind === "choice") text = `Running: a vote "${d.question}", ${d.phase === "open" ? `${Math.ceil(d.leftMs / 1000)} s left, ` : "showing the result, "}${d.votes} voter${d.votes === 1 ? "" : "s"}.`;
  else if (d?.kind === "mystery") text = `Running: a mystery (${d.what}), ${{ clue: "waiting for chat to notice it", walking: "he is walking over", payoff: "paying off" }[d.state] || d.state}.`;
  else if (d?.kind === "surprise") text = `Running: a shooting star, ${d.wishes} wish${d.wishes === 1 ? "" : "es"} so far.`;
  else text = `Next: choice ${minutesText(i.nextInMs.choice)}, mystery ${minutesText(i.nextInMs.mystery)}, surprise ${minutesText(i.nextInMs.surprise)}. ${i.quiet ? "It is quiet now." : "Waiting for a quiet moment (chat, speech or a gift is in the way)."}`;
  $("interactionStatus").textContent = text;
}
// The live preview is a second copy of the whole 3D scene, so it only exists while wanted.
$("previewToggle").onclick = () => {
  const slot = $("previewSlot");
  if (slot.firstChild) {
    slot.replaceChildren();
    $("previewToggle").textContent = "Show preview";
  } else {
    const frame = document.createElement("iframe");
    frame.src = "/stream?preview=1";
    frame.title = "Stream preview (muted)";
    slot.append(frame);
    $("previewToggle").textContent = "Hide preview";
  }
};

$("graphics").onclick = (e) => {
  const value = e.target.closest("button")?.dataset.value;
  if (value) saveSettings({ graphics: value });
};
$("fps").onclick = (e) => {
  const value = e.target.closest("button")?.dataset.value;
  if (value) saveSettings({ fps: Number(value) });
};

function applySettings(s) {
  settings = s;
  if (document.activeElement !== $("username")) $("username").value = s.tiktokUsername || "";
  $("readComments").checked = s.readComments;
  $("commandsEnabled").checked = s.commandsEnabled;
  $("showTopGifter").checked = s.layout.showTopGifter;
  renderLayout(s.layout);
  const i = s.interaction;
  for (const [id, key, kind] of interactionFields) {
    if (document.activeElement === $(id)) continue;
    if (kind === "checkbox") $(id).checked = i[key];
    else $(id).value = i[key];
  }
  document.querySelectorAll("#graphics button").forEach((b) => b.classList.toggle("on", b.dataset.value === s.graphics));
  document.querySelectorAll("#fps button").forEach((b) => b.classList.toggle("on", Number(b.dataset.value) === s.fps));
  if (!document.activeElement?.matches("input[type=range]")) ranges.forEach((r) => r(s));
  $("voicePreset").value = s.voice.preset in { "deep giant": 1, gravel: 1, "gentle giant": 1, "old world": 1, booming: 1 } ? s.voice.preset : "custom";
  $("readerVoice").value = [...$("readerVoice").options].some((o) => o.value === s.readerVoice) ? s.readerVoice : "varied";
  renderTracks(s.music.tracks);
  renderThresholds(s.eventThresholds);
}

// --- Music ---
function renderTracks(tracks) {
  const list = $("tracks");
  list.replaceChildren();
  for (const name of tracks) {
    const li = document.createElement("li");
    li.textContent = name;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.onclick = () => fetch(`/api/music?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(() => fetch("/api/settings")).then((r) => r.json()).then(applySettings);
    li.append(remove);
    list.append(li);
  }
  if (!tracks.length) {
    const li = document.createElement("li");
    li.textContent = "No music yet.";
    list.append(li);
  }
}

$("music-upload").onchange = async (e) => {
  for (const file of e.target.files) {
    const res = await fetch(`/api/music?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    if (!res.ok) alert((await res.json()).error);
  }
  e.target.value = "";
  applySettings(await (await fetch("/api/settings")).json());
};

// --- Brain ---
$("brain-key").addEventListener("submit", async (e) => {
  e.preventDefault();
  const anthropicKey = $("apiKey").value.trim();
  if (!anthropicKey) return;
  try {
    const r = await post("/api/brain", { anthropicKey });
    $("apiKey").value = "";
    $("brain-status").textContent = `Saved. He is thinking with ${r.brain}.`;
  } catch (err) {
    alert(err.message);
  }
});
$("brain-refresh").onclick = async () => {
  const r = await post("/api/brain", {});
  $("brain-status").textContent = r.online ? `He is thinking with ${r.brain}.` : "No local AI found. Is Ollama running with a model pulled?";
};

// --- Go live ---
$("tiktok").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  if (username) await post("/api/connect", { username }).catch((err) => alert(err.message));
});
$("disconnect").onclick = () => post("/api/disconnect", {});
$("skip").onclick = () => post("/api/skip", {});
$("stream-url").value = `${location.origin}/stream`;
$("copy-url").onclick = () => navigator.clipboard.writeText($("stream-url").value);

// --- Testing ---
function viewer() {
  const nick = $("viewer").value.trim() || NAMES[0];
  return { id: nick.toLowerCase(), nick, avatar: null };
}

function randomViewer() {
  $("viewer").value = `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(Math.random() * 90 + 10)}`;
}

const sendComment = (text) => send({ t: "sim", event: { kind: "comment", user: viewer(), text } });

$("chat").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  sendComment(text);
  $("message").value = "";
});

$("quick").addEventListener("click", (e) => {
  const text = e.target.closest("button")?.dataset.text;
  if (!text) return;
  randomViewer();
  sendComment(text);
});

$("gifts").addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  const user = viewer();
  const gift = { id: button.dataset.name, name: button.dataset.name, coins: Number(button.dataset.coins), image: null };
  if ($("streak").checked) {
    for (let count = 1; count <= 10; count++) {
      send({ t: "sim", event: { kind: "gift", user, gift: { ...gift, count, streaking: true } } });
      await new Promise((r) => setTimeout(r, 150));
    }
    send({ t: "sim", event: { kind: "gift", user, gift: { ...gift, count: 10, streaking: false } } });
  } else {
    send({ t: "sim", event: { kind: "gift", user, gift: { ...gift, count: 1, streaking: false } } });
  }
});

$("follow").onclick = () => send({ t: "sim", event: { kind: "follow", user: viewer() } });
$("share").onclick = () => send({ t: "sim", event: { kind: "share", user: viewer() } });
$("like").onclick = () => send({ t: "sim", event: { kind: "like", user: viewer(), count: 100 } });
$("actions").addEventListener("click", (e) => {
  const action = e.target.closest("button")?.dataset.action;
  if (action) send({ t: "action", action });
});

// --- Halloween events: the five thresholds, and the operator controls ---
// The events (id, name, availability) come from GET /api/state "events" (and from the guide the
// show sends); the values are settings.eventThresholds, kept strictly increasing by the server.
const DEFAULT_EVENTS = [
  { id: "bolt", name: "Bolt Spark", minCoins: 30 },
  { id: "pumpkin", name: "Pumpkin Whisper", minCoins: 100 },
  { id: "gate", name: "Haunted Gate", minCoins: 500 },
  { id: "lab", name: "Laboratory Surge", minCoins: 1000 },
  { id: "grand", name: "The Grand Reanimation", minCoins: 3000 },
];
let eventDefs = DEFAULT_EVENTS;
const eventInputs = {}; // id -> { input, range }
const fmtCoins = (n) => Number(n).toLocaleString("en-US");

function setEventDefs(list) {
  const defs = (Array.isArray(list) ? list : []).filter((e) => e && e.id && e.name);
  eventDefs = defs.length ? defs : DEFAULT_EVENTS;
  const rows = eventDefs.map((e) => {
    const tr = document.createElement("tr");
    const name = Object.assign(document.createElement("td"), { textContent: e.name + (e.available === false ? " (paused: asset missing)" : "") });
    const input = Object.assign(document.createElement("input"), { type: "number", min: 1, step: 1, ariaLabel: `${e.name}: from coins` });
    input.onchange = () => {
      const eventThresholds = Object.fromEntries(eventDefs.map((d) => [d.id, Number(eventInputs[d.id].input.value)]));
      saveSettings({ eventThresholds });
    };
    const range = Object.assign(document.createElement("td"), { className: "range-cell" });
    const cell = document.createElement("td");
    cell.append(input);
    tr.append(name, cell, range);
    eventInputs[e.id] = { input, range };
    return tr;
  });
  $("eventRows").replaceChildren(...rows);
  const select = $("auditionId");
  const chosen = select.value;
  select.replaceChildren(...eventDefs.map((e) => Object.assign(document.createElement("option"), { value: e.id, textContent: `${e.name}${e.available === false ? " (paused)" : ""}` })));
  if (eventDefs.some((e) => e.id === chosen)) select.value = chosen;
  renderThresholds(settings?.eventThresholds || Object.fromEntries(eventDefs.map((e) => [e.id, e.minCoins])));
}

function renderThresholds(values) {
  if (!values || $("eventRows").contains(document.activeElement)) return;
  eventDefs.forEach((e, i) => {
    const slot = eventInputs[e.id];
    if (!slot) return;
    const min = values[e.id] ?? e.minCoins;
    const next = values[eventDefs[i + 1]?.id];
    slot.input.value = min;
    slot.range.textContent = next == null ? `${fmtCoins(min)}+` : `${fmtCoins(min)}–${fmtCoins(next - 1)}`;
  });
  const first = values[eventDefs[0]?.id];
  $("eventsNote").textContent = first ? `Gifts below ${fmtCoins(first)} coins get a short thank-you. The guide on the stream shows these values.` : "";
}
setEventDefs(null);

function eventOp(path, body, doing) {
  $("eventOpsStatus").textContent = `${doing}…`;
  return post(path, body || {})
    .then((r) => {
      $("eventOpsStatus").textContent = r?.message || `${doing}: done.`;
    })
    .catch((err) => {
      $("eventOpsStatus").textContent = `${doing}: ${err.message}`;
    });
}
$("auditionEvent").onclick = () => eventOp("/api/event/audition", { id: $("auditionId").value }, `Audition ${$("auditionId").selectedOptions[0]?.textContent || ""}`);
$("cancelEvent").onclick = () => eventOp("/api/event/cancel", {}, "Cancel event");
$("returnCamera").onclick = () => eventOp("/api/event/camera", {}, "Return camera");
$("resetScene").onclick = () => eventOp("/api/event/reset", {}, "Reset scene");
// --- Moderation ---
fetch("/api/blocklist").then((r) => r.json()).then((words) => ($("blocklist").value = words.join("\n")));
$("save-blocklist").onclick = async () => {
  const { count } = await post("/api/blocklist", { words: $("blocklist").value });
  $("blocklist-status").textContent = `Saved ${count} entries.`;
};

// --- Operator ---
// Read-only view of the backend ledger and the TikTok connection. Polls only while the tab is open.
const op = { timer: null, busy: false };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString());
const clock = (at) => (at ? new Date(at).toLocaleTimeString() : "–");
const ago = (ms) => (ms == null ? "–" : ms < 1000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
const span = (ms) => (ms == null ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const who = (u) => (u ? `${u.nick || u.id}${u.uniqueId ? ` (@${u.uniqueId})` : ""}` : "–");

function renderConnection(c) {
  const s = c.connection;
  const rows = [];
  if (!s) rows.push(["State", "No TikTok source attached"]);
  else {
    const h = s.health || {};
    rows.push(
      ["State", `${s.state.replace("_", " ")}${s.errorKind ? ` (${s.errorKind})` : ""}`],
      ["Creator", s.uniqueId ? `@${s.uniqueId}${s.creator?.userId ? ` · user id ${s.creator.userId}` : ""}` : "–"],
      ["Room id", s.roomId || "–"],
      ["Socket", h.socket === "open" ? `open since ${clock(s.connectedAt)}` : "closed"],
      ["Events", { verified: "verified", silent: "socket open but silent", awaiting_first_event: "waiting for the first event", none: "–" }[h.events] || h.events || "–"],
      ["Last event", h.lastEventAt ? `${clock(h.lastEventAt)} (${ago(h.msSinceLastEvent)})` : "–"],
      ["Received", `${fmt(h.eventsThisConnection)} this connection, ${fmt(h.eventsTotal)} total`],
      ["Dropped", h.dropped ? `history ${fmt(h.dropped.history)}, duplicates ${fmt(h.dropped.duplicate)}, malformed ${fmt(h.dropped.malformed)}` : "–"],
      ["Retry", s.retry ? `${s.retry.kind}: attempt ${s.retry.attempt} in ${span(s.retry.inMs)}${s.retry.retryAfterMs ? ` (provider asked for ${span(s.retry.retryAfterMs)})` : ""}` : "none pending"],
      ["Last error", s.error || "–"],
      ["Gift list", s.giftCatalog ? `${s.giftCatalog.state}${s.giftCatalog.count ? `, ${fmt(s.giftCatalog.count)} gifts` : ""}${s.giftCatalog.error ? ` (${s.giftCatalog.error})` : ""}` : "–"],
      ["Connector", s.connector || "–"],
    );
  }
  $("op-conn").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  const gaps = c.ledgerGaps?.gaps || [];
  const list = $("op-gaps");
  list.replaceChildren();
  if (!gaps.length) list.append(el("li", { textContent: "No gaps recorded for this session." }));
  for (const g of [...gaps].reverse()) {
    const end = g.end == null ? "still open" : `${clock(g.end)}${g.endKnown === false ? " (end unknown)" : ""}`;
    list.append(el("li", { className: g.end == null ? "op-bad" : "" }, el("time", { textContent: clock(g.start) }), `${g.reason}${g.detail ? ` – ${g.detail}` : ""}: until ${end}, ${span(g.durationMs)}. Events in this period were not collected.`));
  }
}

function renderLedger(l) {
  const unit = l.unit?.label || "diamonds";
  const t = l.totals;
  const f = l.flags;
  const badges = [];
  if (!l.session) badges.push(["No session yet: connect to a LIVE.", "warn"]);
  if (f.trackingBeganMidStream) badges.push(["Tracking began mid-stream: earlier gifts are not included.", "warn"]);
  if (f.gapOpen) badges.push(["Not collecting right now (open gap).", "bad"]);
  else if (f.incomplete) badges.push([`Incomplete: ${f.gapCount} collection gap${f.gapCount === 1 ? "" : "s"} this session.`, "warn"]);
  if (f.hasPending) badges.push(["Some gift values are pending (metadata not known yet).", "warn"]);
  if (f.streamEnded) badges.push(["The LIVE ended.", "warn"]);
  if (f.lastSaveError) badges.push([`Could not save the ledger: ${f.lastSaveError}`, "bad"]);
  if (!badges.length && l.session) badges.push(["Collecting; no gaps recorded this session.", "good"]);
  $("op-flags").replaceChildren(...badges.map(([text, cls]) => el("span", { className: `op-badge ${cls}`, textContent: text })));

  const stats = [
    [`Session value (${unit})`, fmt(t.value), `${fmt(t.finalValue)} final + ${fmt(t.provisionalValue)} in open streaks`],
    ["Gifts", fmt(t.giftCount), `${fmt(t.contributions)} sends or streaks, ${fmt(t.provisionalGiftCount)} in open streaks`],
    ["Pending", fmt(t.pendingGiftCount), `${fmt(t.pendingContributions)} without a known value`],
    ["Supporters", fmt(t.supporters), `${fmt(t.timedOut)} streak${t.timedOut === 1 ? "" : "s"} closed by timeout`],
  ];
  $("op-totals").replaceChildren(...stats.map(([k, v, sub]) => el("div", { className: "op-stat" }, el("span", { className: "op-stat-k", textContent: k }), el("b", { textContent: v }), el("small", { textContent: sub }))));

  const rows = l.topSupporters || [];
  $("op-supporters").replaceChildren(
    ...(rows.length
      ? rows.map((s) =>
          el(
            "tr",
            {},
            el("td", { textContent: s.rank }),
            el("td", { textContent: who(s) }),
            el("td", { className: "num", textContent: fmt(s.giftCount) }),
            el("td", { className: "num", textContent: fmt(s.value) }),
            el("td", { className: "num", textContent: s.provisionalValue ? fmt(s.provisionalValue) : "" }),
            el("td", { className: "num", textContent: s.pendingGiftCount ? fmt(s.pendingGiftCount) : "" }),
            el("td", { textContent: clock(s.lastContributionAt) }),
          ),
        )
      : [el("tr", {}, el("td", { colSpan: 7, textContent: "No gifts with a known value yet this session." }))]),
  );

  const open = [...(l.provisional || []), ...(l.pending || []).filter((p) => !p.provisional)];
  const pend = $("op-pending");
  pend.replaceChildren();
  if (!open.length) pend.append(el("li", { textContent: "None." }));
  for (const c of open) {
    const sup = rows.find((s) => s.id === c.supporterId);
    const state = c.provisional ? "streak still open" : c.status === "timeout" ? "closed by timeout" : c.status;
    const value = c.value == null ? `value pending (${c.pendingReason === "recipient_unverified" ? "recipient not verified yet" : "gift metadata not known yet"})` : `${fmt(c.value)} ${unit}`;
    pend.append(el("li", {}, el("time", { textContent: clock(c.lastAt) }), el("b", { textContent: `${sup ? who(sup) : c.supporterId}: ` }), `${c.giftName || `gift ${c.giftId}`} ×${c.count}, ${state}, ${value}`));
  }

  const other = $("op-other");
  other.replaceChildren();
  if (!(l.otherRecipients || []).length) other.append(el("li", { textContent: "None." }));
  for (const r of l.otherRecipients || []) other.append(el("li", { textContent: `${r.nick || r.id}${r.uniqueId ? ` (@${r.uniqueId})` : ""}: ${fmt(r.giftCount)} gift${r.giftCount === 1 ? "" : "s"}, ${fmt(r.value)} ${unit}${r.pendingGiftCount ? `, ${fmt(r.pendingGiftCount)} pending` : ""}` }));

  const a = l.allTime;
  $("op-alltime").textContent = a
    ? `All sessions recorded by this app (${fmt(a.sessions)}): ${fmt(a.value)} ${unit} from ${fmt(a.giftCount)} gifts. Session totals above are kept separately.`
    : "";
}

const OUTCOME_CLASS = { accepted: "op-ok", duplicate: "op-dup", ignored: "op-ign" };

function eventDetail(e) {
  if (e.gift) {
    const g = e.gift;
    const c = e.contribution;
    const parts = [`${g.name || `gift ${g.id}`} ×${g.repeatCount ?? 1}${g.repeatEnd ? " (streak end)" : ""}`];
    if (c) parts.push(`counted ×${c.count} = ${c.value == null ? "value pending" : fmt(c.value)}, ${c.status}${c.counted === false ? ", not for this creator" : ""}`);
    return parts.join(" → ");
  }
  if (e.contribution) return `×${e.contribution.count}, ${e.contribution.value == null ? "value pending" : fmt(e.contribution.value)}, ${e.contribution.status}`;
  if (e.text) return e.text;
  if (e.count) return `${fmt(e.count)} likes`;
  return e.repeats ? `${e.repeats} times in 30 s` : "";
}

function renderEvents(data) {
  const giftsOnly = $("op-gifts-only").checked;
  const problemsOnly = $("op-problems-only").checked;
  const events = (data.events || []).filter((e) => (!giftsOnly || e.kind.startsWith("gift") || e.kind === "streak_timeout") && (!problemsOnly || e.outcome !== "accepted"));
  $("op-events").replaceChildren(
    ...(events.length
      ? events.map((e) =>
          el(
            "tr",
            {},
            el("td", { textContent: clock(e.at) }),
            el("td", { textContent: e.kind }),
            el("td", { textContent: who(e.user) }),
            el("td", { className: "op-detail", textContent: eventDetail(e) }),
            el("td", { className: OUTCOME_CLASS[e.outcome] || "", textContent: `${e.outcome}${e.reason ? `: ${e.reason.replaceAll("_", " ")}` : ""}${e.detail ? ` (${e.detail})` : ""}` }),
          ),
        )
      : [el("tr", {}, el("td", { colSpan: 5, textContent: "No events yet." }))]),
  );
}

async function getJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || res.statusText), { status: res.status });
  return res.json();
}

async function refreshOperator() {
  if (op.busy) return;
  op.busy = true;
  try {
    const [ledger, events, connection] = await Promise.all([getJson("/api/operator/ledger"), getJson(`/api/operator/events?limit=${$("op-limit").value}`), getJson("/api/operator/connection")]);
    $("op-wiring").hidden = true;
    renderConnection(connection);
    renderLedger(ledger);
    renderEvents(events);
  } catch (err) {
    $("op-wiring").hidden = false;
    $("op-wiring").textContent = err.status
      ? `The operator API is not available from the server yet (${err.status}: ${err.message}). It appears once src/operator.js is wired into server.js.`
      : `Could not reach the operator API: ${err.message}`;
  } finally {
    op.busy = false;
  }
}

function operatorVisible(visible) {
  clearInterval(op.timer);
  op.timer = null;
  if (!visible) return;
  refreshOperator();
  op.timer = setInterval(refreshOperator, 2000);
}

// The knowledge lookups behind his answers, with their sources, while the replies tab is open.
let lookupTimer = null;
async function refreshLookups() {
  const list = $("lookups");
  try {
    const { items } = await getJson("/api/knowledge/recent?limit=30");
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "No lookups yet.";
      list.append(li);
    }
    for (const k of items) {
      const li = document.createElement("li");
      const what = `${k.kind}: “${k.query}”`;
      const result = k.ok ? `${k.title || "found"} (${k.source}${k.cached ? ", cached" : ""}, ${k.ms} ms)` : `nothing (${k.error || "no result"})`;
      li.append(Object.assign(document.createElement("b"), { textContent: what }), document.createTextNode(` → ${result} `));
      for (const u of (k.urls || []).slice(0, 3)) {
        if (!/^https:\/\//.test(u)) continue;
        const a = Object.assign(document.createElement("a"), { href: u, target: "_blank", rel: "noopener noreferrer", textContent: new URL(u).hostname });
        li.append(a, document.createTextNode(" "));
      }
      list.append(li);
    }
  } catch (err) {
    list.replaceChildren(Object.assign(document.createElement("li"), { textContent: `Could not load lookups: ${err.message}` }));
  }
}
document.querySelector('[role=tab][data-tab="claude"]')?.addEventListener("click", () => {
  clearInterval(lookupTimer);
  refreshLookups();
  lookupTimer = setInterval(refreshLookups, 5000);
});
document.querySelectorAll('[role=tab]:not([data-tab="claude"])').forEach((t) => t.addEventListener("click", () => clearInterval(lookupTimer)));

document.querySelector('[role=tab][data-tab="operator"]')?.addEventListener("click", () => operatorVisible(true));
document.querySelectorAll('[role=tab]:not([data-tab="operator"])').forEach((t) => t.addEventListener("click", () => operatorVisible(false)));
for (const id of ["op-limit", "op-gifts-only", "op-problems-only"]) $(id).addEventListener("change", refreshOperator);

// --- Startup ---
async function init() {
  const [s, state] = await Promise.all([fetch("/api/settings").then((r) => r.json()), fetch("/api/state").then((r) => r.json())]);
  actions = state.actions.filter((a) => a !== "none");
  setEventDefs(state.events);
  $("actions").replaceChildren(
    ...[...actions, "reanimate"].map((a) => {
      const b = document.createElement("button");
      b.textContent = a.replace("walk_", "→ ").replace("_", " ");
      b.dataset.action = a;
      return b;
    }),
  );
  const bridge = `${state.root}\\src\\mcp-bridge.js`;
  $("mcp-code").textContent = `claude mcp add creature-show -- node "${bridge}"`;
  $("mcp-desktop").textContent = JSON.stringify({ mcpServers: { "creature-show": { command: "node", args: [bridge] } } }, null, 2);
  applySettings(s);
  showStatus(state);
}

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=panel`);
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === "status") {
      showStatus(msg);
      showLayoutCheck(!!msg.layoutCheck);
      showInteraction(msg.show?.interaction);
      // How the stream window is really running, as it reports every 10 seconds.
      const s = msg.stream;
      $("streamPerf").textContent = s && Date.now() - s.at < 30_000 ? `Stream window now: ${s.render} at ${s.fps} fps (95% of frames under ${s.p95ms} ms).` : "";
    }
    else if (msg.t === "log") addLine($("log"), { text: msg.text, at: msg.at });
    else if (msg.t === "transcript") addLine($("transcript"), { who: msg.who, text: msg.text, cls: msg.who === "The Creature" ? "creature" : "" });
    else if (msg.t === "settings") applySettings(msg.settings);
    else if (msg.t === "giftGuide") setEventDefs(msg.tiers);
  };
  socket.onclose = () => setTimeout(connect, 1500);
}

randomViewer();
init();
connect();
