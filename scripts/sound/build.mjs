// Builds the show's sound library from the source recordings in assets/sounds/_src (see
// sources.json and LICENSES.md) and the creature's Kokoro renderings:
//   1. decodes every source once (headless Chrome, no ffmpeg needed) into a cache
//   2. cuts, cleans, layers, loops and levels each runtime sound (recipes below)
//   3. encodes them as Ogg Opus into assets/sounds/<category>/
//   4. decodes the encoded files back and measures them (true peak, loudness, length)
//   5. writes assets/sounds/manifest.json (what the stream loads) and build-report.json
//
//   node scripts/sound/build.mjs [--only prefix,prefix] [--no-encode]
//
// Levels: one-shots are levelled to -20 LUFS at their loudest 400 ms and loops to -23 LUFS
// integrated, all under -1 dBTP; the mix itself (how loud each plays against the voice) is
// set in public/stream/sound/library.js and checked in context with real captures.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchTool } from "./lib/chrome.mjs";
import { readWav, writeWav } from "./lib/wav.mjs";
import * as D from "./lib/dsp.mjs";
import { onsets, cut } from "./lib/slice.mjs";
import { loudness, truePeak, db } from "./lib/analysis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SND = path.join(ROOT, "assets/sounds");
const SRC = path.join(SND, "_src");
const CACHE = path.join(os.tmpdir(), "metoda-sound-cache");
const STAGE = path.join(os.tmpdir(), "metoda-sound-stage");
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

const args = process.argv.slice(2);
const only = (args[args.indexOf("--only") + 1] || "").split(",").filter((s) => args.includes("--only") && s);
const encode = !args.includes("--no-encode");

let tool = null;
const getTool = async () => (tool ??= await launchTool());

// --- Sources ----------------------------------------------------------------------------------
const sourceList = JSON.parse(fs.readFileSync(path.join(SND, "sources.json"), "utf8"));
const sourceFile = Object.fromEntries(sourceList.map((s) => [s.key, s.file]));
const cache = new Map();
async function S(key) {
  if (cache.has(key)) return D.clone(cache.get(key));
  const file = sourceFile[key];
  if (!file) throw new Error(`unknown source ${key}`);
  const wav = path.join(CACHE, file.replace(/[\\/]/g, "_") + ".wav");
  if (!fs.existsSync(wav)) await (await getTool()).decode(path.join(SRC, file), wav, 48000);
  const a = readWav(wav);
  cache.set(key, a);
  return D.clone(a);
}
const V = (voice, key) => readWav(path.join(SRC, "voice", voice, `${key}.wav`));
const used = new Map(); // runtime id -> source keys

// --- Helpers ------------------------------------------------------------------------------------
const L = (a, ch = 0) => D.channel(a, ch);
const hp = (a, f, stages = 1) => D.filter(a, "highpass", f, { stages });
const lp = (a, f, stages = 1) => D.filter(a, "lowpass", f, { stages });
const shelf = (a, type, f, g) => D.filter(a, type, f, { gainDb: g });
const peakEq = (a, f, g, q = 1) => D.filter(a, "peak", f, { gainDb: g, q });
const rev = (a) => a.channels.forEach((c) => c.reverse()) || a;
function events(a, opts) {
  return onsets(a, opts).map((s) => D.edges(cut(a, s), 0.003, Math.min(0.06, (s.to - s.from) / 3)));
}
// Keeps the n strongest-but-cleanest segments, in source order.
function best(list, n) {
  const loudest = (a) => {
    const x = D.mono(a).channels[0];
    const w = Math.round(a.sampleRate * 0.1);
    let s = 0, m = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i] * x[i];
      if (i >= w) s -= x[i - w] * x[i - w];
      if (s > m) m = s;
    }
    return 10 * Math.log10(m / w + 1e-12);
  };
  const scored = list.map((a, i) => ({ a, i, l: loudest(a) }));
  return scored
    .filter((s) => Number.isFinite(s.l))
    .sort((x, y) => y.l - x.l)
    .slice(0, n)
    .sort((x, y) => x.i - y.i)
    .map((s) => s.a);
}
function seq(parts) {
  // parts: [[audio, atSeconds, gainDb, pan]]
  const ch = Math.max(...parts.map(([a]) => a.channels.length));
  const out = D.silence(0.01, ch);
  for (const [a, at, g = 0, pan = 0] of parts) D.mixInto(out, a, at, g, pan);
  return out;
}
// Pitch a short recording to a frequency ratio, keeping it clean of aliasing.
const tune = (a, ratio) => D.pitch(a, ratio);
const semis = (n) => 2 ** (n / 12);
const OUTDOOR = D.impulse({ seconds: 1.6, decay: 2.6, early: 7, damp: 5000, seed: 11, predelay: 0.012 });
const HALL = D.impulse({ seconds: 3.2, decay: 1.6, early: 4, damp: 7000, seed: 23, predelay: 0.02 });
const air = (a, wet = -14) => D.reverb(a, OUTDOOR, wet, 0);
const space = (a, wet = -10) => D.reverb(a, HALL, wet, 0);

// --- Recipes ---------------------------------------------------------------------------------
// def(id, { cat, rate (decode rate in the browser), loop, level: ["M"|"I", lufs] }, async () => variants)
const recipes = [];
const def = (id, meta, make, sources = []) => recipes.push({ id, meta: { level: meta.loop ? ["I", -23] : ["M", -20], rate: 48000, ...meta }, make, sources });

// ===== Ambience: loops =====
def("amb.wind", { cat: "ambience", loop: true, rate: 16000 }, async () => {
  const a = D.slice(await S("fs:706532"), 20, 53);
  hp(a, 90, 2); lp(a, 4200); shelf(a, "lowshelf", 250, 2);
  return [D.makeLoop(a, 3)];
}, ["fs:706532"]);
def("amb.air", { cat: "ambience", loop: true, rate: 8000 }, async () => {
  const a = L(D.slice(await S("fs:331222"), 60, 104));
  hp(a, 70, 2); lp(a, 900, 2);
  return [D.makeLoop(a, 3)];
}, ["fs:331222"]);
def("amb.trees", { cat: "ambience", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:573175"), 40, 67));
  hp(a, 260, 2); lp(a, 10500); peakEq(a, 4500, -2, 0.8);
  return [D.makeLoop(a, 3)];
}, ["fs:573175"]);
def("amb.candle", { cat: "ambience", loop: true, rate: 32000 }, async () => {
  const a = L(await S("fs:807942"));
  hp(a, 220, 2); lp(a, 12000);
  return [D.makeLoop(D.slice(a, 0, 8.3), 1)];
}, ["fs:807942"]);
def("amb.fire", { cat: "ambience", loop: true, rate: 24000 }, async () => {
  const a = D.slice(await S("fs:637523"), 1, 17);
  hp(a, 160, 2); lp(a, 11000); shelf(a, "highshelf", 6000, -3);
  return [D.makeLoop(a, 2)];
}, ["fs:637523"]);
def("amb.hum", { cat: "ambience", loop: true, rate: 16000 }, async () => {
  // Mains hum has almost nothing a phone can play: saturation adds the audible harmonics.
  const a = D.mono(D.slice(await S("fs:785942"), 10, 22));
  hp(a, 40); D.normalizePeak(a, -6); D.saturate(a, 2.2); hp(a, 95, 2); lp(a, 3200);
  return [D.makeLoop(a, 2)]; // 10 s: a whole number of 50 Hz and 60 Hz cycles, so the splice is in phase
}, ["fs:785942"]);
def("amb.coil", { cat: "ambience", loop: true, rate: 32000 }, async () => {
  const a = D.slice(await S("fs:675760"), 4, 16);
  hp(a, 110, 2); lp(a, 11000); shelf(a, "highshelf", 5000, -4);
  return [D.makeLoop(a, 2)];
}, ["fs:675760"]);
def("amb.spirit", { cat: "ambience", loop: true, rate: 16000 }, async () => {
  // A singing bowl an octave down through a long dark space: a barely-there supernatural air.
  let a = D.mono(D.slice(await S("fs:573805"), 2, 34));
  a = tune(a, 0.5);
  hp(a, 110, 2); lp(a, 2400);
  a = D.mono(space(a, -4));
  return [D.makeLoop(D.slice(a, 6, 32), 6)];
}, ["fs:573805"]);

