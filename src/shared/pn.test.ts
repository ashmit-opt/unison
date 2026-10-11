import { expect, test } from "bun:test";
import { DECIMATION_DELAY_MS, PN, PN_ACCEPT_RATIO, correlation, decimate3, fft, measureCode, mixPN, nextPow2, peak, pnAt, pnCode, spectrum } from "./pn.ts";

function rng(seed = 9) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** "Music": a few tones + low-passed noise, RMS ≈ 0.2, 48 kHz. Same music on every device. */
function music(n: number) {
  const r = rng(3), out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp = 0.97 * lp + 0.03 * r();
    out[i] = 0.08 * Math.sin((2 * Math.PI * 220 * i) / 48000) + 0.06 * Math.sin((2 * Math.PI * 1320 * i) / 48000) + 0.04 * Math.sin((2 * Math.PI * 3100 * i) / 48000) + 1.2 * lp;
  }
  return out;
}

/** What one device emits: the music with its code mixed in, chunk by chunk (100 ms), as the player does. */
function deviceOutput(m: Float32Array, id: number, startMs: number) {
  const out = m.slice();
  for (let off = 0; off < out.length; off += 4800) mixPN([out.subarray(off, off + 4800)], startMs + off / 48, pnCode(id));
  return out;
}

test("codes are deterministic, unit RMS, periodic and nearly orthogonal", () => {
  const a = pnCode(1), b = pnCode(2);
  expect(pnCode(1)).toBe(a);
  expect(a.length).toBe(PN.length);
  const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0) / x.length;
  expect(dot(a, a)).toBeCloseTo(1, 3);
  expect(Math.abs(dot(a, b))).toBeLessThan(0.02);
  expect(pnAt(a, 0)).toBeCloseTo(pnAt(a, 4000), 9); // 4 s period
});

test("fft round trip", () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i)), im = new Float64Array(64), orig = re.slice();
  fft(re, im);
  fft(re, im, true);
  re.forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9));
});

test("feasibility: two devices' codes 30 dB under shared music are located to < 0.2 ms", () => {
  const sec = 1.5, n = sec * 48000, pad = 48000;
  const m = music(n + pad);
  // Both devices target the same timeline (start = 0 ms); A arrives 12.29 ms late, B 37.10 ms late.
  const a = deviceOutput(m, 1, 0), b = deviceOutput(m, 2, 0);
  const dA = 590, dB = 1781, r = rng(7), mic = new Float32Array(n);
  const t0 = 1000; // the mic window starts 1 s into playback (shared time 1000 ms)
  const s0 = (t0 / 1000) * 48000;
  for (let i = 0; i < n; i++) mic[i] = 0.5 * a[s0 + i - dA] + 0.3 * b[s0 + i - dB] + 0.01 * r();
  const rec = decimate3(mic);
  const spec = spectrum(rec, nextPow2(rec.length + 2 * 0.3 * PN.rate));
  const la = measureCode(spec, t0, pnCode(1), 300), lb = measureCode(spec, t0, pnCode(2), 300), none = measureCode(spec, t0, pnCode(3), 300);
  expect(la.ratio).toBeGreaterThan(PN_ACCEPT_RATIO);
  expect(lb.ratio).toBeGreaterThan(PN_ACCEPT_RATIO);
  expect(none.ratio).toBeLessThan(PN_ACCEPT_RATIO);
  expect(Math.abs(la.lagMs - DECIMATION_DELAY_MS - (dA / 48))).toBeLessThan(0.2);
  expect(Math.abs(lb.lagMs - la.lagMs - (dB - dA) / 48)).toBeLessThan(0.2);
});

test("mixPN: level follows the music; silence stays silent", () => {
  const loud = new Float32Array(4800).fill(0.2), quiet = new Float32Array(4800);
  const amp = mixPN([loud], 0, pnCode(1));
  expect(amp).toBeCloseTo(0.2 * 10 ** (PN.db / 20), 6);
  expect(mixPN([quiet], 0, pnCode(1))).toBe(0);
  expect(quiet.every((v) => v === 0)).toBe(true);
});

test("summing consecutive windows finds a faint far device in bright, noise-like music", () => {
  const r = rng(5), n = 1.5 * 48000, total = 4 * n + 96000;
  const m = Float32Array.from({ length: total }, () => 0.34 * r()); // white "music": worst case
  const a = deviceOutput(m, 1, 0), b = deviceOutput(m, 2, 0), noise = rng(8);
  const dA = 590, dB = 1781;
  let acc: Float64Array | null = null, single = 0;
  for (let w = 0; w < 4; w++) {
    const s0 = 48000 + w * n, mic = new Float32Array(n);
    for (let i = 0; i < n; i++) mic[i] = 0.5 * a[s0 + i - dA] + 0.3 * b[s0 + i - dB] + 0.01 * noise();
    const rec = decimate3(mic), spec = spectrum(rec, nextPow2(rec.length + 2 * 0.3 * PN.rate));
    const c = correlation(spec, (s0 / 48000) * 1000, pnCode(2), 300);
    if (w === 0) single = peak(c).ratio;
    acc = acc ? acc.map((v, i) => v + c[i]) : c;
  }
  const p = peak(acc!);
  expect(single).toBeLessThan(PN_ACCEPT_RATIO); // one window is not enough here…
  expect(p.ratio).toBeGreaterThan(PN_ACCEPT_RATIO); // …four summed windows are
  expect(Math.abs(p.lagMs - DECIMATION_DELAY_MS - dB / 48)).toBeLessThan(0.2);
});

test("prefers the direct path over a slightly stronger reflection 4 ms later", () => {
  const W = 4800, c = new Float64Array(2 * W + 1);
  const r = rng(4);
  for (let k = 0; k < c.length; k++) c[k] = 0.05 * r();
  const kDirect = W - 160, kReflect = W - 224; // lags 10 ms and 14 ms
  c[kDirect] = 0.8; c[kReflect] = 1.0;
  expect(peak(c).lagMs).toBeCloseTo(10, 1);
});
