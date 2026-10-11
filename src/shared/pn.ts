// Continuous silent calibration signals (spec §8.4, ADR-0007). Pure DSP, unit-tested.
// Every device mixes its own faint pseudo-noise code into what it plays, phase-locked to the shared
// (server) timeline. A microphone recording correlated against each code gives that device's arrival
// lag, even with all devices playing the same music at once.

export const PN = {
  rate: 16000, // codes live at 16 kHz; mics are decimated 48k → 16k before correlating
  length: 64000, // 4 s period, longer than any lag we search
  db: -30, // code level relative to the chunk's music RMS (masked by the music; tune by ear)
};

function xorshift(seed: number) {
  let x = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };
function biquad(type: "lp" | "hp", f: number, fs: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * f) / fs, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b1 = type === "lp" ? 1 - cos : -(1 + cos), b0 = Math.abs(b1) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}
function filter(x: Float32Array, c: Biquad) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
}

const codes = new Map<number, Float32Array>();
/** Deterministic band-limited (≈0.8–6 kHz, phone-speaker friendly) code for a device id, RMS 1. */
export function pnCode(id: number): Float32Array {
  const hit = codes.get(id);
  if (hit) return hit;
  const L = PN.length, r = xorshift(id), x = new Float32Array(2 * L);
  for (let i = 0; i < L; i++) x[i] = x[i + L] = r() & 1 ? 1 : -1;
  for (const c of [biquad("hp", 800, PN.rate), biquad("hp", 800, PN.rate), biquad("lp", 6000, PN.rate), biquad("lp", 6000, PN.rate)]) filter(x, c);
  const code = x.slice(L); // second period ≈ steady state of the circular filter
  const rms = Math.sqrt(code.reduce((s, v) => s + v * v, 0) / L);
  for (let i = 0; i < L; i++) code[i] /= rms;
  codes.set(id, code);
  return code;
}

/** Code value at shared-timeline time `ms` (server ms), periodic, linearly interpolated. */
export function pnAt(code: Float32Array, ms: number): number {
  const L = code.length, x = ms * (PN.rate / 1000);
  const f = x - Math.floor(x), i = ((Math.floor(x) % L) + L) % L;
  return code[i] + f * (code[(i + 1) % L] - code[i]);
}

/** Mixes `code` into 48 kHz channels whose first sample sounds at server time tMs. Returns the amplitude used. */
export function mixPN(chs: Float32Array[], tMs: number, code: Float32Array, db = PN.db, sampleRate = 48000): number {
  const n = chs[0].length;
  let e = 0;
  for (const ch of chs) for (let i = 0; i < n; i++) e += ch[i] * ch[i];
  const amp = Math.sqrt(e / (n * chs.length)) * 10 ** (db / 20);
  if (amp < 1e-5) return 0; // silence: nothing to hide the code in
  const step = 1000 / sampleRate;
  for (let i = 0; i < n; i++) {
    const v = amp * pnAt(code, tMs + i * step);
    for (const ch of chs) ch[i] += v;
  }
  return amp;
}

// 31-tap windowed-sinc low-pass at 7 kHz for 48k → 16k decimation (group delay 15 samples, same for every code).
const FIR = (() => {
  const n = 31, fc = 7000 / 48000, h = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = i - (n - 1) / 2, sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    s += h[i];
  }
  return h.map((v) => v / s);
})();
export const DECIMATION_DELAY_MS = (15 / 48000) * 1000;

/** 48 kHz → 16 kHz. Output sample j corresponds to input sample 3j (FIR delay reported separately). */
export function decimate3(x: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(x.length / 3));
  for (let j = 0; j < out.length; j++) {
    let acc = 0;
    const c = 3 * j;
    for (let k = 0; k < FIR.length; k++) {
      const idx = c - k;
      if (idx >= 0) acc += FIR[k] * x[idx];
    }
    out[j] = acc;
  }
  return out;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export type CodeLag = { lagMs: number; ratio: number };
