import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { ROOT, character, tales, settings as env, loadBlocklist, publicCharacter } from "./config.js";
import { Settings } from "./settings.js";
import { Brain, ACTIONS } from "./brain.js";
import { Voice } from "./voice.js";
import { Moderation } from "./moderation.js";
import { Show } from "./show.js";
import { Choices } from "./choices.js";
import { TikTokSource, normalizeEvent } from "./tiktok.js";
import { Ledger } from "./ledger.js";
import { operatorRoutes, configureOperator } from "./operator.js";
import { streamMessage, review, registerSecret, registerSecretsFrom } from "./guard.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".fbx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const MUSIC_DIR = path.join(ROOT, "assets", "music");
const MUSIC_TYPES = [".mp3", ".ogg", ".wav", ".m4a"];

// URL prefix -> folder on disk.
const STATIC_ROOTS = [
  ["/vendor/three/", path.join(ROOT, "node_modules", "three")],
  ["/vendor/three-mesh-bvh/", path.join(ROOT, "node_modules", "three-mesh-bvh")],
  ["/assets/", path.join(ROOT, "assets")],
  ["/", path.join(ROOT, "public")],
];

const clients = new Set(); // { socket, role, preview }

function broadcast(message, target = "all") {
  // The last check on everything the stream window shows (src/guard.js streamMessage): viewer
  // names, gift captions, alerts and comment previews. The panel (operator) gets the raw message.
  const pub = target === "panel" ? message : streamMessage(message);
  if (!pub) return;
  if (pub !== message && target === "all") {
    const raw = JSON.stringify(message);
    const data = JSON.stringify(pub);
    for (const client of clients) client.socket.send(client.role === "stream" ? data : raw);
    return;
  }
  message = pub;
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (target === "all" || client.role === target) client.socket.send(data);
  }
}

function log(text) {
  console.log(text);
  broadcast({ t: "log", text, at: Date.now() }, "panel");
}

const streamCount = () => [...clients].filter((c) => c.role === "stream" && !c.preview).length;
const CAPTURE_DIR = path.join(ROOT, "captures");
// Only the real stream windows, not the panel's muted preview; with a tag, only windows opened
// with that ?tag= (so a rehearsal's captures never come from someone's own viewing window).
function broadcastToStreams(message, tag = "") {
  const data = JSON.stringify(message);
  for (const c of clients) if (c.role === "stream" && !c.preview && (!tag || c.tag === tag)) c.socket.send(data);
}
const streamStats = []; // what the stream window reports about itself every 10 seconds

const settings = new Settings();
// Secret-looking settings and environment values never reach a prompt, speech or caption.
registerSecretsFrom(settings.get());
if (env.anthropicKey) registerSecret(env.anthropicKey);
if (env.eulerApiKey) registerSecret(env.eulerApiKey);
const brain = new Brain({ apiKey: env.anthropicKey, model: env.model, character, log, ollamaModel: process.env.OLLAMA_MODEL || "" });
const voice = new Voice({ character, settings, log });
const moderation = new Moderation(loadBlocklist());
const show = new Show({ character, tales, settings, brain, voice, moderation, broadcast, streamCount, log });
const tiktok = new TikTokSource({ eulerApiKey: env.eulerApiKey });
// Every TikTok event is recorded in the gift ledger before the show sees it (data/ledger.json):
// duplicates and replays are dropped there, and gift streaks are counted once.
const ledger = new Ledger({ log });
ledger.bindSource(tiktok);
configureOperator({ ledger, source: tiktok });
show.ledger = ledger;
// Audience choices, mysteries and surprises: rare, quiet-moment-only, cleared by a skip.
const choices = new Choices({ show, log });
show.interaction = choices;

