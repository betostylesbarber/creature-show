// Test lines for the sound lab's speech check, encoded exactly as src/voice-worker.js does
// (16-bit mono WAV, peaks at -1.5 dBFS, 5 ms edge fades, pitch by a lower declared rate), so the
// lab plays them through the real dialogue chain just like live speech.
//   node scripts/sound/render-test-speech.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KokoroTTS } from "kokoro-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "assets/sounds/test");
fs.mkdirSync(OUT, { recursive: true });

function encodeWav(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0 ? Math.min(1.6, 0.84 / peak) : 1;
  const fade = Math.min(samples.length / 2, Math.round(sampleRate * 0.005));
  for (let i = 0; i < samples.length; i++) {
    const edge = Math.min(1, i / fade, (samples.length - 1 - i) / fade);
    const s = Math.max(-1, Math.min(1, samples[i] * gain * edge));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });
const lines = [
  ["speech_creature.wav", "Ah, my friend, the storm is wild tonight, but the candles still burn. Tell me, what brings you to my little graveyard?", "am_onyx", 1.04, 0.93],
  ["speech_reader.wav", "Mina says: is the lightning real, or are you just showing off?", "am_michael", 1.08, 1],
];
for (const [file, text, voice, speed, pitch] of lines) {
  const a = await tts.generate(text, { voice, speed });
  fs.writeFileSync(path.join(OUT, file), encodeWav(a.audio, Math.round(a.sampling_rate * pitch)));
  console.log(file, (a.audio.length / a.sampling_rate / pitch).toFixed(2), "s");
}
