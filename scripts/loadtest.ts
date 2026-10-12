// Relay capacity check (spec §5.10). The real server runs in this process; simulated hosts and listeners run in a
// child process, so the CPU/memory numbers are the server's own. Hosts send chunk-sized frames (128 kbps Opus,
// 100 ms chunks, sealed overhead) at 10/s; listeners ping and report status like real clients.
//   bun scripts/loadtest.ts [rooms=50] [listenersPerRoom=4] [seconds=30]
// Indicative only: loopback networking, and your machine is not the deployment VM.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkHeader, PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { startServer } from "../src/server/server.ts";

const CHUNK_BYTES = 1600 + 5 * 2 + 1 + 12 + 16; // 100 ms of 128 kbps Opus + packet lengths + IV + GCM tag (header added below)

if (process.argv[2] === "--clients") {
  const [, , , url, roomsJson, perRoomS, secondsS, serverOriginS] = process.argv;
  const serverNow = () => performance.timeOrigin + performance.now() - Number(serverOriginS); // chunk times are server time
  const rooms = JSON.parse(roomsJson) as { room: string; hostToken: string }[];
  const perRoom = Number(perRoomS), seconds = Number(secondsS);
  let bytes = 0, closed = 0, sent = 0;
  const ws = (onOpen: (w: WebSocket) => void, count = false) => {
    const w = new WebSocket(url.replace(/^http/, "ws") + "ws");
    w.binaryType = "arraybuffer";
    w.onopen = () => onOpen(w);
    w.onmessage = (e) => { if (count) bytes += typeof e.data === "string" ? e.data.length : (e.data as ArrayBuffer).byteLength; };
    w.onclose = () => closed++;
    return w;
  };
  const status = JSON.stringify({ type: "status", state: "playing", bufferMs: 800, errMs: 0.2, rate: 1, late: 0, drops: 0, resyncs: 1, authFail: 0, rttMs: 4, uncMs: 1, outLatMs: 40, offsetMs: 0, calibrated: true, map: "ots", starts: 1, jumps: 0, under: 0, flushes: 0, bgDrops: 0, maxJumpMs: 0, hidden: false });
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const { room, hostToken } of rooms) {
    ws((w) => {
      w.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, room, role: "host", hostToken }));
      let seq = 0;
      const body = crypto.getRandomValues(new Uint8Array(CHUNK_BYTES));
      timers.push(setInterval(() => {
        const h = chunkHeader({ epoch: 1, seq: seq++, t: serverNow() + 800 }), f = new Uint8Array(h.length + body.length);
        f.set(h); f.set(body, h.length);
        w.send(f);
        sent++;
      }, 100));
      timers.push(setInterval(() => w.send(status), 2000));
    });
    for (let i = 0; i < perRoom; i++) ws((w) => {
      w.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, room, role: "listener" }));
      let id = 0;
      timers.push(setInterval(() => { for (const idx of [0, 1]) w.send(JSON.stringify({ type: "ping", id: ++id, t0: performance.now(), pair: id, idx })); }, 1000));
      timers.push(setInterval(() => w.send(status), 2000));
    }, true);
  }
  await Bun.sleep(5000); // connect + warm up
  const b0 = bytes, s0 = sent;
  process.stdout.write("measuring\n");
  await Bun.sleep(seconds * 1000);
  const listeners = rooms.length * perRoom;
  console.log(JSON.stringify({ kbpsPerListener: ((bytes - b0) * 8) / 1000 / seconds / listeners, chunksPerSecPerHost: (sent - s0) / seconds / rooms.length, closed }));
  timers.forEach(clearInterval);
  process.exit(0);
}

const [roomsN = 50, perRoom = 4, seconds = 30] = process.argv.slice(2).map(Number);
const app = startServer({ port: 0, metricsFile: join(tmpdir(), "unison-loadtest-metrics.jsonl") });
const rooms = Array.from({ length: roomsN }, () => app.rooms.create()!);
const rss0 = process.memoryUsage().rss;
const child = Bun.spawn(["bun", import.meta.path, "--clients", String(app.server.url), JSON.stringify(rooms), String(perRoom), String(seconds), String(performance.timeOrigin)], { stdout: "pipe", stderr: "inherit" });
const reader = child.stdout.getReader();
let out = "", cpu0 = process.cpuUsage(), t0 = performance.now(), rssPeak = 0, measuring = false;
const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 500);
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  out += new TextDecoder().decode(value);
  if (!measuring && out.includes("measuring\n")) { measuring = true; cpu0 = process.cpuUsage(); t0 = performance.now(); rssPeak = 0; }
}
clearInterval(sampler);
const cpu = process.cpuUsage(cpu0), wall = performance.now() - t0;
const res = JSON.parse(out.trim().split("\n").at(-1)!);
const buffered = [...app.rooms.rooms.values()].reduce((n, r) => n + r.buffer.reduce((m, c) => m + c.data.length, 0), 0);
console.log(JSON.stringify({
  rooms: roomsN, listeners: roomsN * perRoom, seconds,
  serverCpuPctOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10,
  rssMB: { idle: Math.round(rss0 / 1e6), peak: Math.round(rssPeak / 1e6) },
  bufferedMB: Math.round(buffered / 1e5) / 10,
  hostChunksPerSec: Math.round(res.chunksPerSecPerHost * 10) / 10, // < 10 when the client process can't keep up (Windows timers)
  kbpsPerListener: Math.round(res.kbpsPerListener * 10) / 10,
  kbpsPerListenerAt10ChunksPerSec: Math.round((res.kbpsPerListener * 10) / res.chunksPerSecPerHost * 10) / 10,
  egressMbps: Math.round((res.kbpsPerListener * roomsN * perRoom) / 100) / 10,
  socketsClosed: res.closed,
}, null, 1));
app.stop();
process.exit(0);
