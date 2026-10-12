// Single process: static PWA, room API, WebSocket relay (spec §5, ADR-0001).
import type { Server, ServerWebSocket } from "bun";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import index from "../client/index.html";
import { MAX_BINARY, parseClientMsg } from "../shared/protocol.ts";
import { appendRecord, readRecords, summarize } from "./metrics.ts";
import { Rooms, coarseUA, liveTotals, type Session } from "./rooms.ts";

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "microphone=(self), display-capture=(self)",
  "X-Frame-Options": "DENY",
};

/** Allowlist of files under public/ (no path traversal possible: only listed paths are served). */
function listPublic(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set("/" + relative(dir, p).split(sep).join("/"), p);
    }
  };
  try { walk(dir); } catch { /* no public dir */ }
  return out;
}

export type ServerOptions = { port?: number; publicDir?: string; metricsFile?: string; statsToken?: string; trustProxy?: boolean };

// Optional HTTPS for testing phones on a LAN (secure context needed for WebCrypto/AudioWorklet/mic).
const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: Bun.file(process.env.TLS_CERT), key: Bun.file(process.env.TLS_KEY) } : undefined;

export function startServer(opts: ServerOptions = {}) {
  const metricsFile = opts.metricsFile ?? process.env.METRICS_FILE ?? "data/metrics.jsonl";
  const statsToken = opts.statsToken ?? process.env.STATS_TOKEN;
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === "1";
  const files = listPublic(opts.publicDir ?? process.env.PUBLIC_DIR ?? join(process.cwd(), "public"));
  const rooms = new Rooms(() => performance.now(), (rec) => {
    try { appendRecord(metricsFile, rec); } catch (e) { console.error("metrics write failed", e); }
  });
  const sweeper = setInterval(() => rooms.sweep(), 5000);

  // ponytail: in-memory per-IP window for room creation; IPs never leave this map and expire each minute.
  const created = new Map<string, number>();
  const resetCreated = setInterval(() => created.clear(), 60_000);

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    hostname: process.env.HOST ?? "0.0.0.0",
    tls,
    development: process.env.NODE_ENV !== "production",
    routes: {
      "/": index,
      "/r/:id": index,
      "/healthz": new Response("ok"),
      "/api/rooms": {
        POST: (req: Request, srv: Server) => {
          const ip = (trustProxy && (req.headers.get("fly-client-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim())) || srv.requestIP(req)?.address || "?";
          const n = (created.get(ip) ?? 0) + 1;
          created.set(ip, n);
          if (n > 20) return Response.json({ error: "rate-limit" }, { status: 429, headers: SECURITY_HEADERS });
          const r = rooms.create();
          return r ? Response.json(r, { headers: SECURITY_HEADERS }) : Response.json({ error: "full" }, { status: 503, headers: SECURITY_HEADERS });
        },
      },
      "/api/live": {
        GET: () => Response.json(liveTotals(rooms), { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=5" } }),
      },
      "/api/stats": {
        GET: (req: Request) => {
          if (!statsToken || new URL(req.url).searchParams.get("token") !== statsToken) return new Response("not found", { status: 404 });
          return Response.json({ ...summarize(readRecords(metricsFile)), liveRooms: rooms.rooms.size }, { headers: SECURITY_HEADERS });
        },
      },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const { browser, mobile } = coarseUA(req.headers.get("user-agent") ?? "");
        const conn = { send: (_: string | Uint8Array) => {}, close: (_c: number, _r: string) => {} };
        const data = rooms.session(conn, browser, mobile);
        return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const file = files.get(url.pathname);
      if (file) {
        const headers: Record<string, string> = { ...SECURITY_HEADERS, "Cache-Control": url.pathname === "/sw.js" ? "no-cache" : url.pathname.startsWith("/fonts/") ? "public, max-age=604800" : "public, max-age=3600" };
        if (url.pathname.endsWith(".webmanifest")) headers["Content-Type"] = "application/manifest+json";
        return new Response(Bun.file(file), { headers });
      }
      return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
    },
    websocket: {
      maxPayloadLength: MAX_BINARY,
      backpressureLimit: 512 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 30,
      open(ws: ServerWebSocket<Session>) {
        ws.data.conn = { send: (d) => void ws.send(d), close: (c, r) => ws.close(c, r) };
        setTimeout(() => { if (!ws.data.room && ws.readyState === 1) ws.close(4000, "hello-timeout"); }, 5000);
      },
      message(ws: ServerWebSocket<Session>, msg: string | Buffer) {
        if (typeof msg === "string") rooms.text(ws.data, parseClientMsg(msg));
        else rooms.binary(ws.data, new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
      },
      close(ws: ServerWebSocket<Session>) {
        rooms.leave(ws.data);
      },
    },
  });

  return {
    server,
    rooms,
    stop() {
      clearInterval(sweeper);
      clearInterval(resetCreated);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const app = startServer();
  console.log(`unison listening on ${app.server.url}`);
  // Graceful shutdown (deploys, Ctrl+C): end every room — clients get "room-closed" instead of a dead socket,
  // and each room's anonymous metrics record is written — then stop.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    const n = app.rooms.rooms.size;
    for (const room of [...app.rooms.rooms.values()]) app.rooms.close(room);
    console.log(`${sig}: closed ${n} room(s), shutting down`);
    setTimeout(() => { app.stop(); process.exit(0); }, 300); // let close frames flush
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