// The layout-check view (estimated TikTok zones and our protected regions drawn on the stream
// window) is only ever on while the operator asks for it, and switches itself off after 20 minutes.
let layoutCheck = false;
let layoutCheckTimer = null;
function setLayoutCheck(on) {
  layoutCheck = !!on;
  clearTimeout(layoutCheckTimer);
  if (layoutCheck) {
    layoutCheckTimer = setTimeout(() => setLayoutCheck(false), 20 * 60_000);
    layoutCheckTimer.unref?.();
  }
  broadcast({ t: "layoutCheck", on: layoutCheck }, "stream");
  return layoutCheck;
}

settings.on("change", (value) => broadcast({ t: "settings", settings: value }, "all"));
tiktok.on("event", (event) => show.handle(event));
// A streak that never sent its final message is settled by the ledger after a timeout (or when
// a new streak replaces it); the show performs it then. Streaks that end normally arrive as events.
function performSettled(l) {
  l.on("finalized", ({ contribution: c, reason }) => {
    if (reason === "final_event" || !c.counted) return;
    const real = show.ledger;
    show.ledger = l;
    show.handle({ kind: "gift", user: c.supporter, gift: { id: c.giftId, name: c.giftName, image: c.giftImage, count: c.count, coins: c.diamondCount ?? 0 }, ledger: { accepted: true, contribution: c, finalizedNow: true } });
    show.ledger = real;
  });
  l.on("top", (top) => show.ledger === l && show.topSupporterChanged(top));
}
performSettled(ledger);

// Rehearsals: simulated TikTok messages (POST /api/sim with { provider: true, kind, payload })
// go through the same normalizer and the same kind of ledger as real ones (streaks, duplicates,
// values), but into a memory-only ledger that never touches data/ledger.json, so accounting can
// be checked end to end without a live stream (GET /api/sim/ledger).
let rehearsalLedger = null;
function rehearse(kind, payload) {
  if (!rehearsalLedger) {
    rehearsalLedger = new Ledger({ persist: false, log: () => {} });
    rehearsalLedger.beginSession({ roomId: "rehearsal", connectedAt: Date.now() });
    performSettled(rehearsalLedger);
  }
  const result = normalizeEvent(kind, payload, { roomId: "rehearsal", receivedAt: Date.now() });
  if (!result.ok) return result;
  rehearsalLedger.record(result.event);
  if (kind === "gift") show.simulated = true; // cleared from the display when the real LIVE connects
  const real = show.ledger;
  show.ledger = rehearsalLedger;
  try {
    show.handle(result.event);
  } finally {
    show.ledger = real;
  }
  return { ok: true, outcome: result.event.ledger?.outcome, reason: result.event.ledger?.reason };
}
tiktok.on("log", log);
let lastState = null;
tiktok.on("status", (status) => {
  if (status.state === lastState) return;
  lastState = status.state;
  if (status.state === "connected") {
    log(`Connected to @${status.username}'s LIVE.`);
    if (show.clearSimulatedSupport(ledger.topSupporter())) log("Cleared the rehearsal's supporters from the stream (the real ledger was never touched).");
  } else if (status.state !== "connecting") log(`TikTok: ${status.description}${status.error ? ` (${status.error})` : ""}`);
});

// Saves the Claude key into .env so it survives restarts; the key is never sent back out.
function saveKey(key) {
  const file = path.join(ROOT, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !l.startsWith("ANTHROPIC_API_KEY=")) : [];
  if (key) lines.unshift(`ANTHROPIC_API_KEY=${key}`);
  fs.writeFileSync(file, lines.filter((l, i) => l || i < lines.length - 1).join("\n") + "\n");
}

function status() {
  return {
    brain: brain.provider,
    brainOnline: brain.online,
    voice: voice.state,
    tiktok: tiktok.status,
    streams: streamCount(),
    stream: streamStats.at(-1) || null, // latest resolution / fps / memory from the stream window
    show: show.snapshot(),
    layoutCheck,
  };
}

function listMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  return fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_TYPES.includes(path.extname(f).toLowerCase()));
}

