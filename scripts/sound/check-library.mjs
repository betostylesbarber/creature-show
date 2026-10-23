// Checks the built library as the browser will play it (decoded from the Opus files):
// true peak, clipping, start/end discontinuities (clicks at a sound's edges), loop seams of the
// sample-exact loops, and the decoded-memory budget.   node scripts/sound/check-library.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchTool } from "./lib/chrome.mjs";
import { readWav } from "./lib/wav.mjs";
import { truePeak, clipping, seam, db } from "./lib/analysis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SND = path.join(ROOT, "assets/sounds");
const manifest = JSON.parse(fs.readFileSync(path.join(SND, "manifest.json"), "utf8"));
const tool = await launchTool();
const tmp = path.join(os.tmpdir(), "snd-check.wav");
let files = 0, worstTp = -99, worstTpFile = "", clipped = 0, edgeIssues = [], seams = [], bytesOne = 0, bytesAll = 0, disk = 0;
for (const [id, s] of Object.entries(manifest.sounds)) {
  for (const v of s.variants) {
    await tool.decode(path.join(SND, v.file), tmp, 48000);
    const a = readWav(tmp);
    files++;
    disk += fs.statSync(path.join(SND, v.file)).size;
    const tp = db(truePeak(a.channels).truePeak);
    if (tp > worstTp) { worstTp = tp; worstTpFile = v.file; }
    if (clipping(a.channels).clipRuns) clipped++;
    // edges: a one-shot must start and end at (near) silence, or it clicks
    if (!s.loop) {
      const first = Math.max(...a.channels.map((c) => Math.abs(c[0])));
      const last = Math.max(...a.channels.map((c) => Math.abs(c[c.length - 1])));
      if (first > 0.003 || last > 0.003) edgeIssues.push(`${v.file} start ${first.toFixed(4)} end ${last.toFixed(4)}`);
    } else seams.push([v.file, seam(a.channels)]);
    const b = (a.channels[0].length / 48000) * s.decodeRate * a.channels.length * 4;
    bytesAll += b;
    if (!id.startsWith("nv.") || id.startsWith("nv.am_onyx")) bytesOne += b;
  }
}
await tool.close();
console.log(JSON.stringify({ files, diskMB: +(disk / 2 ** 20).toFixed(1), decodedMB_oneVoiceSet: +(bytesOne / 2 ** 20).toFixed(1), decodedMB_everything: +(bytesAll / 2 ** 20).toFixed(1), worstTruePeakDBTP: +worstTp.toFixed(2), worstTpFile, filesWithClipping: clipped, edgeIssues, loopSeams: seams.map(([f, s]) => `${f} ${s}`) }, null, 1));
