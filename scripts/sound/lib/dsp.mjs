// Offline DSP for building the sound library: resampling, filters, envelopes, fades, loops,
// layering, convolution reverb, synthesis helpers and loudness-based levelling.
import { loudness, truePeak, biquad, fft, db } from "./analysis.mjs";

export const RATE = 48000;

// --- Random (seeded, so builds are repeatable) ---------------------------------------------
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  next.range = (a, b) => a + next() * (b - a);
  next.gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// --- Buffers ------------------------------------------------------------------------------
export const frames = (a) => a.channels[0].length;
export const duration = (a) => frames(a) / a.sampleRate;
export const silence = (seconds, ch = 1, rate = RATE) => ({ sampleRate: rate, channels: Array.from({ length: ch }, () => new Float32Array(Math.round(seconds * rate))) });
export const clone = (a) => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => Float32Array.from(c)) });
export const mono = (a) => {
  if (a.channels.length === 1) return a;
  const out = new Float32Array(frames(a));
  for (const c of a.channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / a.channels.length;
  return { sampleRate: a.sampleRate, channels: [out] };
};
export const channel = (a, i) => ({ sampleRate: a.sampleRate, channels: [Float32Array.from(a.channels[Math.min(i, a.channels.length - 1)])] });
export const stereoOf = (l, r = l) => ({ sampleRate: l.sampleRate, channels: [Float32Array.from(l.channels[0]), Float32Array.from(r.channels[0])] });

export function slice(a, from, to) {
  const s = Math.max(0, Math.round(from * a.sampleRate));
  const e = Math.min(frames(a), to == null ? frames(a) : Math.round(to * a.sampleRate));
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => Float32Array.from(c.subarray(s, e))) };
}

export function gain(a, dB) {
  const g = 10 ** (dB / 20);
  for (const c of a.channels) for (let i = 0; i < c.length; i++) c[i] *= g;
  return a;
}

export function concat(...parts) {
  const ch = Math.max(...parts.map((p) => p.channels.length));
  const len = parts.reduce((s, p) => s + frames(p), 0);
  const out = { sampleRate: parts[0].sampleRate, channels: Array.from({ length: ch }, () => new Float32Array(len)) };
  let o = 0;
  for (const p of parts) {
    for (let c = 0; c < ch; c++) out.channels[c].set(p.channels[Math.min(c, p.channels.length - 1)], o);
    o += frames(p);
  }
  return out;
}

// Mix `b` into `a` at time `at` seconds with gain dB (a grows if needed). Mono sources spread to all channels.
export function mixInto(a, b, at = 0, dB = 0, pan = 0) {
  const off = Math.round(at * a.sampleRate);
  const need = off + frames(b);
  if (need > frames(a)) a.channels = a.channels.map((c) => {
    const n = new Float32Array(need);
    n.set(c);
    return n;
  });
  const g = 10 ** (dB / 20);
  const ch = a.channels.length;
  for (let c = 0; c < ch; c++) {
    const src = b.channels[Math.min(c, b.channels.length - 1)];
    // equal-power pan for mono sources into stereo
    let pg = 1;
    if (ch === 2 && b.channels.length === 1) {
      const p = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
      pg = (c === 0 ? Math.cos(p) : Math.sin(p)) * Math.SQRT2;
    }
    const dst = a.channels[c];
    for (let i = 0; i < src.length; i++) dst[off + i] += src[i] * g * pg;
  }
  return a;
}

export function toChannels(a, n) {
  if (a.channels.length === n) return a;
  if (n === 1) return mono(a);
  return { sampleRate: a.sampleRate, channels: Array.from({ length: n }, (_, i) => Float32Array.from(a.channels[Math.min(i, a.channels.length - 1)])) };
}

// --- Fades and envelopes --------------------------------------------------------------------
const curve = (x, shape) => (shape === "lin" ? x : shape === "exp" ? x * x : Math.sin((x * Math.PI) / 2)); // sine = equal power
export function fadeIn(a, seconds, shape = "sine") {
  const n = Math.min(frames(a), Math.round(seconds * a.sampleRate));
  for (const c of a.channels) for (let i = 0; i < n; i++) c[i] *= curve(i / n, shape);
  return a;
}
export function fadeOut(a, seconds, shape = "sine") {
  const len = frames(a);
  const n = Math.min(len, Math.round(seconds * a.sampleRate));
  for (const c of a.channels) for (let i = 0; i < n; i++) c[len - 1 - i] *= curve(i / n, shape);
  return a;
}
export const edges = (a, inS = 0.004, outS = 0.01) => fadeOut(fadeIn(a, inS), outS);

