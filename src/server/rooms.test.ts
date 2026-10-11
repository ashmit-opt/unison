import { expect, test } from "bun:test";
import { CHUNK_HEADER, chunkHeader, ctlHeader, parseServerMsg, type ClientMsg, type ServerMsg } from "../shared/protocol.ts";
import { LIMITS, Rooms, coarseUA, type RoomRecord, type Session } from "./rooms.ts";

let clock = 0;
const records: RoomRecord[] = [];
const rooms = () => new Rooms(() => clock, (r) => records.push(r));

class FakeConn {
  text: ServerMsg[] = [];
  bin: Uint8Array[] = [];
  closed: string | null = null;
  send(d: string | Uint8Array) { typeof d === "string" ? this.text.push(parseServerMsg(d)!) : this.bin.push(d); }
  close(_c: number, r: string) { this.closed = r; }
  last(type: string) { return this.text.filter((m) => m.type === type).at(-1) as any; }
}

function connect(R: Rooms, room: string, role: "host" | "listener", extra: Partial<ClientMsg & { hostToken: string; peer: number; v: number }> = {}) {
  const c = new FakeConn(), s = R.session(c, "safari", true);
  R.text(s, { type: "hello", v: 1, room, role, ...extra } as ClientMsg);
  return { c, s };
}
const chunk = (epoch: number, seq: number, t: number) => {
  const h = chunkHeader({ epoch, seq, t }), out = new Uint8Array(CHUNK_HEADER + 40);
  out.set(h);
  return out;
};

test("create → host + listener join; peers broadcast; no account needed", () => {
  const R = rooms(), { room, hostToken } = R.create()!;
  expect(room).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/);
  const h = connect(R, room, "host", { hostToken });
  expect(h.c.last("welcome")).toMatchObject({ role: "host", peer: 0, epoch: 0 });
  const l = connect(R, room, "listener");
  expect(l.c.last("welcome")).toMatchObject({ role: "listener", peer: 1, hostOnline: true });
  expect(h.c.last("peers").peers.map((p: any) => p.peer)).toEqual([0, 1]);
});

test("rejections: version, room, token, full", () => {
  const R = new Rooms(() => clock, () => {}, { ...LIMITS, maxPeers: 1 }), { room, hostToken } = R.create()!;
  expect(connect(R, room, "listener", { v: 2 }).c.last("error")).toMatchObject({ code: "bad-version", v: 1 });
  expect(connect(R, "zzzzzzzzzz", "listener").c.closed).toBe("no-room");
  expect(connect(R, room, "host", { hostToken: hostToken + "x" }).c.closed).toBe("bad-token");
  connect(R, room, "listener");
  expect(connect(R, room, "listener").c.closed).toBe("room-full");
});

test("only the host may send binary; chunks relay verbatim and are buffered", () => {
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken }), l = connect(R, room, "listener");
  const msg = chunk(1, 0, clock + 800);
  R.binary(l.s, msg);
  expect(h.c.bin.length + l.c.bin.length).toBe(0);
  R.binary(h.s, msg);
  expect(l.c.bin[0]).toEqual(msg);
  expect(R.rooms.get(room)!.buffer.length).toBe(1);
});

test("seq must increase; new epoch resets buffer; old epoch rejected", () => {
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken }), l = connect(R, room, "listener");
  R.binary(h.s, chunk(1, 5, clock + 800));
  R.binary(h.s, chunk(1, 5, clock + 900)); // duplicate seq
  R.binary(h.s, chunk(1, 4, clock + 900)); // older seq
  expect(l.c.bin.length).toBe(1);
  R.binary(h.s, chunk(2, 0, clock + 900));
  expect(R.rooms.get(room)!.buffer.map((b) => b.seq)).toEqual([0]);
  R.binary(h.s, chunk(1, 9, clock + 900));
  expect(l.c.bin.length).toBe(2);
  expect(h.s.bad).toBe(3);
});