// ===== Weather: rain loops =====
def("rain.far", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = D.slice(await S("fs:200273"), 2, 29);
  hp(a, 300, 2); lp(a, 8500); shelf(a, "highshelf", 5000, -2);
  return [D.makeLoop(a, 3)];
}, ["fs:200273"]);
def("rain.near", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:96729"), 4, 29));
  hp(a, 380, 2); lp(a, 11000); peakEq(a, 3000, -2);
  return [D.makeLoop(a, 3)];
}, ["fs:96729"]);
def("rain.leaves", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:672696"), 0, 21), 1);
  hp(a, 420, 2); lp(a, 11000);
  return [D.makeLoop(a, 3)];
}, ["fs:672696"]);
def("rain.stone", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = D.slice(await S("fs:486270"), 6, 29);
  hp(a, 260, 2); lp(a, 9000);
  return [D.makeLoop(a, 3)];
}, ["fs:486270"]);
def("rain.metal", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:637780"), 2, 25));
  hp(a, 320, 2); lp(a, 11000); peakEq(a, 2500, -2);
  return [D.makeLoop(a, 3)];
}, ["fs:637780"]);
def("rain.puddle", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:202898"), 0, 16));
  hp(a, 220, 2); lp(a, 11000); shelf(a, "highshelf", 7000, -3);
  return [D.makeLoop(a, 2)];
}, ["fs:202898"]);
def("rain.heavy", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:640651"), 0, 23));
  hp(a, 160, 2); lp(a, 11000); shelf(a, "highshelf", 6000, -3);
  return [D.makeLoop(a, 3)];
}, ["fs:640651"]);
def("rain.drips", { cat: "weather", loop: true, rate: 24000 }, async () => {
  const a = L(D.slice(await S("fs:628404"), 20, 37));
  hp(a, 350, 2); lp(a, 9000);
  return [D.makeLoop(a, 3)];
}, ["fs:628404"]);

// ===== Thunder =====
async function thunderEvents(key, { n, from = 0, to = null, len = 11, pre = 0.4 }) {
  const a = D.slice(await S(key), from, to);
  const segs = onsets(a, { thresholdDb: -11, minGap: 2.5, pre, post: 1, minLen: 1, maxLen: 30, win: 0.05, smooth: 6 });
  return best(
    segs.map((s) => D.edges(D.slice(a, s.from, Math.min(s.from + len, D.duration(a))), 0.25, 2.5)),
    n,
  );
}
def("thunder.far", { cat: "weather", rate: 16000, level: ["M", -20] }, async () => {
  const list = [...(await thunderEvents("fs:581232", { n: 3, len: 9 })), ...(await thunderEvents("fs:572443", { n: 2, len: 9 }))];
  return list.map((a) => {
    a = D.mono(a);
    hp(a, 35, 2); lp(a, 6500);
    return a;
  });
}, ["fs:581232", "fs:572443"]);
def("thunder.mid", { cat: "weather", rate: 24000, level: ["M", -20] }, async () => {
  const a1 = D.mono(D.slice(await S("fs:744723"), 2.5, 14.5));
  const a2 = D.mono(D.slice(await S("fs:361772"), 6.6, 18.6));
  return [a1, a2].map((a) => {
    hp(a, 35, 2); lp(a, 11000);
    return D.edges(a, 0.05, 3);
  });
}, ["fs:744723", "fs:361772"]);
def("thunder.close", { cat: "weather", rate: 24000, stereo: true, level: ["M", -20] }, async () => {
  const a1 = D.slice(await S("fs:567945"), 1.3, 11.3);
  const a2 = D.slice(await S("fs:795412"), 0.8, 10.8);
  return [a1, a2].map((a) => {
    hp(a, 35, 2); lp(a, 11000); peakEq(a, 3500, -2);
    return D.edges(a, 0.02, 3);
  });
}, ["fs:567945", "fs:795412"]);

// ===== Ambience one-shots =====
def("amb.creak", { cat: "ambience", rate: 32000 }, async () => {
  const out = [D.mono(await S("fs:238289")), D.mono(await S("fs:119468")), D.mono(await S("fs:483166"))];
  out.push(...best(events(D.mono(await S("fs:172411")), { thresholdDb: -16, minGap: 0.35, maxLen: 3 }), 3));
  return out.map((a) => {
    hp(a, 220, 2); lp(a, 9000);
    return D.edges(D.trimSilence(a, -45, 0.02, 0.15), 0.01, 0.2);
  });
}, ["fs:238289", "fs:119468", "fs:483166", "fs:172411"]);
def("amb.rattle", { cat: "ambience", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:274766")), { thresholdDb: -14, minGap: 0.4, maxLen: 2.2 }), 4);
  return list.map((a) => (hp(a, 180, 2), lp(a, 10000), a));
}, ["fs:274766"]);
def("amb.settle", { cat: "ambience", rate: 32000 }, async () => {
  const keys = ["fs:618084", "fs:618082", "fs:590171", "fs:506665", "kenney_rpg:creak1", "kenney_rpg:creak2", "kenney_rpg:creak3"];
  const out = [];
  for (const k of keys) {
    const a = D.mono(await S(k));
    hp(a, 140, 2); lp(a, 8000);
    out.push(D.edges(D.trimSilence(a, -45, 0.01, 0.12), 0.005, 0.15));
  }
  return out;
}, ["fs:618084", "fs:618082", "fs:590171", "fs:506665", "kenney_rpg:creak1", "kenney_rpg:creak2", "kenney_rpg:creak3"]);
def("amb.branch", { cat: "ambience", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:733731")), { thresholdDb: -16, minGap: 0.3, maxLen: 2.5 }), 4);
  return list.map((a) => (hp(a, 260, 2), lp(a, 11000), D.softLimit(a, -3), a));
}, ["fs:733731"]);
def("amb.crow", { cat: "ambience", rate: 32000 }, async () => {
  const hooded = D.mono(await S("fs:741366"));
  const caws = onsets(hooded, { thresholdDb: -20, minGap: 0.12, maxLen: 1 });
  const take = (i, n) => D.edges(D.slice(hooded, caws[i].from, caws[Math.min(caws.length - 1, i + n - 1)].to + 0.25), 0.01, 0.2);
  const out = caws.length >= 6 ? [take(0, 1), take(1, 2), take(3, 3), take(6 % caws.length, 2)] : [hooded];
  out.push(...best(events(D.mono(await S("fs:250095")), { thresholdDb: -14, minGap: 0.5, pre: 0.05, post: 0.4, maxLen: 2 }), 2));
  return out.map((a) => (hp(a, 300, 2), lp(a, 9000), a));
}, ["fs:741366", "fs:250095"]);
def("amb.owl", { cat: "ambience", rate: 24000 }, async () => {
  const out = [];
  const tawny = D.mono(await S("fs:655380"));
  out.push(D.edges(D.slice(tawny, 0.25, D.duration(tawny)), 0.05, 0.3));
  out.push(...best(events(D.mono(await S("fs:688869")), { thresholdDb: -14, minGap: 0.8, pre: 0.08, post: 0.5, maxLen: 3 }), 2));
  out.push(...best(events(D.mono(await S("fs:450214")), { thresholdDb: -12, minGap: 0.8, pre: 0.08, post: 0.5, maxLen: 3 }), 1));
  out.push(D.mono(await S("fs:558397")));
  return out.map((a) => {
    hp(a, 160, 2); lp(a, 6500);
    D.softLimit(a, -3);
    return D.edges(D.trimSilence(a, -40, 0.05, 0.3), 0.02, 0.25);
  });
}, ["fs:655380", "fs:688869", "fs:450214", "fs:558397"]);
def("amb.batwings", { cat: "ambience", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:546823")), { thresholdDb: -14, minGap: 0.4, pre: 0.1, post: 0.3, maxLen: 3 }), 4);
  return list.map((a) => (hp(a, 300, 2), lp(a, 11000), a));
}, ["fs:546823"]);
def("amb.batsqueak", { cat: "ambience", rate: 32000 }, async () => {
  // Bat social calls an octave down, into the range people (and phones) actually hear.
  const a = tune(D.mono(await S("fs:806574")), 0.5);
  const list = best(events(a, { thresholdDb: -12, minGap: 0.08, pre: 0.01, post: 0.05, maxLen: 0.8 }), 5);
  return list.map((x) => (hp(x, 1500, 2), lp(x, 9000), x));
}, ["fs:806574"]);

