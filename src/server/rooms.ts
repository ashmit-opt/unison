// Room state and relay logic (spec §5.2, §6). Socket-agnostic and clock-injected for tests.
// The server only ever handles ciphertext: binary payloads are forwarded/buffered verbatim.
import { timingSafeEqual } from "node:crypto";
import { b64urlEncode } from "../shared/crypto.ts";
import {
  KIND_CHUNK, KIND_UP, PROTOCOL_VERSION, ROOM_RE, parseBinary,
  type ClientMsg, type ErrorCode, type Hello, type PeerInfo, type Role, type ServerMsg, type SourceKind, type Status,
} from "../shared/protocol.ts";

export const LIMITS = {
  maxPeers: 32,
  maxRooms: 2000,
  bufferMs: 1000, // keep chunks whose target time is at most this far in the past
  bufferMax: 100,
  replayPastMs: 100, // on join, replay chunks with t > now − this
  hostGraceMs: 10 * 60_000,
  emptyMs: 60_000,
  lifetimeMs: 12 * 3600_000,
  maxBad: 50,
  maxMsgsPerSec: 200,
};

export interface Conn {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

export type Session = {
  conn: Conn;
  browser: string;
  mobile: boolean;
  name?: string;
  room: Room | null;
  role: Role | null;
  peer: number;
  bad: number;
  win: number; // rate-limit window start
  msgs: number;
  status?: Status;
};

export type RoomRecord = {
  v: 1; day: string; durationS: number; peakPeers: number; joins: number; reconnects: number; played: boolean; playedS: number;
  sources: SourceKind[]; browsers: Record<string, number>; mobile: number; desktop: number;
  late: number; drops: number; resyncs: number; authFail: number; calibrated: boolean; spreadMs: number | null;
};

type Buffered = { seq: number; t: number; data: Uint8Array };

export class Room {
  host: Session | null = null;
  listeners = new Map<number, Session>();
  nextPeer = 1;
  locked = false;
  resume = new Map<number, string>(); // listener peer id → token that reclaims it after a reconnect
  epoch = 0;
  lastSeq = -1;
  buffer: Buffered[] = [];
  hostGoneAt: number | null;
  emptyAt: number | null;
  stats = {
    joins: 0, reconnects: 0, peakPeers: 0, chunks: 0, late: 0, drops: 0, resyncs: 0, authFail: 0, calibrated: false,
    spreadMs: null as number | null, sources: new Set<SourceKind>(), browsers: {} as Record<string, number>, mobile: 0, desktop: 0,
  };
  constructor(readonly id: string, readonly hostToken: string, readonly createdAt: number) {
    this.hostGoneAt = createdAt;
    this.emptyAt = createdAt;
  }
  get members() { return this.listeners.size + (this.host ? 1 : 0); }
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newRoomId(): string {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, (b) => ALPHABET[b & 31]).join("");
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const json = (m: ServerMsg) => JSON.stringify(m);

export class Rooms {
  rooms = new Map<string, Room>();

  constructor(
    private now: () => number,
    private onClosed: (r: RoomRecord) => void = () => {},
    private limits = LIMITS,
  ) {}

  create(): { room: string; hostToken: string } | null {
    if (this.rooms.size >= this.limits.maxRooms) return null;
    let id = newRoomId();
    while (this.rooms.has(id)) id = newRoomId();
    const hostToken = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    this.rooms.set(id, new Room(id, hostToken, this.now()));
    return { room: id, hostToken };
  }

  session(conn: Conn, browser = "other", mobile = false): Session {
    return { conn, browser, mobile, room: null, role: null, peer: -1, bad: 0, win: 0, msgs: 0 };
  }

  private fail(s: Session, code: ErrorCode, extra: Partial<{ v: number }> = {}) {
    s.conn.send(json({ type: "error", code, ...extra }));
    s.conn.close(4000, code);
  }

  /** Message rate limit and junk counter. Returns false if the message must be ignored. */
  private allow(s: Session): boolean {
    const t = this.now();
    if (t - s.win > 1000) { s.win = t; s.msgs = 0; }
    if (++s.msgs > this.limits.maxMsgsPerSec) { this.fail(s, "rate-limit"); return false; }
    return true;
  }

  private bad(s: Session) {
    if (++s.bad > this.limits.maxBad) this.fail(s, "bad-message");
  }

