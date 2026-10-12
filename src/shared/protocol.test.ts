import { expect, test } from "bun:test";
import {
  CHUNK_HEADER, KIND_CHUNK, KIND_CTL, chunkHeader, ctlHeader, packPackets, parseBinary, parseClientMsg, parseCtl, unpackPackets,
} from "./protocol.ts";

const body = (n = 40) => new Uint8Array(n).fill(7);
const join = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

test("chunk header round trip", () => {
  const p = parseBinary(join(chunkHeader({ epoch: 3, seq: 4_000_000_000, t: 123456.789 }), body()));
  expect(p?.kind).toBe(KIND_CHUNK);
  if (p?.kind !== KIND_CHUNK) return;
  expect([p.epoch, p.seq, p.t]).toEqual([3, 4_000_000_000, 123456.789]);
  expect(p.header.length).toBe(CHUNK_HEADER);
  expect(p.body.length).toBe(40);
});

test("ctl header round trip", () => {
  const p = parseBinary(join(ctlHeader(42), body()));
  expect(p?.kind === KIND_CTL && p.to).toBe(42);
});

test("binary validation rejects junk", () => {
  const good = join(chunkHeader({ epoch: 1, seq: 1, t: 1 }), body());
  expect(parseBinary(good)).not.toBeNull();
  expect(parseBinary(Object.assign(good.slice(), { 0: 9 }))).toBeNull(); // version
  expect(parseBinary(Object.assign(good.slice(), { 1: 5 }))).toBeNull(); // kind
  expect(parseBinary(good.subarray(0, CHUNK_HEADER + 10))).toBeNull(); // shorter than iv+tag
  const nan = good.slice();
  new DataView(nan.buffer).setFloat64(10, NaN);
  expect(parseBinary(nan)).toBeNull();
  expect(parseBinary(new Uint8Array(70000).fill(1))).toBeNull();
});

test("packets pack/unpack and reject malformed", () => {
  const ps = [new Uint8Array([1, 2, 3]), new Uint8Array(300).fill(9), new Uint8Array([4])];
  const packed = packPackets(ps);
  expect(unpackPackets(packed)?.map((p) => Array.from(p))).toEqual(ps.map((p) => Array.from(p)));
  expect(unpackPackets(packed.subarray(0, packed.length - 1))).toBeNull();
  expect(unpackPackets(join(packed, new Uint8Array([0])))).toBeNull();
  expect(unpackPackets(new Uint8Array([0]))).toBeNull();
});

test("client message validation", () => {
  expect(parseClientMsg(JSON.stringify({ type: "hello", v: 1, room: "abc", role: "host", hostToken: "x" }))?.type).toBe("hello");
  expect(parseClientMsg(JSON.stringify({ type: "hello", v: 1, room: "abc", role: "admin" }))).toBeNull();
  expect(parseClientMsg("[1,2]")).toBeNull();
  expect(parseClientMsg("{bad json")).toBeNull();
  expect(parseClientMsg(JSON.stringify({ type: "ping", id: 1, t0: 5 }))).toEqual({ type: "ping", id: 1, t0: 5 });
  expect(parseClientMsg(JSON.stringify({ type: "ping", id: -1, t0: 5 }))).toBeNull();
  expect(parseClientMsg("x".repeat(5000))).toBeNull();
  const st = parseClientMsg(JSON.stringify({ type: "status", state: "playing", bufferMs: 1e12, errMs: "x", source: "evil", rate: 1 }));
  expect(st?.type === "status" && [st.bufferMs, st.errMs, st.source]).toEqual([1e7, 0, undefined]);
  expect(parseClientMsg(JSON.stringify({ type: "status", state: "hacking" }))).toBeNull();
});

test("ctl validation", () => {
  expect(parseCtl(JSON.stringify({ type: "cal-play", round: 1, at: 99.5 }))).toEqual({ type: "cal-play", round: 1, at: 99.5 });
  expect(parseCtl(JSON.stringify({ type: "cal-adjust", deltaMs: 5000 }))).toBeNull();
  expect(parseCtl(JSON.stringify({ type: "meta", epoch: 2, kind: "audius", title: "t".repeat(400) }))?.type).toBe("meta");
  expect(parseCtl(JSON.stringify({ type: "meta", epoch: 2, kind: "spotify" }))).toBeNull();
});