test("late joiner receives only future buffered chunks; buffer is pruned and capped", () => {
  clock = 10_000;
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken });
  R.binary(h.s, chunk(1, 0, 8_900)); // t in the past (pruned: older than bufferMs)
  R.binary(h.s, chunk(1, 1, 9_850)); // in the past: kept in the buffer, but too old to replay
  R.binary(h.s, chunk(1, 2, 10_500)); // future
  expect(R.rooms.get(room)!.buffer.map((b) => b.seq)).toEqual([1, 2]);
  const l = connect(R, room, "listener");
  expect(l.c.bin.length).toBe(1);
  for (let i = 3; i < 300; i++) R.binary(h.s, chunk(1, i, 10_500 + i));
  expect(R.rooms.get(room)!.buffer.length).toBe(LIMITS.bufferMax);
});

test("stop clears buffer and notifies listeners; ctl routes to one peer or all", () => {
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken }), a = connect(R, room, "listener"), b = connect(R, room, "listener");
  R.binary(h.s, chunk(1, 0, clock + 800));
  R.text(h.s, { type: "stop", epoch: 1 });
  expect(R.rooms.get(room)!.buffer.length).toBe(0);
  expect(a.c.last("stop")).toMatchObject({ epoch: 1 });
  const ctl = (to: number) => { const o = new Uint8Array(6 + 40); o.set(ctlHeader(to)); return o; };
  R.binary(h.s, ctl(b.s.peer));
  expect([a.c.bin.length, b.c.bin.length]).toEqual([1, 2]);
  R.binary(h.s, ctl(0));
  expect([a.c.bin.length, b.c.bin.length]).toEqual([2, 3]);
});

test("reconnecting listener keeps its peer id; host reload replaces the old host socket", () => {
  const R = rooms(), { room, hostToken } = R.create()!;
  const h1 = connect(R, room, "host", { hostToken });
  const l1 = connect(R, room, "listener");
  R.leave(l1.s);
  const l2 = connect(R, room, "listener", { peer: l1.s.peer });
  expect(l2.s.peer).toBe(l1.s.peer);
  const h2 = connect(R, room, "host", { hostToken });
  expect(h1.c.closed).toBe("replaced");
  expect(R.rooms.get(room)!.host).toBe(h2.s);
});

test("status is forwarded to the host and pings answered with server time", () => {
  clock = 1234.5;
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken }), l = connect(R, room, "listener");
  R.text(l.s, { type: "ping", id: 7, t0: 1 });
  expect(l.c.last("pong")).toEqual({ type: "pong", id: 7, t0: 1, ts: 1234.5 });
  R.text(l.s, { type: "status", state: "playing", bufferMs: 1, errMs: 0, rate: 1, late: 2, drops: 1, resyncs: 1, authFail: 0, rttMs: 3, uncMs: 1, outLatMs: 0, offsetMs: 0, calibrated: true, map: "ots" });
  expect(h.c.last("peer-status")).toMatchObject({ peer: 1, status: { late: 2 } });
});

test("junk and floods close the socket", () => {
  const R = rooms(), { room } = R.create()!;
  const l = connect(R, room, "listener");
  for (let i = 0; i < 60; i++) R.text(l.s, null);
  expect(l.c.closed).toBe("bad-message");
  const R2 = rooms(), r2 = R2.create()!;
  const f = connect(R2, r2.room, "listener");
  for (let i = 0; i < 250; i++) R2.text(f.s, { type: "ping", id: i, t0: 0 });
  expect(f.c.closed).toBe("rate-limit");
});

