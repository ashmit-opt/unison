// Acoustic calibration (spec §8, ADR-0005). Runs on the host: every device chirps in its own slot,
// the host microphone hears them, lags are compared, offsets adjusted, then verified.
import { accepted, analyzeLags, chirp, correlate } from "../shared/calib.ts";
import { MaxWindow } from "../shared/clock.ts";
import { SAMPLE_RATE } from "../shared/protocol.ts";
import type { Host } from "./host.ts";
import type { Connection } from "./net.ts";

/** A device to calibrate: how to make it chirp at a server time, and how to shift its offset. */
export type Target = { id: string; play(at: number, round: number): void; adjust(deltaMs: number): void };
export type CalResult = { spreadMs: number | null; rounds: number; lags: { id: string; lagMs: number | null }[] };

// Window [-200, +600] ms around each expected arrival; slots 900 ms apart so windows never see a neighbour.
const SLOT_MS = 900, START_MS = 1500, WIN_BEFORE = 0.2, WIN_AFTER = 0.6, MAX_ROUNDS = 4, GOOD_MS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `input` replaces the microphone (tests use a digital loopback). */
export async function calibrate(ctx: AudioContext, conn: Connection, host: Host, targets: Target[],
  progress: (msg: string) => void, input?: MediaStream): Promise<CalResult> {
  if (!targets.length) throw new Error("No devices to calibrate yet.");
  host.stop();
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session && !input) session.type = "play-and-record";
  const mic = input ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const src = ctx.createMediaStreamSource(mic);
  const rec = new AudioWorkletNode(ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const blocks: { frame: number; l: Float32Array }[] = [];
  const env = new MaxWindow(2000);
  rec.port.onmessage = (e) => {
    blocks.push({ frame: e.data.frame, l: e.data.l });
    env.add(performance.now(), ctx.currentTime * 1000 - performance.now());
  };
  src.connect(rec);
  rec.connect(ctx.destination);
  const template = chirp(SAMPLE_RATE);
  // Don't schedule chirps until the input is actually delivering audio (mic start-up takes a while).
  for (let i = 0; i < 60 && blocks.length < 10; i++) await sleep(50);
  if (blocks.length < 10) throw new Error("The microphone isn't delivering audio.");
  let result: CalResult = { spreadMs: null, rounds: 0, lags: [] };
  let missing = 0;
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      progress(round === 1 ? `Round 1 of up to ${MAX_ROUNDS}: listening to each device…` : `Round ${round} of up to ${MAX_ROUNDS}: checking${missing ? ` (${missing} not heard yet)` : ""}…`);
      blocks.length = 0;
      const base = conn.serverNow() + START_MS;
      const slots = targets.map((tg, i) => ({ tg, at: base + i * SLOT_MS }));
      for (const { tg, at } of slots) tg.play(at, round);
      while (conn.serverNow() < base + slots.length * SLOT_MS + 1000) await sleep(100);
      const lags = slots.map(({ at }) => measure(blocks, template, at, conn, env.value ?? 0));
      const { deltas, spreadMs } = analyzeLags(lags);
      result = { spreadMs, rounds: round, lags: slots.map(({ tg }, i) => ({ id: tg.id, lagMs: lags[i] })) };
      const allHeard = lags.every((l) => l !== null);
      missing = lags.filter((l) => l === null).length;
      const done = round > 1 && allHeard && spreadMs !== null && spreadMs <= GOOD_MS;
      if (done || round === MAX_ROUNDS) break;
      slots.forEach(({ tg }, i) => { if (deltas[i] !== null) tg.adjust(deltas[i]!); });
      await sleep(300);
    }
  } finally {
    src.disconnect();
    rec.disconnect();
    if (!input) mic.getTracks().forEach((t) => t.stop());
    if (session && !input) session.type = "playback";
  }
  return result;
}

/** Arrival lag (ms) of the chirp scheduled at server time `at`, or null if it wasn't clearly heard.
 *  Mic input latency and mapping bias are the same for every slot, so they cancel in lag differences. */
function measure(blocks: { frame: number; l: Float32Array }[], template: Float32Array, at: number, conn: Connection, envMs: number): number | null {
  if (!blocks.length) return null;
  const expectedFrame = ((at - conn.clock.offset + envMs) / 1000) * SAMPLE_RATE;
  const from = Math.round(expectedFrame - WIN_BEFORE * SAMPLE_RATE), to = Math.round(expectedFrame + WIN_AFTER * SAMPLE_RATE);
  const sig = new Float32Array(to - from);
  for (const b of blocks) {
    for (let i = 0; i < b.l.length; i++) {
      const k = b.frame + i - from;
      if (k >= 0 && k < sig.length) sig[k] = b.l[i];
    }
  }
  const m = correlate(sig, template);
  return accepted(m) ? ((from + m!.index - expectedFrame) / SAMPLE_RATE) * 1000 : null;
}