  text(s: Session, m: ClientMsg | null) {
    if (!this.allow(s)) return;
    if (!m) return this.bad(s);
    if (m.type === "hello") return s.room ? this.bad(s) : this.hello(s, m);
    const room = s.room;
    if (!room) return this.bad(s);
    switch (m.type) {
      case "ping":
        s.conn.send(json({ type: "pong", id: m.id, t0: m.t0, ts: this.now(), ...(m.pair !== undefined ? { pair: m.pair, idx: m.idx } : {}) }));
        return;
      case "status": {
        const { type: _, ...status } = m;
        s.status = status;
        if (status.calibrated) room.stats.calibrated = true;
        if (s.role === "host") {
          if (status.source) room.stats.sources.add(status.source);
          if (status.spreadMs !== undefined) room.stats.spreadMs = status.spreadMs;
        }
        room.host?.conn.send(json({ type: "peer-status", peer: s.peer, status }));
        return;
      }
      case "lock":
        if (s.role !== "host") return this.bad(s);
        room.locked = m.locked;
        s.conn.send(json({ type: "locked", locked: room.locked }));
        return;
      case "remove": {
        if (s.role !== "host") return this.bad(s);
        const l = room.listeners.get(m.peer);
        room.resume.delete(m.peer);
        if (l) this.fail(l, "removed"); // the close handler runs leave()
        return;
      }
      case "stop":
        if (s.role !== "host" || m.epoch < room.epoch) return this.bad(s);
        room.epoch = m.epoch;
        room.buffer = [];
        room.lastSeq = -1;
        this.toListeners(room, json({ type: "stop", epoch: m.epoch }));
        return;
    }
  }

  private hello(s: Session, m: Hello) {
    if (m.v !== PROTOCOL_VERSION) return this.fail(s, "bad-version", { v: PROTOCOL_VERSION });
    const room = ROOM_RE.test(m.room) ? this.rooms.get(m.room) : undefined;
    if (!room) return this.fail(s, "no-room");
    if (m.role === "host") {
      if (!m.hostToken || !sameToken(m.hostToken, room.hostToken)) return this.fail(s, "bad-token");
      if (room.host) this.fail(room.host, "replaced");
      room.host = s;
      s.peer = 0;
      room.hostGoneAt = null;
      this.toListeners(room, json({ type: "host", online: true }));
    } else {
      const want = m.peer, token = want !== undefined ? room.resume.get(want) : undefined;
      const reclaim = want !== undefined && !!token && !!m.resume && !room.listeners.has(want) && sameToken(m.resume, token);
      if (room.locked && !reclaim) return this.fail(s, "locked");
      if (room.listeners.size >= this.limits.maxPeers) return this.fail(s, "room-full");
      if (reclaim) {
        s.peer = want;
        room.stats.reconnects++;
      } else {
        s.peer = room.nextPeer++;
        room.resume.set(s.peer, b64urlEncode(crypto.getRandomValues(new Uint8Array(16))));
        room.stats.joins++;
        room.stats.browsers[s.browser] = (room.stats.browsers[s.browser] ?? 0) + 1;
        s.mobile ? room.stats.mobile++ : room.stats.desktop++;
      }
      room.listeners.set(s.peer, s);
    }
    s.room = room;
    s.role = m.role;
    s.name = m.name;
    room.emptyAt = null;
    room.stats.peakPeers = Math.max(room.stats.peakPeers, room.members);
    s.conn.send(json({ type: "welcome", v: PROTOCOL_VERSION, peer: s.peer, role: m.role, epoch: room.epoch, hostOnline: !!room.host, locked: room.locked, resume: room.resume.get(s.peer) }));
    if (m.role === "listener") {
      const from = this.now() - this.limits.replayPastMs;
      for (const c of room.buffer) if (c.t > from) s.conn.send(c.data);
    }
    this.broadcastPeers(room);
  }

