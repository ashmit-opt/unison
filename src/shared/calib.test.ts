import { expect, test } from "bun:test";
import { accepted, analyzeLags, chirp, correlate } from "./calib.ts";

function noise(n: number, amp: number, seed = 5) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * ((((seed = (seed * 16807) % 2147483647) / 2147483647) * 2) - 1);
  return out;
}

test("chirp shape", () => {
  const c = chirp();
  expect(c.length).toBe(1920);
  expect(Math.max(...c.map(Math.abs))).toBeLessThanOrEqual(0.8);
  expect(Math.abs(c[0])).toBeLessThan(0.01);
});

test("finds a quiet chirp in noise to sub-millisecond accuracy", () => {
  const c = chirp(), sig = noise(31200, 0.02);
  const at = 12345;
  for (let i = 0; i < c.length; i++) sig[at + i] += 0.1 * c[i];
  const m = correlate(sig, c);
  expect(accepted(m)).toBe(true);
  expect(Math.abs(m!.index - at)).toBeLessThan(0.5); // < 0.01 ms at 48 kHz
});

test("pure noise is not accepted", () => {
  expect(accepted(correlate(noise(31200, 0.3, 11), chirp()))).toBe(false);
});

test("lag analysis: median reference, deltas, spread", () => {
  expect(analyzeLags([10, 12, null, 11])).toEqual({ deltas: [-1, 1, null, 0], spreadMs: 2, ref: 11 });
  expect(analyzeLags([null]).spreadMs).toBeNull();
  expect(analyzeLags([null, 7]).spreadMs).toBeNull(); // regression: one heard device is not "0 ms spread"
});
