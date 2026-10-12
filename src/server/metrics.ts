// Anonymous aggregate metrics (spec §9.6, ADR-0006): one JSON line per finished room.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RoomRecord } from "./rooms.ts";

export function appendRecord(file: string, rec: RoomRecord) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n");
}

export function readRecords(file: string): RoomRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as RoomRecord]; } catch { return []; }
  });
}

/** "Real session" = at least 2 devices and at least 60 s of audio relayed. */
export function summarize(recs: RoomRecord[]) {
  const real = recs.filter((r) => r.peakPeers >= 2 && r.playedS >= 60);
  const spreads = recs.map((r) => r.spreadMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const count = (key: "sources") => recs.flatMap((r) => r[key]).reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  return {
    rooms: recs.length,
    realSessions: real.length,
    // Funnel: created → a second device joined → audio played → real session.
    funnel: { created: recs.length, joined: recs.filter((r) => r.peakPeers >= 2).length, played: recs.filter((r) => r.played).length, real: real.length },
    deviceJoins: recs.reduce((n, r) => n + r.joins, 0),
    reconnects: recs.reduce((n, r) => n + (r.reconnects ?? 0), 0), // older records predate the field
    // Failure signals (summed device counters): late chunks, drops, playback resyncs; rooms where decryption failed.
    glitches: { late: recs.reduce((n, r) => n + r.late, 0), drops: recs.reduce((n, r) => n + r.drops, 0), resyncs: recs.reduce((n, r) => n + r.resyncs, 0) },
    authFailRooms: recs.filter((r) => r.authFail > 0).length,
    calibratedRooms: recs.filter((r) => r.calibrated).length,
    medianSpreadMs: spreads.length ? spreads[spreads.length >> 1] : null,
    sources: count("sources"),
    firstDay: recs[0]?.day ?? null,
    lastDay: recs.at(-1)?.day ?? null,
  };
}