// ===== Character foley =====
async function steps(key, n, { pitchBy = 0.94, hpf = 70, lpf = 14000, thr = -30 } = {}) {
  const a = D.mono(await S(key));
  const list = events(a, { thresholdDb: thr, minGap: 0.16, pre: 0.004, post: 0.22, minLen: 0.12, maxLen: 0.9 });
  return best(list, n).map((x) => {
    x = tune(x, pitchBy);
    hp(x, hpf, 2); lp(x, lpf);
    return D.edges(D.trimSilence(x, -50, 0.004, 0.12), 0.002, 0.08);
  });
}
def("step.stone", { cat: "foley" }, async () => [...(await steps("fs:521590", 6)), ...(await steps("fs:813622", 6))], ["fs:521590", "fs:813622"]);
def("step.soil", { cat: "foley" }, async () => steps("fs:548384", 10, { lpf: 11000 }), ["fs:548384"]);
def("step.grass", { cat: "foley" }, async () => steps("fs:521587", 6, { lpf: 12000 }), ["fs:521587"]);
def("step.scuff", { cat: "foley", rate: 32000 }, async () => {
  const a = D.mono(await S("fs:667284"));
  const b = D.mono(await S("fs:321488"));
  const out = [];
  for (const [src, from, len] of [[a, 0.05, 0.28], [a, 0.45, 0.3], [b, 0.2, 0.32], [b, 0.9, 0.26], [b, 1.6, 0.3]]) {
    const x = D.slice(src, from, from + len);
    hp(x, 300, 2); lp(x, 9000);
    out.push(D.edges(x, 0.02, 0.12));
  }
  return out;
}, ["fs:667284", "fs:321488"]);
def("step.brush", { cat: "foley", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:637547")), { thresholdDb: -14, minGap: 0.15, pre: 0.02, post: 0.1, maxLen: 0.7 }), 5);
  return list.map((x) => (hp(x, 350, 2), lp(x, 11000), x));
}, ["fs:637547"]);
def("step.weight", { cat: "foley", rate: 16000 }, async () => {
  const out = [];
  for (let i = 0; i < 5; i++) {
    let a = D.mono(await S(`kenney_impact:impactSoft_heavy_00${i}`));
    a = tune(a, 0.72);
    hp(a, 55, 2); lp(a, 700);
    out.push(D.edges(a, 0.002, 0.05));
  }
  return out;
}, [0, 1, 2, 3, 4].map((i) => `kenney_impact:impactSoft_heavy_00${i}`));
def("step.wet", { cat: "foley", rate: 32000 }, async () => {
  const list = await steps("fs:548384", 5, { pitchBy: 1, hpf: 1200, lpf: 12000 });
  return list;
}, ["fs:548384"]);
def("cloth.move", { cat: "foley", rate: 32000, level: ["M", -24] }, async () => {
  const out = [];
  for (const k of ["cloth1", "cloth2", "cloth3", "cloth4", "clothBelt", "clothBelt2"]) {
    const a = D.mono(await S(`kenney_rpg:${k}`));
    hp(a, 160, 2); lp(a, 11000);
    out.push(D.edges(D.trimSilence(a, -40, 0.01, 0.06), 0.01, 0.06));
  }
  return out;
}, ["cloth1", "cloth2", "cloth3", "cloth4", "clothBelt", "clothBelt2"].map((k) => `kenney_rpg:${k}`));
def("cloth.big", { cat: "foley", rate: 32000, level: ["M", -22] }, async () => {
  const list = best(events(D.mono(await S("fs:235252")), { thresholdDb: -12, minGap: 0.2, pre: 0.03, post: 0.15, maxLen: 1.5 }), 4);
  return list.map((x) => (hp(x, 220, 2), lp(x, 10000), x));
}, ["fs:235252"]);
def("leather", { cat: "foley", rate: 32000, level: ["M", -24] }, async () => {
  const out = [D.mono(await S("fs:501015"))];
  out.push(...best(events(D.mono(await S("fs:445159")), { thresholdDb: -14, minGap: 0.2, maxLen: 1.2 }), 2));
  for (const k of ["handleSmallLeather", "handleSmallLeather2"]) out.push(D.mono(await S(`kenney_rpg:${k}`)));
  return out.map((a) => (hp(a, 160, 2), lp(a, 10000), D.edges(D.trimSilence(a, -40, 0.01, 0.08), 0.01, 0.06)));
}, ["fs:501015", "fs:445159", "kenney_rpg:handleSmallLeather", "kenney_rpg:handleSmallLeather2"]);
def("hardware", { cat: "foley", rate: 32000, level: ["M", -26] }, async () => {
  const out = [];
  for (const k of ["beltHandle1", "beltHandle2", "metalClick", "dropLeather"]) {
    const a = D.mono(await S(`kenney_rpg:${k}`));
    hp(a, 250, 2);
    out.push(D.edges(D.trimSilence(a, -40, 0.005, 0.06), 0.004, 0.05));
  }
  return out;
}, ["beltHandle1", "beltHandle2", "metalClick", "dropLeather"].map((k) => `kenney_rpg:${k}`));
def("body.impact", { cat: "foley", rate: 32000, level: ["M", -18] }, async () => {
  const dirt = await steps("fs:556002", 5, { pitchBy: 0.9 });
  const out = [];
  for (let i = 0; i < 5; i++) {
    let a = tune(D.mono(await S(`kenney_impact:impactPunch_heavy_00${i}`)), 0.78);
    lp(a, 2500);
    a = seq([[a, 0, 0], [dirt[i % dirt.length], 0.005, -6]]);
    hp(a, 50, 2);
    out.push(D.edges(a, 0.002, 0.1));
  }
  return out;
}, ["fs:556002", ...[0, 1, 2, 3, 4].map((i) => `kenney_impact:impactPunch_heavy_00${i}`)]);
def("breath.in", { cat: "foley", rate: 24000, level: ["M", -24] }, async () => breaths(0), ["fs:722717"]);
def("breath.out", { cat: "foley", rate: 24000, level: ["M", -24] }, async () => breaths(1), ["fs:722717"]);
async function breaths(part) {
  // Each breath cycle: inhale then exhale, split at the quietest point in its middle third.
  let a = tune(D.mono(await S("fs:722717")), 0.9);
  hp(a, 130, 2); lp(a, 6000);
  const segs = onsets(a, { thresholdDb: -26, minGap: 0.5, pre: 0.05, post: 0.2, minLen: 1, maxLen: 12, win: 0.02, smooth: 4 });
  const out = [];
  for (const s of segs) {
    const x = D.slice(a, s.from, s.to);
    // the turn from inhaling to exhaling: the quietest 200 ms in the middle of the cycle
    const m = x.channels[0];
    const w = Math.round(0.2 * 48000);
    let best = 0.5, low = Infinity;
    for (let f = 0.3; f <= 0.7; f += 0.01) {
      const at = Math.round(f * m.length);
      let e = 0;
      for (let i = at - w / 2; i < at + w / 2; i++) e += m[i] * m[i];
      if (e < low) { low = e; best = f; }
    }
    const turn = best * D.duration(x);
    // a quick intake (its last 1.1 s) and a short release (its first 1.7 s)
    const piece = part === 0 ? D.slice(x, Math.max(0, turn - 1.1), turn) : D.slice(x, turn, Math.min(D.duration(x), turn + 1.7));
    out.push(part === 0 ? D.edges(piece, 0.35, 0.05) : D.edges(piece, 0.04, 0.8));
  }
  return out.slice(0, 5);
}

