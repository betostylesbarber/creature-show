// Receives the stream window's PCM captures (open the stream with ?soundtap=<port>) and saves
// them as float WAVs in captures/ for analysis (scripts/sound/analyze.mjs). Test tool only:
// listens on 127.0.0.1, accepts snd_*.wav names only.
//   node scripts/sound/capture-server.mjs [port=3102]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, "captures");
const port = Number(process.argv[2] || 3102);
http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url, "http://x");
    const name = path.basename(url.searchParams.get("p") || "");
    if (req.method !== "POST" || url.pathname !== "/save" || !/^snd_[\w-]+\.wav$/.test(name)) {
      res.writeHead(req.method === "OPTIONS" ? 204 : 400);
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, name), Buffer.concat(chunks));
    console.log("saved", name, (Buffer.concat(chunks).length / 2 ** 20).toFixed(1), "MB");
    res.writeHead(200);
    res.end("ok");
  })
  .listen(port, "127.0.0.1", () => console.log(`capture server on ${port} -> ${DIR}`));