  binary(s: Session, data: Uint8Array) {
    if (!this.allow(s)) return;
    const room = s.room;
    if (!room) return this.bad(s);
    const b = parseBinary(data);
    if (!b) return this.bad(s);
    // Listeners may only send song requests to the host, stamped with their own peer id (checked here, and
    // authenticated end to end because the header is part of the AEAD's associated data).
    if (s.role === "listener") {
      if (b.kind !== KIND_UP || b.from !== s.peer || room.listeners.get(s.peer) !== s) return this.bad(s);
      room.host?.conn.send(data);
      return;
    }
    if (s.role !== "host" || room.host !== s || b.kind === KIND_UP) return this.bad(s);
    if (b.kind === KIND_CHUNK) {
      if (b.epoch < room.epoch) return this.bad(s);
      if (b.epoch > room.epoch) {
        room.epoch = b.epoch;
        room.buffer = [];
        room.lastSeq = -1;
      }
      if (b.seq <= room.lastSeq) return this.bad(s);
      room.lastSeq = b.seq;
      const copy = data.slice(); // own the bytes; the socket may reuse its buffer
      room.buffer.push({ seq: b.seq, t: b.t, data: copy });
      const oldest = this.now() - this.limits.bufferMs;
      while (room.buffer.length && (room.buffer[0].t < oldest || room.buffer.length > this.limits.bufferMax)) room.buffer.shift();
      room.stats.chunks++;
      this.toListeners(room, copy);
    } else if (b.to === 0) {
      this.toListeners(room, data);
    } else {
      room.listeners.get(b.to)?.conn.send(data);
    }
  }

  leave(s: Session) {
    const room = s.room;
    if (!room) return;
    s.room = null;
    if (room.host === s) {
      room.host = null;
      room.hostGoneAt = this.now();
      this.toListeners(room, json({ type: "host", online: false }));
    } else if (room.listeners.get(s.peer) === s) {
      room.listeners.delete(s.peer);
      this.absorb(room, s);
    }
    if (!room.members) room.emptyAt = this.now();
    this.broadcastPeers(room);
  }

  /** Lifecycle rules (spec §5.2). Call periodically. */
  sweep() {
    const t = this.now(), L = this.limits;
    for (const room of this.rooms.values()) {
      const hostGone = room.hostGoneAt !== null && t - room.hostGoneAt > L.hostGraceMs;
      const empty = room.emptyAt !== null && t - room.emptyAt > L.emptyMs;
      if (hostGone || empty || t - room.createdAt > L.lifetimeMs) this.close(room);
    }
  }

  close(room: Room) {
    const all = [...room.listeners.values(), ...(room.host ? [room.host] : [])];
    for (const s of all) {
      if (s !== room.host) this.absorb(room, s);
      s.room = null;
      this.fail(s, "room-closed");
    }
    this.rooms.delete(room.id);
    const st = room.stats;
    this.onClosed({
      v: 1, day: new Date().toISOString().slice(0, 10), durationS: Math.round((this.now() - room.createdAt) / 1000),
      peakPeers: st.peakPeers, joins: st.joins, reconnects: st.reconnects, played: st.chunks > 0, playedS: Math.round(st.chunks / 10),
      sources: [...st.sources], browsers: st.browsers, mobile: st.mobile, desktop: st.desktop,
      late: st.late, drops: st.drops, resyncs: st.resyncs, authFail: st.authFail, calibrated: st.calibrated, spreadMs: st.spreadMs,
    });
  }

  private absorb(room: Room, s: Session) {
    const st = s.status;
    if (!st) return;
    room.stats.late += st.late;
    room.stats.drops += st.drops;
    room.stats.resyncs += st.resyncs;
    room.stats.authFail += st.authFail;
    s.status = undefined;
  }

  private toListeners(room: Room, data: string | Uint8Array) {
    for (const l of room.listeners.values()) l.conn.send(data);
  }

  private broadcastPeers(room: Room) {
    const peers: PeerInfo[] = [];
    if (room.host) peers.push({ peer: 0, role: "host", browser: room.host.browser, mobile: room.host.mobile, name: room.host.name });
    for (const l of room.listeners.values()) peers.push({ peer: l.peer, role: "listener", browser: l.browser, mobile: l.mobile, name: l.name });
    const msg = json({ type: "peers", peers });
    room.host?.conn.send(msg);
    this.toListeners(room, msg);
  }
}

/** Anonymous live totals for the landing page ("N people listening right now"). */
export function liveTotals(rooms: Rooms) {
  let listeners = 0, active = 0;
  for (const r of rooms.rooms.values()) {
    if (r.members) active++;
    listeners += r.members;
  }
  return { listeners, rooms: active };
}

/** Coarse browser family + mobile flag from a User-Agent. Only these two values are ever kept. */
export function coarseUA(ua: string): { browser: string; mobile: boolean } {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const browser = /Edg\//.test(ua) ? "edge" : /Firefox\/|FxiOS/.test(ua) ? "firefox" : /Chrome\/|CriOS/.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other";
  return { browser, mobile };
}