// Multiply by a breakpoint envelope [[t, gainLinear], ...] (linear interpolation).
export function envelope(a, points) {
  const r = a.sampleRate;
  const len = frames(a);
  let k = 0;
  for (let i = 0; i < len; i++) {
    const t = i / r;
    while (k < points.length - 2 && t > points[k + 1][0]) k++;
    const [t0, g0] = points[k];
    const [t1, g1] = points[Math.min(k + 1, points.length - 1)];
    const g = t <= t0 ? g0 : t >= t1 ? g1 : g0 + ((g1 - g0) * (t - t0)) / (t1 - t0);
    for (const c of a.channels) c[i] *= g;
  }
  return a;
}

// Trim leading/trailing material below `thresholdDb` (peak-relative), keeping pre/post roll.
export function trimSilence(a, thresholdDb = -50, pre = 0.01, post = 0.05) {
  const m = mono(a).channels[0];
  let peak = 0;
  for (const v of m) peak = Math.max(peak, Math.abs(v));
  const th = peak * 10 ** (thresholdDb / 20);
  const win = Math.round(a.sampleRate * 0.005);
  const level = (i) => {
    let s = 0;
    for (let j = i; j < Math.min(m.length, i + win); j++) s = Math.max(s, Math.abs(m[j]));
    return s;
  };
  let s = 0;
  while (s < m.length && level(s) < th) s += win;
  let e = m.length - 1;
  while (e > s && level(Math.max(0, e - win)) < th) e -= win;
  return slice(a, Math.max(0, s / a.sampleRate - pre), Math.min(duration(a), e / a.sampleRate + post));
}

// --- Filters (RBJ cookbook) ----------------------------------------------------------------
export function coefs(type, f, fs, { q = 0.7071, gainDb = 0 } = {}) {
  const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const A = 10 ** (gainDb / 40);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case "lowpass": b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "highpass": b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "bandpass": b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "peak": b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break;
    }
    default: throw new Error(type);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

// filter(a, "highpass", 80, {q}) ; order 2 per call, `stages` for steeper slopes.
export function filter(a, type, f, opts = {}) {
  const k = coefs(type, f, a.sampleRate, opts);
  for (let s = 0; s < (opts.stages || 1); s++) a.channels = a.channels.map((c) => biquad(c, k));
  return a;
}
export const eq = (a, list) => {
  for (const [type, f, opts] of list) filter(a, type, f, opts || {});
  return a;
};

// Time-varying one-pole lowpass with cutoff from a function of time (sweeps).
export function sweepLowpass(a, cutoffAt) {
  const r = a.sampleRate;
  a.channels = a.channels.map((c) => {
    const out = new Float32Array(c.length);
    let y = 0;
    for (let i = 0; i < c.length; i++) {
      if (i % 32 === 0) var k = 1 - Math.exp((-2 * Math.PI * cutoffAt(i / r)) / r);
      y += k * (c[i] - y);
      out[i] = y;
    }
    return out;
  });
  return a;
}

// --- Resampling (windowed sinc, Kaiser) --------------------------------------------------
function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
  }
  return s;
}
// Resample from a.sampleRate to `to`. `ratio` lets you declare a different source rate
// (pitch: declaring 22320 Hz for 24 kHz audio plays it 0.93x deeper).
export function resample(a, to = RATE, { from = a.sampleRate, taps = 24, beta = 8.6 } = {}) {
  const step = from / to;
  const cutoff = Math.min(1, to / from) * 0.97;
  const len = Math.floor(frames(a) / step);
  const i0b = besselI0(beta);
  // Kernel table over distance d in [-taps, taps], 1024 points per sample.
  const RES = 1024;
  const half = taps * RES;
  const table = new Float32Array(2 * half + 2);
  for (let j = 0; j <= 2 * half + 1; j++) {
    const d = (j - half) / RES;
    const u = d / taps;
    if (Math.abs(u) >= 1) continue;
    const arg = Math.PI * d * cutoff;
    table[j] = (arg === 0 ? 1 : Math.sin(arg) / arg) * (besselI0(beta * Math.sqrt(1 - u * u)) / i0b);
  }
  const channels = a.channels.map((x) => {
    const out = new Float32Array(len);
    for (let n = 0; n < len; n++) {
      const t = n * step;
      const c = Math.floor(t);
      let s = 0;
      let wsum = 0;
      const k0 = Math.max(0, c - taps + 1), k1 = Math.min(x.length - 1, c + taps);
      for (let k = k0; k <= k1; k++) {
        const pos = (t - k) * RES + half;
        const j = pos | 0;
        const h = table[j] + (table[j + 1] - table[j]) * (pos - j);
        s += x[k] * h;
        wsum += h;
      }
      out[n] = wsum ? s / wsum : 0;
    }
    return out;
  });
  return { sampleRate: to, channels };
}
// Pitch by factor (0.9 = lower) keeping the output rate (changes duration, like tape).
export const pitch = (a, factor) => resample(a, a.sampleRate, { from: a.sampleRate * factor });

