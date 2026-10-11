import { expect, test } from "bun:test";
import { Scheduler } from "./scheduler.ts";

const D = 0.1;

/** Feeds chunks to the scheduler as they would arrive (lead s ahead), returns placements. */
function run(n: number, desiredOf: (k: number) => number, opts: { lead?: number; skip?: Set<number> } = {}) {
  const s = new Scheduler(), out = [];
  for (let k = 0; k < n; k++) {
    if (opts.skip?.has(k)) continue;
    const desired = desiredOf(k);
    out.push({ k, desired, p: s.place(desired, D, desired - (opts.lead ?? 0.3)) });
  }
  return out;
}

function rng(seed = 3) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

test("steady stream: one resync then a gapless chain at rate 1", () => {
  const r = run(50, (k) => 10 + k * D);
  expect(r.filter((x) => x.p.kind === "play" && x.p.resync).length).toBe(1);
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1].p, b = r[i].p;
    if (a.kind !== "play" || b.kind !== "play") throw new Error("drop");
    expect(b.when).toBeCloseTo(a.when + D / a.rate, 9);
    expect(b.rate).toBe(1);
  }
});

test("100 ppm drift + ±1 ms mapping jitter: locked within 1 ms, no resyncs", () => {
  const j = rng();
  const r = run(1200, (k) => 10 + k * D * (1 + 100e-6) + j() * 0.001);
  const plays = r.map((x) => x.p).filter((p) => p.kind === "play");
  expect(plays.filter((p) => p.resync).length).toBe(1);
  // After 10 s, chain error (excluding the ±1 ms jitter itself) stays small.
  for (const x of r.slice(100)) if (x.p.kind === "play") expect(Math.abs(x.p.err)).toBeLessThan(0.002);
  for (const p of plays) expect(Math.abs(p.rate - 1)).toBeLessThanOrEqual(0.002 + 1e-12);
});

test("10 ms anchor step is slewed away without resync", () => {
  const r = run(300, (k) => 10 + k * D + (k >= 50 ? 0.01 : 0));
  expect(r.filter((x) => x.p.kind === "play" && x.p.resync).length).toBe(1);
  const tail = r.slice(-50).map((x) => (x.p.kind === "play" ? Math.abs(x.p.err) : 1));
  expect(Math.max(...tail)).toBeLessThan(0.001);
});

test("missing chunk causes exactly one extra resync", () => {
  const r = run(30, (k) => 10 + k * D, { skip: new Set([10]) });
  expect(r.filter((x) => x.p.kind === "play" && x.p.resync).length).toBe(2);
});

test("late chunk is trimmed; fully past chunk is dropped", () => {
  const s = new Scheduler();
  const late = s.place(5.0, D, 5.05); // half past
  expect(late.kind === "play" && late.late && late.offset).toBeCloseTo(0.06, 9);
  const s2 = new Scheduler();
  expect(s2.place(5.0, D, 5.2).kind).toBe("drop");
  expect(s2.next).toBeNull();
});

test("never overlaps: each start is at or after the previous end", () => {
  const j = rng(9);
  const s = new Scheduler();
  let prevEnd = -Infinity;
  for (let k = 0; k < 500; k++) {
    const desired = 10 + k * D + j() * 0.02;
    const p = s.place(desired, D, desired - 0.2);
    if (p.kind !== "play") continue;
    expect(p.when).toBeGreaterThanOrEqual(prevEnd - 1e-9);
    prevEnd = p.when + (D - p.offset) / p.rate;
  }
});

test("regression: chain placed far in the future (bad early clock) recovers with a flush", () => {
  const s = new Scheduler();
  s.place(500, D, 10); // scheduled ~8 minutes ahead
  const p = s.place(10.5, D, 10.2); // correct time arrives
  expect(p.kind === "play" && p.flush && p.when).toBeCloseTo(10.5, 9);
  const q = s.place(10.6, D, 10.25);
  expect(q.kind === "play" && !q.resync && !q.flush).toBe(true);
});

test("restart reasons: start, jump, underrun, flush", () => {
  const s = new Scheduler();
  const why = (p: ReturnType<Scheduler["place"]>) => (p.kind === "play" ? p.why : "drop");
  expect(why(s.place(10, D, 9.5))).toBe("start");
  expect(why(s.place(10.1, D, 9.6))).toBeNull(); // chain
  expect(why(s.place(10.25, D, 9.7))).toBe("jump"); // target moved +50 ms
  expect(why(s.place(10.35, D, 10.4))).toBe("underrun"); // arrived after its slot began
  expect(why(s.place(5, D, 4))).toBe("flush"); // far behind the chain
});
