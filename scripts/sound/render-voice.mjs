// Renders the creature's nonverbal sounds (hums, chuckles, grunts, gasps, effort sounds) with
// his own TTS voice, Kokoro, so they carry the same identity as his speech. One set per Kokoro
// voice used by the voice presets in src/settings.js; each set is rendered at the voice's
// natural pitch and the stream window plays it at the configured `voice.pitch` (playbackRate),
// which is exactly how the stream pitches his speech (a lower declared sample rate).
//   node scripts/sound/render-voice.mjs <outDir> <listFile.json> [voiceId ...]
// The list is [{ key, text, speed? }]. Kokoro phonemizes spelled-out letters for some
// interjections ("Hm" becomes "aitch em"), so every text in the list was checked against
// its phonemes first (see SOUND.md). Writes 48 kHz float WAVs to <outDir>/<voiceId>/.
import fs from "node:fs";
import path from "node:path";
import { KokoroTTS } from "kokoro-js";
import { resample } from "./lib/dsp.mjs";
import { writeWav } from "./lib/wav.mjs";

// Kokoro voice -> the speaking speed of its preset (src/settings.js VOICE_PRESETS).
const VOICES = { am_onyx: 1.04, am_puck: 1.06, am_michael: 1.04, bm_lewis: 1.03 };
const [outDir, listFile, ...ids] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });
for (const id of ids.length ? ids : Object.keys(VOICES)) {
  const dir = path.join(outDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of list) {
    const file = path.join(dir, `${item.key}.wav`);
    if (fs.existsSync(file)) continue;
    const audio = await tts.generate(item.text, { voice: id, speed: (item.speed ?? 1) * (VOICES[id] ?? 1.04) });
    const out = resample({ sampleRate: audio.sampling_rate, channels: [Float32Array.from(audio.audio)] }, 48000);
    writeWav(file, out, 32);
    console.log(id, item.key, JSON.stringify(item.text), (out.channels[0].length / 48000).toFixed(2) + "s");
  }
}