// Pages, scripts and styles are always revalidated (an OBS browser source or a stream window
// must never run a stale mix of old and new modules after an update); unchanged files answer
// 304 from their modification time. Large assets (models, textures, sounds) may be cached.
const CODE = new Set([".html", ".js", ".css", ".json"]);
function serveFile(res, file, req) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: "Not found" });
    const ext = path.extname(file).toLowerCase();
    const tag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", ETag: tag, "Cache-Control": CODE.has(ext) ? "no-cache" : "public, max-age=3600" };
    if (req?.headers["if-none-match"] === tag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(file).pipe(res);
  });
}

function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// The server only listens on this computer, but any web page open in the operator's browser
// could still send it requests. Pages served by this server, OBS and the MCP bridge (no Origin
// header) are let through; anything from another site is refused before it can control the show.
// The Host must be local too, so a site whose name has been pointed at 127.0.0.1 (DNS
// rebinding) can't pass as this server.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function foreignOrigin(req) {
  if (!LOCAL_HOST.test(req.headers.host || "")) return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return !LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return true;
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const readJson = async (req) => JSON.parse((await readBody(req)).toString("utf8") || "{}");

// Simple local API used by the setup page and the Claude MCP bridge.
async function api(req, res, pathname, url) {
  const method = req.method;
  if (pathname === "/api/character") return sendJson(res, 200, publicCharacter());
  if (pathname === "/api/settings" && method === "GET") return sendJson(res, 200, settings.get());
  if (pathname === "/api/settings" && method === "POST") return sendJson(res, 200, settings.update(await readJson(req)));
  if (pathname === "/api/settings/reset" && method === "POST") return sendJson(res, 200, settings.reset((await readJson(req)).key));
  if (pathname === "/api/state") return sendJson(res, 200, { ...status(), actions: ACTIONS, events: show.giftGuide().tiers, root: ROOT, port: env.port });
  if (pathname === "/api/chat") return sendJson(res, 200, show.chatLog.slice(-Number(url.searchParams.get("limit") || 20)));
  if (pathname === "/api/metrics") return sendJson(res, 200, { latency: show.latency(), recentOutcomes: show.outcomeLog.slice(-50), lines: show.metrics.slice(-Number(url.searchParams.get("limit") || 100)) });
  if (pathname === "/api/spoken") return sendJson(res, 200, show.spoken.slice(-Number(url.searchParams.get("limit") || 200)));
  // Sources behind his current-information answers (query, source, title, URL, time), newest
  // first, for the operator. Never read aloud.
  if (pathname === "/api/knowledge/recent" && method === "GET") return sendJson(res, 200, { items: brain.knowledge?.recentLookups(Math.min(100, Number(url.searchParams.get("limit")) || 50)) || [] });
  if (pathname === "/api/streamstats") return sendJson(res, 200, streamStats.slice(-Number(url.searchParams.get("limit") || 360)));
  if (pathname === "/api/sim/ledger") return sendJson(res, 200, rehearsalLedger ? { totals: rehearsalLedger.sessionTotals(), top: rehearsalLedger.topSupporters(100), history: rehearsalLedger.history(200) } : { totals: null });
  if (pathname === "/api/blocklist" && method === "GET") return sendJson(res, 200, loadBlocklist());
  if (method !== "POST" && pathname !== "/api/music") return sendJson(res, 405, { error: "Use POST" });

  if (pathname === "/api/brain") {
    const body = await readJson(req);
    if (typeof body.anthropicKey === "string") {
      const key = body.anthropicKey.trim();
      if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) return sendJson(res, 400, { error: "That doesn't look like a Claude API key (it starts with sk-ant-)." });
      saveKey(key);
      registerSecret(key);
      brain.setKey(key);
      log(key ? "Claude API key saved. He now thinks with Claude." : "Claude API key removed.");
    }
    await brain.findOllama();
    return sendJson(res, 200, { brain: brain.provider, online: brain.online });
  }
  if (pathname === "/api/say") {
    const { text, mood, action } = await readJson(req);
    if (!text || typeof text !== "string") return sendJson(res, 400, { error: "text is required" });
    if (text.length > 400) return sendJson(res, 400, { error: "text is too long (at most 400 characters)" });
    // Operator lines are public speech too: the broadcast guard checks them before they queue.
    const verdict = review(text, { route: "director" });
    if (!verdict.ok) return sendJson(res, 422, { error: `Held back by the broadcast guard (${verdict.category}: ${verdict.reason}). Rephrase it.` });
    show.say(text, { mood, action: ACTIONS.includes(action) ? action : null });
    return sendJson(res, 200, { queued: true });
  }
  if (pathname === "/api/action") {
    const { action } = await readJson(req);
    if (!ACTIONS.includes(action) && action !== "reanimate") return sendJson(res, 400, { error: `Unknown action. Use one of: ${ACTIONS.join(", ")}` });
    show.runAction(action, { nick: "the director" }, { force: true });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/api/skip") {
    show.skip();
    return sendJson(res, 200, { ok: true });
  }
  // The panel's buttons for the audience moments: { action: "choice" | "mystery" | "surprise" | "cancel" }.
  // A manual start replaces whatever audience moment is running.
  if (pathname === "/api/interaction") {
    const { action } = await readJson(req);
    if (action === "choice") choices.startChoice({ force: true });
    else if (action === "mystery") choices.startMystery({ force: true });
    else if (action === "surprise") choices.startSurprise({ force: true });
    else if (action === "cancel") choices.cancel("cancelled by the operator");
    else return sendJson(res, 400, { error: "action must be choice, mystery, surprise or cancel" });
    return sendJson(res, 200, choices.snapshot());
  }
  // Draws the estimated TikTok zones and the protected regions on the stream window (and the
  // panel preview) so they can be compared with TikTok LIVE Studio's previews.
  if (pathname === "/api/layout-check") {
    const { on } = await readJson(req);
    return sendJson(res, 200, { on: setLayoutCheck(on) });
  }
  // Operator event controls. An audition plays an event without any gift (nothing reaches a
  // ledger); cancel stops the running event and restores the scene; camera returns to the normal
  // shot; reset cancels everything and restores weather, lights and his position, keeping the
  // supporter totals.
  if (pathname.startsWith("/api/event/")) {
    const action = pathname.slice("/api/event/".length);
    if (action === "audition") {
      const { id, variant } = await readJson(req);
      const ev = (character.giftEvents || []).find((e) => e.id === id);
      if (!ev) return sendJson(res, 400, { error: `Unknown event. Use one of: ${(character.giftEvents || []).map((e) => e.id).join(", ")}` });
      const run = { id: `audition${Date.now()}`, type: ev.id, name: ev.name, variant: Object.values(ev.variants || {}).includes(variant) ? variant : null, user: { id: "operator", nick: "Audition", spoken: "friend" }, value: ev.minCoins, audition: true };
      broadcastToStreams({ t: "eventAudition", event: run });
      log(`Auditioning ${ev.name}${run.variant ? ` (${run.variant})` : ""}`);
      return sendJson(res, 200, { ok: true, event: run });
    }
    if (["cancel", "camera", "reset"].includes(action)) {
      broadcastToStreams({ t: `event${action[0].toUpperCase()}${action.slice(1)}` });
      if (action === "reset") show.skip();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "Unknown event control" });
  }
  // Evidence capture for rehearsals: the stream window renders a still (optionally from a fixed
  // camera view) or records N seconds with sound, and uploads it into captures/.
  if (pathname === "/api/capture" || pathname === "/api/record") {
    const body = await readJson(req);
    const name = String(body.name || "").replace(/[^\w.-]/g, "_").slice(0, 80);
    if (!name) return sendJson(res, 400, { error: "name is required" });
    if (!streamCount()) return sendJson(res, 409, { error: "No stream window is open" });
    const tag = String(body.tag || "").replace(/[^\w-]/g, "").slice(0, 24);
    if (pathname === "/api/capture") broadcastToStreams({ t: "capture", name, view: body.view || null }, tag);
    else broadcastToStreams({ t: "record", name, seconds: Math.min(120, Math.max(1, Number(body.seconds) || 10)) }, tag);
    return sendJson(res, 200, { ok: true, file: path.join(CAPTURE_DIR, name) });
  }
  if (pathname === "/api/capture/upload") {
    const name = String(url.searchParams.get("name") || "").replace(/[^\w.-]/g, "_").slice(0, 80);
    const ext = url.searchParams.get("ext") === "webm" ? "webm" : "jpg";
    if (!name) return sendJson(res, 400, { error: "name is required" });
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    const file = path.join(CAPTURE_DIR, `${name}.${ext}`);
    fs.writeFileSync(file, await readBody(req, 400_000_000));
    log(`Saved ${path.relative(ROOT, file)}`);
    return sendJson(res, 200, { file });
  }
  if (pathname === "/api/sim") {
    const event = await readJson(req);
    if (event?.provider) return sendJson(res, 200, rehearse(event.kind, event.payload));
    if (!event?.user?.nick) return sendJson(res, 400, { error: "event.user.nick is required" });
    event.user.id ||= event.user.nick.toLowerCase();
    if (event.kind === "gift") show.simulated = true;
    show.handle(event);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/api/connect") {
    const username = (await readJson(req)).username || settings.get().tiktokUsername;
    if (!username) return sendJson(res, 400, { error: "No TikTok username set" });
    settings.update({ tiktokUsername: username });
    await tiktok.connect(username);
    return sendJson(res, 200, tiktok.status);
  }
  if (pathname === "/api/disconnect") {
    await tiktok.disconnect({ manual: true }); // no automatic reconnect after a deliberate disconnect
    return sendJson(res, 200, tiktok.status);
  }
  if (pathname === "/api/blocklist") {
    const { words } = await readJson(req);
    const list = String(words || "").split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
    fs.writeFileSync(path.join(ROOT, "blocklist.txt"), ["# One word or phrase per line; comments containing them are never shown or read.", ...list].join("\n") + "\n");
    moderation.blocklist = loadBlocklist();
    return sendJson(res, 200, { count: moderation.blocklist.length });
  }

  if (pathname === "/api/music") {
    const name = path.basename(url.searchParams.get("name") || "");
    if (method === "GET") return sendJson(res, 200, listMusic());
    if (!name || !MUSIC_TYPES.includes(path.extname(name).toLowerCase())) return sendJson(res, 400, { error: "Use an .mp3, .ogg, .wav or .m4a file" });
    const file = path.join(MUSIC_DIR, name);
    if (method === "DELETE") {
      fs.rmSync(file, { force: true });
    } else {
      if (listMusic().length >= 10 && !fs.existsSync(file)) return sendJson(res, 400, { error: "Up to 10 songs" });
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
      fs.writeFileSync(file, await readBody(req, 40_000_000));
    }
    return sendJson(res, 200, settings.update({ music: { tracks: listMusic() } }).music);
  }
  return sendJson(res, 404, { error: "Unknown endpoint" });
}

