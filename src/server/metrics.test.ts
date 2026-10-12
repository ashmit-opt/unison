import { expect, test } from "bun:test";
import { summarize } from "./metrics.ts";
import type { RoomRecord } from "./rooms.ts";

const rec = (o: Partial<RoomRecord>): RoomRecord => ({
  v: 1, day: "2026-10-12", durationS: 600, peakPeers: 1, joins: 0, reconnects: 0, played: false, playedS: 0, sources: [], browsers: {},
  mobile: 0, desktop: 1, late: 0, drops: 0, resyncs: 0, authFail: 0, calibrated: false, spreadMs: null, ...o,
});

test("summary: funnel, reconnects (old records without the field count 0), failure signals", () => {
  const { reconnects: _, ...old } = rec({ peakPeers: 2, joins: 1 });
  const s = summarize([
    rec({}), // created, nobody came
    old as RoomRecord, // joined, never played
    rec({ peakPeers: 3, joins: 2, reconnects: 4, played: true, playedS: 30, late: 2, drops: 1, sources: ["file"] }), // played briefly
    rec({ peakPeers: 2, joins: 1, reconnects: 1, played: true, playedS: 900, resyncs: 3, authFail: 1, calibrated: true, spreadMs: 6, sources: ["audius"] }),
  ]);
  expect(s.funnel).toEqual({ created: 4, joined: 3, played: 2, real: 1 });
  expect([s.reconnects, s.deviceJoins, s.authFailRooms]).toEqual([5, 4, 1]);
  expect(s.glitches).toEqual({ late: 2, drops: 1, resyncs: 3 });
  expect(s.medianSpreadMs).toBe(6);
});
