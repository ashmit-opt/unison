import { expect, test } from "bun:test";
import { solveOffsets, type Heard } from "./solve.ts";

const heard = (o: Record<string, Record<string, number>>): Heard => new Map(Object.entries(o).map(([m, v]) => [m, new Map(Object.entries(v))]));
const rel = (e: Map<string, number>, a: string, b: string) => e.get(a)! - e.get(b)!;

test("one microphone: relative emission errors = lag differences (aligned at the mic)", () => {
  const { e, groups } = solveOffsets(heard({ host: { host: 5, p1: 25, p2: 15 } }));
  expect(rel(e, "p1", "host")).toBeCloseTo(20, 3);
  expect(rel(e, "p2", "host")).toBeCloseTo(10, 3);
  expect(groups.length).toBe(1);
});

test("two mic devices far apart: travel time cancels (two-way ranging)", () => {
  // True errors: A = 0, B = +30 ms. Distance A↔B = 20 ms (~7 m). Mic latencies: A 4 ms, B 9 ms.
  const eA = 0, eB = 30, d = 20, bA = 4, bB = 9;
  const { e } = solveOffsets(heard({
    A: { A: eA + bA, B: eB + bA + d },
    B: { B: eB + bB, A: eA + bB + d },
  }));
  expect(rel(e, "B", "A")).toBeCloseTo(30, 4);
});

test("chain: C is only heard by B's mic, still placed relative to A through B", () => {
  const eA = 0, eB = 12, eC = -7, dAB = 15, bA = 3, bB = 6;
  const { e, groups } = solveOffsets(heard({
    A: { A: eA + bA, B: eB + bA + dAB },
    B: { B: eB + bB, A: eA + bB + dAB, C: eC + bB + 2 },
  }));
  expect(groups.length).toBe(1);
  expect(rel(e, "B", "A")).toBeCloseTo(12, 3);
  expect(rel(e, "C", "B")).toBeCloseTo(eC + 2 - eB, 3); // one-way: C's 2 ms path to B's mic stays in (aligned at B)
});

test("disconnected groups are reported separately", () => {
  const { groups } = solveOffsets(heard({ A: { A: 1, B: 2 }, C: { C: 1, D: 5 } }));
  expect(groups.length).toBe(2);
});
