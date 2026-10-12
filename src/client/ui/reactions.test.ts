import { expect, test } from "bun:test";
import { reactionLimiter } from "./reactions.ts";

test("reaction limiter: per guest, a burst is capped and the window slides", () => {
  let t = 0;
  const ok = reactionLimiter(3, 1000, () => t);
  expect([ok(1), ok(1), ok(1), ok(1)]).toEqual([true, true, true, false]);
  expect(ok(2)).toBe(true); // other guests unaffected
  t = 1001;
  expect(ok(1)).toBe(true);
});
