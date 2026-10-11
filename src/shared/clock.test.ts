import { expect, test } from "bun:test";
import { ClockEstimator, DriftTracker, MaxWindow, MedianWindow } from "./clock.ts";

// Deterministic PRNG so failures reproduce.
function rng(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function simulate(theta: number, fwd: number, back: number, jitterMs: number, n = 15) {
  const r = rng(7), est = new ClockEstimator();
  let p = 1000;
  for (let i = 0; i < n; i++) {
    const t0 = p;
    const up = fwd + -Math.log(1 - r()) * jitterMs, down = back + -Math.log(1 - r()) * jitterMs; // exponential queueing
    const ts = t0 + up + theta;
    const t1 = t0 + up + down;
    est.add(t0, t1, ts);
    p += 1000;
  }
  return est;
}

test("symmetric path with typical Wi-Fi jitter: offset within 1 ms", () => {
  const est = simulate(12345.6, 20, 20, 3);
  expect(est.ready).toBe(true);
  expect(Math.abs(est.offset - 12345.6)).toBeLessThan(1);
});

test("heavy jitter: error stays within the reported uncertainty", () => {
  const est = simulate(12345.6, 20, 20, 15);
  expect(Math.abs(est.offset - 12345.6)).toBeLessThanOrEqual(est.uncertainty);
});

test("asymmetric path: bias stays within the reported uncertainty", () => {
  const est = simulate(-500, 30, 10, 3);
  const err = Math.abs(est.offset - -500);
  expect(err).toBeGreaterThan(5); // asymmetry cannot be seen by pings…
  expect(err).toBeLessThanOrEqual(est.uncertainty); // …but it is bounded by minRtt/2
});

test("negative rtt and non-finite samples are ignored", () => {
  const est = new ClockEstimator();
  est.add(10, 5, 100);
  est.add(0, 10, NaN);
  expect(est.count).toBe(0);
});

test("windows", () => {
  const med = new MedianWindow(3);
  [5, 1, 100, 2].forEach((x) => med.add(x));
  expect(med.value).toBe(2);
  const max = new MaxWindow(1000);
  max.add(0, 50);
  max.add(500, 10);
  expect(max.value).toBe(50);
  max.add(1600, 20); // 0 and 500 expire
  expect(max.value).toBe(20);
});

function driftRun(ppm: number, seconds: number, earlyBurstMs = 0) {
  const r = rng(11), d = new DriftTracker();
  let total = 0;
  const steps: number[] = [];
  for (let k = 0; k < seconds * 50; k++) {
    const audioMs = k * 20; // one 20 ms block per arrival
    const burst = k < 25 ? -earlyBurstMs : 0; // start-up: blocks rendered ahead of real time
    const server = 5000 + audioMs * (1 + ppm * 1e-6) + -Math.log(1 - r()) * 8 + burst; // main-thread delay noise
    const c = d.add(server, audioMs);
    if (c) { total += c; steps.push(c); }
  }
  return { total, steps };
}

test("drift tracker ignores startup transients and main-thread jitter", () => {
  expect(driftRun(0, 120).steps).toEqual([]);
});

test("drift tracker follows a 100 ppm clock difference in small steps", () => {
  const { total, steps } = driftRun(100, 300); // ~29 ms of drift after warm-up
  expect(Math.abs(total - 0.1 * 290)).toBeLessThan(6);
  for (const s of steps) expect(Math.abs(s)).toBeLessThan(8);
});

test("regression: an early burst of blocks (rendered ahead) causes no step when it leaves the window", () => {
  expect(driftRun(0, 60, 10).steps).toEqual([]);
});

test("probe pairs: a queued probe (gap mismatch) is rejected, a clean pair keeps the faster probe", () => {
  const est = new ClockEstimator();
  est.addPair({ t0: 0, t1: 20, ts: 1010 }, { t0: 25, t1: 45, ts: 1035 }); // gaps 25/25 → pure
  expect([est.pure, est.count]).toEqual([1, 1]);
  est.addPair({ t0: 100, t1: 120, ts: 1110 }, { t0: 125, t1: 190, ts: 1170 }); // server gap 60 vs 25 → queued
  expect([est.impure, est.count]).toEqual([1, 1]);
});