test("lifecycle: empty room, absent host, max lifetime; one anonymous record each", () => {
  records.length = 0;
  clock = 0;
  const R = rooms();
  const a = R.create()!; // never joined → empty after 60 s
  clock = 61_000;
  R.sweep();
  expect(R.rooms.has(a.room)).toBe(false);

  const b = R.create()!;
  const h = connect(R, b.room, "host", { hostToken: b.hostToken });
  const l = connect(R, b.room, "listener");
  R.text(h.s, { type: "status", state: "playing", bufferMs: 0, errMs: 0, rate: 1, late: 0, drops: 0, resyncs: 0, authFail: 0, rttMs: 0, uncMs: 0, outLatMs: 0, offsetMs: 0, calibrated: false, map: "ots", source: "audius", spreadMs: 4.2 });
  R.binary(h.s, chunk(1, 0, clock + 800));
  R.leave(h.s); // host gone; listener stays
  clock += LIMITS.hostGraceMs + 1;
  R.sweep();
  expect(R.rooms.has(b.room)).toBe(false);
  expect(l.c.closed).toBe("room-closed");

  const c = R.create()!;
  connect(R, c.room, "host", { hostToken: c.hostToken });
  clock += LIMITS.lifetimeMs + 1;
  R.sweep();
  expect(R.rooms.has(c.room)).toBe(false);

  expect(records.length).toBe(3);
  const rec = records[1];
  expect(rec).toMatchObject({ v: 1, peakPeers: 2, joins: 1, played: true, sources: ["audius"], spreadMs: 4.2, mobile: 1, browsers: { safari: 1 } });
  const text = JSON.stringify(rec);
  expect(text.includes(b.room)).toBe(false);
  expect(text.includes(b.hostToken)).toBe(false);
  expect(Object.keys(rec).sort()).toEqual(["browsers", "calibrated", "day", "desktop", "drops", "durationS", "joins", "late", "mobile", "peakPeers", "playedS", "played", "resyncs", "sources", "spreadMs", "authFail", "v"].sort());
});

test("coarse user agent", () => {
  expect(coarseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toEqual({ browser: "safari", mobile: true });
  expect(coarseUA("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/152.0 Safari/537.36 Edg/152.0")).toEqual({ browser: "edge", mobile: false });
});

// Session typing is exercised above; keep the import used for type-checking.
export type _S = Session;

test("pong echoes probe-pair ids; names reach the peer list; live totals count members only", async () => {
  const { liveTotals } = await import("./rooms.ts");
  const R = rooms(), { room, hostToken } = R.create()!;
  R.create(); // an empty room doesn't count
  const h = connect(R, room, "host", { hostToken, name: "Host laptop" } as any);
  const l = connect(R, room, "listener", { name: "cheerful dolphin" } as any);
  R.text(l.s, { type: "ping", id: 1, t0: 5, pair: 3, idx: 1 });
  expect(l.c.last("pong")).toMatchObject({ pair: 3, idx: 1 });
  expect(h.c.last("peers").peers.map((p: any) => p.name)).toEqual(["Host laptop", "cheerful dolphin"]);
  expect(liveTotals(R)).toEqual({ listeners: 2, rooms: 1 });
});

test("listeners can only send song requests, stamped with their own id, and only the host receives them", async () => {
  const { upHeader } = await import("../shared/protocol.ts");
  const R = rooms(), { room, hostToken } = R.create()!;
  const h = connect(R, room, "host", { hostToken }), a = connect(R, room, "listener"), b = connect(R, room, "listener");
  const up = (from: number) => { const o = new Uint8Array(6 + 40); o.set(upHeader(from)); return o; };
  R.binary(a.s, up(a.s.peer));
  expect([h.c.bin.length, b.c.bin.length]).toEqual([1, 0]);
  R.binary(a.s, up(b.s.peer)); // impersonating another listener
  R.binary(a.s, chunk(1, 0, 1)); // listeners can't send audio
  expect([h.c.bin.length, b.c.bin.length, a.s.bad]).toEqual([1, 0, 2]);
  R.binary(h.s, up(0)); // and the host can't send up frames
  expect(h.s.bad).toBe(1);
});
