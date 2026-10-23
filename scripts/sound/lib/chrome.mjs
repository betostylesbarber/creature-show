// Headless Chrome as an audio codec for the sound tools (no ffmpeg on this machine): decodes any
// format Chrome reads (Ogg Vorbis/Opus, MP3, FLAC, WAV, WebM) and encodes Ogg Opus through
// WebCodecs. A tiny local file server gives the page access to the files; the page is driven over
// the DevTools protocol. Also exports `cdp` for driving an already running Chrome (the stream
// window during capture tests).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MUX = fs.readFileSync(new URL("./ogg-opus.js", import.meta.url), "utf8");

export function startFileServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<!doctype html><title>sound tool</title>");
      }
      const p = url.searchParams.get("p");
      if (url.pathname === "/file" && p) {
        const data = fs.readFileSync(p);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(data);
      }
      if (url.pathname === "/save" && p && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.concat(chunks));
        res.writeHead(200);
        return res.end("ok");
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// Minimal DevTools protocol client over the browser's page websocket.
export async function cdp(debugPort, match = () => true) {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = list.find((t) => t.type === "page" && match(t));
  if (!target) throw new Error("no matching page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression, timeout = 600000) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, on: (fn) => listeners.add(fn), close: () => ws.close(), target };
}

export async function launchTool() {
  const { server, port } = await startFileServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sndtool-"));
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      page = await cdp(debugPort, (t) => t.url.includes(`127.0.0.1:${port}`));
    } catch {}
  }
  if (!page) throw new Error("Chrome did not start");
  for (let i = 0; i < 100; i++) {
    const href = await page.evaluate("location.href");
    if (href.startsWith(`http://127.0.0.1:${port}`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.evaluate(MUX + ";true");
  await page.evaluate(PAGE_HELPERS + ";true");
  return {
    port,
    page,
    async close() {
      page.close();
      proc.kill();
      server.close();
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
    // Decode any file to a float WAV at `rate` (48 kHz default), keeping its channel count.
    decode(src, dst, rate = 48000) {
      return page.evaluate(`decodeToWav(${JSON.stringify(src)}, ${JSON.stringify(dst)}, ${rate})`);
    },
    // Encode a WAV (any rate; resampled by Chrome to 48 kHz) to Ogg Opus.
    encodeOpus(src, dst, bitrate = 128000) {
      return page.evaluate(`encodeOpus(${JSON.stringify(src)}, ${JSON.stringify(dst)}, ${bitrate})`);
    },
  };
}

const PAGE_HELPERS = `
async function loadBuffer(p, rate) {
  const bytes = await (await fetch('/file?p=' + encodeURIComponent(p))).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate);
  return ctx.decodeAudioData(bytes);
}
function floatWav(buffer) {
  const n = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * n * 4));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 3, true); out.setUint16(22, n, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * n * 4, true); out.setUint16(32, n * 4, true); out.setUint16(34, 32, true); w(36, 'data'); out.setUint32(40, len * n * 4, true);
  const ch = []; for (let c = 0; c < n; c++) ch.push(buffer.getChannelData(c));
  let o = 44; for (let i = 0; i < len; i++) for (let c = 0; c < n; c++) { out.setFloat32(o, ch[c][i], true); o += 4; }
  return out.buffer;
}
async function save(p, data) {
  const r = await fetch('/save?p=' + encodeURIComponent(p), { method: 'POST', body: data });
  if (!r.ok) throw new Error('save failed ' + p);
}
async function decodeToWav(src, dst, rate) {
  const b = await loadBuffer(src, rate);
  await save(dst, floatWav(b));
  return { channels: b.numberOfChannels, duration: b.duration, sampleRate: b.sampleRate };
}
async function encodeOpus(src, dst, bitrate) {
  const b = await loadBuffer(src, 48000);
  const n = b.numberOfChannels, len = b.length;
  const packets = []; let description = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push(d); if (meta && meta.decoderConfig && meta.decoderConfig.description) description = new Uint8Array(meta.decoderConfig.description); }, error: (e) => { throw e; } });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: n, bitrate, opus: { complexity: 10, frameDuration: 20000, application: 'audio' } });
  const planar = new Float32Array(len * n);
  for (let c = 0; c < n; c++) planar.set(b.getChannelData(c), c * len);
  // Feed in 1 s pieces
  const step = 48000;
  for (let s = 0; s < len; s += step) {
    const m = Math.min(step, len - s);
    const data = new Float32Array(m * n);
    for (let c = 0; c < n; c++) data.set(planar.subarray(c * len + s, c * len + s + m), c * m);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: m, numberOfChannels: n, timestamp: Math.round(s / 48 * 1000), data }));
  }
  await enc.flush(); enc.close();
  let preSkip = 312;
  if (description && description.length >= 12 && String.fromCharCode(...description.slice(0, 8)) === 'OpusHead') preSkip = description[10] | (description[11] << 8);
  const ogg = muxOggOpus({ packets, channels: n, preSkip, totalFrames: len });
  await save(dst, ogg);
  return { bytes: ogg.length, packets: packets.length, preSkip, duration: len / 48000, description: description ? description.length : 0 };
}
`;
