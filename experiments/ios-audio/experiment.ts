// Throwaway experiment: can this browser decode streamed raw Opus packets (WASM) and
// schedule them gaplessly against the Web Audio clock? Measures, does not assume.
import { OpusDecoder } from "opus-decoder";

const SR = 48000, FRAME = 960, PER_CHUNK = 5, CHUNK_S = (FRAME * PER_CHUNK) / SR; // 100 ms chunks
const out = document.getElementById("out")!;
const phaseEl = document.getElementById("phase")!;
const R: any = { ua: navigator.userAgent, startedAt: new Date().toISOString(), caps: {}, phases: [], events: [] };
const render = () => (out.textContent = JSON.stringify(R, null, 1));
const ev = (name: string, data: object = {}) => { R.events.push({ t: +performance.now().toFixed(1), name, ...data }); render(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Capability probe before any gesture.
async function probe() {
  const c = R.caps;
  c.secureContext = isSecureContext;
  const pre = new AudioContext({ sampleRate: SR });
  c.stateBeforeGesture = pre.state;
  c.sampleRateHonored = pre.sampleRate === SR;
  c.getOutputTimestamp = "getOutputTimestamp" in pre;
  c.outputLatencyProp = "outputLatency" in pre;
  c.audioWorklet = "audioWorklet" in pre;
  await pre.close();
  const cfg = { codec: "opus", sampleRate: SR, numberOfChannels: 2 };
  c.webcodecsAudioDecoderOpus = typeof AudioDecoder !== "undefined" && !!(await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported;
  c.webcodecsAudioEncoderOpus = typeof AudioEncoder !== "undefined" && !!(await AudioEncoder.isConfigSupported({ ...cfg, bitrate: 128000 }).catch(() => ({ supported: false }))).supported;
  c.audioSession = "audioSession" in navigator;
  c.wakeLock = "wakeLock" in navigator;
  c.subtleCrypto = !!globalThis.crypto?.subtle;
  if (c.subtleCrypto) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12)), data = new Uint8Array(2048);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    c.aesGcmDecryptMsPer2KB = +((performance.now() - t0) / 200).toFixed(3);
  }
  render();
}