const server = http.createServer(async (req, res) => {
  if (foreignOrigin(req)) return sendJson(res, 403, { error: "Cross-origin request refused" });
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (operatorRoutes(req, res, url)) return;
    if (pathname.startsWith("/api/")) return await api(req, res, pathname, url);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  if (pathname === "/") return serveFile(res, path.join(ROOT, "public", "panel.html"), req);
  if (pathname === "/stream") return serveFile(res, path.join(ROOT, "public", "stream.html"), req);
  for (const [prefix, dir] of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.resolve(dir, "." + pathname.slice(prefix.length - 1));
    if (!file.startsWith(dir + path.sep)) break; // no escaping the folder
    return serveFile(res, file, req);
  }
  sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket, req) => {
  if (foreignOrigin(req)) return socket.close(1008);
  const params = new URL(req.url, "http://localhost").searchParams;
  const client = { socket, role: params.get("role") === "stream" ? "stream" : "panel", preview: params.get("preview") === "1", tag: (params.get("tag") || "").replace(/[^\w-]/g, "").slice(0, 24) };
  clients.add(client);
  if (client.role === "stream") {
    socket.send(JSON.stringify(show.streamState()));
    for (const message of choices.streamSync()) socket.send(JSON.stringify(message)); // a moment already under way
    if (layoutCheck) socket.send(JSON.stringify({ t: "layoutCheck", on: true }));
  }
  socket.on("close", () => clients.delete(client));
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (client.role === "stream") {
      if (msg.t === "segmentDone" && !client.preview) show.segmentDone(msg.id);
      if (msg.t === "clipStart" && !client.preview) show.clipStarted(msg.id, msg.role);
      // Which events the stream window has everything for (an event whose props or effects
      // failed to load is left out of the guide and never selected).
      if (msg.t === "eventsAvailable" && !client.preview && msg.available && typeof msg.available === "object") {
        show.eventsAvailable = Object.fromEntries(Object.entries(msg.available).map(([k, v]) => [String(k).slice(0, 20), v !== false]));
        broadcast(show.giftGuide("compact"), "stream");
      }
      if (msg.t === "eventLog" && !client.preview && typeof msg.text === "string") log(`🎃 ${msg.text.slice(0, 160)}`);
      if (msg.t === "clientError" && !client.preview && typeof msg.text === "string") log(`⚠️ Stream window: ${msg.text.slice(0, 300)}`);
      if (msg.t === "activity" && !client.preview) {
        show.activityUntil = Date.now() + Math.min(30, Math.max(0, Number(msg.seconds) || 0)) * 1000;
        if (typeof msg.kind === "string") log(`🚶 He goes to look at ${msg.kind.replace(/[^a-z ]/g, "").slice(0, 20)}`);
      }
      if (msg.t === "mysteryArrived" && !client.preview) choices.arrived(msg.id); // he reached the mystery's spot
      // A window that has just finished loading asks for the moment already under way (what is
      // sent on connect can arrive before its scene is ready to show it).
      if (msg.t === "syncInteraction") for (const message of choices.streamSync()) socket.send(JSON.stringify(message));
      // Performance reports from the stream window, kept for the setup page and rehearsals.
      if (msg.t === "stats" && !client.preview && msg.stats) {
        streamStats.push({ at: Date.now(), ...msg.stats });
        if (streamStats.length > 720) streamStats.shift(); // two hours at one report every 10 s
      }
      return;
    }
    if (msg.t === "sim" && msg.event?.user) show.handle(msg.event);
    else if (msg.t === "action") show.runAction(msg.action, { nick: "test panel" }, { force: true });
    else if (msg.t === "skip") show.skip();
  });
});

setInterval(() => broadcast({ t: "status", ...status() }, "panel"), 1000);

// Closing the window or Ctrl+C: leave the LIVE cleanly and write the ledger to disk.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await tiktok.shutdown().catch(() => {});
    ledger.close();
    process.exit(0);
  });
}

// Only this PC can reach the show (OBS and the browser connect over localhost).
server.listen(env.port, "127.0.0.1", () => {
  log(`Setup page:    http://localhost:${env.port}/`);
  log(`Stream window: http://localhost:${env.port}/stream`);
  if (!env.anthropicKey) log("No Claude API key set. Add one on the setup page, or run a local AI with Ollama, so he can understand chat.");
  voice.load();
  show.start();
  choices.start();
  const username = env.tiktokUsername || settings.get().tiktokUsername;
  if (env.tiktokUsername) tiktok.connect(username);
});
