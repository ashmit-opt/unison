// Smart Sync Doctor: turns a device's status report into a plain-language diagnosis with fixes.
// Pure (unit-tested). Every number shown is labelled by where it comes from — acoustic measurement,
// software estimate, or browser report — and nothing implies more precision than we have.
import type { Status } from "../shared/protocol.ts";

export type Level = "good" | "warn" | "bad" | "idle";
export type Action = "identify" | "resync" | "help-sync";
export type Fact = { label: string; value: string; source: "measured" | "estimate" | "browser" };
export type Diagnosis = { level: Level; title: string; detail: string; actions: Action[]; facts: Fact[] };

export type Context = {
  hostPlaying: boolean; // the host is sending audio right now
  autoSync: boolean; // the host mic is listening for codes
  heard: boolean; // the host (or a helper) mic currently hears this device's code
  recentGlitches: number; // playback faults in the last ~minute (late chunks, timing jumps, fell behind, resets)
  recent: { drops: number; jumps: number; under: number }; // the same, by cause
};

const ms = (x: number) => `${Math.round(x)} ms`;

export function diagnose(s: Status | undefined, c: Context): Diagnosis {
  const facts: Fact[] = [];
  if (!s) return { level: "idle", title: "Joining…", detail: "Waiting for this device's first report.", actions: [], facts };
  if (s.calibrated) facts.push({ label: "Sync correction", value: ms(s.offsetMs), source: "measured" });
  if (s.state === "playing") facts.push({ label: "Scheduling error", value: `${Math.abs(s.errMs) < 1 ? "<1 ms" : ms(Math.abs(s.errMs))}`, source: "estimate" });
  if (s.outLatMs > 0) facts.push({ label: "Output latency", value: ms(s.outLatMs), source: "browser" });
  facts.push({ label: "Network round trip", value: ms(s.rttMs), source: "measured" });
  if (s.uncMs > 0) facts.push({ label: "Clock uncertainty", value: s.uncMs < 1 ? "<1 ms" : `±${ms(s.uncMs)}`, source: "estimate" });
  if (s.bufferMs && s.state === "playing") facts.push({ label: "Audio buffered ahead", value: ms(s.bufferMs), source: "measured" });

  if (s.hidden) {
    return { level: "bad", title: "Screen off or app in the background", detail: "Phones pause web audio when locked or switched away. Keep Unison open with the screen on.", actions: ["identify"], facts };
  }
  if (s.authFail > 0) {
    return { level: "bad", title: "Can't decrypt the audio", detail: "This device may have an incomplete link. Rejoin with the full invite link or QR code.", actions: ["identify"], facts };
  }
  if (c.hostPlaying && s.state !== "playing") {
    const behind = s.bufferMs < 0;
    return {
      level: "bad", title: behind ? "Not playing — audio arrives too late" : "Not playing",
      detail: behind ? "The connection is too slow or unstable. Move closer to the Wi-Fi router, or switch off mobile data." : "It's connected but not playing yet. Try Re-sync; if that fails, rejoin from the link.",
      actions: ["resync", "identify"], facts,
    };
  }
  if (c.recentGlitches >= 3) {
    const r = c.recent;
    const cause = r.drops >= r.jumps && r.drops >= r.under ? "Audio is arriving late (weak or busy Wi-Fi)."
      : r.under >= r.jumps ? "The device is falling behind (too busy, or the browser was throttled)."
      : "Its clock estimate keeps jumping (unstable network).";
    const fix = r.drops >= r.jumps && r.drops >= r.under ? "Move it closer to the router or away from crowded 2.4 GHz Wi-Fi." : r.under >= r.jumps ? "Close other apps or tabs on it." : "Re-sync usually settles it.";
    return { level: "warn", title: `${c.recentGlitches} glitches in the last minute`, detail: `${cause} ${fix}`, actions: ["resync", "identify"], facts };
  }
  if (c.hostPlaying && c.autoSync && !c.heard && !s.calibrated) {
    const bt = s.outLatMs >= 100;
    return {
      level: "warn", title: "Not heard by the microphone yet",
      detail: `Auto-sync can't hear this device${bt ? " (it reports high output latency — maybe Bluetooth)" : ""}. Turn its volume up or move it closer to the host — or turn on Help sync on a phone near it. Headphones can't be heard: use Fine-tune on that device.`,
      actions: ["identify", "resync", "help-sync"], facts,
    };
  }
  if (s.calibrated) {
    return { level: "good", title: "In sync", detail: c.heard ? "Auto-sync hears it and keeps it lined up." : "Lined up by microphone measurement.", actions: ["identify", "resync"], facts };
  }
  if (s.state === "playing") {
    return { level: c.autoSync ? "warn" : "good", title: "Playing", detail: c.autoSync ? "Auto-sync is measuring this device…" : "Not acoustically synced yet — turn on auto-sync or calibrate with chirps for the tightest sync.", actions: ["identify", "resync"], facts };
  }
  return { level: "idle", title: s.state === "stopped" ? "Stopped" : "Ready", detail: "Waiting for music.", actions: ["identify"], facts };
}

/** Room-level summary line for the devices card. */
export function summarize(levels: Level[]): { level: Level; text: string } {
  const bad = levels.filter((l) => l === "bad").length, warn = levels.filter((l) => l === "warn").length;
  if (bad) return { level: "bad", text: `${bad} device${bad > 1 ? "s" : ""} need${bad > 1 ? "" : "s"} attention` };
  if (warn) return { level: "warn", text: `${warn} device${warn > 1 ? "s" : ""} still lining up` };
  if (levels.length < 2) return { level: "idle", text: "Waiting for devices" };
  return levels.every((l) => l === "idle") ? { level: "idle", text: "All devices ready" } : { level: "good", text: "Everything looks healthy" };
}