// ===== Electricity =====
def("elec.spark", { cat: "fx", rate: 32000, level: ["M", -22] }, async () => {
  const list = best(events(D.mono(await S("fs:655812")), { thresholdDb: -16, minGap: 0.1, pre: 0.005, post: 0.08, maxLen: 0.8 }), 6);
  return list.map((x) => (hp(x, 400, 2), lp(x, 10000), shelf(x, "highshelf", 6000, -3), x));
}, ["fs:655812"]);
def("elec.zap", { cat: "fx", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:393823")), { thresholdDb: -14, minGap: 0.2, pre: 0.005, post: 0.25, maxLen: 3 }), 6);
  return list.map((x) => (hp(x, 160, 2), lp(x, 11000), shelf(x, "highshelf", 6000, -4), x));
}, ["fs:393823"]);
def("elec.arc", { cat: "fx", rate: 32000 }, async () => {
  const a = D.mono(await S("fs:449013"));
  hp(a, 140, 2); lp(a, 9500); shelf(a, "highshelf", 5000, -5);
  const out = [];
  for (let t = 2; t + 2.4 < Math.min(38, D.duration(a)) && out.length < 4; t += 8) out.push(D.edges(D.slice(a, t, t + 2.4), 0.06, 0.4));
  return out;
}, ["fs:449013"]);
def("elec.buzz", { cat: "fx", rate: 32000, loop: true, level: ["I", -23] }, async () => {
  const a = D.mono(await S("fs:776446"));
  const segs = onsets(a, { thresholdDb: -10, minGap: 0.3, minLen: 4, maxLen: 60, win: 0.02 });
  const s = segs[0] || { from: 1, to: 9 };
  const x = D.slice(a, s.from + 0.5, Math.min(s.to - 0.3, s.from + 9.5));
  hp(x, 120, 2); lp(x, 9000); shelf(x, "highshelf", 4500, -5);
  return [D.makeLoop(x, 1.5)];
}, ["fs:776446"]);
def("elec.crackle", { cat: "fx", rate: 32000, loop: true, level: ["I", -23] }, async () => {
  const a = D.mono(D.slice(await S("fs:871766"), 0.2, 10.5));
  hp(a, 400, 2); lp(a, 8500); shelf(a, "highshelf", 4000, -6);
  return [D.makeLoop(a, 1.5)];
}, ["fs:871766"]);
def("elec.relay", { cat: "fx", rate: 32000 }, async () => {
  const list = best(events(D.mono(await S("fs:807384")), { thresholdDb: -10, minGap: 0.3, pre: 0.005, post: 0.35, maxLen: 1.2 }), 6);
  return list.map((x) => (hp(x, 90, 2), lp(x, 11000), x));
}, ["fs:807384"]);
def("elec.relays", { cat: "fx", rate: 32000 }, async () => {
  const a = D.mono(await S("fs:513818"));
  hp(a, 200, 2); lp(a, 10000); shelf(a, "highshelf", 5000, -4);
  return [D.edges(D.slice(a, 2, 4.2), 0.02, 0.3), D.edges(D.slice(a, 9, 11), 0.02, 0.3)];
}, ["fs:513818"]);
def("elec.lever", { cat: "fx", rate: 32000, level: ["M", -18] }, async () => {
  // A knife switch thrown home: the latch, the contact, a spit of spark.
  const latch = D.mono(await S("kenney_rpg:metalLatch"));
  const relays = best(events(D.mono(await S("fs:807384")), { thresholdDb: -10, minGap: 0.3, pre: 0.005, post: 0.35, maxLen: 1.2 }), 3);
  const sparks = best(events(D.mono(await S("fs:655812")), { thresholdDb: -16, minGap: 0.1, pre: 0.005, post: 0.08, maxLen: 0.8 }), 3);
  return relays.map((r, i) => {
    const a = seq([[tune(latch, 0.85 + i * 0.05), 0, -4], [tune(r, 0.9), 0.06, 0], [sparks[i % sparks.length], 0.08, -6]]);
    hp(a, 70, 2);
    return D.edges(a, 0.002, 0.2);
  });
}, ["kenney_rpg:metalLatch", "fs:807384", "fs:655812"]);