// Fixture: 20 s of a 440 Hz tone as raw 20 ms Opus packets. Generated once by a browser with AudioEncoder.
async function loadFixture(): Promise<Uint8Array[]> {
  const res = await fetch("/fixture.bin");
  if (res.ok) return unpack(new Uint8Array(await res.arrayBuffer()));
  if (!R.caps.webcodecsAudioEncoderOpus) throw new Error("no fixture on server and no AudioEncoder to create one");
  const packets: Uint8Array[] = [];
  const enc = new AudioEncoder({ output: (ch) => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); packets.push(b); }, error: (e) => ev("encoderError", { e: String(e) }) });
  enc.configure({ codec: "opus", sampleRate: SR, numberOfChannels: 2, bitrate: 128000 });
  for (let off = 0; off < SR * 20; off += FRAME) {
    const d = new Float32Array(FRAME * 2);
    for (let i = 0; i < FRAME; i++) d[i] = d[FRAME + i] = 0.5 * Math.sin((2 * Math.PI * 440 * (off + i)) / SR);
    enc.encode(new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: FRAME, numberOfChannels: 2, timestamp: (off / SR) * 1e6, data: d }));
  }
  await enc.flush();
  enc.close();
  await fetch("/fixture.bin", { method: "POST", body: pack(packets) });
  ev("fixtureCreated", { packets: packets.length });
  return packets;
}
const pack = (ps: Uint8Array[]) => {
  const out = new Uint8Array(ps.reduce((n, p) => n + 2 + p.length, 0));
  let o = 0;
  for (const p of ps) { out[o] = p.length >> 8; out[o + 1] = p.length & 255; out.set(p, o + 2); o += 2 + p.length; }
  return out;
};
const unpack = (b: Uint8Array) => {
  const ps: Uint8Array[] = [];
  for (let o = 0; o < b.length; ) { const n = (b[o] << 8) | b[o + 1]; ps.push(b.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  return ps;
};

// Graph-level dropout monitor: RMS per 128-frame block and sample-step discontinuities.
// Only blocks fully inside the active window [from, to] (audio-clock seconds) are judged.
const MONITOR = `registerProcessor("monitor", class extends AudioWorkletProcessor {
  constructor() { super(); this.low = 0; this.jumps = 0; this.blocks = 0; this.prev = 0; this.from = 1e9; this.to = 0;
    this.port.onmessage = (e) => { this.port.postMessage({ low: this.low, jumps: this.jumps, blocks: this.blocks });
      this.low = this.jumps = this.blocks = 0; this.from = e.data.from; this.to = e.data.to; }; }
  process(inputs) { const x = inputs[0] && inputs[0][0];
    const t0 = currentTime, t1 = currentTime + 128 / sampleRate;
    if (t0 < this.from + 0.01 || t1 > this.to - 0.01) { if (x) this.prev = x[x.length - 1]; return true; }
    this.blocks++;
    if (!x) { this.low++; return true; }
    let s = 0; for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; if (Math.abs(x[i] - this.prev) > 0.15) this.jumps++; this.prev = x[i]; }
    if (Math.sqrt(s / x.length) < 0.1) this.low++; return true; } });`;

let ctx: AudioContext, decoder: OpusDecoder, packets: Uint8Array[], monitor: AudioWorkletNode, gain: GainNode;
const monitorRead = (from = 1e9, to = 0) => new Promise<any>((r) => { monitor.port.onmessage = (e) => r(e.data); monitor.port.postMessage({ from, to }); });

// Clock probes: currentTime update granularity, audio-vs-performance clock slope, output timestamp.
function clockProbe(ms: number) {
  return new Promise<any>((resolve) => {
    const steps: number[] = [], pairs: [number, number][] = [];
    let last = ctx.currentTime;
    const t0 = performance.now();
    const id = setInterval(() => {
      const now = performance.now(), ct = ctx.currentTime;
      if (ct !== last) { steps.push((ct - last) * 1000); last = ct; pairs.push([now, ct * 1000]); }
      if (now - t0 > ms) {
        clearInterval(id);
        steps.sort((a, b) => a - b);
        const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
        const slope = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
        const r: any = { updates: n, stepMedianMs: +steps[n >> 1]?.toFixed(2), stepMaxMs: +steps[n - 1]?.toFixed(2), audioVsPerfPpm: +((slope - 1) * 1e6).toFixed(0) };
        r.outputLatencyMs = (ctx as any).outputLatency !== undefined ? +((ctx as any).outputLatency * 1000).toFixed(1) : null;
        r.baseLatencyMs = ctx.baseLatency !== undefined ? +(ctx.baseLatency * 1000).toFixed(1) : null;
        if ("getOutputTimestamp" in ctx) {
          const ts = ctx.getOutputTimestamp(), ct2 = ctx.currentTime, pn = performance.now();
          r.outputTs = { contextTime: ts.contextTime, performanceTime: ts.performanceTime, currentMinusContextMs: +((ct2 - (ts.contextTime ?? 0)) * 1000).toFixed(1), nowMinusPerfTimeMs: +(pn - (ts.performanceTime ?? 0)).toFixed(1) };
        }
        resolve(r);
      }
    }, 1);
  });
}

// One playback phase: simulated network delivers chunk k at (k*100ms - lead + extraDelay), we decode and
// schedule it at its fixed slot on the audio clock. Late chunks start with an offset (or are dropped).
async function phase(name: string, leadMs: number, durationS: number, lateEvery = 0, lateExtraMs = 0) {
  phaseEl.textContent = name;
  const r: any = { name, leadMs, durationS, lateEvery, lateExtraMs, chunks: 0, lateChunks: 0, droppedChunks: 0, decodeErrors: 0, decodeMs: [] as number[], scheduleLeadMs: [] as number[] };
  decoder.reset();
  const nChunks = Math.round(durationS / CHUNK_S);
  const base = ctx.currentTime + 0.5 + leadMs / 1000; // slot 0 on the audio clock
  const startPerf = performance.now() + 500;
  await monitorRead(base, base + nChunks * CHUNK_S); // reset counters, arm window
  const deliveries = Array.from({ length: nChunks }, (_, k) => new Promise<void>((done) => {
    const late = lateEvery && k % lateEvery === lateEvery - 1 ? lateExtraMs : 0;
    setTimeout(() => {
      const ps = packets.slice((k * PER_CHUNK) % (packets.length - PER_CHUNK), ((k * PER_CHUNK) % (packets.length - PER_CHUNK)) + PER_CHUNK);
      const t0 = performance.now();
      const dec = decoder.decodeFrames(ps);
      r.decodeMs.push(performance.now() - t0);
      r.decodeErrors += dec.errors.length;
      const buf = ctx.createBuffer(2, dec.samplesDecoded, SR);
      buf.copyToChannel(dec.channelData[0] as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel((dec.channelData[1] ?? dec.channelData[0]) as Float32Array<ArrayBuffer>, 1);
      const when = base + k * CHUNK_S, now = ctx.currentTime;
      r.scheduleLeadMs.push((when - now) * 1000);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain); src.connect(monitor);
      if (when >= now + 0.003) src.start(when);
      else if (now + 0.003 < when + buf.duration) { r.lateChunks++; src.start(now + 0.003, now + 0.003 - when); }
      else r.droppedChunks++;
      r.chunks++;
      done();
    }, Math.max(0, startPerf + k * CHUNK_S * 1000 - performance.now() + late));
  }));
  const clock = clockProbe(Math.min(durationS * 1000, 5000));
  await Promise.all(deliveries);
  r.clock = await clock;
  await sleep(leadMs + 400);
  r.monitor = await monitorRead();
  const s = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return { p50: +b[b.length >> 1].toFixed(2), p95: +b[Math.floor(b.length * 0.95)].toFixed(2), max: +b[b.length - 1].toFixed(2) }; };
  r.decodeMs = s(r.decodeMs);
  r.scheduleLeadMs = s(r.scheduleLeadMs);
  R.phases.push(r);
  render();
}

function watchLifecycle() {
  let hide: { perf: number; ctx: number } | null = null;
  const rec = (name: string) => () => {
    if (name === "hidden") hide = { perf: performance.now(), ctx: ctx.currentTime };
    const extra: any = { ctxState: ctx.state, ctxTime: +ctx.currentTime.toFixed(3) };
    if (name === "visible" && hide) { extra.wallAwayMs = +(performance.now() - hide.perf).toFixed(0); extra.audioAdvancedMs = +((ctx.currentTime - hide.ctx) * 1000).toFixed(0); }
    ev(name, extra);
  };
  document.addEventListener("visibilitychange", () => rec(document.visibilityState)());
  addEventListener("pagehide", rec("pagehide"));
  addEventListener("pageshow", rec("pageshow"));
  ctx.addEventListener("statechange", rec("ctxStatechange"));
}

document.getElementById("start")!.addEventListener("click", async () => {
  try {
    if ("audioSession" in navigator) (navigator as any).audioSession.type = "playback";
    ctx = new AudioContext({ sampleRate: SR });
    R.caps.stateAtGestureCreate = ctx.state;
    await ctx.resume();
    R.caps.stateAfterResume = ctx.state;
    watchLifecycle();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([MONITOR], { type: "text/javascript" })));
    monitor = new AudioWorkletNode(ctx, "monitor");
    monitor.connect(ctx.destination); // must be pulled; outputs silence
    gain = ctx.createGain(); gain.gain.value = 0.15; gain.connect(ctx.destination);
    decoder = new OpusDecoder({ channels: 2 });
    await decoder.ready;
    packets = await loadFixture();
    R.fixturePackets = packets.length;
    await phase("A: lead 300 ms", 300, 8);
    await phase("B: lead 100 ms", 100, 6);
    await phase("C: lead 40 ms", 40, 6);
    await phase("D: lead 150 ms, every 10th chunk +250 ms late", 150, 8, 10, 250);
    await phase("E: background — lock the screen for ~10 s now, then return", 400, 30);
    R.verdict = verdict();
    phaseEl.textContent = "done";
  } catch (e) {
    ev("error", { e: String(e) });
    phaseEl.textContent = "error";
  }
  render();
  await fetch("/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(R) }).catch(() => {});
});

function verdict() {
  const [a, b, c, d] = R.phases;
  return {
    decodesRawOpusIncrementally: R.phases.every((p: any) => p.decodeErrors === 0) && R.fixturePackets > 0,
    gaplessAtLead300: a.monitor.low <= 2 && a.lateChunks === 0 && a.droppedChunks === 0,
    gaplessAtLead100: b.monitor.low <= 2 && b.lateChunks === 0,
    gaplessAtLead40: c.monitor.low <= 2 && c.lateChunks === 0,
    lateChunksHandled: d.lateChunks + d.droppedChunks > 0,
    decodeMsP95: a.decodeMs.p95,
  };
}

probe();
