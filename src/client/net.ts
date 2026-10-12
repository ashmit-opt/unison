// WebSocket connection with automatic reconnect and server-clock estimation (spec §5.8, §7.1).
import { ClockEstimator } from "../shared/clock.ts";
import { PROTOCOL_VERSION, parseServerMsg, type ErrorCode, type Role, type ServerMsg } from "../shared/protocol.ts";

const FATAL: ErrorCode[] = ["bad-version", "no-room", "bad-token", "room-full", "replaced", "room-closed", "locked", "removed"];

export class Connection {
  readonly clock = new ClockEstimator();
  peer: number | undefined;
  private resume: string | undefined; // reclaims our peer id after a reconnect
  connected = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onBinary: (b: Uint8Array) => void = () => {};
  onState: (connected: boolean) => void = () => {};
  onFatal: (code: ErrorCode) => void = () => {};
  private ws: WebSocket | null = null;
  private pingId = 0;
  private pings = 0;
  private pairId = 0;
  private pairs = new Map<number, { t0: number; t1: number; ts: number }>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;

  constructor(private room: string, private role: Role, private hostToken?: string, public name?: string) {}

  /** Start the clock estimate over (Sync Doctor "Re-sync"): fast probe pairs again, ready in ~0.5 s. */
  resyncClock() {
    this.clock.reset();
    clearTimeout(this.timer);
    if (this.connected) this.startPings();
  }

  /** Change the display name: names travel in hello, so reconnect (same peer id) with the new one. */
  rename(name: string) { this.name = name; this.drop(); }

  /** Current server time (ms) in this device's view. */
  serverNow() { return performance.now() + this.clock.offset; }

  connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, room: this.room, role: this.role, hostToken: this.hostToken, peer: this.peer, resume: this.resume, name: this.name }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return this.onBinary(new Uint8Array(e.data as ArrayBuffer));
      const m = parseServerMsg(e.data);
      if (!m) return;
      if (m.type === "pong") return this.onPong(m.t0, performance.now(), m.ts, m.pair, m.idx);
      if (m.type === "welcome") {
        this.peer = m.peer;
        this.resume = m.resume;
        this.connected = true;
        this.retry = 0;
        this.startPings();
        this.onState(true);
      }
      if (m.type === "error" && FATAL.includes(m.code)) {
        this.ended = true;
        this.onFatal(m.code);
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      clearTimeout(this.timer);
      if (was) this.onState(false);
      if (!this.ended) setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  private onPong(t0: number, t1: number, ts: number, pair?: number, idx?: number) {
    if (pair === undefined) return this.clock.add(t0, t1, ts);
    const first = this.pairs.get(pair);
    if (idx === 0) { this.pairs.set(pair, { t0, t1, ts }); return; }
    this.pairs.delete(pair);
    if (first) this.clock.addPair(first, { t0, t1, ts });
  }

  /** Probe pairs (25 ms apart) every 100 ms at first, then every second (spec §7.1). */
  private startPings() {
    this.pings = 0;
    const tick = () => {
      if (!this.connected) return;
      const pair = ++this.pairId;
      if (this.pairs.size > 20) this.pairs.clear(); // lost replies
      this.send({ type: "ping", id: ++this.pingId, t0: performance.now(), pair, idx: 0 });
      setTimeout(() => this.send({ type: "ping", id: ++this.pingId, t0: performance.now(), pair, idx: 1 }), 25);
      this.timer = setTimeout(tick, this.pings++ < 10 ? 100 : 1000);
    };
    tick();
  }

  send(m: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  sendBinary(b: Uint8Array) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(b as Uint8Array<ArrayBuffer>); }
  /** Simulates a network drop (tests / debugging); the client reconnects by itself. */
  drop() { this.ws?.close(); }
  close() { this.ended = true; this.ws?.close(); }
}
