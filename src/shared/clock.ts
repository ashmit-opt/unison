// Clock estimation (spec §7.1).

/** Server-offset estimator: θ = S − P from ping round trips, min-RTT filtered. */
export class ClockEstimator {
  private samples: { rtt: number; theta: number }[] = [];
  /** Probe-pair statistics (Huygens-style purity check). */
  pure = 0;
  impure = 0;
  constructor(private keep = 15) {}

  /** Two probes sent `gap` ms apart: if the server saw the same gap (±tol), neither was queued; keep the
   *  faster one. Otherwise discard both — unless almost nothing is pure (degraded network), then keep it. */
  addPair(a: { t0: number; t1: number; ts: number }, b: { t0: number; t1: number; ts: number }, tolMs = 5) {
    const pure = Math.abs((b.ts - a.ts) - (b.t0 - a.t0)) <= tolMs;
    pure ? this.pure++ : this.impure++;
    if (!pure && !(this.impure > 20 && this.pure < this.impure / 10)) return;
    const best = b.t1 - b.t0 < a.t1 - a.t0 ? b : a;
    this.add(best.t0, best.t1, best.ts);
  }

  add(t0: number, t1: number, ts: number) {
    const rtt = t1 - t0;
    if (!(rtt >= 0) || !Number.isFinite(ts)) return;
    this.samples.push({ rtt, theta: ts - (t0 + t1) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get ready() { return this.samples.length >= 5; }
  get count() { return this.samples.length; }
  get minRtt() { return this.samples.reduce((m, s) => Math.min(m, s.rtt), Infinity); }
  /** Half the best round trip: the offset error bound from path asymmetry. */
  get uncertainty() { return this.minRtt / 2; }

  get offset(): number {
    if (!this.samples.length) return 0;
    const lim = this.minRtt + Math.max(2, 0.2 * this.minRtt);
    const best = this.samples.filter((s) => s.rtt <= lim);
    return best.reduce((a, s) => a + s.theta, 0) / best.length;
  }

  reset() { this.samples = []; }
}

/** Median of the last N values (smooths audio-clock mapping readings). */
export class MedianWindow {
  private v: number[] = [];
  constructor(private n = 15) {}
  add(x: number) {
    this.v.push(x);
    if (this.v.length > this.n) this.v.shift();
  }
  get value(): number | null {
    if (!this.v.length) return null;
    const s = [...this.v].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
  reset() { this.v = []; }
}

/** Host side (spec §5.4): drift between the capture clock (samples produced) and the server clock.
 *  Tracks a low percentile of (serverTime − audioTime) at block arrival over a 10 s window: main-thread
 *  delays add positive noise, and a percentile (not the minimum) ignores rare early outliers such as
 *  audio-callback bursts. Returns anchor corrections in ms. */
export class DriftTracker {
  private v: { at: number; x: number }[] = [];
  private start: number | null = null;
  private base: number | null = null;
  private lastEval = -Infinity;
  constructor(private stepMs = 5, private warmupMs = 10_000, private spanMs = 10_000, private pct = 0.1) {}

  /** serverNow: server ms when the block arrived; audioMs: audio time (ms) of the block's first sample. */
  add(serverNow: number, audioMs: number): number {
    this.start ??= serverNow;
    this.v.push({ at: serverNow, x: serverNow - audioMs });
    while (this.v[0].at < serverNow - this.spanMs) this.v.shift();
    if (serverNow - this.start < this.warmupMs || serverNow - this.lastEval < 1000) return 0;
    this.lastEval = serverNow;
    const xs = this.v.map((e) => e.x).sort((a, b) => a - b);
    const low = xs[Math.floor(xs.length * this.pct)];
    if (this.base === null) { this.base = low; return 0; }
    const d = low - this.base;
    if (Math.abs(d) < this.stepMs) return 0;
    this.base = low;
    return d;
  }
}

/** Maximum over a sliding time window. `currentTime` is stale between audio-thread updates, so
 *  max(currentTime·1000 − now) over a window is the tightest estimate of the true mapping. */
export class MaxWindow {
  private v: { at: number; x: number }[] = [];
  constructor(private spanMs = 2000) {}
  add(at: number, x: number) {
    this.v.push({ at, x });
    while (this.v.length && this.v[0].at < at - this.spanMs) this.v.shift();
  }
  get value(): number | null {
    return this.v.length ? this.v.reduce((m, e) => Math.max(m, e.x), -Infinity) : null;
  }
  reset() { this.v = []; }
}
