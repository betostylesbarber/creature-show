// Measures sound captures of the stream window:
//   node scripts/sound/analyze.mjs <captureName> [...]     (names without extension)
// For each name it reads captures/<name>_master.wav, _dialogue.wav and _bed.wav (the PCM taps of
// the final mix and its stems, see public/stream/sound/index.js ?soundtap) and, when present,
// captures/<name>.webm (the encoded recording, decoded by headless Chrome) and reports:
// integrated / short-term / momentary loudness (BS.1770-4), loudness range, true peak (4x),
// clipping, transient outliers ("clicks"), spectral balance, stereo correlation, the mono
// downmix change, and the speech-to-background ratio while he speaks.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readWav } from "./lib/wav.mjs";
import { report, loudness, db } from "./lib/analysis.mjs";
import { launchTool } from "./lib/chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAP = path.join(ROOT, "captures");
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const json = process.argv.includes("--json");
let tool = null;
const results = {};

// Speech-to-background: the dialogue stem's loudness against everything else, in the 400 ms
// blocks where he is clearly speaking (dialogue momentary loudness above -40 LUFS).
function speechToBackground(dialogue, bed) {
  const L = loudness(dialogue);
  const d = L.momentary;
  const b = loudness(bed).momentary;
  const ratios = [];
  // active speech only: blocks within 10 LU of his integrated speech level (not the gaps)
  const gate = Math.max(-40, L.integrated - 10);
  for (let i = 0; i < Math.min(d.length, b.length); i++) if (d[i] > gate) ratios.push(d[i] - Math.max(b[i], -90));
  if (!ratios.length) return null;
  ratios.sort((x, y) => x - y);
  const mean = ratios.reduce((a, x) => a + x, 0) / ratios.length;
  return { blocks: ratios.length, meanDb: +mean.toFixed(1), worst5pctDb: +ratios[Math.floor(ratios.length * 0.05)].toFixed(1), minDb: +ratios[0].toFixed(1) };
}

for (const name of names) {
  const r = {};
  const file = (s) => path.join(CAP, `${name}_${s}.wav`);
  if (fs.existsSync(file("master"))) {
    const master = readWav(file("master"));
    r.master = report(master);
    delete r.master.clicks.events;
    if (fs.existsSync(file("dialogue")) && fs.existsSync(file("bed"))) {
      const dlg = readWav(file("dialogue"));
      const bed = readWav(file("bed"));
      r.dialogueLUFS = +loudness(dlg).integrated.toFixed(1);
      r.bedLUFS = +loudness(bed).integrated.toFixed(1);
      r.speechToBackground = speechToBackground(dlg, bed);
    }
  }
  const webm = path.join(CAP, `${name}.webm`);
  if (fs.existsSync(webm)) {
    tool ??= await launchTool();
    const out = path.join(os.tmpdir(), `${name}_webm.wav`);
    try {
      await tool.decode(webm, out, 48000);
      const enc = readWav(out);
      const rep = report(enc);
      r.encoded = { duration: rep.duration, integratedLUFS: rep.integratedLUFS, maxShortTermLUFS: rep.maxShortTermLUFS, truePeakDBTP: rep.truePeakDBTP, samplePeakDBFS: rep.samplePeakDBFS, clipRuns: rep.clipRuns, clicks: rep.clicks.count, mono: rep.stereo };
    } catch (e) {
      r.encoded = { error: String(e.message || e) };
    }
  }
  results[name] = r;
}
if (tool) await tool.close();
if (json) console.log(JSON.stringify(results, null, 1));
else {
  for (const [name, r] of Object.entries(results)) {
    const m = r.master;
    console.log(`\n${name}`);
    if (m) {
      console.log(`  master  ${m.duration}s  I ${m.integratedLUFS} LUFS  S-max ${m.maxShortTermLUFS}  M-max ${m.maxMomentaryLUFS}  LRA ${m.lraLU} LU  TP ${m.truePeakDBTP} dBTP (at ${m.truePeakAt}s)  clip runs ${m.clipRuns}  clicks ${m.clicks.count}`);
      console.log(`          bands ${Object.entries(m.spectrum.bands).map(([k, v]) => `${k} ${v}`).join("  ")}  centroid ${m.spectrum.centroidHz} Hz`);
      console.log(`          stereo correlation ${m.stereo.correlation}, mono downmix ${m.stereo.monoLoudnessChange >= 0 ? "+" : ""}${m.stereo.monoLoudnessChange} LU`);
    }
    if (r.speechToBackground) console.log(`  speech  dialogue ${r.dialogueLUFS} LUFS, bed ${r.bedLUFS} LUFS; while speaking: mean +${r.speechToBackground.meanDb} dB, worst 5% +${r.speechToBackground.worst5pctDb} dB, min ${r.speechToBackground.minDb} dB (${r.speechToBackground.blocks} blocks)`);
    else if (r.bedLUFS != null) console.log(`  stems   dialogue ${r.dialogueLUFS} LUFS, bed ${r.bedLUFS} LUFS (no speech)`);
    if (r.encoded) console.log(`  webm    ${JSON.stringify(r.encoded)}`);
  }
}
fs.writeFileSync(path.join(CAP, `snd_analysis_${Date.now()}.json`), JSON.stringify(results, null, 1));