// A charging whine (synthesized: electrical energy is the one place synthesis is the real
// sound): a buzzy harmonic tone sweeping up with filtered noise, under the recorded buzz.
function whine(seconds, f0, f1, { hold = 0, seed = 3, fall = false } = {}) {
  const r = 48000;
  const n = Math.round((seconds + hold) * r);
  const out = new Float32Array(n);
  const R = D.rng(seed);
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / r;
    const u = Math.min(1, t / seconds);
    const shape = fall ? 1 - (1 - u) ** 2 : u * u * (3 - 2 * u);
    const f = f0 * (f1 / f0) ** shape;
    ph += (2 * Math.PI * f) / r;
    ph2 += (2 * Math.PI * f * 2.003) / r;
    // band-limited buzz: a few odd/even partials, brighter as it rises
    let s = 0;
    for (let k = 1; k <= 7; k++) s += Math.sin(ph * k + k) / (k ** (1.25 - 0.35 * u));
    s = s * 0.5 + Math.sin(ph2) * 0.15 + (R() * 2 - 1) * 0.08 * (0.3 + u);
    const wobble = 1 + 0.08 * Math.sin(2 * Math.PI * (6 + 10 * u) * t);
    out[i] = s * wobble;
  }
  const a = { sampleRate: r, channels: [out] };
  hp(a, 120, 2); lp(a, 6000); shelf(a, "highshelf", 3000, -4);
  return a;
}
def("lab.charge", { cat: "fx", rate: 32000, level: ["M", -20] }, async () => {
  const buzz = D.mono(await S("fs:776446"));
  const segs = onsets(buzz, { thresholdDb: -10, minGap: 0.3, minLen: 4, maxLen: 60, win: 0.02 });
  const s = segs[1] || segs[0] || { from: 1, to: 9 };
  const out = [];
  // The coils charge for ~2.7 s after the switch (lab) and ~3 s into the reanimation (grand).
  for (const [len, seed] of [[2.8, 3], [3.2, 5]]) {
    const w = whine(len, 70, 330, { hold: 3, seed });
    let b = D.slice(buzz, s.from + 0.3, s.from + 0.3 + len + 3);
    hp(b, 150, 2); lp(b, 8000);
    // the buzz swells in with the whine
    D.envelope(b, [[0, 0.15], [len, 1], [len + 3, 1]]);
    D.envelope(w, [[0, 0], [0.6, 0.6], [len, 1], [len + 3, 1]]);
    const a = seq([[w, 0, -3], [b, 0, -2]]);
    out.push(D.edges(a, 0.3, 0.1));
  }
  return out;
}, ["fs:776446"]);
def("lab.discharge", { cat: "fx", rate: 32000, level: ["M", -16] }, async () => {
  const zaps = best(events(D.mono(await S("fs:393823")), { thresholdDb: -14, minGap: 0.2, pre: 0.005, post: 0.25, maxLen: 3 }), 2);
  const crack = D.slice(await S("fs:567945"), 1.6, 5.5);
  const punch = tune(D.mono(await S("kenney_impact:impactPunch_heavy_002")), 0.6);
  lp(punch, 1500);
  const crackle = D.mono(D.slice(await S("fs:871766"), 0.5, 4.5));
  hp(crackle, 500); lp(crackle, 8000);
  D.envelope(crackle, [[0, 1], [4, 0]]);
  return zaps.map((z, i) => {
    const a = seq([[z, 0, 0], [crack, 0.01, -5 - i], [punch, 0, -3], [crackle, 0.15, -10]]);
    hp(a, 40, 2); shelf(a, "highshelf", 6000, -3);
    return D.edges(a, 0.001, 1.2);
  });
}, ["fs:393823", "fs:567945", "kenney_impact:impactPunch_heavy_002", "fs:871766"]);
def("lab.tail", { cat: "fx", rate: 32000, level: ["M", -22] }, async () => {
  const crackle = D.mono(D.slice(await S("fs:871766"), 3, 7));
  hp(crackle, 600); lp(crackle, 7000);
  return [3, 7].map((seed) => {
    const w = whine(3.4, 320, 55, { seed, fall: true });
    D.envelope(w, [[0, 1], [3.4, 0]]);
    const c = D.clone(crackle);
    D.envelope(c, [[0, 0.8], [2.5, 0.15], [4, 0]]);
    return D.edges(seq([[w, 0, -2], [c, 0, -8]]), 0.01, 0.5);
  });
}, ["fs:871766"]);
def("lab.powerdown", { cat: "fx", rate: 24000, level: ["M", -22] }, async () => {
  // The power draw: the hum sags as the candles dim.
  const h = D.mono(D.slice(await S("fs:785942"), 10, 13));
  hp(h, 40); D.normalizePeak(h, -6); D.saturate(h, 2);
  const out = [];
  for (const k of [0.7, 0.62]) {
    // pitch glide down by resampling in two halves
    const a = D.concat(D.slice(h, 0, 0.5), tune(D.slice(h, 0.5, 2.2), 0.85), tune(D.slice(h, 2.2, 3), k));
    hp(a, 80, 2); lp(a, 2500);
    D.envelope(a, [[0, 0], [0.08, 1], [1, 0.8], [D.duration(a), 0]]);
    out.push(a);
  }
  return out;
}, ["fs:785942"]);

// ===== Bells, glints and shimmer (the musical side of the events) =====
// The recorded crystal bell (Bb3) pitched to a D-minor pentatonic set: small glass glints.
const NOTES = { D5: 587.33, F5: 698.46, G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66, F6: 1396.91, A6: 1760 };
async function glint(note, len = 1.6) {
  const bell = D.mono(D.slice(await S("fs:858114"), 0, 12));
  const ratio = NOTES[note] / 233.08;
  let a = D.slice(tune(bell, ratio), 0, len);
  hp(a, 300, 2);
  return D.edges(a, 0.001, len * 0.5);
}
async function tube(note, len = 3) {
  const bell = D.mono(D.slice(await S("fs:858147"), 0, 10));
  let a = D.slice(tune(bell, NOTES[note] / 466.16), 0, len);
  hp(a, 200, 2);
  return D.edges(a, 0.001, len * 0.5);
}
async function chime(i) {
  const c = D.mono(await S("fs:437337"));
  const list = onsets(c, { thresholdDb: -18, minGap: 0.25, pre: 0.005, post: 1.2, maxLen: 2.5 });
  const s = list[(i * 7) % Math.max(1, list.length)] || { from: 0, to: 1.5 };
  const a = D.slice(c, s.from, s.from + 1.6);
  hp(a, 900, 2);
  return D.edges(a, 0.002, 0.8);
}
const BELLS = ["fs:858114", "fs:858147", "fs:437337"];
def("ack.glint", { cat: "fx", rate: 32000, level: ["M", -22] }, async () => {
  const out = [];
  const notes = ["D6", "A5", "F6", "C6", "G5", "D5"];
  for (let i = 0; i < notes.length; i++) out.push(seq([[await glint(notes[i]), 0, 0], [await chime(i), 0.02, -12]]));
  return out;
}, BELLS);
def("ack.two", { cat: "fx", rate: 32000, level: ["M", -21] }, async () => {
  const pairs = [["A5", "D6"], ["F5", "C6"], ["D5", "A5"], ["G5", "D6"]];
  const out = [];
  for (const [a, b] of pairs) out.push(seq([[await glint(a), 0, -1], [await glint(b, 1.8), 0.13, 0], [await chime(out.length + 3), 0.15, -12]]));
  return out;
}, BELLS);
def("ack.three", { cat: "fx", rate: 32000, maxDur: 2.6, level: ["M", -20] }, async () => {
  const runs = [["D5", "F5", "A5"], ["F5", "A5", "C6"], ["A5", "C6", "D6"], ["G5", "A5", "D6"]];
  const out = [];
  for (const r of runs) {
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push([await glint(r[i], 1.8), i * 0.11, i === 2 ? 0 : -2]);
    parts.push([await chime(out.length + 5), 0.24, -10]);
    out.push(air(seq(parts), -16));
  }
  return out;
}, BELLS);

// ===== Signature events =====
// Bolt Spark (30-99): close, intimate electricity at his neck.
def("bolt.tick", { cat: "fx", rate: 32000, level: ["M", -26] }, async () => {
  const list = best(events(D.mono(await S("fs:655812")), { thresholdDb: -20, minGap: 0.05, pre: 0.002, post: 0.03, maxLen: 0.25 }), 4);
  return list.map((x) => (hp(x, 900, 2), lp(x, 9000), x));
}, ["fs:655812"]);
def("bolt.buzz", { cat: "fx", rate: 32000, level: ["M", -22] }, async () => {
  return [2, 9].map((seed) => {
    const w = whine(0.7, 140, 420, { seed });
    D.envelope(w, [[0, 0], [0.6, 1], [0.7, 0.8]]);
    return D.edges(w, 0.01, 0.08);
  });
}, []);
def("bolt.snap", { cat: "fx", rate: 32000, level: ["M", -18] }, async () => {
  const zaps = best(events(D.mono(await S("fs:393823")), { thresholdDb: -14, minGap: 0.2, pre: 0.003, post: 0.2, maxLen: 1.5 }), 3);
  const sparks = best(events(D.mono(await S("fs:655812")), { thresholdDb: -16, minGap: 0.1, pre: 0.003, post: 0.1, maxLen: 0.8 }), 4);
  return zaps.map((z, i) => {
    const a = seq([[D.slice(z, 0, 0.9), 0, 0], [sparks[i % sparks.length], 0.12, -5], [sparks[(i + 1) % sparks.length], 0.35, -8]]);
    hp(a, 200, 2); shelf(a, "highshelf", 6000, -3);
    return D.edges(a, 0.001, 0.3);
  });
}, ["fs:393823", "fs:655812"]);
def("fire.flick", { cat: "fx", rate: 32000, level: ["M", -24] }, async () => {
  const f = D.mono(await S("fs:637533"));
  hp(f, 200, 2);
  return [0.95, 1.1].map((p) => D.edges(tune(D.clone(f), p), 0.004, 0.3));
}, ["fs:637533"]);

