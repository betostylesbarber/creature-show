// Spectrogram and waveform pictures (PNG) for inspecting recordings: contamination (voices,
// traffic hum, birds), clicks, clipping and loop seams show up clearly.
import zlib from "node:zlib";
import fs from "node:fs";
import { fft, mix } from "./analysis.mjs";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function heat(v) {
  // 0..1 -> dark blue, purple, orange, yellow, white
  const stops = [[0, 0, 0], [30, 10, 80], [130, 30, 120], [220, 80, 40], [250, 190, 40], [255, 255, 230]];
  const x = Math.max(0, Math.min(0.9999, v)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
}

// Spectrogram (log frequency 40 Hz..20 kHz) above a waveform envelope strip.
export function spectrogramPng(file, audio, { width = 1000, height = 220, from = 0, to = null, floorDb = -110, ceilDb = -20 } = {}) {
  const fs_ = audio.sampleRate;
  const x = mix(audio.channels);
  const a = Math.floor(from * fs_);
  const b = Math.min(x.length, to ? Math.floor(to * fs_) : x.length);
  const size = 2048;
  const wave = 60;
  const H = height + wave;
  const rgb = Buffer.alloc(width * H * 3);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float64Array(size), im = new Float64Array(size);
  const fmin = 40, fmax = Math.min(20000, fs_ / 2);
  for (let col = 0; col < width; col++) {
    const center = a + Math.floor(((col + 0.5) / width) * (b - a));
    for (let i = 0; i < size; i++) {
      const s = center - size / 2 + i;
      re[i] = s >= 0 && s < x.length ? x[s] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let row = 0; row < height; row++) {
      const f0 = fmin * (fmax / fmin) ** (1 - (row + 1) / height);
      const f1 = fmin * (fmax / fmin) ** (1 - row / height);
      let k0 = Math.floor((f0 / fs_) * size), k1 = Math.max(k0 + 1, Math.ceil((f1 / fs_) * size));
      let p = 0;
      for (let k = k0; k < k1 && k < size / 2; k++) p = Math.max(p, re[k] * re[k] + im[k] * im[k]);
      const d = 10 * Math.log10(p / (size * size * 0.25) + 1e-20);
      const [r, g, bl] = heat((d - floorDb) / (ceilDb - floorDb));
      const o = (row * width + col) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = bl;
    }
    // waveform peak strip (dB scaled)
    const s0 = a + Math.floor((col / width) * (b - a)), s1 = a + Math.floor(((col + 1) / width) * (b - a));
    let pk = 0;
    for (let s = s0; s < s1; s++) pk = Math.max(pk, Math.abs(x[s]));
    const level = Math.max(0, (20 * Math.log10(pk + 1e-9) + 60) / 60);
    for (let r = 0; r < wave; r++) {
      const y = height + r;
      const on = wave - r <= level * wave;
      const o = (y * width + col) * 3;
      const clip = pk >= 0.999;
      rgb[o] = on ? (clip ? 255 : 120) : 15;
      rgb[o + 1] = on ? (clip ? 40 : 200) : 15;
      rgb[o + 2] = on ? (clip ? 40 : 120) : 15;
    }
  }
  fs.writeFileSync(file, encodePng(width, H, rgb));
}