export const PN_ACCEPT_RATIO = 6; // peak vs correlation RMS: ~6σ, false alarms negligible

/** Spectrum of a mic window, reused across codes. Whitened (GCC-PHAT style): each bin is divided by the
 *  locally averaged magnitude, so loud, coloured music no longer dominates the correlation. */
export function spectrum(rec16: Float32Array, size: number, whiten = true) {
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(rec16);
  fft(re, im);
  if (whiten) {
    const mag = new Float64Array(size);
    for (let i = 0; i < size; i++) mag[i] = Math.hypot(re[i], im[i]);
    const half = 8;
    let acc = 0;
    for (let i = -half; i <= half; i++) acc += mag[(i + size) % size];
    for (let i = 0; i < size; i++) {
      const w = acc / (2 * half + 1) + 1e-9;
      re[i] /= w; im[i] /= w;
      acc += mag[(i + half + 1) % size] - mag[(i - half + size) % size];
    }
  }
  return { re, im, n: rec16.length, size };
}

/** Cross-correlation of `code` (expected at shared time `startMs` = the window's first sample) with a mic
 *  window, over lags ±maxLagMs. Index k ↔ lag (W − k) samples. Windows can be summed while timing is stable. */
export function correlation(spec: ReturnType<typeof spectrum>, startMs: number, code: Float32Array, maxLagMs: number): Float64Array {
  const W = Math.round((maxLagMs * PN.rate) / 1000), len = spec.n + 2 * W, step = 1000 / PN.rate;
  if (len > spec.size) throw new Error("FFT size too small");
  const tr = new Float64Array(spec.size), ti = new Float64Array(spec.size);
  for (let k = 0; k < len; k++) tr[k] = pnAt(code, startMs + (k - W) * step);
  fft(tr, ti);
  for (let i = 0; i < spec.size; i++) { // conj(R) · T
    const r = spec.re[i], m = spec.im[i], a = tr[i], b = ti[i];
    tr[i] = r * a + m * b;
    ti[i] = r * b - m * a;
  }
  fft(tr, ti, true);
  return tr.slice(0, 2 * W + 1);
}

/** Arrival lag (positive = later than target) and peak-to-RMS ratio. Prefers the earliest strong arrival
 *  (direct path) over a slightly stronger later reflection. */
export function peak(c: Float64Array): CodeLag {
  const W = (c.length - 1) / 2, step = 1000 / PN.rate, guard = 32;
  let best = 0;
  for (let k = 0; k < c.length; k++) if (Math.abs(c[k]) > Math.abs(c[best])) best = k;
  const reach = Math.round((10 * PN.rate) / 1000); // earlier arrival = larger k, look up to 10 ms earlier
  for (let k = Math.min(c.length - 2, best + reach); k > best + guard / 4; k--) {
    const v = Math.abs(c[k]);
    if (v >= 0.6 * Math.abs(c[best]) && v >= Math.abs(c[k - 1]) && v >= Math.abs(c[k + 1])) { best = k; break; }
  }
  let sum = 0, cnt = 0;
  for (let k = 0; k < c.length; k++) if (Math.abs(k - best) > guard) { sum += c[k] * c[k]; cnt++; }
  const rms = Math.sqrt(sum / Math.max(1, cnt)) || 1e-12;
  let kf = best;
  if (best > 0 && best < c.length - 1) {
    const a = Math.abs(c[best - 1]), b = Math.abs(c[best]), d = Math.abs(c[best + 1]), den = a - 2 * b + d;
    if (den < 0) kf = best + (0.5 * (a - d)) / den;
  }
  return { lagMs: (W - kf) * step, ratio: Math.abs(c[best]) / rms };
}

/** One-shot convenience: correlate one window and take the peak. */
export function measureCode(spec: ReturnType<typeof spectrum>, startMs: number, code: Float32Array, maxLagMs: number): CodeLag {
  return peak(correlation(spec, startMs, code, maxLagMs));
}

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(n));
