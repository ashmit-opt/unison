// Wire format v1 (spec §6). Shared by server and clients; every parser here validates untrusted input.

export const PROTOCOL_VERSION = 1;
export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20 ms Opus frame
export const FRAMES_PER_CHUNK = 5; // 100 ms chunk
export const CHUNK_MS = (FRAME_SAMPLES * FRAMES_PER_CHUNK * 1000) / SAMPLE_RATE;
export const LEAD_MS = 800; // host schedules audio this far ahead of capture
export const MAX_TEXT = 4096;
export const MAX_BINARY = 65536;
export const KIND_CHUNK = 1;
export const KIND_CTL = 2;
export const KIND_UP = 3; // listener → host sealed message (song requests); `from` must match the sender
export const CHUNK_HEADER = 18;
export const CTL_HEADER = 6;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const ROOM_RE = /^[0-9a-hjkmnp-tv-z]{10}$/; // Crockford base32, lower case

export type Role = "host" | "listener";
export type SourceKind = "tab" | "system" | "file" | "audius" | "clicks";
export const SOURCE_KINDS: SourceKind[] = ["tab", "system", "file", "audius", "clicks"];
export type PlayState = "idle" | "waiting" | "playing" | "stopped";
export type RequestMode = "ask" | "auto" | "off";
/** Party reactions guests can send (a fixed set: no free text, nothing to moderate). */
export const REACTIONS = ["fire", "heart", "hands", "party", "laugh"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Listener → host (inside KIND_UP payloads): ask for an Audius track to be queued, or react. */
export type SongRequest = { type: "request"; ref: string; audiusId: string; title: string; artist?: string; art?: string; durationS?: number };
export type Up = SongRequest | { type: "react"; r: Reaction };
export type ErrorCode =
  | "bad-version" | "no-room" | "bad-token" | "room-full" | "bad-message" | "replaced" | "room-closed" | "rate-limit" | "locked" | "removed";

export type Status = {
  state: PlayState;
  bufferMs: number; // how far ahead of "now" the newest received chunk is
  errMs: number; // last scheduler error (software estimate)
  rate: number; // current playbackRate slew
  late: number; drops: number; resyncs: number; authFail: number; // cumulative since join
  // Breakdown (optional for older clients): restart causes, background skips, worst timing jump.
  starts?: number; jumps?: number; under?: number; flushes?: number; bgDrops?: number; maxJumpMs?: number; hidden?: boolean;
  // Auto-sync helper (listener lending its mic): lag in ms of each device code it heard, keyed by peer id.
  heard?: Record<string, number>;
  rttMs: number; uncMs: number; outLatMs: number; offsetMs: number;
  calibrated: boolean;
  map: "ots" | "env";
  source?: SourceKind; // host only
  spreadMs?: number; // host only: last measured acoustic spread
};

/** `peer` + `resume` (the token from this peer's first welcome) reclaim a peer id after a reconnect. */
export type Hello = { type: "hello"; v: number; room: string; role: Role; hostToken?: string; peer?: number; resume?: string; name?: string };
/** Clock probes go out in pairs (`pair` id, `idx` 0/1, 25 ms apart) so queued measurements can be rejected. */
export type Ping = { type: "ping"; id: number; t0: number; pair?: number; idx?: number };
export type StatusMsg = { type: "status" } & Status;
export type StopMsg = { type: "stop"; epoch: number };
/** Host moderation: refuse new devices (members can still reconnect) / disconnect a guest and revoke its resume token. */
export type LockMsg = { type: "lock"; locked: boolean };
export type RemoveMsg = { type: "remove"; peer: number };
export type ClientMsg = Hello | Ping | StatusMsg | StopMsg | LockMsg | RemoveMsg;

export type PeerInfo = { peer: number; role: Role; browser: string; mobile: boolean; name?: string };
export type ServerMsg =
  | { type: "welcome"; v: number; peer: number; role: Role; epoch: number; hostOnline: boolean; locked: boolean; resume?: string }
  | { type: "locked"; locked: boolean }
  | { type: "pong"; id: number; t0: number; ts: number; pair?: number; idx?: number }
  | { type: "peers"; peers: PeerInfo[] }
  | { type: "peer-status"; peer: number; status: Status }
  | { type: "stop"; epoch: number }
  | { type: "host"; online: boolean }
  | { type: "error"; code: ErrorCode; v?: number };

/** A queue entry as listeners see it (no file data: files never leave the host). */
export type QueueView = { title: string; artist?: string; art?: string; by?: string };

// Encrypted control messages (inside CTL payloads).
export type Ctl =
  | { type: "queue"; mode: RequestMode; now?: QueueView; next: QueueView[] }
  | { type: "request-result"; ref: string; ok: boolean; reason?: string }
  | { type: "meta"; epoch: number; kind: SourceKind; title?: string; artist?: string; url?: string; art?: string }
  | { type: "cal-play"; round: number; at: number }
  | { type: "cal-adjust"; deltaMs: number }
  | { type: "pn"; db: number | null } // auto-sync code level for this device (null = off)
  | { type: "identify" } // Sync Doctor: chime + flash so people can find this device
  | { type: "resync" }; // Sync Doctor: restart this device's clock estimate and playback timing

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isInt = (x: unknown, max = 0xffffffff): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max;
const clamp = (x: unknown, lim = 1e7) => (isNum(x) ? Math.max(-lim, Math.min(lim, x)) : 0);
const str = (x: unknown, max: number) => (typeof x === "string" && x.length <= max ? x : undefined);

function parseJson(text: string, max: number): Record<string, unknown> | null {
  if (text.length > max) return null;
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

export function parseStatus(o: Record<string, unknown>): Status | null {
  if (!["idle", "waiting", "playing", "stopped"].includes(o.state as string)) return null;
  const s: Status = {
    state: o.state as PlayState,
    bufferMs: clamp(o.bufferMs), errMs: clamp(o.errMs), rate: clamp(o.rate, 2),
    late: clamp(o.late), drops: clamp(o.drops), resyncs: clamp(o.resyncs), authFail: clamp(o.authFail),
    rttMs: clamp(o.rttMs), uncMs: clamp(o.uncMs), outLatMs: clamp(o.outLatMs), offsetMs: clamp(o.offsetMs),
    calibrated: o.calibrated === true,
    map: o.map === "ots" ? "ots" : "env",
  };
  for (const k of ["starts", "jumps", "under", "flushes", "bgDrops", "maxJumpMs"] as const) if (isNum(o[k])) s[k] = clamp(o[k]);
  if (typeof o.hidden === "boolean") s.hidden = o.hidden;
  if (o.heard && typeof o.heard === "object" && !Array.isArray(o.heard)) {
    const h = Object.entries(o.heard as Record<string, unknown>).filter(([k, v]) => /^\d{1,6}$/.test(k) && isNum(v)).slice(0, 40);
    if (h.length) s.heard = Object.fromEntries(h.map(([k, v]) => [k, clamp(v, 2000)]));
  }
  if (SOURCE_KINDS.includes(o.source as SourceKind)) s.source = o.source as SourceKind;
  if (isNum(o.spreadMs)) s.spreadMs = clamp(o.spreadMs, 1e4);
  return s;
}

export function parseClientMsg(text: string): ClientMsg | null {
  const o = parseJson(text, MAX_TEXT);
  if (!o) return null;
  switch (o.type) {
    case "hello":
      if (!isInt(o.v, 1000) || typeof o.room !== "string" || (o.role !== "host" && o.role !== "listener")) return null;
      return {
        type: "hello", v: o.v, room: o.room, role: o.role,
        hostToken: str(o.hostToken, 64), peer: isInt(o.peer, 1e6) ? o.peer : undefined, resume: str(o.resume, 64), name: deviceName(o.name),
      };
    case "ping": {
      if (!isInt(o.id) || !isNum(o.t0)) return null;
      const p: Ping = { type: "ping", id: o.id, t0: o.t0 };
      if (isInt(o.pair) && (o.idx === 0 || o.idx === 1)) { p.pair = o.pair; p.idx = o.idx; }
      return p;
    }
    case "status": {
      const s = parseStatus(o);
      return s ? { type: "status", ...s } : null;
    }
    case "stop":
      return isInt(o.epoch) ? { type: "stop", epoch: o.epoch } : null;
    case "lock":
      return typeof o.locked === "boolean" ? { type: "lock", locked: o.locked } : null;
    case "remove":
      return isInt(o.peer, 1e6) ? { type: "remove", peer: o.peer } : null;
  }
  return null;
}

// Clients trust the server only for availability, but still never crash on junk.
export function parseServerMsg(text: string): ServerMsg | null {
  const o = parseJson(text, 64 * 1024);
  return o && typeof o.type === "string" ? (o as ServerMsg) : null;
}

/** Display names are short, plain words (they're shown to everyone in the room and seen by the server). */
export function deviceName(x: unknown): string | undefined {
  return typeof x === "string" && /^[\p{L}\p{N} _-]{1,32}$/u.test(x) ? x.trim() || undefined : undefined;
}

const httpsUrl = (x: unknown) => { const s = str(x, 500); return s && /^https:\/\/[^\s"'<>]+$/.test(s) ? s : undefined; };

const qview = (x: unknown): QueueView | undefined => {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>, title = str(o.title, 200);
  return title ? { title, artist: str(o.artist, 200), art: httpsUrl(o.art), by: deviceName(o.by) } : undefined;
};

export function parseUp(text: string): Up | null {
  const o = parseJson(text, MAX_TEXT);
  if (o?.type === "react") return REACTIONS.includes(o.r as Reaction) ? { type: "react", r: o.r as Reaction } : null;
  if (!o || o.type !== "request") return null;
  const ref = str(o.ref, 40), audiusId = str(o.audiusId, 20), title = str(o.title, 200);
  if (!ref || !audiusId || !/^[A-Za-z0-9]+$/.test(audiusId) || !title) return null;
  return { type: "request", ref, audiusId, title, artist: str(o.artist, 200), art: httpsUrl(o.art), durationS: isNum(o.durationS) ? clamp(o.durationS, 1e5) : undefined };
}

export function parseCtl(text: string): Ctl | null {
  const o = parseJson(text, 16 * 1024); // queue snapshots can be a few KB
  if (!o) return null;
  if (o.type === "queue" && ["ask", "auto", "off"].includes(o.mode as string) && Array.isArray(o.next))
    return { type: "queue", mode: o.mode as RequestMode, now: qview(o.now), next: o.next.slice(0, 30).map(qview).filter((q): q is QueueView => !!q) };
  if (o.type === "request-result" && str(o.ref, 40) && typeof o.ok === "boolean")
    return { type: "request-result", ref: o.ref as string, ok: o.ok, reason: str(o.reason, 200) };
  if (o.type === "meta" && isInt(o.epoch) && SOURCE_KINDS.includes(o.kind as SourceKind))
    return { type: "meta", epoch: o.epoch, kind: o.kind as SourceKind, title: str(o.title, 300), artist: str(o.artist, 300), url: httpsUrl(o.url), art: httpsUrl(o.art) };
  if (o.type === "cal-play" && isInt(o.round, 1000) && isNum(o.at)) return { type: "cal-play", round: o.round, at: o.at };
  if (o.type === "cal-adjust" && isNum(o.deltaMs) && Math.abs(o.deltaMs) < 2000) return { type: "cal-adjust", deltaMs: o.deltaMs };
  if (o.type === "identify") return { type: "identify" };
  if (o.type === "resync") return { type: "resync" };
  if (o.type === "pn" && (o.db === null || (isNum(o.db) && o.db >= -60 && o.db <= -10))) return { type: "pn", db: o.db as number | null };
  return null;
}

// ---- binary framing ----
export type ChunkHead = { epoch: number; seq: number; t: number };
export type Binary =
  | ({ kind: typeof KIND_CHUNK; header: Uint8Array; body: Uint8Array } & ChunkHead)
  | { kind: typeof KIND_CTL; to: number; header: Uint8Array; body: Uint8Array }
  | { kind: typeof KIND_UP; from: number; header: Uint8Array; body: Uint8Array };

export function chunkHeader(h: ChunkHead): Uint8Array {
  const b = new Uint8Array(CHUNK_HEADER), v = new DataView(b.buffer);
  b[0] = PROTOCOL_VERSION; b[1] = KIND_CHUNK;
  v.setUint32(2, h.epoch); v.setUint32(6, h.seq); v.setFloat64(10, h.t);
  return b;
}

export function ctlHeader(to: number, kind: typeof KIND_CTL | typeof KIND_UP = KIND_CTL): Uint8Array {
  const b = new Uint8Array(CTL_HEADER);
  b[0] = PROTOCOL_VERSION; b[1] = kind;
  new DataView(b.buffer).setUint32(2, to);
  return b;
}
/** Listener → host header; the server checks `from` equals the sender's peer id. */
export const upHeader = (from: number) => ctlHeader(from, KIND_UP);

/** Parses the clear header of a sealed message. `body` = iv ‖ ciphertext ‖ tag. */
export function parseBinary(buf: Uint8Array): Binary | null {
  if (buf.length > MAX_BINARY || buf.length < 2 || buf[0] !== PROTOCOL_VERSION) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const min = IV_LEN + TAG_LEN;
  if (buf[1] === KIND_CHUNK && buf.length >= CHUNK_HEADER + min) {
    const t = v.getFloat64(10);
    if (!Number.isFinite(t)) return null;
    return { kind: KIND_CHUNK, epoch: v.getUint32(2), seq: v.getUint32(6), t, header: buf.subarray(0, CHUNK_HEADER), body: buf.subarray(CHUNK_HEADER) };
  }
  if (buf[1] === KIND_CTL && buf.length >= CTL_HEADER + min)
    return { kind: KIND_CTL, to: v.getUint32(2), header: buf.subarray(0, CTL_HEADER), body: buf.subarray(CTL_HEADER) };
  if (buf[1] === KIND_UP && buf.length >= CTL_HEADER + min)
    return { kind: KIND_UP, from: v.getUint32(2), header: buf.subarray(0, CTL_HEADER), body: buf.subarray(CTL_HEADER) };
  return null;
}

/** Chunk plaintext: u8 count, then per packet u16 length + bytes. */
export function packPackets(packets: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(1 + packets.reduce((n, p) => n + 2 + p.length, 0));
  out[0] = packets.length;
  let o = 1;
  for (const p of packets) {
    out[o] = p.length >> 8; out[o + 1] = p.length & 255;
    out.set(p, o + 2);
    o += 2 + p.length;
  }
  return out;
}

export function unpackPackets(b: Uint8Array): Uint8Array[] | null {
  const n = b[0] ?? 0, out: Uint8Array[] = [];
  let o = 1;
  for (let i = 0; i < n; i++) {
    if (o + 2 > b.length) return null;
    const len = (b[o] << 8) | b[o + 1];
    if (o + 2 + len > b.length) return null;
    out.push(b.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  return o === b.length && n > 0 ? out : null;
}