// Pumpkin Whisper (100-499): warm fire, a whisper from inside the pumpkin, a little magic.
def("pumpkin.ignite", { cat: "fx", rate: 32000, level: ["M", -18] }, async () => {
  const a = D.mono(await S("fs:637533"));
  const b = D.mono(D.slice(await S("fs:592572"), 0, 2.6));
  hp(b, 110, 2); lp(b, 6000);
  return [0, 1].map((i) => {
    const x = seq([[tune(D.clone(a), 0.85 + 0.15 * i), 0, 0], [b, 0.02, -4]]);
    hp(x, 70, 2);
    return D.edges(x, 0.005, 0.8);
  });
}, ["fs:637533", "fs:592572"]);
async function whispers(key, n, { from = 0, to = null } = {}) {
  const a = D.mono(D.slice(await S(key), from, to));
  hp(a, 450, 2); lp(a, 6500);
  let list = onsets(a, { thresholdDb: -14, minGap: 0.6, pre: 0.1, post: 0.4, minLen: 1, maxLen: 4, win: 0.02, smooth: 4 });
  // continuous whispering: fixed 3.4 s windows instead
  if (list.length < n) list = Array.from({ length: Math.floor((D.duration(a) - 3.4) / 4) }, (_, i) => ({ from: i * 4, to: i * 4 + 3.4 }));
  return best(list.map((s) => D.edges(D.slice(a, s.from, Math.min(s.to, s.from + 3.4)), 0.3, 0.8)), n);
}
def("pumpkin.whisper", { cat: "fx", rate: 24000, level: ["M", -22] }, async () => {
  const list = [...(await whispers("fs:194628", 2)), ...(await whispers("fs:656439", 1))];
  return list.map((w) => {
    w = tune(w, 0.92);
    return D.edges(air(w, -9), 0.2, 0.9); // stereo: a little space inside the pumpkin
  });
}, ["fs:194628", "fs:656439"]);
def("pumpkin.magic", { cat: "fx", rate: 32000, level: ["M", -20] }, async () => {
  const runs = [["A5", "D6", "F6"], ["C6", "F6", "A6"]];
  const out = [];
  for (const r of runs) {
    const parts = [];
    for (let i = 0; i < 3; i++) parts.push([await glint(r[i], 1.4), i * 0.07, -2]);
    parts.push([await chime(out.length + 2), 0.12, -6]);
    out.push(air(seq(parts), -12));
  }
  return out;
}, BELLS);

// Haunted Gate (500-999): iron, wind and something spectral.
def("gate.toll", { cat: "fx", rate: 24000, maxDur: 8, level: ["M", -22] }, async () => {
  const a = D.mono(D.slice(await S("fs:554655"), 0, 9));
  hp(a, 90, 2); lp(a, 3200);
  D.envelope(a, [[0, 1], [6, 0.6], [9, 0]]);
  return [D.edges(space(a, -8), 0.002, 2)];
}, ["fs:554655"]);
def("gate.creak", { cat: "fx", rate: 32000, level: ["M", -19] }, async () => {
  const out = [D.mono(await S("fs:238289")), D.mono(await S("fs:483166"))];
  out.push(...best(events(D.mono(await S("fs:172411")), { thresholdDb: -10, minGap: 0.6, maxLen: 4 }), 1));
  return out.map((a) => {
    a = tune(a, 0.88);
    hp(a, 150, 2); lp(a, 8000);
    return D.edges(air(D.trimSilence(a, -45, 0.02, 0.2), -14), 0.01, 0.4);
  });
}, ["fs:238289", "fs:483166", "fs:172411"]);
def("gate.clank", { cat: "fx", rate: 32000, level: ["M", -18] }, async () => {
  const rattles = best(events(D.mono(await S("fs:274766")), { thresholdDb: -8, minGap: 0.4, maxLen: 1.6 }), 2);
  const clunk = best(events(D.mono(await S("fs:807384")), { thresholdDb: -10, minGap: 0.3, pre: 0.005, post: 0.35, maxLen: 1.2 }), 2);
  return rattles.map((r, i) => {
    const a = seq([[tune(clunk[i], 0.7), 0, -3], [r, 0.005, 0]]);
    hp(a, 80, 2); lp(a, 9000);
    return D.edges(air(a, -12), 0.002, 0.5);
  });
}, ["fs:274766", "fs:807384"]);
def("gate.wind", { cat: "fx", rate: 24000, level: ["M", -21] }, async () => {
  const a = L(await S("fs:331222"));
  hp(a, 90, 2); lp(a, 6000);
  const segs = onsets(a, { thresholdDb: -6, minGap: 1.5, pre: 1.5, post: 1.5, minLen: 2, maxLen: 8, win: 0.1, smooth: 5 });
  return best(segs.map((s) => D.edges(D.slice(a, s.from, Math.min(s.from + 6, s.to)), 1.2, 2)), 3);
}, ["fs:331222"]);
def("gate.spectral", { cat: "fx", rate: 32000, maxDur: 6, level: ["M", -21] }, async () => {
  const swell = D.mono(D.slice(await S("fs:826131"), 0, 66));
  const segs = onsets(swell, { thresholdDb: -8, minGap: 1, pre: 3, post: 0.2, minLen: 1, maxLen: 20, win: 0.05, smooth: 4 });
  const w = await whispers("fs:194628", 2, { from: 30, to: 90 });
  const out = [];
  for (let i = 0; i < 2; i++) {
    const s = segs[i] || { peakAt: 4 + i * 8 };
    let c = D.slice(swell, Math.max(0, s.peakAt - 3.5), s.peakAt + 0.4);
    lp(c, 5000); hp(c, 200, 2);
    const wh = rev(D.clone(w[i % w.length]));
    const a = seq([[c, 0, 0], [wh, 0.3, -6]]);
    D.envelope(a, [[0, 0], [3, 1], [3.8, 1], [D.duration(a), 0]]);
    out.push(D.edges(space(a, -6), 0.05, 1.5));
  }
  return out;
}, ["fs:826131", "fs:194628"]);
def("gate.bats", { cat: "fx", rate: 32000, level: ["M", -21] }, async () => {
  const a = D.mono(await S("fs:437935"));
  hp(a, 260, 2); lp(a, 11000);
  const sq = tune(D.mono(await S("fs:806574")), 0.5);
  hp(sq, 1500, 2); lp(sq, 9000);
  return [6, 30].map((t, i) => {
    const flock = D.slice(a, t, t + 4.5);
    D.envelope(flock, [[0, 0], [0.8, 1], [3.2, 1], [4.5, 0]]);
    return D.edges(seq([[flock, 0, 0], [D.slice(sq, 3 + i * 9, 6 + i * 9), 0.5, -12]]), 0.05, 0.6);
  });
}, ["fs:437935", "fs:806574"]);

