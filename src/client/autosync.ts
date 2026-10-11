// Continuous silent calibration (spec §8.4, ADR-0007).
// MicListener: records a microphone and measures every device code it hears, once per 1.5 s window.
// AutoSyncHost: combines the host mic with helper phones' reports, solves offsets, adjusts devices.
import { MaxWindow } from "../shared/clock.ts";
import { PN, PN_ACCEPT_RATIO, correlation, decimate3, nextPow2, peak, pnCode, spectrum } from "../shared/pn.ts";
import { SAMPLE_RATE } from "../shared/protocol.ts";
import { solveOffsets, type Heard } from "../shared/solve.ts";
import type { Connection } from "./net.ts";

const WINDOW_S = 1.5, KEEP_S = 4, SUM_WINDOWS = 4, MAX_LAG_MS = 300;

export type Lag = { lagMs: number; ratio: number };

export class MicListener {
  onMeasure: (lags: Map<number, Lag>) => void = () => {};
  /** Device codes (peer ids) to look for. */
  ids: () => number[] = () => [];
  running = false;
  private blocks: { frame: number; l: Float32Array }[] = [];
  private env = new MaxWindow(2000);
  private acc = new Map<number, Float64Array[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopMic: (() => void) | undefined;

  constructor(private ctx: AudioContext, private conn: Connection) {}

  /** `input` replaces the microphone (tests use a digital loopback). */
  async start(input?: MediaStream) {
    if (this.running) return;
    const mic = input ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    await this.ctx.audioWorklet.addModule("/tap-worklet.js");
    const src = this.ctx.createMediaStreamSource(mic);
    const rec = new AudioWorkletNode(this.ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    rec.port.onmessage = (e) => {
      const now = performance.now();
      this.blocks.push({ frame: e.data.frame, l: e.data.l });
      this.env.add(now, this.ctx.currentTime * 1000 - now);
      const keepFrom = e.data.frame - KEEP_S * SAMPLE_RATE;
      while (this.blocks.length && this.blocks[0].frame < keepFrom) this.blocks.shift();
    };
    src.connect(rec);
    rec.connect(this.ctx.destination); // outputs silence; keeps the node processing
    this.stopMic = () => { src.disconnect(); rec.disconnect(); if (!input) mic.getTracks().forEach((t) => t.stop()); };
    this.running = true;
    this.timer = setInterval(() => this.tick(), WINDOW_S * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.stopMic?.();
    this.running = false;
    this.blocks = [];
    this.acc.clear();
  }

  /** Forget accumulated correlation for a device (its timing just changed). */
  reset(id: number) { this.acc.delete(id); }

  // ponytail: runs on the main thread (~20–30 ms per device per 1.5 s); move to a Worker if rooms get big.
  private tick() {
    const ids = this.ids();
    if (!this.conn.clock.ready || !this.blocks.length || !ids.length) return;
    const n = WINDOW_S * SAMPLE_RATE, last = this.blocks[this.blocks.length - 1];
    const startFrame = last.frame + last.l.length - n;
    const x = new Float32Array(n);
    let filled = 0;
    for (const b of this.blocks) {
      for (let i = 0; i < b.l.length; i++) {
        const k = b.frame + i - startFrame;
        if (k >= 0 && k < n) { x[k] = b.l[i]; filled++; }
      }
    }
    if (filled < n * 0.98) return; // incomplete window (mic just started or blocks were lost)
    // Shared (server) time at which sound reaching the first sample was expected to be emitted.
    const startMs = (startFrame / SAMPLE_RATE) * 1000 - (this.env.value ?? 0) + this.conn.clock.offset;
    const rec = decimate3(x);
    const spec = spectrum(rec, nextPow2(rec.length + (2 * MAX_LAG_MS * PN.rate) / 1000));
    const out = new Map<number, Lag>();
    for (const id of ids) {
      const c = correlation(spec, startMs, pnCode(id), MAX_LAG_MS);
      const hist = [...(this.acc.get(id) ?? []), c].slice(-SUM_WINDOWS);
      this.acc.set(id, hist);
      const sum = new Float64Array(c.length);
      for (const h of hist) for (let i = 0; i < sum.length; i++) sum[i] += h[i];
      const p = peak(sum);
      if (p.ratio >= PN_ACCEPT_RATIO) out.set(id, p);
    }
    this.onMeasure(out);
  }
}

export const LEVEL = { start: PN.db, min: -36, max: -24, step: 3 };
// After a correction a device is re-measured only once it finished slewing (chain error small) and 3 s passed.
const SETTLE_MS = 3000, HELPER_SETTLE_MS = 7500, FRESH_MS = 4000, DEADBAND_MS = 1, SETTLED_ERR_MS = 1.5;

export type HostSyncDeps = {
  adjust(id: number, deltaMs: number): void; // shift a device's offset (positive = it was late)
  setLevel(id: number, db: number): void; // code level for a device
  chainErrMs(id: number): number | undefined; // device's current scheduler error (slew in progress)
  reset(id: number): void; // tell local mic listener to drop stale accumulation
};

/** Turns microphone measurements into offset corrections, continuously. */
export class AutoSyncHost {
  spreadMs: number | null = null;
  heardIds = new Set<number>();
  private heard = new Map<number, Map<number, { lag: number; at: number }>>(); // mic → device → filtered lag
  private history = new Map<string, number[]>(); // "mic:device" → last raw lags (median rejects one-off false peaks)
  private spreadAt = 0;
  private lastAdjust = new Map<number, number>();
  private levels = new Map<number, { db: number; lastHeard: number; strong: number }>();

  constructor(private hostMicId: number, private deps: HostSyncDeps, private clock: () => number = () => performance.now()) {}

  /** Codes that should be playing (each device's level starts at LEVEL.start). */
  ensure(ids: number[]) {
    const now = this.clock();
    for (const id of ids) if (!this.levels.has(id)) {
      this.levels.set(id, { db: LEVEL.start, lastHeard: now, strong: 0 });
      this.deps.setLevel(id, LEVEL.start);
    }
    for (const id of this.levels.keys()) if (!ids.includes(id)) this.levels.delete(id);
  }

  onHostMic(lags: Map<number, Lag>) {
    this.record(this.hostMicId, new Map([...lags].map(([id, l]) => [id, l.lagMs])));
    this.adaptLevels(lags);
    this.step();
  }

  onHelper(micId: number, heard: Record<string, number>) {
    this.record(micId, new Map(Object.entries(heard).map(([k, v]) => [Number(k), v])));
  }

  /** Keeps each mic→device entry until it goes stale, so one missed detection doesn't change the equations. */
  private record(mic: number, lags: Map<number, number>) {
    const now = this.clock(), entries = this.heard.get(mic) ?? new Map();
    for (const [id, lag] of lags) {
      const key = `${mic}:${id}`, h = [...(this.history.get(key) ?? []), lag].slice(-3);
      this.history.set(key, h);
      entries.set(id, { lag: [...h].sort((a, b) => a - b)[h.length >> 1], at: now });
    }
    this.heard.set(mic, entries);
  }

  private adaptLevels(lags: Map<number, Lag>) {
    const now = this.clock();
    for (const [id, lv] of this.levels) {
      const l = lags.get(id);
      const heardElsewhere = [...this.heard.values()].some((m) => { const e = m.get(id); return !!e && now - e.at < FRESH_MS; });
      if (l || heardElsewhere) lv.lastHeard = now;
      // Only turn codes down when the host mic is the only listener: helpers further away need them louder.
      const helpers = [...this.heard].some(([m, en]) => m !== this.hostMicId && [...en.values()].some((e) => now - e.at < FRESH_MS));
      lv.strong = l && l.ratio > 20 && !helpers ? lv.strong + 1 : 0;
      let db = lv.db;
      if (now - lv.lastHeard > 6000) { db = Math.min(LEVEL.max, db + LEVEL.step); lv.lastHeard = now; }
      else if (lv.strong >= 3) { db = Math.max(LEVEL.min, db - LEVEL.step); lv.strong = 0; }
      if (db !== lv.db) { lv.db = db; this.deps.setLevel(id, db); }
    }
  }

  private step() {
    const now = this.clock(), valid = new Map<number, Map<number, number>>();
    for (const [mic, entries] of this.heard) {
      // Helpers' own accumulations aren't reset by our corrections, so their data needs longer to refresh.
      const settleMs = mic === this.hostMicId ? SETTLE_MS : HELPER_SETTLE_MS;
      const m = new Map<number, number>();
      for (const [id, e] of entries) {
        const settled = e.at - (this.lastAdjust.get(id) ?? -Infinity) > settleMs && Math.abs(this.deps.chainErrMs(id) ?? 0) <= SETTLED_ERR_MS;
        if (now - e.at < FRESH_MS && settled) m.set(id, e.lag);
      }
      valid.set(mic, m);
    }
    // Between two active microphones, only complete two-way measurements (each hears itself and the other)
    // are used: they cancel travel time. A one-way equation would include the distance and pull devices off.
    const active = [...this.heard].filter(([, en]) => [...en.values()].some((e) => now - e.at < FRESH_MS)).map(([m]) => m);
    for (const a of active) for (const b of active) {
      if (a >= b) continue;
      const ma = valid.get(a)!, mb = valid.get(b)!;
      if (!(ma.has(a) && ma.has(b) && mb.has(b) && mb.has(a))) { ma.delete(b); mb.delete(a); }
    }
    const heard: Heard = new Map();
    for (const [mic, m] of valid) if (m.size) heard.set(String(mic), new Map([...m].map(([id, lag]) => [String(id), lag])));
    this.heardIds = new Set([...heard.values()].flatMap((m) => [...m.keys()].map(Number)));
    const { e, groups } = solveOffsets(heard);
    const group = groups.sort((a, b) => b.length - a.length)[0] ?? [];
    if (group.length < 2) {
      if (now - this.spreadAt > 8000) this.spreadMs = null; // hold the last reading through brief gaps
      return;
    }
    const vals = group.map((d) => e.get(d)!).sort((a, b) => a - b);
    const ref = vals[vals.length >> 1];
    this.spreadMs = vals[vals.length - 1] - vals[0];
    this.spreadAt = now;
    for (const d of group) {
      const id = Number(d), delta = e.get(d)! - ref;
      if (Math.abs(delta) < DEADBAND_MS) continue;
      // Lags are median-of-3 filtered, so the full correction is applied (≤ 25 ms slews silently, larger resyncs once).
      this.deps.adjust(id, delta);
      this.lastAdjust.set(id, now);
      this.deps.reset(id);
      for (const key of this.history.keys()) if (key.endsWith(`:${id}`)) this.history.delete(key);
    }
  }
}
