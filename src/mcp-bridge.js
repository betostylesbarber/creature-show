// MCP bridge: lets Claude (Claude Desktop or Claude Code) watch the chat and direct the
// creature on the running local show. Start the show first (npm start); Claude launches
// this file itself over stdio. stdout belongs to the MCP protocol, so log to stderr only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.SHOW_URL || `http://localhost:${process.env.PORT || 3000}`;

const ACTIONS = [
  "nod", "wave", "bow", "flex", "jacks", "dance", "roar", "spin", "stomp", "kneel", "backflip", "pushups", "handstand", "reanimate",
  "walk_center", "walk_front", "walk_gate", "walk_crypt", "walk_left_graves", "walk_right_graves", "walk_pumpkins", "walk_tree",
];
const MOODS = ["warm", "amused", "melancholy", "delighted", "indignant", "thoughtful"];

async function call(path, body) {
  let res;
  try {
    res = await fetch(BASE + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`The show is not running at ${BASE}. Start it with "npm start" in the project folder.`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const run = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (error) {
    return { ...text(error.message), isError: true };
  }
};

const server = new McpServer({ name: "creature-show", version: "1.0.0" });

server.registerTool(
  "show_status",
  { description: "Status of the live show: TikTok connection, whether the creature is speaking, queue sizes, top gifter, likes, flagged comments." },
  run(async () => {
    const s = await call("/api/state");
    const tk = s.tiktok.state === "connected" ? `connected to @${s.tiktok.username}` : s.tiktok.state;
    return [
      `TikTok: ${tk}`,
      `Brain: ${s.brain} · Voice: ${s.voice} · Stream windows open: ${s.streams}`,
      `Creature: ${s.show.speaking ? "speaking" : "listening"} at ${s.show.location}`,
      `Queue: ${s.show.queue.comments} comments, ${s.show.queue.gifts} gifts, ${s.show.queue.director} director lines`,
      `Top gifter: ${s.show.topGifter ? `${s.show.topGifter.user.nick} (${s.show.topGifter.coins} coins)` : "none yet"} · Likes: ${s.show.likes} · Viewers met: ${s.show.viewers}`,
    ].join("\n");
  }),
);

server.registerTool(
  "recent_chat",
  { description: "The most recent viewer comments from the TikTok LIVE chat (or the test panel).", inputSchema: { limit: z.number().int().min(1).max(50).default(20) } },
  run(async ({ limit }) => {
    const chat = await call(`/api/chat?limit=${limit}`);
    return chat.length ? chat.map((c) => `${new Date(c.at).toLocaleTimeString()} ${c.nick}: ${c.text}`).join("\n") : "No chat yet.";
  }),
);

server.registerTool(
  "say",
  {
    description: "Make the creature say a line next, exactly as written, in his voice. Write it in character: Mary Shelley's eloquent Creature, one or two sentences.",
    inputSchema: { text: z.string().min(1).max(400), mood: z.enum(MOODS).optional(), action: z.enum(ACTIONS).optional() },
  },
  run(async (args) => {
    await call("/api/say", args);
    return "Queued. He will say it after the current line.";
  }),
);

server.registerTool(
  "perform",
  { description: "Make the creature perform a stunt or walk to a spot in the cemetery right now.", inputSchema: { action: z.enum(ACTIONS) } },
  run(async ({ action }) => {
    await call("/api/action", { action });
    return `Performing ${action}.`;
  }),
);

server.registerTool(
  "skip",
  { description: "Stop the current line and stunts and walk the creature back to the middle (the 'unstick' button)." },
  run(async () => {
    await call("/api/skip", {});
    return "Skipped.";
  }),
);

server.registerTool(
  "connect_tiktok",
  { description: "Connect the show to a TikTok LIVE that is happening now, by username.", inputSchema: { username: z.string().min(1) } },
  run(async ({ username }) => {
    const s = await call("/api/connect", { username });
    return s.state === "connected" ? `Connected to @${s.username}.` : `Not connected: ${s.error || s.state}`;
  }),
);

server.registerTool(
  "disconnect_tiktok",
  { description: "Disconnect from TikTok LIVE." },
  run(async () => {
    await call("/api/disconnect", {});
    return "Disconnected.";
  }),
);

server.registerTool(
  "simulate_viewer",
  {
    description: "Test the show without going live: send a fake comment, or a fake gift with its coin value.",
    inputSchema: {
      nick: z.string().min(1),
      comment: z.string().optional(),
      gift: z.object({ name: z.string(), coins: z.number().int().min(1), count: z.number().int().min(1).default(1) }).optional(),
    },
  },
  run(async ({ nick, comment, gift }) => {
    const user = { id: nick.toLowerCase(), nick, avatar: null };
    if (comment) await call("/api/sim", { kind: "comment", user, text: comment });
    if (gift) await call("/api/sim", { kind: "gift", user, gift: { id: gift.name, name: gift.name, coins: gift.coins, count: gift.count, image: null, streaking: false } });
    return comment || gift ? "Sent." : "Nothing to send: give a comment or a gift.";
  }),
);

await server.connect(new StdioServerTransport());
console.error(`creature-show MCP bridge ready, talking to ${BASE}`);
