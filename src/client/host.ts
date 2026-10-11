// Host pipeline (spec §5.3–5.4): any source node → tap worklet → Opus encoder → chunks → seal → relay.
import { DriftTracker } from "../shared/clock.ts";
import { seal } from "../shared/crypto.ts";
import {
  FRAME_SAMPLES, FRAMES_PER_CHUNK, LEAD_MS, SAMPLE_RATE, chunkHeader, ctlHeader, packPackets, type Ctl, type SourceKind,
} from "../shared/protocol.ts";
import type { Connection } from "./net.ts";
import type { Player } from "./player.ts";

const ENC_CONFIG = { codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000 } as const;
const utf8 = new TextEncoder();

export class UserError extends Error {}

export type Meta = { title?: string; artist?: string; url?: string; art?: string };

export async function canHost(): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try { return !!(await AudioEncoder.isConfigSupported(ENC_CONFIG)).supported; } catch { return false; }
}

export function canCapture(): boolean {
  return !!navigator.mediaDevices?.getDisplayMedia && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

export class Host {
  epoch: number;
  kind: SourceKind | null = null;
  meta: Meta = {};
  local: Player | null = null;
  onChange: () => void = () => {};
  onError: (msg: string) => void = () => {};
  /** The user stopped sharing from the browser's own bar. */
  onEnded: () => void = () => {};
  /** Smoothed input level (RMS, 0..1) of whatever is being sent — proof that a shared tab is audible. */
  level = 0;
  private tap!: AudioWorkletNode;
  private enc: AudioEncoder | null = null;
  private input: AudioNode | null = null;
  private cleanup: (() => void) | undefined;
  private seq = 0;
  private sample = 0;
  private anchor = NaN;
  private drift = new DriftTracker();
  private pending: { ts: number; data: Uint8Array }[] = [];
  private sendQ: Promise<void> = Promise.resolve();
  private elementNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  /** Anchor corrections applied (ms), for diagnostics. */
  anchorSteps: number[] = [];

  constructor(readonly ctx: AudioContext, private conn: Connection, private key: CryptoKey, private room: string, startEpoch: number) {
    this.epoch = startEpoch;
  }

  async init() {
    await this.ctx.audioWorklet.addModule("/tap-worklet.js");
    this.tap = new AudioWorkletNode(this.ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
    this.tap.connect(this.ctx.destination); // outputs silence; connection keeps it processing
    this.tap.port.onmessage = (e) => this.onBlock(e.data);
  }

  // ---- sources ----
  /** Share a browser tab (or system audio). `meta` labels it for listeners, e.g. { title: "Spotify" }. */
  async useCapture(meta: Meta = {}): Promise<SourceKind> {
    // CaptureController (Chrome 109+) lets us keep focus on Unison after the pick instead of jumping to the tab.
    const Ctrl = (globalThis as { CaptureController?: new () => { setFocusBehavior(b: string): void } }).CaptureController;
    const controller = Ctrl ? new Ctrl() : undefined;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, displaySurface: "browser" }, // picker opens on the tabs list
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include", // "Share this tab instead" in Chrome's bar
      ...(controller ? { controller } : {}),
    } as DisplayMediaStreamOptions);
    try { controller?.setFocusBehavior("no-focus-change"); } catch { /* only allowed right after the pick */ }
    const audio = stream.getAudioTracks()[0];
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop());
      throw new UserError("No audio was shared. Pick a tab and turn on “Share tab audio” (or choose a screen with “Share system audio”).");
    }
    const surface = (stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    const kind: SourceKind = surface === "browser" ? "tab" : "system";
    const node = this.ctx.createMediaStreamSource(new MediaStream([audio]));
    this.setInput(node, kind, { title: kind === "tab" ? "Shared tab" : "System audio", ...meta }, () => stream.getTracks().forEach((t) => t.stop()));
    audio.onended = () => { this.stop(); this.onEnded(); };
    return kind;
  }

  /** File or Audius: an <audio> element routed only into the graph (silent locally; heard via the local player). */
  useElement(el: HTMLMediaElement, kind: "file" | "audius", meta: Meta) {
    let node = this.elementNodes.get(el);
    if (!node) {
      node = this.ctx.createMediaElementSource(el);
      this.elementNodes.set(el, node);
    }
    this.setInput(node, kind, meta, () => el.pause());
  }

  /** 5 ms clicks every 500 ms: used to measure sync with an external recorder (spec §10.1 B). */
  useClicks() {
    const buf = this.ctx.createBuffer(1, SAMPLE_RATE / 2, SAMPLE_RATE), d = buf.getChannelData(0);
    for (let i = 0; i < 240; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 2000 * i) / SAMPLE_RATE);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    this.setInput(src, "clicks", { title: "Test clicks" }, () => src.stop());
  }

  private setInput(node: AudioNode, kind: SourceKind, meta: Meta, cleanup?: () => void) {
    this.detach();
    this.epoch++;
    this.seq = 0;
    this.sample = 0;
    this.anchor = NaN;
    this.drift = new DriftTracker();
    this.pending = [];
    this.level = 0;
    this.kind = kind;
    this.meta = meta;
    this.enc = new AudioEncoder({ output: (c) => this.onPacket(c), error: (e) => this.onError(`Encoder error: ${e.message}`) });
    this.enc.configure({ ...ENC_CONFIG, opus: { frameDuration: 20_000 } } as AudioEncoderConfig);
    this.tap.port.postMessage("reset");
    this.input = node;
    this.cleanup = cleanup;
    node.connect(this.tap);
    this.sendCtl(0, { type: "meta", epoch: this.epoch, kind, ...meta });
    this.onChange();
  }

  private detach() {
    if (this.input) { try { this.input.disconnect(this.tap); } catch { /* not connected */ } }
    this.cleanup?.();
    this.cleanup = undefined;
    this.input = null;
    if (this.enc && this.enc.state !== "closed") this.enc.close();
    this.enc = null;
  }

  stop() {
    if (!this.input) return;
    this.detach();
    this.conn.send({ type: "stop", epoch: this.epoch });
    this.local?.stop(this.epoch);
    this.kind = null;
    this.meta = {};
    this.onChange();
  }

  // ---- encode → chunk → seal ----
  private onBlock({ l, r }: { l: Float32Array; r: Float32Array }) {
    const enc = this.enc;
    if (!enc || !this.input || enc.state !== "configured") return;
    if (!this.conn.clock.ready) return; // timestamps need the server offset; first pings take ~0.5 s
    const now = this.conn.serverNow();
    if (Number.isNaN(this.anchor)) this.anchor = now + LEAD_MS;
    const corr = this.drift.add(now, (this.sample / SAMPLE_RATE) * 1000);
    if (corr) {
      this.anchor += corr; // keep the lead constant as the capture clock drifts (listeners slew it away)
      this.anchorSteps.push(Math.round(corr * 10) / 10);
    }
    const data = new Float32Array(FRAME_SAMPLES * 2);
    data.set(l);
    data.set(r, FRAME_SAMPLES);
    let e = 0;
    for (let i = 0; i < l.length; i++) e += l[i] * l[i] + r[i] * r[i];
    this.level += (Math.sqrt(e / (2 * l.length)) - this.level) * 0.2;
    const frame = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 2, timestamp: Math.round((this.sample * 1e6) / SAMPLE_RATE), data });
    enc.encode(frame);
    frame.close();
    this.sample += FRAME_SAMPLES;
  }

  private onPacket(c: EncodedAudioChunk) {
    const b = new Uint8Array(c.byteLength);
    c.copyTo(b);
    this.pending.push({ ts: c.timestamp, data: b });
    if (this.pending.length < FRAMES_PER_CHUNK) return;
    const ps = this.pending.splice(0, FRAMES_PER_CHUNK);
    const t = this.anchor + (ps[0].ts / 1e6) * 1000;
    const epoch = this.epoch, seq = this.seq++, packets = ps.map((p) => p.data);
    this.local?.push(epoch, seq, t, packets);
    const plain = packPackets(packets);
    this.sendQ = this.sendQ
      .then(async () => this.conn.sendBinary(await seal(this.key, this.room, chunkHeader({ epoch, seq, t }), plain)))
      .catch((e) => console.error("send", e));
  }

  sendCtl(to: number, ctl: Ctl) {
    const body = utf8.encode(JSON.stringify(ctl));
    this.sendQ = this.sendQ
      .then(async () => this.conn.sendBinary(await seal(this.key, this.room, ctlHeader(to), body)))
      .catch((e) => console.error("send", e));
  }

  /** Change what listeners see as "now playing" without restarting the source. */
  setMeta(meta: Meta) {
    if (!this.kind) return;
    this.meta = { ...this.meta, ...meta };
    this.sendCtl(0, { type: "meta", epoch: this.epoch, kind: this.kind, ...this.meta });
    this.onChange();
  }

  /** Re-send what's playing to peers that just joined. */
  announceTo(peer: number) {
    if (this.kind) this.sendCtl(peer, { type: "meta", epoch: this.epoch, kind: this.kind, ...this.meta });
  }
}
