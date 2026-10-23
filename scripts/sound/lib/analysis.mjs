// Objective measurements for the sound tools and capture reports:
//  - ITU-R BS.1770-4 loudness (K-weighting at any sample rate, gated integrated loudness,
//    momentary 400 ms and short-term 3 s maxima, EBU R128 loudness range)
//  - true peak with 4x oversampling (polyphase windowed-sinc interpolator)
//  - sample peak, clipping runs, DC offset
//  - transient outliers ("clicks"): 1 ms high-band energy far above its local median
//  - spectral balance in bands (sub-bass ... air), centroid
//  - stereo correlation and mono-downmix loudness change
//  - seam continuity for loops

const LOG10 = Math.log10;
export const db = (x) => (x > 0 ? 20 * LOG10(x) : -Infinity);
export const pdb = (x) => (x > 0 ? 10 * LOG10(x) : -Infinity);

// --- Filters --------------------------------------------------------------------------
export function biquad(x, [b0, b1, b2, a1, a2], out = new Float32Array(x.length)) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

export function kWeightingCoefs(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

function kWeighted(channels, fs) {
  const [shelf, hp] = kWeightingCoefs(fs);
  return channels.map((ch) => biquad(biquad(ch, shelf), hp));
}

// Mean-square power per block (summed over channels, weights 1) for window/hop in samples.
function blockPowers(kw, win, hop) {
  const n = kw[0].length;
  const out = [];
  // cumulative sums of squares per channel
  const cum = kw.map((ch) => {
    const c = new Float64Array(ch.length + 1);
    for (let i = 0; i < ch.length; i++) c[i + 1] = c[i] + ch[i] * ch[i];
    return c;
  });
  for (let s = 0; s + win <= n; s += hop) {
    let z = 0;
    for (const c of cum) z += (c[s + win] - c[s]) / win;
    out.push(z);
  }
  return out;
}

const lufs = (z) => -0.691 + pdb(z);

export function loudness({ sampleRate: fs, channels }) {
  const kw = kWeighted(channels, fs);
  const m = blockPowers(kw, Math.round(0.4 * fs), Math.round(0.1 * fs));
  const st = blockPowers(kw, Math.round(3 * fs), Math.round(0.1 * fs));
  // Integrated (gated)
  const abs = m.filter((z) => lufs(z) > -70);
  let integrated = -Infinity;
  if (abs.length) {
    const ungated = abs.reduce((a, b) => a + b, 0) / abs.length;
    const rel = lufs(ungated) - 10;
    const g = abs.filter((z) => lufs(z) > rel);
    integrated = g.length ? lufs(g.reduce((a, b) => a + b, 0) / g.length) : -Infinity;
  }
  // Loudness range (EBU Tech 3342)
  let lra = 0;
  const sAbs = st.map(lufs).filter((l) => l > -70);
  if (sAbs.length > 2) {
    const meanPow = sAbs.reduce((a, l) => a + 10 ** ((l + 0.691) / 10), 0) / sAbs.length;
    const relGate = lufs(meanPow) - 20;
    const g = sAbs.filter((l) => l > relGate).sort((a, b) => a - b);
    if (g.length > 1) lra = g[Math.floor(0.95 * (g.length - 1))] - g[Math.floor(0.1 * (g.length - 1))];
  }
  const momentary = m.map(lufs);
  const shortTerm = st.map(lufs);
  return {
    integrated,
    maxMomentary: momentary.length ? Math.max(...momentary) : -Infinity,
    maxShortTerm: shortTerm.length ? Math.max(...shortTerm) : (momentary.length ? Math.max(...momentary) : -Infinity),
    lra,
    momentary, // every 100 ms
    shortTerm, // every 100 ms
  };
}

// Loudness of a time range (seconds), ungated except the absolute gate; used for stems.
export function rangeLoudness(audio, from, to) {
  const fs = audio.sampleRate;
  const a = Math.max(0, Math.floor(from * fs));
  const b = Math.min(audio.channels[0].length, Math.floor(to * fs));
  if (b - a < fs * 0.4) return -Infinity;
  return loudness({ sampleRate: fs, channels: audio.channels.map((c) => c.subarray(a, b)) }).integrated;
}

// --- True peak (4x oversampling) -----------------------------------------------------
const TP_TAPS = 16; // per phase
let tpKernel = null;
function truePeakKernel() {
  if (tpKernel) return tpKernel;
  const L = 4;
  const N = TP_TAPS * L;
  const h = new Float64Array(N);
  const beta = 8;
  const i0 = (x) => {
    let s = 1, t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const c = (N - 1) / 2;
  for (let n = 0; n < N; n++) {
    const t = (n - c) / L;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = i0(beta * Math.sqrt(1 - ((n - c) / c) ** 2)) / i0(beta);
    h[n] = sinc * w;
  }
  // phases
  tpKernel = Array.from({ length: L }, (_, p) => {
    const k = [];
    for (let n = p; n < N; n += L) k.push(h[n]);
    return Float64Array.from(k);
  });
  return tpKernel;
}

export function truePeak(channels) {
  const phases = truePeakKernel();
  let peak = 0;
  let at = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const s = Math.abs(x[i]);
      if (s > peak) { peak = s; at = i; }
    }
  }
  let tp = peak;
  let tpAt = at;
  for (const x of channels) {
    const n = x.length;
    for (let i = TP_TAPS; i < n; i++) {
      // quick reject: interpolated peaks cannot exceed ~1.4x neighbouring magnitudes
      const m = Math.max(Math.abs(x[i - TP_TAPS / 2]), Math.abs(x[i - TP_TAPS / 2 - 1]));
      if (m * 1.6 < tp) continue;
      for (const k of phases) {
        let y = 0;
        for (let j = 0; j < TP_TAPS; j++) y += k[j] * x[i - j];
        const a = Math.abs(y);
        if (a > tp) { tp = a; tpAt = i - TP_TAPS / 2; }
      }
    }
  }
  return { samplePeak: peak, samplePeakAt: at, truePeak: tp, truePeakAt: tpAt };
}

