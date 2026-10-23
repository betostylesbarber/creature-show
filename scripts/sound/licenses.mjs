// Writes assets/sounds/LICENSES.md from sources.json (where every source came from, its author
// and licence) and manifest.json (which runtime sounds use it).   node scripts/sound/licenses.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SND = path.join(ROOT, "assets/sounds");
const sources = JSON.parse(fs.readFileSync(path.join(SND, "sources.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(SND, "manifest.json"), "utf8"));
const usedBy = {};
for (const [id, s] of Object.entries(manifest.sounds)) for (const k of s.sources || []) (usedBy[k] ??= []).push(id);

// What the build does to each family of sounds (scripts/sound/build.mjs has the exact recipe).
const CHANGES = {
  "amb.": "cut a section, high/low-pass filtered, levelled (-23 LUFS loops / -20 LUFS one-shots), loops spliced with an equal-power crossfade; one-shots cut at their events, trimmed, faded",
  "rain.": "one channel cut, high-passed (rumble and traffic removed), low-passed, gentle top-end shelf, crossfade-looped, levelled to -23 LUFS",
  "thunder.": "individual rolls found by envelope, trimmed with long fades, filtered (35 Hz high-pass), levelled",
  "step.": "individual footsteps cut by onset detection, pitched 6% lower for his weight, filtered, faded, levelled",
  "cloth.": "trimmed, filtered, levelled", "leather": "trimmed, filtered, levelled", "hardware": "trimmed, filtered, levelled",
  "body.": "pitched down, layered with a dirt footstep, filtered", "breath.": "breath cycles split into inhale / exhale, pitched 10% lower, filtered",
  "elec.": "events cut and filtered (harsh top end reduced); knife switch layered from a latch, a contactor and a spark",
  "lab.": "layered: recorded arc buzz with a synthesized charging whine; discharge = zap + thunder crack + low impact + crackle",
  "ack.": "a crystal bell recording pitched to D-minor pentatonic notes, layered with wind-chime strikes",
  "bolt.": "spark recordings cut and layered; the short buzz is synthesized", "fire.": "flame burst pitched and trimmed",
  "pumpkin.": "flame bursts layered; whispers cut, band-limited, pitched 8% lower, small reverb; glints as in ack",
  "gate.": "bell, creaks, rattles and wind cut, pitched and filtered, small reverb; spectral swell = cymbal swell + reversed whispers",
  "gal.": "chime texture looped; twinkles and the bloom built from the pitched crystal bell, a tubular bell and singing glass",
  "grand.": "bell and chimes trimmed and reverberated; choir = singing bowl slowed + reversed whispers",
  "lion.": "growls and roars cut, harshness and sub-bass reduced, softly limited and saturated, layered with a low impact, reverb",
  "fw.": "distant booms layered with crackle tails", "ui.": "glints and bells as in ack, a soft whoosh; carving = chisel taps",
};
const change = (id) => Object.entries(CHANGES).find(([p]) => id.startsWith(p))?.[1] || "trimmed, filtered, levelled";

const lines = [];
lines.push("# Sound library: sources and licences", "");
lines.push("Every recording used by the show's sound design, where it came from and under which licence. All sources are **CC0 1.0 (public domain dedication)**: free for commercial use, livestreams and recorded clips, no attribution required (credit is given here anyway). Nothing here is ripped film or game audio; nothing was bought.", "");
lines.push("- **Freesound** (freesound.org): CC0-only searches; each sound page's licence link was checked before downloading. Freesound's original uploads need a login, so the files are its high-quality OGG previews (lossy, about 192 kbps Vorbis), kept unmodified in `_src/freesound/`. Every candidate was measured and inspected as a spectrogram first (clipping, noise floor, traffic, voices and birds in the background); rejected candidates are listed in SOUND.md.");
lines.push("- **Kenney** (kenney.nl) packs *RPG Audio* and *Impact Sounds*: CC0, original OGG files, kept unmodified in `_src/kenney_*/` with the pack's License.txt.");
lines.push("- **Created for this show**: his nonverbal sounds rendered with his own TTS voice (Kokoro-82M, Apache-2.0 model, the voices the show already uses) by `scripts/sound/render-voice.mjs` (`_src/voice/`); the charging whines and the short bolt buzz are synthesized in `scripts/sound/build.mjs`; reverbs are generated impulses.", "");
lines.push("Runtime files (`<category>/*.ogg`, Ogg Opus) are rebuilt from these sources by `node scripts/sound/build.mjs`; `manifest.json` lists each sound's variants with their measured loudness and true peak.", "");
lines.push("| Source | Title | Author | Licence | Original file | Used in | What the build changes |", "|---|---|---|---|---|---|---|");
for (const s of sources) {
  const ids = usedBy[s.key] || [];
  if (!ids.length) continue;
  lines.push(`| [${s.key}](${s.url}) | ${s.title.replace(/\|/g, "/")} | ${s.author} | [CC0 1.0](${s.licenceUrl}) | \`_src/${s.file}\` (${s.obtained.split(";")[0]}) | ${ids.join(", ")} | ${change(ids[0])} |`);
}
const unused = sources.filter((s) => !(usedBy[s.key] || []).length).map((s) => s.key);
if (unused.length) lines.push("", `Imported but not used by the current build: ${unused.join(", ")}.`);
lines.push("", "## Created sounds", "", "| Sounds | Made from | Licence |", "|---|---|---|");
lines.push("| nv.<voice>.curious / thoughtful / chuckle / surprised / relieved / effort / delight / roar | Kokoro-82M renderings of short interjections (\"Hmm?\", \"Heh heh.\", \"Oh!\", \"Haah.\", \"Hup!\", \"Raaaah!\" ...) in the voices am_onyx, am_puck, am_michael and bm_lewis; trimmed, faded, levelled | Created for the show (model: Apache-2.0) |");
lines.push("| lab.charge, lab.tail, bolt.buzz (the whine) | synthesized in build.mjs | Created for the show |");
lines.push("| test/speech_*.wav (sound lab only) | Kokoro renderings of two test lines | Created for the show |");
fs.writeFileSync(path.join(SND, "LICENSES.md"), lines.join("\n") + "\n");
console.log(`LICENSES.md: ${sources.length - unused.length} sources used, ${unused.length} unused`);