// Laboratory Surge (1000-2999): relays, a knife switch, coils, arcs, discharge into his bolts.
// (elec.*, lab.* above.) Galaxy variant: starlight instead of plain sparks.
def("gal.pad", { cat: "fx", rate: 24000, loop: true, level: ["I", -23] }, async () => {
  const a = D.mono(D.slice(await S("fs:772279"), 4, 22));
  hp(a, 400, 2); lp(a, 11000); shelf(a, "highshelf", 7000, -4);
  return [D.makeLoop(a, 4)];
}, ["fs:772279"]);
def("gal.twinkle", { cat: "fx", rate: 32000, level: ["M", -26] }, async () => {
  const out = [];
  for (const n of ["D6", "F6", "A6", "C6", "A5", "F6"]) {
    const a = D.slice(await glint(n, 1), 0, 1);
    hp(a, 800, 2);
    out.push(a);
  }
  return out;
}, BELLS);
def("gal.rise", { cat: "fx", rate: 32000, level: ["M", -20] }, async () => {
  const swell = D.mono(await S("fs:826131"));
  const segs = onsets(swell, { thresholdDb: -8, minGap: 1, pre: 4, post: 0.05, minLen: 1, maxLen: 20, win: 0.05, smooth: 4 });
  return segs.slice(0, 2).map((s) => {
    const c = D.slice(swell, Math.max(0, s.peakAt - 4), s.peakAt + 0.05);
    hp(c, 500, 2); lp(c, 12000);
    return D.edges(c, 0.5, 0.05);
  });
}, ["fs:826131"]);
def("gal.bloom", { cat: "fx", rate: 32000, stereo: true, maxDur: 6.5, level: ["M", -17] }, async () => {
  const chords = [["D5", "A5", "D6", "F6"], ["F5", "C6", "F6", "A6"]];
  const glass = D.mono(D.slice(await S("fs:145513"), 0, 8));
  hp(glass, 300, 2);
  const out = [];
  for (const c of chords) {
    const parts = [[await tube(c[0], 6), 0, -2]];
    for (let i = 0; i < c.length; i++) parts.push([await glint(c[i], 4), 0.02 * i, -3]);
    for (let i = 0; i < 5; i++) parts.push([await chime(i + out.length * 5), 0.15 + i * 0.21, -9]);
    parts.push([glass, 0, -8]);
    const a = seq(parts);
    D.envelope(a, [[0, 1], [2, 0.8], [6, 0.4], [D.duration(a), 0]]);
    out.push(D.edges(space(a, -7), 0.001, 2));
  }
  return out;
}, [...BELLS, "fs:145513"]);

// The Grand Reanimation (3000+): storm, apparatus, rising, a beautiful aftermath.
def("grand.toll", { cat: "fx", rate: 24000, maxDur: 9, level: ["M", -20] }, async () => {
  const a = D.mono(D.slice(await S("fs:139110"), 0, 10));
  hp(a, 70, 2); lp(a, 4000);
  D.envelope(a, [[0, 1], [7, 0.5], [10, 0]]);
  return [D.edges(space(a, -8), 0.002, 2.5)];
}, ["fs:139110"]);
def("grand.choir", { cat: "fx", rate: 24000, maxDur: 8, level: ["M", -20] }, async () => {
  // Spectral voices: a slowed singing bowl and reversed whispers, swelling into the climax.
  const bowl = tune(D.mono(D.slice(await S("fs:573805"), 0, 20)), 0.75);
  hp(bowl, 150, 2); lp(bowl, 4000);
  const w = await whispers("fs:194628", 2, { from: 10, to: 80 });
  const out = [];
  for (let i = 0; i < 2; i++) {
    const a = seq([[D.slice(bowl, i * 4, i * 4 + 7), 0, 0], [rev(D.clone(w[i % w.length])), 1.5, -6]]);
    D.envelope(a, [[0, 0], [5, 1], [5.6, 0.9], [7, 0]]);
    out.push(D.edges(space(a, -5), 0.1, 1));
  }
  return out;
}, ["fs:573805", "fs:194628"]);
def("grand.chimes", { cat: "fx", rate: 32000, maxDur: 7, level: ["M", -24] }, async () => {
  const c = D.mono(await S("fs:437337"));
  hp(c, 700, 2); lp(c, 10000);
  return [10, 40].map((t) => {
    const a = D.slice(c, t, t + 9);
    D.envelope(a, [[0, 0], [1.5, 1], [6, 0.7], [9, 0]]);
    return a;
  });
}, ["fs:437337"]);
// Lion variant: a spectral lion, controlled, with weight in the low mids rather than sub-bass.
def("lion.growl", { cat: "fx", rate: 24000, level: ["M", -21] }, async () => {
  const a = D.mono(await S("fs:270383"));
  hp(a, 70, 2); lp(a, 5000); shelf(a, "lowshelf", 120, -3);
  const segs = onsets(a, { thresholdDb: -10, minGap: 0.4, pre: 0.2, post: 0.4, minLen: 0.8, maxLen: 4, win: 0.02, smooth: 4 });
  return best(segs.map((s) => D.edges(air(D.slice(a, s.from, s.to), -12), 0.15, 0.6)), 2);
}, ["fs:270383"]);
def("lion.roar", { cat: "fx", rate: 32000, level: ["M", -16] }, async () => {
  const a = D.mono(await S("fs:69572"));
  const segs = onsets(a, { thresholdDb: -6, minGap: 0.35, pre: 0.08, post: 0.6, minLen: 0.8, maxLen: 3.5, win: 0.02, smooth: 3 });
  const roars = best(segs.map((s) => D.slice(a, s.from, s.to)), 2);
  const punch = tune(D.mono(await S("kenney_impact:impactPunch_heavy_001")), 0.55);
  lp(punch, 900);
  return roars.map((r) => {
    hp(r, 75, 2); peakEq(r, 3000, -3, 0.8); shelf(r, "lowshelf", 110, -2);
    D.softLimit(r, -6);
    D.saturate(r, 1.2);
    const x = seq([[r, 0, 0], [punch, 0.03, -6]]);
    return D.edges(space(x, -9), 0.01, 1.2);
  });
}, ["fs:69572", "kenney_impact:impactPunch_heavy_001"]);

// Old gift effects still emitted by the show
def("fw.burst", { cat: "fx", rate: 24000, level: ["M", -22] }, async () => {
  const booms = best(events(D.mono(await S("fs:434225")), { thresholdDb: -12, minGap: 0.4, pre: 0.01, post: 1, maxLen: 3 }), 4);
  const crack = D.mono(await S("fs:505264"));
  hp(crack, 600, 2); lp(crack, 9000);
  const cr = best(events(crack, { thresholdDb: -10, minGap: 0.5, pre: 0.01, post: 0.5, maxLen: 2.5 }), 4);
  return booms.map((b, i) => {
    hp(b, 60, 2); lp(b, 5000);
    return D.edges(seq([[b, 0, 0], [cr[i % cr.length], 0.25, -7]]), 0.002, 0.8);
  });
}, ["fs:434225", "fs:505264"]);

// ===== Interface cues =====
// (the interface cues' recipes are in UI below; they share the glint helpers)
def("ui.open", { cat: "ui", rate: 32000, maxDur: 3, level: ["M", -24] }, async () => null, ["fs:858147", "fs:423799"]);
def("ui.close", { cat: "ui", rate: 32000, level: ["M", -25] }, async () => null, BELLS);
def("ui.clue", { cat: "ui", rate: 32000, maxDur: 3.2, level: ["M", -23] }, async () => null, [...BELLS, "fs:826131"]);
def("ui.payoff", { cat: "ui", rate: 32000, maxDur: 3, level: ["M", -21] }, async () => null, BELLS);
def("ui.surprise", { cat: "ui", rate: 32000, level: ["M", -23] }, async () => null, [...BELLS, "fs:486234"]);
def("ui.milestone", { cat: "ui", rate: 32000, maxDur: 3.6, level: ["M", -21] }, async () => null, BELLS);
def("ui.carve", { cat: "ui", rate: 32000, level: ["M", -24] }, async () => {
  const a = D.mono(await S("fs:718918"));
  hp(a, 300, 2); lp(a, 9000);
  const taps = onsets(a, { thresholdDb: -10, minGap: 0.08, pre: 0.003, post: 0.12, maxLen: 0.5 });
  const pick = best(taps.map((s) => D.slice(a, s.from, s.to)), 8);
  return [0, 3].map((o) => D.edges(air(seq([[pick[o], 0, 0], [pick[o + 1], 0.32, -2], [pick[o + 2], 0.58, -4]]), -14), 0.002, 0.3));
}, ["fs:718918"]);