export function clipping(channels, threshold = 0.9995) {
  let runs = 0;
  let samples = 0;
  for (const x of channels) {
    let run = 0;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) >= threshold) {
        run++;
        samples++;
      } else {
        if (run >= 2) runs++;
        run = 0;
      }
    }
    if (run >= 2) runs++;
  }
  return { clippedSamples: samples, clipRuns: runs };
}

// --- Transient outliers ----------------------------------------------------------------
// High-passed (about 3 kHz) energy in 1 ms frames compared with the median of the
// surrounding 300 ms. Flags frames at least `ratioDb` above it and above `floorDb`.
export function clicks({ sampleRate: fs, channels }, { ratioDb = 24, floorDb = -55, maxReport = 40 } = {}) {
  const mono = mix(channels);
  const w = (2 * Math.PI * 3000) / fs;
  const alpha = 1 / (1 + w);
  const hp = new Float32Array(mono.length);
  let px = 0, py = 0;
  for (let i = 0; i < mono.length; i++) {
    py = alpha * (py + mono[i] - px);
    px = mono[i];
    hp[i] = py;
  }
  // second stage
  px = 0; py = 0;
  for (let i = 0; i < hp.length; i++) {
    const v = hp[i];
    py = alpha * (py + v - px);
    px = v;
    hp[i] = py;
  }
  const frame = Math.max(1, Math.round(fs / 1000));
  const nf = Math.floor(hp.length / frame);
  const e = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += hp[i] * hp[i];
    e[f] = s / frame;
  }
  const half = 150;
  const found = [];
  const floor = 10 ** (floorDb / 10);
  const ratio = 10 ** (ratioDb / 10);
  // running median approximation: sorted window recomputed every 25 frames
  let med = 0;
  for (let f = 0; f < nf; f++) {
    if (f % 25 === 0) {
      const a = Math.max(0, f - half), b = Math.min(nf, f + half);
      const win = Array.from(e.subarray(a, b)).sort((x, y) => x - y);
      med = win[Math.floor(win.length / 2)] || 0;
    }
    if (e[f] > floor && e[f] > ratio * Math.max(med, 1e-12)) {
      if (!found.length || f - found[found.length - 1].frame > 30) found.push({ frame: f, t: +(f / 1000).toFixed(3), db: +pdb(e[f] / Math.max(med, 1e-12)).toFixed(1), level: +pdb(e[f]).toFixed(1) });
    }
  }
  return { count: found.length, events: found.slice(0, maxReport) };
}

