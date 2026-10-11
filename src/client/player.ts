// Listener engine (spec §7): open → WASM Opus decode → place on the audio clock → play.
// The host's local player uses the same class via push() (no network, no crypto).
import { OpusDecoder } from "opus-decoder";
import { chirp } from "../shared/calib.ts";
import { MaxWindow, MedianWindow, type ClockEstimator } from "../shared/clock.ts";
import { open } from "../shared/crypto.ts";
import { mixPN, pnCode } from "../shared/pn.ts";
import { CHUNK_MS, KIND_CTL, KIND_UP, SAMPLE_RATE, parseBinary, parseCtl, unpackPackets, type Ctl, type PlayState, type Status } from "../shared/protocol.ts";
import { Scheduler } from "../shared/scheduler.ts";

const dec = new TextDecoder();

export class Player {
  readonly out: GainNode;
  offsetMs = 0; // from calibration
  nudgeMs = 0; // manual
  calibrated = false;
  /** Auto-sync code mixed into everything this device plays (spec §8.4): its peer id and level. */
  pn: { id: number; db: number } | null = null;
  state: PlayState = "waiting";
  mapKind: "ots" | "env" = "env";
  stats = {
    chunks: 0, late: 0, drops: 0, resyncs: 0, authFail: 0, decodeErrors: 0, errMs: 0, rate: 1, bufferMs: 0,
    starts: 0, jumps: 0, under: 0, flushes: 0, bgDrops: 0, maxJumpMs: 0,
  };
  /** Software estimate of when the last chunk will sound (epoch ms) — lets tests compare devices. */
  last = { seq: -1, emitEpochMs: 0 };
  onCtl: (c: Ctl) => void = () => {};
  private sched = new Scheduler();
  private decoder!: OpusDecoder;
  private q: Promise<void> = Promise.resolve();
  private epoch = -1;
  private lastSeq = -1;
  private lastChunkAt = 0;
  private sources: { node: AudioBufferSourceNode; end: number }[] = [];
  private ots = new MedianWindow(15);
  private env = new MaxWindow(2000);
  private chirpBuf: AudioBuffer;
  private visibleSince = performance.now();
  private mapSamples = 0;

