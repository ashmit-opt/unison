// Pieces shared by every view: app shell, audio unlock, wake lock, full-screen states, debug hook.
import { SAMPLE_RATE, type ErrorCode } from "../../shared/protocol.ts";
import { esc, ic, setInert } from "../ui/dom.ts";

export const app = () => document.getElementById("app")!;
export const debug: Record<string, unknown> = ((window as unknown as { __unison: Record<string, unknown> }).__unison ??= {});

export const brand = `<a class="brand" href="/" aria-label="Unison home"><span class="logo" aria-hidden="true"><i></i><i></i><i></i></span>Unison</a>`;

export function shell(nav: string, body: string) {
  app().innerHTML = `<div class="wrap"><header class="topbar">${brand}<nav class="nav">${nav}</nav></header>${body}</div>`;
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

/** Must run inside a user gesture: creates and unlocks audio (iOS needs a sound started in the gesture). */
export function audioContext(): AudioContext {
  const s = (navigator as AudioSessionNav).audioSession;
  if (s) s.type = "playback"; // don't let the iPhone ringer switch mute us
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
  void ctx.resume();
  const b = ctx.createBufferSource();
  b.buffer = ctx.createBuffer(1, 1, SAMPLE_RATE);
  b.connect(ctx.destination);
  b.start();
  return ctx;
}

let wakeLock: { release(): Promise<void> } | null = null;
export async function keepAwake() {
  try {
    wakeLock = (await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
  } catch { /* unsupported or denied */ }
}
document.addEventListener("visibilitychange", () => { if (wakeLock && document.visibilityState === "visible") void keepAwake(); });

const FATAL: Record<string, [string, string]> = {
  "bad-version": ["Unison was updated", "Reload to get the latest version — it only takes a second."],
  "no-room": ["This room doesn't exist", "It may have ended, or the link was copied incompletely."],
  "room-closed": ["This room has ended", "Thanks for listening. Start your own room in one tap."],
  "bad-token": ["Couldn't resume hosting", "This room can only be hosted from the tab that created it."],
  "room-full": ["This room is full", "A room holds up to 32 devices."],
  "replaced": ["Hosting moved to another tab", "This room is now being hosted from somewhere else."],
  "locked": ["This room is locked", "The host isn't letting new devices in right now. Ask them to unlock it, then try again."],
  "removed": ["You were removed from the room", "The host disconnected this device."],
};

/** Full-screen end state with a way forward. */
export function stateScreen(title: string, body: string, glyph: "alert" | "offline" | "lock" = "alert", action?: { label: string; href?: string; onClick?: () => void }) {
  document.querySelectorAll(".overlay, .party, .sheet, .scrim").forEach((e) => e.remove()); // e.g. the room ended under the big QR
  setInert(false);
  shell("", `<main class="state"><div class="inner">
    <div class="glyph">${ic(glyph, 28)}</div>
    <h1>${esc(title)}</h1>
    <p class="muted">${esc(body)}</p>
    ${action ? `<a class="btn btn-primary btn-lg" id="stateAction" href="${action.href ?? "#"}">${esc(action.label)}</a>` : ""}
  </div></main>`);
  if (action?.onClick) document.getElementById("stateAction")!.onclick = (e) => { e.preventDefault(); action.onClick!(); };
}

export function fatal(code: ErrorCode) {
  const [title, body] = FATAL[code] ?? ["Something went wrong", code];
  if (code === "locked") {
    stateScreen(title, body, "lock", { label: "Try again", onClick: () => location.reload() });
  } else if (code === "bad-version") {
    stateScreen(title, body, "alert", { label: "Reload", onClick: async () => { await (await navigator.serviceWorker?.getRegistration())?.update(); location.reload(); } });
  } else {
    stateScreen(title, body, "alert", { label: "Host your own room", href: "/" });
  }
  // keep the old banner hook for tests/automation
  const b = document.getElementById("banner");
  if (b) { b.hidden = false; b.textContent = `${title}. ${body}`; }
}

export const fmtMs = (x: number) => `${Math.round(x)} ms`;
