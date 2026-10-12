// Real server, real WebSockets, real AES-GCM: host → server → listener, late join, reconnect, errors.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { importRoomKey, newRoomKey, open, seal } from "../src/shared/crypto.ts";
import { chunkHeader, packPackets, parseBinary, PROTOCOL_VERSION, type ServerMsg } from "../src/shared/protocol.ts";
import { startServer } from "../src/server/server.ts";

const metricsFile = `${import.meta.dir}/../data/test-metrics-${process.pid}.jsonl`;
let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  srv = startServer({ port: 0, metricsFile, statsToken: "t0ken" });
  base = `http://localhost:${srv.server.port}`;
});
afterAll(() => { srv.stop(); rmSync(metricsFile, { force: true }); });

type Client = { ws: WebSocket; text: ServerMsg[]; bin: Uint8Array[]; wait: (pred: () => boolean) => Promise<void> };
function client(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    ws.binaryType = "arraybuffer";
    const c: Client = {
      ws, text: [], bin: [],
      wait: async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(10); if (!pred()) throw new Error("timeout"); },
    };
    ws.onmessage = (e) => (typeof e.data === "string" ? c.text.push(JSON.parse(e.data)) : c.bin.push(new Uint8Array(e.data)));
    ws.onopen = () => resolve(c);
    ws.onerror = reject;
  });
}
const hello = (c: Client, room: string, role: string, extra = {}) => c.ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, room, role, ...extra }));
const has = (c: Client, type: string) => () => c.text.some((m) => m.type === type);

async function setup() {
  const { room, hostToken } = await (await fetch(`${base}/api/rooms`, { method: "POST" })).json();
  const host = await client();
  hello(host, room, "host", { hostToken });
  await host.wait(has(host, "welcome"));
  return { room, hostToken, host };
}

test("encrypted chunk relays byte-identical; listener decrypts; server holds no plaintext", async () => {
  const { room, host } = await setup();
  const key = await importRoomKey(newRoomKey());
  const listener = await client();
  hello(listener, room, "listener");
  await listener.wait(has(listener, "welcome"));
  const secret = new TextEncoder().encode("SECRET-AUDIO-PAYLOAD");
  const msg = await seal(key, room, chunkHeader({ epoch: 1, seq: 0, t: performance.now() + 60_000 }), packPackets([secret]));
  host.ws.send(msg);
  await listener.wait(() => listener.bin.length === 1);
  expect(listener.bin[0]).toEqual(msg);
  const p = parseBinary(listener.bin[0])!;
  expect(await open(key, room, p.header, p.body)).toEqual(packPackets([secret]));
  const buffered = srv.rooms.rooms.get(room)!.buffer;
  expect(buffered.length).toBe(1);
  expect(Buffer.from(buffered[0].data).includes(Buffer.from("SECRET"))).toBe(false);
});

test("late join replays future chunks; reconnect resumes with the same peer id", async () => {
  const { room, host } = await setup();
  const key = await importRoomKey(newRoomKey());
  // Server time is the server process's performance.now(); a far-future t is always "future".
  for (let seq = 0; seq < 3; seq++) host.ws.send(await seal(key, room, chunkHeader({ epoch: 1, seq, t: 1e12 + seq * 100 }), packPackets([new Uint8Array([seq])])));
  const late = await client();
  hello(late, room, "listener");
  await late.wait(() => late.bin.length === 3);
  const { peer, resume } = late.text.find((m) => m.type === "welcome") as { peer: number; resume: string };
  late.ws.close();
  await Bun.sleep(50);
  const imposter = await client();
  hello(imposter, room, "listener", { peer }); // no resume token → a new id, not someone else's
  await imposter.wait(() => imposter.text.some((m) => m.type === "welcome"));
  expect((imposter.text.find((m) => m.type === "welcome") as { peer: number }).peer).not.toBe(peer);
  const again = await client();
  hello(again, room, "listener", { peer, resume });
  await again.wait(() => again.bin.length === 3);
  expect((again.text.find((m) => m.type === "welcome") as { peer: number }).peer).toBe(peer);
});

test("version mismatch and unknown room are explicit errors", async () => {
  const c = await client();
  c.ws.send(JSON.stringify({ type: "hello", v: 99, room: "abcdefghjk", role: "listener" }));
  await c.wait(has(c, "error"));
  expect(c.text[0]).toEqual({ type: "error", code: "bad-version", v: PROTOCOL_VERSION });
  const d = await client();
  hello(d, "abcdefghjk", "listener");
  await d.wait(has(d, "error"));
  expect(d.text[0]).toMatchObject({ code: "no-room" });
});

test("listener cannot inject binary; stats endpoint is token-protected", async () => {
  const { room } = await setup();
  const l = await client(), other = await client();
  hello(l, room, "listener");
  hello(other, room, "listener");
  await other.wait(has(other, "welcome"));
  l.ws.send(new Uint8Array(64));
  await Bun.sleep(100);
  expect(other.bin.length).toBe(0);
  expect((await fetch(`${base}/api/stats`)).status).toBe(404);
  const stats = await (await fetch(`${base}/api/stats?token=t0ken`)).json();
  expect(stats.liveRooms).toBeGreaterThan(0);
});

test("static files: allowlisted, security headers, no traversal", async () => {
  const sw = await fetch(`${base}/sw.js`);
  expect(sw.status).toBe(200);
  expect(sw.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await fetch(`${base}/manifest.webmanifest`)).headers.get("content-type")).toContain("manifest+json");
  const font = await fetch(`${base}/fonts/inter-latin-wght.woff2`);
  expect([font.status, font.headers.get("content-type"), font.headers.get("cache-control")]).toEqual([200, "font/woff2", "public, max-age=604800"]);
  expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
});