// --- Dynamics / level -----------------------------------------------------------------------
export function peakDb(a) {
  let p = 0;
  for (const c of a.channels) for (const v of c) p = Math.max(p, Math.abs(v));
  return db(p);
}
export function normalizePeak(a, targetDb = -1) {
  return gain(a, targetDb - peakDb(a));
}
// Level by loudness: integrated (gated) for long material, or the loudest 400 ms for one-shots.
export function normalizeLoudness(a, targetLufs, { mode = "integrated", ceilingDbtp = -1 } = {}) {
  // Sounds shorter than one 400 ms block are measured as a 400 ms meter would show them.
  const min = Math.round(0.42 * a.sampleRate);
  const probe = frames(a) >= min ? a : { sampleRate: a.sampleRate, channels: a.channels.map((c) => { const p = new Float32Array(min); p.set(c); return p; }) };
  const L = loudness(probe);
  const cur = mode === "momentary" ? L.maxMomentary : mode === "shortterm" ? L.maxShortTerm : L.integrated;
  if (!Number.isFinite(cur)) return a;
  gain(a, targetLufs - cur);
  const tp = db(truePeak(a.channels).truePeak);
  if (tp > ceilingDbtp) softLimit(a, ceilingDbtp);
  return a;
}
// Look-ahead peak limiter (offline): smooth gain reduction so peaks stay under ceiling.
export function softLimit(a, ceilingDb = -1, { release = 0.08, lookahead = 0.004 } = {}) {
  const ceil = 10 ** (ceilingDb / 20) * 0.98; // margin for inter-sample peaks
  const r = a.sampleRate;
  const n = frames(a);
  const la = Math.round(lookahead * r);
  const peak = new Float32Array(n);
  for (const c of a.channels) for (let i = 0; i < n; i++) peak[i] = Math.max(peak[i], Math.abs(c[i]));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) need[i] = peak[i] > ceil ? ceil / peak[i] : 1;
  // minimum over look-ahead window, then smooth release
  const g = new Float32Array(n);
  let cur = 1;
  const rel = Math.exp(-1 / (release * r));
  for (let i = n - 1; i >= 0; i--) {
    // backward pass: attack ramps over look-ahead
    cur = Math.min(need[i], cur + (1 - cur) * (1 / la));
    g[i] = cur;
  }
  cur = 1;
  for (let i = 0; i < n; i++) {
    cur = g[i] < cur ? g[i] : 1 - (1 - cur) * rel;
    if (cur > g[i]) cur = g[i];
    for (const c of a.channels) c[i] *= cur;
  }
  return a;
}
export function saturate(a, drive = 1.5) {
  const t = Math.tanh(drive);
  for (const c of a.channels) for (let i = 0; i < c.length; i++) c[i] = Math.tanh(c[i] * drive) / t;
  return a;
}
export function dcBlock(a) {
  return filter(a, "highpass", 12, { q: 0.6 });
}

// --- Loops -----------------------------------------------------------------------------------
// Turns material into a seamless loop of `length` s by overlapping its tail onto its head with
// an equal-power crossfade of `xfade` s (the classic tape-loop splice).
export function makeLoop(a, xfade = 2) {
  const r = a.sampleRate;
  const n = frames(a);
  const x = Math.min(Math.round(xfade * r), Math.floor(n / 3));
  const len = n - x;
  const channels = a.channels.map((c) => {
    const out = Float32Array.from(c.subarray(0, len));
    for (let i = 0; i < x; i++) {
      const t = i / x;
      const fin = Math.sin((t * Math.PI) / 2);
      const fout = Math.cos((t * Math.PI) / 2);
      out[i] = c[i] * fin + c[len + i] * fout;
    }
    return out;
  });
  return { sampleRate: r, channels };
}