test("status breakdown fields are parsed, clamped and optional", () => {
  const base = { type: "status", state: "playing", rate: 1 };
  const st = parseClientMsg(JSON.stringify({ ...base, jumps: 3, bgDrops: 50, maxJumpMs: 1e12, hidden: true, under: "x" }));
  expect(st?.type === "status" && [st.jumps, st.bgDrops, st.maxJumpMs, st.hidden, st.under]).toEqual([3, 50, 1e7, true, undefined]);
  const old = parseClientMsg(JSON.stringify(base));
  expect(old?.type === "status" && old.jumps).toBeUndefined();
});

test("auto-sync messages: pn ctl and helper 'heard' lags are validated", () => {
  expect(parseCtl(JSON.stringify({ type: "pn", db: -30 }))).toEqual({ type: "pn", db: -30 });
  expect(parseCtl(JSON.stringify({ type: "pn", db: null }))).toEqual({ type: "pn", db: null });
  expect(parseCtl(JSON.stringify({ type: "pn", db: 0 }))).toBeNull(); // too loud is refused
  const st = parseClientMsg(JSON.stringify({ type: "status", state: "playing", heard: { "0": 12.5, "3": 1e9, evil: 1, "4": "x" } }));
  expect(st?.type === "status" && st.heard).toEqual({ "0": 12.5, "3": 2000 });
});

test("hello names, ping pairs and meta artwork are validated", () => {
  const hello = (name: unknown) => parseClientMsg(JSON.stringify({ type: "hello", v: 1, room: "abcdefghjk", role: "listener", name }));
  expect((hello("cheerful dolphin") as any).name).toBe("cheerful dolphin");
  expect((hello("<script>") as any).name).toBeUndefined();
  expect((hello("x".repeat(40)) as any).name).toBeUndefined();
  expect(parseClientMsg(JSON.stringify({ type: "ping", id: 1, t0: 2, pair: 7, idx: 1 }))).toEqual({ type: "ping", id: 1, t0: 2, pair: 7, idx: 1 });
  expect(parseClientMsg(JSON.stringify({ type: "ping", id: 1, t0: 2, pair: 7, idx: 5 }))).toEqual({ type: "ping", id: 1, t0: 2 });
  const meta = (art: string) => parseCtl(JSON.stringify({ type: "meta", epoch: 1, kind: "audius", art })) as any;
  expect(meta("https://cdn.example/a.jpg").art).toBe("https://cdn.example/a.jpg");
  expect(meta("javascript:alert(1)").art).toBeUndefined();
  expect(meta('https://x/"onerror=').art).toBeUndefined();
});

test("song requests (up frames) and queue snapshots are validated", async () => {
  const { KIND_UP, upHeader, parseUp } = await import("./protocol.ts");
  const frame = new Uint8Array(6 + 40); frame.set(upHeader(7));
  const p = parseBinary(frame);
  expect(p?.kind === KIND_UP && p.from).toBe(7);
  expect(parseUp(JSON.stringify({ type: "request", ref: "r1", audiusId: "JbKjZ", title: "Song" }))).toMatchObject({ audiusId: "JbKjZ" });
  expect(parseUp(JSON.stringify({ type: "request", ref: "r1", audiusId: "../x", title: "Song" }))).toBeNull();
  expect(parseUp(JSON.stringify({ type: "react", r: "fire" }))).toEqual({ type: "react", r: "fire" });
  expect(parseUp(JSON.stringify({ type: "react", r: "<img src=x>" }))).toBeNull(); // only the fixed set
  expect(parseUp(JSON.stringify({ type: "react", r: "toString" }))).toBeNull();
  const q = parseCtl(JSON.stringify({ type: "queue", mode: "ask", next: [{ title: "A", by: "brave fox", art: "javascript:x" }, { nope: 1 }] }));
  expect(q).toEqual({ type: "queue", mode: "ask", now: undefined, next: [{ title: "A", artist: undefined, art: undefined, by: "brave fox" }] });
  expect(parseCtl(JSON.stringify({ type: "request-result", ref: "r1", ok: false, reason: "Requests are off" }))?.type).toBe("request-result");
});
