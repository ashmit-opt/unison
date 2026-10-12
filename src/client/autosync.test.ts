// AutoSyncHost decision logic with a fake clock (no audio): corrections, settling, two-way pairs.
import { expect, test } from "bun:test";
import { AutoSyncHost, type Lag } from "./autosync.ts";

function rig() {
  let now = 0;
  const adjusts: [number, number][] = [];
  const sync = new AutoSyncHost(1, {
    adjust: (id, d) => adjusts.push([id, Math.round(d * 100) / 100]),
    setLevel: () => {},
    chainErrMs: () => 0,
    reset: () => {},
  }, () => now);
  sync.ensure([1, 2]);
  const host = (lags: Record<number, number>) => sync.onHostMic(new Map(Object.entries(lags).map(([k, v]) => [Number(k), { lagMs: v, ratio: 10 } as Lag])));
  return { sync, adjusts, host, tick: (ms = 1500) => (now += ms) };
}

test("single mic: the late device is corrected once, then left alone while it settles", () => {
  const { adjusts, host, tick } = rig();
  host({ 1: 5, 2: 30 }); // device 2 is 25 ms behind (median of 2 = the later one is the reference)
  expect(adjusts).toEqual([[1, -25]]);
  tick(); host({ 1: 5, 2: 30 }); // stale pre-correction data inside the settle window: no new action
  expect(adjusts.length).toBe(1);
});

test("two active mics: no correction until the pair is measured both ways; then distance cancels", () => {
  const { sync, adjusts, host, tick } = rig();
  // Mic 1 (host) hears itself and device 2 (20 ms away, emitting 15 ms late); helper 2 hasn't heard device 1 yet.
  sync.onHelper(2, { "2": 9 });
  host({ 1: 4, 2: 4 + 15 + 20 });
  expect(adjusts).toEqual([]); // a one-way solve would wrongly move device 2 by 35 ms
  tick();
  // Now complete. Helper mic latency b2 = 9 − e2 = −6, so device 1 (e1 = 0) arrives at e1 + b2 + 20 = 14.
  sync.onHelper(2, { "2": 9, "1": 0 - 6 + 20 });
  host({ 1: 4, 2: 4 + 15 + 20 });
  const [[id, d]] = adjusts;
  expect(Math.abs(d)).toBeCloseTo(15, 1); // the true emission error, not 35
  expect([1, 2]).toContain(id);
});

test("forget(): a re-synced device is measured from scratch after the settle time", () => {
  const { sync, adjusts, host, tick } = rig();
  host({ 1: 5, 2: 30 });
  expect(adjusts.length).toBe(1);
  tick(10_000);
  sync.forget(1);
  host({ 1: 5, 2: 30 }); // inside the settle window after forget → ignored
  expect(adjusts.length).toBe(1);
  tick(4000);
  host({ 1: 5, 2: 30 });
  expect(adjusts.length).toBe(2);
});
