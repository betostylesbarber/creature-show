// Features that tell a breath from a hum from a word in short vocal renderings:
// active duration, syllable bursts, voiced share and mean F0 (autocorrelation), spectral
// centroid, flatness (noise-likeness) and the share of energy above 1.5 kHz.
import { fft } from "./analysis.mjs";

export function voiceFeatures({ sampleRate: fs, channels }) {
  const x = channels[0];
  const hop = Math.round(fs * 0.01);
  const win = Math.round(fs * 0.03);
  const frames = [];
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const size = 2048;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let s = 0; s + win < x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += x[s + i] * x[s + i];
    const rms = Math.sqrt(e / win);
    // autocorrelation pitch 60..400 Hz
    let best = 0, lag = 0;
    const minLag = Math.floor(fs / 400), maxLag = Math.floor(fs / 60);
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[s + i] * x[s + i];
    for (let L = minLag; L <= maxLag; L++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < win && s + i + L < x.length; i++) {
        c += x[s + i] * x[s + i + L];
        e1 += x[s + i + L] * x[s + i + L];
      }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; lag = L; }
    }
    // spectrum
    re.fill(0); im.fill(0);
    for (let i = 0; i < Math.min(size, win); i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
    fft(re, im);
    let tot = 0, cen = 0, hi = 0, logSum = 0, n = 0;
    for (let k = 2; k < size / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-18;
      const f = (k * fs) / size;
      if (f > 8000) break;
      tot += p; cen += p * f; if (f > 1500) hi += p;
      logSum += Math.log(p); n++;
    }
    frames.push({ rms, r: best, f0: lag ? fs / lag : 0, centroid: cen / tot, flat: Math.exp(logSum / n) / (tot / n), hi: hi / tot });
  }
  const active = frames.filter((f) => f.rms > peak * 0.06);
  const voiced = active.filter((f) => f.r > 0.75);
  const mean = (a, k) => (a.length ? a.reduce((s, f) => s + f[k], 0) / a.length : 0);
  // syllable bursts: rising crossings of 35% of the max envelope, smoothed
  const env = frames.map((f) => f.rms);
  const maxE = Math.max(...env, 1e-9);
  let bursts = 0, on = false;
  for (const e of env) {
    if (!on && e > maxE * 0.35) { bursts++; on = true; }
    else if (on && e < maxE * 0.18) on = false;
  }
  const f0s = voiced.map((f) => f.f0).sort((a, b) => a - b);
  return {
    activeS: +(active.length * 0.01).toFixed(2),
    bursts,
    voiced: +(voiced.length / Math.max(1, active.length)).toFixed(2),
    f0: Math.round(f0s[Math.floor(f0s.length / 2)] || 0),
    centroid: Math.round(mean(active, "centroid")),
    flatness: +mean(active, "flat").toFixed(3),
    hiShare: +mean(active, "hi").toFixed(2),
  };
}
