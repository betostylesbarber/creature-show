// Minimal WAV reader/writer for the sound tools: PCM 16/24/32-bit and 32-bit float, any channel
// count. Audio is handled as { sampleRate, channels: Float32Array[] }.
import fs from "node:fs";

export function readWav(file) {
  const buf = fs.readFileSync(file);
  return parseWav(buf);
}

export function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (body + size > buf.length) size = buf.length - body;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === "data") data = { start: body, size };
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV without fmt or data");
  const { channels: n, bits, format } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.size / (bytes * n));
  const channels = Array.from({ length: n }, () => new Float32Array(frames));
  let p = data.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      let v;
      if (format === 3 && bits === 32) v = buf.readFloatLE(p);
      else if (format === 3 && bits === 64) v = buf.readDoubleLE(p);
      else if (bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (bits === 24) v = buf.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (buf[p] - 128) / 128;
      else throw new Error(`unsupported ${bits}-bit WAV`);
      channels[c][i] = v;
      p += bytes;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}

// bits: 16 (TPDF dithered), 24, or 32 (float).
export function encodeWav({ sampleRate, channels }, bits = 16) {
  const n = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const float = bits === 32;
  const buf = Buffer.alloc(44 + frames * n * bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * n * bytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20);
  buf.writeUInt16LE(n, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * n * bytes, 28);
  buf.writeUInt16LE(n * bytes, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * n * bytes, 40);
  let p = 44;
  let seed = 22222;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const v = channels[c][i];
      if (float) buf.writeFloatLE(v, p);
      else if (bits === 16) {
        const d = (rnd() - rnd()) / 32768; // TPDF dither, 1 LSB
        const s = Math.max(-32768, Math.min(32767, Math.round((v + d) * 32768)));
        buf.writeInt16LE(s, p);
      } else {
        const s = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608)));
        buf.writeIntLE(s, p, 3);
      }
      p += bytes;
    }
  }
  return buf;
}

export function writeWav(file, audio, bits = 16) {
  fs.writeFileSync(file, encodeWav(audio, bits));
}
