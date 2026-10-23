// Finding the individual events in a recording (footsteps, caws, hoots, thunder rolls, zaps)
// from its loudness envelope, so the build can cut clean one-shots automatically.
import { mono, slice } from "./dsp.mjs";

export function envelope(a, win = 0.01) {
  const x = mono(a).channels[0];
  const n = Math.max(1, Math.round(win * a.sampleRate));
  const out = new Float32Array(Math.floor(x.length / n));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * n; i < (f + 1) * n; i++) s += x[i] * x[i];
    out[f] = Math.sqrt(s / n);
  }
  return { env: out, step: n / a.sampleRate };
}

// Segments where the envelope is within `thresholdDb` of the loudest point (or above an
// absolute floor), merged across gaps shorter than `minGap`, padded by pre/post.
export function onsets(a, { thresholdDb = -30, absDb = null, minGap = 0.15, pre = 0.01, post = 0.08, minLen = 0.05, maxLen = 3, win = 0.01, smooth = 1 } = {}) {
  let { env, step } = envelope(a, win);
  if (smooth > 1) {
    const s = new Float32Array(env.length);
    for (let i = 0; i < env.length; i++) {
      let t = 0, c = 0;
      for (let j = Math.max(0, i - smooth); j <= Math.min(env.length - 1, i + smooth); j++) { t += env[j]; c++; }
      s[i] = t / c;
    }
    env = s;
  }
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  const th = absDb != null ? 10 ** (absDb / 20) : peak * 10 ** (thresholdDb / 20);
  const segs = [];
  let start = -1, lastOn = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= th) {
      if (start < 0) start = i;
      lastOn = i;
    } else if (start >= 0 && (i - lastOn) * step > minGap) {
      segs.push([start, lastOn]);
      start = -1;
    }
  }
  if (start >= 0) segs.push([start, lastOn]);
  const dur = a.channels[0].length / a.sampleRate;
  return segs
    .map(([s, e]) => {
      let peakAt = s, pk = 0;
      for (let i = s; i <= e; i++) if (env[i] > pk) { pk = env[i]; peakAt = i; }
      return { from: Math.max(0, s * step - pre), to: Math.min(dur, (e + 1) * step + post), peak: 20 * Math.log10(pk + 1e-12), peakAt: peakAt * step };
    })
    .filter((s) => s.to - s.from >= minLen && s.to - s.from <= maxLen + pre + post);
}

export function cut(a, seg) {
  return slice(a, seg.from, seg.to);
}