// --- Convolution (FFT overlap-add) -------------------------------------------------------
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
export function convolve(x, h) {
  const n = x.length + h.length - 1;
  const block = 8192;
  const size = nextPow2(block + h.length - 1);
  const hr = new Float64Array(size), hi = new Float64Array(size);
  hr.set(h);
  fft(hr, hi);
  const out = new Float32Array(n);
  const xr = new Float64Array(size), xi = new Float64Array(size);
  for (let s = 0; s < x.length; s += block) {
    xr.fill(0);
    xi.fill(0);
    for (let i = 0; i < block && s + i < x.length; i++) xr[i] = x[s + i];
    fft(xr, xi);
    for (let k = 0; k < size; k++) {
      const r = xr[k] * hr[k] - xi[k] * hi[k];
      const im = xr[k] * hi[k] + xi[k] * hr[k];
      xr[k] = r;
      xi[k] = -im; // conjugate for inverse via forward fft
    }
    fft(xr, xi);
    for (let i = 0; i < size && s + i < n; i++) out[s + i] += xr[i] / size;
  }
  return out;
}

// A synthetic outdoor / hall impulse: sparse early reflections + exponentially decaying
// diffuse noise, darker over time. Stereo (decorrelated).
export function impulse({ seconds = 1.2, decay = 3, early = 6, damp = 6000, rate = RATE, seed = 7, predelay = 0.01 } = {}) {
  const R = rng(seed);
  const n = Math.round(seconds * rate);
  const channels = [0, 1].map(() => {
    const h = new Float32Array(n);
    const pd = Math.round(predelay * rate);
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / (n - pd);
      h[i] = R.gauss() * Math.exp(-decay * t * 3) * 0.25;
    }
    for (let e = 0; e < early; e++) {
      const at = pd + Math.round(R.range(0.004, 0.06) * rate);
      if (at < n) h[at] += (R() < 0.5 ? -1 : 1) * R.range(0.3, 0.7);
    }
    return h;
  });
  const ir = { sampleRate: rate, channels };
  // darken the tail: progressively lowpassed
  sweepLowpass(ir, (t) => damp * Math.exp(-t * 2.2) + 400);
  return ir;
}

export function reverb(a, ir, wetDb = -12, dryDb = 0) {
  const ch = Math.max(2, a.channels.length);
  const src = toChannels(a, ch);
  const out = { sampleRate: a.sampleRate, channels: [] };
  for (let c = 0; c < ch; c++) {
    const wet = convolve(src.channels[c], ir.channels[c % ir.channels.length]);
    const o = new Float32Array(wet.length);
    const gw = 10 ** (wetDb / 20), gd = 10 ** (dryDb / 20);
    for (let i = 0; i < o.length; i++) o[i] = wet[i] * gw + (i < src.channels[c].length ? src.channels[c][i] * gd : 0);
    out.channels.push(o);
  }
  return out;
}

// --- Synthesis helpers ---------------------------------------------------------------------
export function noise(seconds, { color = "white", seed = 3, rate = RATE } = {}) {
  const R = rng(seed);
  const n = Math.round(seconds * rate);
  const c = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = R() * 2 - 1;
    if (color === "pink") {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      c[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else if (color === "brown") {
      br = (br + 0.02 * w) / 1.02;
      c[i] = br * 3.5;
    } else c[i] = w * 0.5;
  }
  return { sampleRate: rate, channels: [c] };
}

// Additive tone: partials [[ratio, amp, decaySeconds]], base frequency f (Hz) or f(t) function.
export function partials(seconds, f, list, { rate = RATE, seed = 5, detune = 0, attack = 0.002 } = {}) {
  const R = rng(seed);
  const n = Math.round(seconds * rate);
  const c = new Float32Array(n);
  for (const [ratio, amp, dec] of list) {
    let ph = R() * Math.PI * 2;
    const det = 1 + (R() - 0.5) * detune;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const fr = (typeof f === "function" ? f(t) : f) * ratio * det;
      ph += (2 * Math.PI * fr) / rate;
      const env = Math.min(1, t / attack) * Math.exp(-t / dec);
      c[i] += Math.sin(ph) * amp * env;
    }
  }
  return { sampleRate: rate, channels: [c] };
}

export function measure(a) {
  const L = loudness(a);
  return { lufs: +L.integrated.toFixed(1), maxM: +L.maxMomentary.toFixed(1), tp: +db(truePeak(a.channels).truePeak).toFixed(2), dur: +duration(a).toFixed(3) };
}
