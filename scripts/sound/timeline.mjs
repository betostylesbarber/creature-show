// Loudness over time of a capture's stems (1 s steps, momentary 400 ms max per second), plus the
// strongest transient outliers: node scripts/sound/timeline.mjs <captureName> [stem=bed]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWav } from "./lib/wav.mjs";
import { loudness, clicks } from "./lib/analysis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [name, ...stems] = process.argv.slice(2);
for (const stem of stems.length ? stems : ["bed", "dialogue"]) {
  const a = readWav(path.join(ROOT, "captures", `${name}_${stem}.wav`));
  const m = loudness(a).momentary;
  const per = [];
  for (let s = 0; s * 10 < m.length; s++) per.push(Math.max(...m.slice(s * 10, s * 10 + 10)));
  console.log(`${stem.padEnd(9)} ${per.map((v) => (Number.isFinite(v) ? Math.round(v) : "-")).join(" ")}`);
  if (stem === "master" || stems.includes("clicks")) {
    const c = clicks(a, { maxReport: 12 });
    console.log(`clicks: ${c.events.map((e) => `${e.t}s(+${e.db}dB @${e.level})`).join(" ")}`);
  }
}