  constructor(readonly ctx: AudioContext, private clock: ClockEstimator, private key?: CryptoKey, private room?: string) {
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    const c = chirp(SAMPLE_RATE);
    this.chirpBuf = ctx.createBuffer(1, c.length, SAMPLE_RATE);
    this.chirpBuf.copyToChannel(c as Float32Array<ArrayBuffer>, 0);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.visibleSince = performance.now(); });
    // Keep the audio-clock mapping warm (median/max windows full) before the first chunk or chirp needs it:
    // fast sampling for the first ~0.5 s, then every 250 ms.
    let n = 0;
    const sample = () => {
      if (ctx.state === "running") { this.ctxAtPerf(performance.now()); this.mapSamples++; }
      setTimeout(sample, n++ < 25 ? 20 : 250);
    };
    sample();
  }

  /** The page is (or just was) in the background: browsers freeze it, so missed audio isn't a playback fault. */
  private get inBackground() { return document.hidden || performance.now() - this.visibleSince < 3000; }

  async init() {
    this.decoder = new OpusDecoder({ channels: 2 });
    await this.decoder.ready;
  }

  /** Sealed message from the network (host → server → here). */
  receive(buf: Uint8Array) {
    const b = parseBinary(buf);
    if (!b || b.kind === KIND_UP || !this.key || !this.room) return; // song requests are for the host only
    const key = this.key, room = this.room;
    this.enqueue(async () => {
      const pt = await open(key, room, b.header, b.body);
      if (!pt) { this.stats.authFail++; return; }
      if (b.kind === KIND_CTL) {
        const c = parseCtl(dec.decode(pt));
        if (c) this.onCtl(c);
        return;
      }
      const packets = unpackPackets(pt);
      if (!packets) { this.stats.authFail++; return; }
      await this.chunk(b.epoch, b.seq, b.t, packets);
    });
  }

  /** Plain chunk (host's local player). */
  push(epoch: number, seq: number, t: number, packets: Uint8Array[]) {
    this.enqueue(() => this.chunk(epoch, seq, t, packets));
  }

  private enqueue(f: () => Promise<void>) {
    this.q = this.q.then(f).catch((e) => console.error("player", e));
  }

  /** Audio-clock time (s) at which a sound must be scheduled to be heard at performance time P (ms). */
  ctxAtPerf(P: number): number {
    const ctx = this.ctx, now = performance.now();
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime && ts.performanceTime && ts.contextTime <= ctx.currentTime && ts.contextTime > ctx.currentTime - 0.5
        && ts.performanceTime <= now && ts.performanceTime > now - 500) {
      this.ots.add(ts.contextTime * 1000 - ts.performanceTime);
    }
    this.env.add(now, ctx.currentTime * 1000 - now);
    const otsVal = this.ots.value;
    this.mapKind = otsVal !== null ? "ots" : "env";
    const lat = ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) + (ctx.baseLatency ?? 0);
    const m = otsVal ?? this.env.value! - lat * 1000;
    return (P + m) / 1000;
  }

  /** Performance time (ms) at which the device should emit server time `t`, including its offsets. */
  private targetPerf(t: number) {
    return t - this.clock.offset - (this.offsetMs + this.nudgeMs);
  }

  /** Scheduling needs the server offset; before the first pings return it is meaningless. */
  private async clockReady() {
    for (let i = 0; i < 300 && !(this.clock.ready && this.mapSamples >= 10); i++) await new Promise((r) => setTimeout(r, 20));
  }

  private async chunk(epoch: number, seq: number, t: number, packets: Uint8Array[]) {
    await this.clockReady();
    if (epoch < this.epoch) return;
    if (epoch > this.epoch) {
      this.flush();
      this.epoch = epoch;
      this.lastSeq = -1;
      await this.decoder.reset();
    }
    if (seq <= this.lastSeq) return; // duplicate (reconnect replay) or replayed message
    this.lastSeq = seq;
    const serverNow = performance.now() + this.clock.offset;
    this.stats.bufferMs = t + CHUNK_MS - serverNow;
    if (t + CHUNK_MS < serverNow) { this.inBackground ? this.stats.bgDrops++ : this.stats.drops++; return; } // already over
    const r = this.decoder.decodeFrames(packets);
    this.stats.decodeErrors += r.errors.length;
    if (!r.samplesDecoded) return;
    const buf = this.ctx.createBuffer(2, r.samplesDecoded, SAMPLE_RATE);
    buf.copyToChannel(r.channelData[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel((r.channelData[1] ?? r.channelData[0]) as Float32Array<ArrayBuffer>, 1);
    if (this.pn) mixPN([buf.getChannelData(0), buf.getChannelData(1)], t, pnCode(this.pn.id), this.pn.db);
    const target = this.targetPerf(t);
    const p = this.sched.place(this.ctxAtPerf(target), buf.duration, this.ctx.currentTime);
    if (p.kind === "drop") { this.inBackground ? this.stats.bgDrops++ : this.stats.drops++; return; }
    if (p.flush) this.stopSources();
    if (p.resync) this.stats.resyncs++;
    if (p.why === "start") this.stats.starts++;
    else if (p.why === "flush") this.stats.flushes++;
    else if (p.why === "underrun") this.inBackground ? this.stats.bgDrops++ : this.stats.under++;
    else if (p.why === "jump") {
      this.stats.jumps++;
      this.stats.maxJumpMs = Math.max(this.stats.maxJumpMs, Math.abs(p.err) * 1000);
    }
    if (p.late) this.stats.late++;
    this.stats.errMs = p.err * 1000;
    this.stats.rate = p.rate;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = p.rate;
    src.connect(this.out);
    src.start(p.when, p.offset);
    const now = this.ctx.currentTime;
    this.sources = this.sources.filter((s) => s.end > now);
    this.sources.push({ node: src, end: p.when + (buf.duration - p.offset) / p.rate });
    this.stats.chunks++;
    this.last = { seq, emitEpochMs: performance.timeOrigin + target - p.err * 1000 };
    this.lastChunkAt = performance.now();
    this.state = "playing";
  }

  private stopSources() {
    for (const s of this.sources) { try { s.node.stop(); } catch { /* already ended */ } }
    this.sources = [];
  }

  /** Stop everything scheduled (new epoch, Stop). */
  flush() {
    this.stopSources();
    this.sched.reset();
  }

  stop(epoch: number) {
    if (epoch < this.epoch) return;
    this.enqueue(async () => {
      this.flush();
      this.epoch = Math.max(this.epoch, epoch);
      this.lastSeq = Number.MAX_SAFE_INTEGER; // ignore stragglers of the stopped epoch
      this.state = "stopped";
    });
  }

  /** Calibration: emit the chirp at server time `at`, through the same timing path as audio. */
  playChirp(at: number): boolean {
    if (!this.clock.ready) return false;
    const when = this.ctxAtPerf(this.targetPerf(at));
    if (when < this.ctx.currentTime + 0.02) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = this.chirpBuf;
    src.connect(this.out);
    src.start(when);
    return true;
  }

  status(): Status {
    if (this.state === "playing" && performance.now() - this.lastChunkAt > 1500) this.state = "waiting";
    const s = this.stats, ctx = this.ctx as AudioContext & { outputLatency?: number };
    const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
    return {
      state: this.state, bufferMs: round(s.bufferMs, 0), errMs: round(s.errMs, 2), rate: round(s.rate, 5),
      late: s.late, drops: s.drops, resyncs: s.resyncs, authFail: s.authFail,
      rttMs: Number.isFinite(this.clock.minRtt) ? round(this.clock.minRtt) : 0,
      uncMs: Number.isFinite(this.clock.uncertainty) ? round(this.clock.uncertainty) : 0,
      outLatMs: round((ctx.outputLatency ?? 0) * 1000), offsetMs: round(this.offsetMs + this.nudgeMs),
      calibrated: this.calibrated, map: this.mapKind,
      starts: s.starts, jumps: s.jumps, under: s.under, flushes: s.flushes, bgDrops: s.bgDrops,
      maxJumpMs: round(s.maxJumpMs), hidden: document.hidden,
    };
  }
}
