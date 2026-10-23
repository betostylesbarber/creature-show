// Audio-thread processors for the mixer (loaded with audioWorklet.addModule):
//  - "tp-limiter": the protective output limiter. Look-ahead, true-peak aware (4x oversampled
//    peak estimate), smooth attack over the look-ahead and exponential release, so stacked
//    sounds never clip and the stream stays under about -1 dBTP even after encoding (ceiling -2 dBTP: Opus adds up to ~0.5 dB).
//  - "pcm-tap": copies its inputs to the main thread while recording (debug captures only).

const TAPS = 16;
// 4x interpolation kernel (Kaiser-windowed sinc); phases 1..3 estimate the inter-sample values.
const KERNEL = (() => {
  const L = 4;
  const N = TAPS * L;
  const c = (N - 1) / 2;
  const i0 = (x) => {
    let s = 1, t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const h = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = (n - c) / L;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[n] = sinc * (i0(8 * Math.sqrt(1 - ((n - c) / c) ** 2)) / i0(8));
  }
  return [1, 2, 3].map((p) => {
    const k = new Float32Array(TAPS);
    for (let j = 0, n = p; n < N && j < TAPS; n += L, j++) k[j] = h[n];
    return k;
  });
})();

class TruePeakLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ceiling", defaultValue: -2, minValue: -20, maxValue: 0, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.12, minValue: 0.01, maxValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.look = Math.round(sampleRate * 0.0025); // 2.5 ms look-ahead
    this.size = this.look + TAPS + 4;
    this.delay = [new Float32Array(this.size * 4), new Float32Array(this.size * 4)];
    this.hist = [new Float32Array(TAPS), new Float32Array(TAPS)];
    this.histPos = 0;
    this.pos = 0;
    // sliding minimum over the look-ahead (monotonic deque) and a moving average after it
    this.dqVal = new Float32Array(this.look + 2);
    this.dqIdx = new Int32Array(this.look + 2);
    this.dqHead = 0;
    this.dqLen = 0;
    this.n = 0;
    this.avg = new Float32Array(this.look);
    this.avgPos = 0;
    this.avgSum = this.look;
    this.avg.fill(1);
    this.gain = 1;
    this.reduction = 0;
    this.frames = 0;
    this.port.onmessage = () => {};
  }

  pushMin(v, i) {
    const cap = this.dqVal.length;
    while (this.dqLen && this.dqVal[(this.dqHead + this.dqLen - 1) % cap] >= v) this.dqLen--;
    const at = (this.dqHead + this.dqLen) % cap;
    this.dqVal[at] = v;
    this.dqIdx[at] = i;
    this.dqLen++;
    while (this.dqIdx[this.dqHead] <= i - this.look - 1) {
      this.dqHead = (this.dqHead + 1) % cap;
      this.dqLen--;
    }
    return this.dqVal[this.dqHead];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const ceil = 10 ** (params.ceiling[0] / 20);
    const rel = Math.exp(-1 / (params.release[0] * sampleRate));
    const nch = output.length;
    const frames = output[0].length;
    const D = this.delay[0].length;
    for (let i = 0; i < frames; i++) {
      // peak estimate of the newest input sample (true peak, 4x)
      let peak = 0;
      for (let c = 0; c < Math.min(2, nch); c++) {
        const x = input[c] ? input[c][i] : input[0] ? input[0][i] : 0;
        const h = this.hist[c];
        h[this.histPos] = x;
        let p = Math.abs(x);
        for (const k of KERNEL) {
          let y = 0;
          for (let j = 0; j < TAPS; j++) y += k[j] * h[(this.histPos - j + TAPS) % TAPS];
          const a = Math.abs(y);
          if (a > p) p = a;
        }
        if (p > peak) peak = p;
        this.delay[c][this.pos] = x;
      }
      this.histPos = (this.histPos + 1) % TAPS;
      const need = peak > ceil ? ceil / peak : 1;
      const m = this.pushMin(need, this.n++);
      this.avgSum += m - this.avg[this.avgPos];
      this.avg[this.avgPos] = m;
      this.avgPos = (this.avgPos + 1) % this.look;
      const target = Math.min(m, this.avgSum / this.look);
      this.gain = target < this.gain ? target : target - (target - this.gain) * rel;
      // the interpolator's own delay is TAPS/2; the look-ahead covers both
      const read = (this.pos - this.look - TAPS / 2 + D) % D;
      for (let c = 0; c < nch; c++) output[c][i] = this.delay[Math.min(c, 1)][read] * this.gain;
      this.pos = (this.pos + 1) % D;
      if (1 - this.gain > this.reduction) this.reduction = 1 - this.gain;
    }
    if ((this.frames += frames) >= sampleRate / 4) {
      this.port.postMessage({ reductionDb: this.reduction > 0 ? -20 * Math.log10(1 - this.reduction) : 0 });
      this.reduction = 0;
      this.frames = 0;
    }
    return true;
  }
}
registerProcessor("tp-limiter", TruePeakLimiter);

// Records every input (each stereo) while `recording`; posts Float32 chunks to the main thread.
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputsCount = options.numberOfInputs || 1;
    this.recording = false;
    this.chunk = 8192;
    this.buf = null;
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.recording = true;
        this.reset();
      } else if (e.data === "stop") {
        this.flush();
        this.recording = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  reset() {
    this.buf = Array.from({ length: this.inputsCount * 2 }, () => new Float32Array(this.chunk));
    this.fill = 0;
  }
  flush() {
    if (!this.fill) return;
    const out = this.buf.map((b) => b.slice(0, this.fill));
    this.port.postMessage({ chunk: out }, out.map((b) => b.buffer));
    this.reset();
  }
  process(inputs) {
    if (!this.recording) return true;
    const frames = 128;
    for (let i = 0; i < frames; i++) {
      for (let k = 0; k < this.inputsCount; k++) {
        const inp = inputs[k] || [];
        const l = inp[0] ? inp[0][i] : 0;
        const r = inp[1] ? inp[1][i] : l;
        this.buf[k * 2][this.fill] = l;
        this.buf[k * 2 + 1][this.fill] = r;
      }
      if (++this.fill === this.chunk) this.flush();
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