// --- Spectrum ----------------------------------------------------------------------------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = i + j + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const BANDS = [
  ["sub<40", 0, 40],
  ["bass40-120", 40, 120],
  ["lowmid120-500", 120, 500],
  ["mid500-2k", 500, 2000],
  ["presence2-5k", 2000, 5000],
  ["high5-10k", 5000, 10000],
  ["air>10k", 10000, 1e9],
];

export function averageSpectrum({ sampleRate: fs, channels }, size = 4096, maxFrames = 4000) {
  const x = mix(channels);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const power = new Float64Array(size / 2);
  let frames = 0;
  const hop = Math.max(size / 2, Math.floor((x.length - size) / maxFrames));
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let s = 0; s + size <= x.length; s += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = x[s + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames) for (let k = 0; k < power.length; k++) power[k] /= frames;
  return { power, binHz: fs / size };
}

export function spectralBalance(audio) {
  const { power, binHz } = averageSpectrum(audio);
  let total = 0;
  let centroid = 0;
  for (let k = 1; k < power.length; k++) {
    total += power[k];
    centroid += power[k] * k * binHz;
  }
  const bands = {};
  for (const [name, a, b] of BANDS) {
    let s = 0;
    for (let k = 1; k < power.length; k++) {
      const f = k * binHz;
      if (f >= a && f < b) s += power[k];
    }
    bands[name] = total ? +pdb(s / total).toFixed(1) : null;
  }
  return { bands, centroidHz: total ? Math.round(centroid / total) : 0 };
}

// --- Stereo ------------------------------------------------------------------------------
export function mix(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

export function stereo(audio) {
  const { channels } = audio;
  if (channels.length < 2) return { correlation: 1, monoLoudnessChange: 0 };
  const [l, r] = channels;
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  const correlation = ll && rr ? lr / Math.sqrt(ll * rr) : 1;
  // Mono downmix as a phone plays it: (L+R)/2 on one speaker, compared with the stereo loudness.
  const st = loudness(audio).integrated;
  const mono = mix(channels);
  const m = loudness({ sampleRate: audio.sampleRate, channels: [mono, mono] }).integrated;
  return { correlation: +correlation.toFixed(3), monoLoudnessChange: +(m - st).toFixed(2) };
}

// Discontinuity at a loop seam: the jump from the last to the first sample against the typical
// sample-to-sample step of the material (1 = as smooth as anywhere else).
export function seam(channels) {
  let worst = 0;
  for (const x of channels) {
    let sum = 0;
    for (let i = 1; i < x.length; i++) sum += Math.abs(x[i] - x[i - 1]);
    const typical = sum / (x.length - 1) || 1e-9;
    worst = Math.max(worst, Math.abs(x[0] - x[x.length - 1]) / typical);
  }
  return +worst.toFixed(2);
}

export function report(audio, { clicksOpts, withSeam = false } = {}) {
  const dur = audio.channels[0].length / audio.sampleRate;
  const L = loudness(audio);
  const tp = truePeak(audio.channels);
  let dc = 0;
  for (const c of audio.channels) {
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i];
    dc = Math.max(dc, Math.abs(s / c.length));
  }
  const r = {
    duration: +dur.toFixed(3),
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    integratedLUFS: +L.integrated.toFixed(2),
    maxMomentaryLUFS: +L.maxMomentary.toFixed(2),
    maxShortTermLUFS: +L.maxShortTerm.toFixed(2),
    lraLU: +L.lra.toFixed(1),
    samplePeakDBFS: +db(tp.samplePeak).toFixed(2),
    truePeakDBTP: +db(tp.truePeak).toFixed(2),
    truePeakAt: +(tp.truePeakAt / audio.sampleRate).toFixed(3),
    ...clipping(audio.channels),
    dcOffset: +dc.toFixed(5),
    clicks: clicks(audio, clicksOpts),
    spectrum: spectralBalance(audio),
    stereo: stereo(audio),
  };
  if (withSeam) r.seam = seam(audio.channels);
  return r;
}
