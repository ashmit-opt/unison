// Floating party reactions (host screen, Party Mode, and the sender's own screen as feedback).
import type { Reaction } from "../../shared/protocol.ts";
import { esc } from "./dom.ts";

export const EMOJI: Record<Reaction, string> = { fire: "🔥", heart: "❤️", hands: "🙌", party: "🎉", laugh: "😂" };
export const REACTION_LABEL: Record<Reaction, string> = { fire: "Fire", heart: "Love it", hands: "Hands up", party: "Party", laugh: "Haha" };

const MAX_ON_SCREEN = 24;

/** Float one reaction up from the bottom of `layer` (a fixed, pointer-events:none container). */
export function floatReaction(layer: HTMLElement, r: Reaction, by?: string) {
  if (layer.childElementCount >= MAX_ON_SCREEN) layer.firstElementChild?.remove();
  const el = document.createElement("span");
  el.className = "rx";
  el.style.left = `${8 + Math.random() * 84}%`;
  el.style.setProperty("--sway", `${(Math.random() - 0.5) * 80}px`);
  el.innerHTML = `<b>${EMOJI[r]}</b>${by ? `<small>${esc(by)}</small>` : ""}`;
  layer.append(el);
  setTimeout(() => el.remove(), 3200);
}

/** Per-sender rate limit for incoming reactions: at most `n` per `windowMs`. */
export function reactionLimiter(n = 6, windowMs = 5000, now = () => performance.now()) {
  const seen = new Map<number, number[]>();
  return (peer: number) => {
    const t = now(), recent = (seen.get(peer) ?? []).filter((x) => t - x < windowMs);
    const ok = recent.length < n;
    if (ok) recent.push(t);
    seen.set(peer, recent);
    return ok;
  };
}
