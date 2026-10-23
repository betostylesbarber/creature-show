// Kokoro runs here, on its own thread. Phonemizing and synthesis are CPU-heavy and partly
// synchronous: on the server's main thread they froze everything else (the AI's reply stream,
// chat, gifts, the stream window's messages) for up to a second per line.
import { parentPort } from "node:worker_threads";
import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// 16-bit mono PCM WAV. Declaring a lower sample rate than the audio was made at
// plays it slower and deeper, which is how the creature gets his low voice.
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
  // Peaks sit at -1.5 dBFS so the stream window's chain has headroom (no clipping), and 5 ms
  // fades at each end stop clicks between lines.
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

let tts = null;

async function load() {
  let lastLogged = -1;
  try {
    // fp32 measured ~2.7x faster than q8 on a Ryzen 5 CPU, and it is the highest quality.
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "fp32",
      device: "cpu",
      progress_callback: (p) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx")) {
          const pct = Math.floor(p.progress / 10) * 10;
          if (pct !== lastLogged) parentPort.postMessage({ type: "progress", pct: (lastLogged = pct) });
        }
      },
    });
    parentPort.postMessage({ type: "ready" });
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error?.message || String(error) });
  }
}

// One line at a time, in the order they were asked for.
let queue = Promise.resolve();
parentPort.on("message", (msg) => {
  if (msg.type === "load") return load();
  if (msg.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
      const rate = Math.round(audio.sampling_rate * msg.pitch);
      parentPort.postMessage({ type: "done", id: msg.id, wav: encodeWav(audio.audio, rate).toString("base64"), duration: audio.audio.length / rate });
    } catch (error) {
      parentPort.postMessage({ type: "failed", id: msg.id, message: error?.message || String(error) });
    }
  });
});
