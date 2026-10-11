// Calibration signal + analysis (spec §8, ADR-0005). Pure functions.

export const CHIRP = { ms: 40, f0: 1500, f1: 7000, amp: 0.8, fadeMs: 2 };

/** Deterministic linear sweep with short fades. */
export function chirp(sr = 48000): Float32Array {
  const n = Math.round((CHIRP.ms / 1000) * sr), T = n / sr, fade = (CHIRP.fadeMs / 1000) * sr;
  const k = (CHIRP.f1 - CHIRP.f0) / T, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, g = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = CHIRP.amp * g * Math.sin(2 * Math.PI * (CHIRP.f0 * t + (k * t * t) / 2));
  }
  return out;
}

export type Match = { index: number; peak: number; ratio: number };

/** Normalized cross-correlation of `template` across `signal`; index is fractional (parabolic fit).
 *  ponytail: O(N·M) direct correlation (~60M MACs per 650 ms window); switch to FFT if it ever matters. */
export function correlate(signal: Float32Array, template: Float32Array): Match | null {
  const n = signal.length, m = template.length;
  if (n < m) return null;
  let tEnergy = 0;
  for (let i = 0; i < m; i++) tEnergy += template[i] * template[i];
  const tNorm = Math.sqrt(tEnergy);
  let win = 0;
  for (let i = 0; i < m; i++) win += signal[i] * signal[i];
  const c = new Float32Array(n - m + 1);
  for (let k = 0; k <= n - m; k++) {
    if (k > 0) win += signal[k + m - 1] ** 2 - signal[k - 1] ** 2;
    let dot = 0;
    for (let i = 0; i < m; i++) dot += signal[k + i] * template[i];
    c[k] = win > 1e-9 ? dot / (tNorm * Math.sqrt(win)) : 0;
  }
  let best = 0;
  for (let k = 1; k < c.length; k++) if (c[k] > c[best]) best = k;
  let index = best;
  if (best > 0 && best < c.length - 1) {
    const a = c[best - 1], b = c[best], d = c[best + 1], den = a - 2 * b + d;
    if (den < 0) index = best + (0.5 * (a - d)) / den;
  }
  const abs = Array.from(c, Math.abs).sort((x, y) => x - y);
  const median = abs[abs.length >> 1] || 1e-9;
  return { index, peak: c[best], ratio: c[best] / median };
}

export const ACCEPT = { minPeak: 0.3, minRatio: 8 };
export const accepted = (m: Match | null) => !!m && m.peak >= ACCEPT.minPeak && m.ratio >= ACCEPT.minRatio;

/** From per-device lags (ms, null = not heard): deltas to add to each device offset, and the spread
 *  (null unless at least two devices were heard — one device has nothing to be in sync with). */
export function analyzeLags(lags: (number | null)[]): { deltas: (number | null)[]; spreadMs: number | null; ref: number | null } {
  const ok = lags.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!ok.length) return { deltas: lags.map(() => null), spreadMs: null, ref: null };
  const ref = ok[ok.length >> 1];
  return { deltas: lags.map((l) => (l === null ? null : l - ref)), spreadMs: ok.length >= 2 ? ok[ok.length - 1] - ok[0] : null, ref };
}