// UI recipes are filled in here (they share the glint helpers).
const UI = {
  "ui.open": async () => {
    const w = D.mono(await S("fs:423799"));
    lp(w, 4000); hp(w, 200, 2);
    const out = [];
    for (const [a, b] of [["D5", "A5"], ["F5", "C6"]]) out.push(air(seq([[w, 0, -10], [await tube(a, 2.4), 0.05, -2], [await glint(b, 1.6), 0.12, -6]]), -12));
    return out;
  },
  "ui.close": async () => {
    const out = [];
    for (const [a, b] of [["A5", "D5"], ["C6", "F5"]]) out.push(seq([[await glint(a, 1.2), 0, -2], [await glint(b, 1.6), 0.14, 0]]));
    return out;
  },
  "ui.clue": async () => {
    const sw = await S("fs:826131");
    const segs = onsets(D.mono(sw), { thresholdDb: -8, minGap: 1, pre: 1.2, post: 0.05, minLen: 0.5, maxLen: 20, win: 0.05, smooth: 4 });
    const s = D.mono(D.slice(sw, Math.max(0, segs[0].peakAt - 1.2), segs[0].peakAt));
    hp(s, 900, 2);
    const out = [];
    for (const n of ["A6", "F6"]) out.push(air(seq([[s, 0, -6], [await glint(n, 1.5), 1.15, 0], [await chime(out.length + 8), 1.2, -10]]), -12));
    return out;
  },
  "ui.payoff": async () => {
    const out = [];
    for (const c of [["D5", "F5", "A5", "D6"], ["F5", "A5", "C6", "F6"]]) {
      const parts = [[await tube(c[0], 3), 0, -4]];
      for (let i = 1; i < 4; i++) parts.push([await glint(c[i], 2.2), 0.06 * i, -3]);
      parts.push([await chime(out.length + 11), 0.3, -9]);
      out.push(air(seq(parts), -10));
    }
    return out;
  },
  "ui.surprise": async () => {
    const w = D.mono(await S("fs:486234"));
    hp(w, 300, 2); lp(w, 6000);
    const out = [];
    for (const n of ["D6", "A6"]) out.push(seq([[w, 0, -6], [await glint(n, 1.2), 0.18, 0]]));
    return out;
  },
  "ui.milestone": async () => {
    const out = [];
    for (const c of [["D5", "A5", "F6"], ["F5", "C6", "A6"]]) {
      const parts = [[await tube(c[0], 3.5), 0, -2], [await glint(c[1], 2.5), 0.25, -4], [await glint(c[2], 2.5), 0.5, -4]];
      for (let i = 0; i < 4; i++) parts.push([await chime(i + 14 + out.length * 4), 0.6 + i * 0.25, -11]);
      out.push(air(seq(parts), -10));
    }
    return out;
  },
};
for (const r of recipes) if (UI[r.id]) r.make = UI[r.id];

// ===== His nonverbal voice (Kokoro renderings), one set per voice =====
const VOICES = fs.readdirSync(path.join(SRC, "voice")).filter((d) => fs.statSync(path.join(SRC, "voice", d)).isDirectory());
for (const voice of VOICES) {
  const keys = fs.readdirSync(path.join(SRC, "voice", voice)).map((f) => f.replace(".wav", ""));
  const kinds = [...new Set(keys.map((k) => k.split("_")[0]))];
  for (const kind of kinds) {
    def(`nv.${voice}.${kind}`, { cat: `voice/${voice}`, rate: 48000, level: ["M", kind === "effort" || kind === "roar" ? -19 : -21], voice }, async () =>
      keys.filter((k) => k.split("_")[0] === kind).sort().map((k) => {
        const a = V(voice, k);
        hp(a, 60, 2);
        return D.edges(D.trimSilence(a, -46, 0.012, 0.06), 0.006, 0.05);
      }), []);
  }
}

// --- Run ----------------------------------------------------------------------------------------
const manifestFile = path.join(SND, "manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { sounds: {} };
const report = [];
const selected = recipes.filter((r) => !only.length || only.some((p) => r.id.startsWith(p)));
for (const r of selected) {
  const t0 = Date.now();
  let variants = (await r.make()) || [];
  variants = (await Promise.all(variants)).filter(Boolean);
  if (!variants.length) throw new Error(`${r.id}: no variants`);
  const [mode, target] = r.meta.level;
  const files = [];
  const dir = path.join(SND, r.meta.cat);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < variants.length; i++) {
    let a = variants[i];
    if (a.sampleRate !== 48000) a = D.resample(a, 48000);
    // Memory budget: mono unless the width is part of the sound (the runtime reverb send gives
    // everything else its space), and long ring-outs trimmed with a fade.
    if (a.channels.length > 1 && !r.meta.stereo) a = D.mono(a);
    if (r.meta.maxDur && D.duration(a) > r.meta.maxDur) a = D.fadeOut(D.slice(a, 0, r.meta.maxDur), r.meta.maxDur * 0.3);
    D.dcBlock(a);
    // Assets keep 2 dB of true-peak headroom so the Opus encoding cannot push them over.
    D.normalizeLoudness(a, target, { mode: mode === "M" ? "momentary" : "integrated", ceilingDbtp: -3.5 });
    const base = `${r.id.split(".").slice(r.meta.voice ? 2 : 0).join("_").replace(/\./g, "_")}_${String(i + 1).padStart(2, "0")}`;
    const stage = path.join(STAGE, `${r.meta.cat.replace(/\//g, "_")}_${base}.wav`);
    writeWav(stage, a, 32);
    const rel = `${r.meta.cat}/${base}.ogg`;
    if (encode) await (await getTool()).encodeOpus(stage, path.join(SND, rel), a.channels.length > 1 ? 160000 : 112000);
    files.push({ file: rel, stage, channels: a.channels.length, dur: +D.duration(a).toFixed(3) });
  }
  // Verify what will actually play: decode the encoded files and measure them.
  const checked = [];
  for (const f of files) {
    let m = null;
    if (encode) {
      const back = path.join(STAGE, "verify.wav");
      await (await getTool()).decode(path.join(SND, f.file), back, 48000);
      const a = readWav(back);
      const Lx = loudness(a);
      m = { dur: +D.duration(a).toFixed(3), lufsI: +Lx.integrated.toFixed(1), lufsM: +Lx.maxMomentary.toFixed(1), tp: +db(truePeak(a.channels).truePeak).toFixed(2), bytes: fs.statSync(path.join(SND, f.file)).size };
    }
    checked.push({ file: f.file, dur: m?.dur ?? f.dur, channels: f.channels, lufsI: m?.lufsI, lufsM: m?.lufsM, tp: m?.tp, bytes: m?.bytes });
  }
  // stale files of an older build of this id
  const old = manifest.sounds[r.id]?.variants || [];
  for (const o of old) if (!checked.some((c) => c.file === o.file)) try { fs.unlinkSync(path.join(SND, o.file)); } catch {}
  manifest.sounds[r.id] = { cat: r.meta.cat, decodeRate: r.meta.rate, loop: Boolean(r.meta.loop), level: r.meta.level, sources: r.sources, variants: checked };
  report.push({ id: r.id, n: checked.length, maxTp: Math.max(...checked.map((c) => c.tp ?? -99)), ms: Date.now() - t0 });
  console.log(`${r.id.padEnd(26)} ${String(checked.length).padStart(2)} variants  tp<=${Math.max(...checked.map((c) => c.tp ?? -99)).toFixed(2)} dBTP  ${checked.map((c) => c.dur.toFixed(1)).join(" ")}`);
}
manifest.version = 1;
manifest.generated = new Date().toISOString();
manifest.sounds = Object.fromEntries(Object.entries(manifest.sounds).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(SND, "build-report.json"), JSON.stringify(report, null, 1));
if (tool) await tool.close();
console.log(`${selected.length} sounds built`);
