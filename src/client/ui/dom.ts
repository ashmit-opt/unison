// Small UI helpers: icons, escaping, toasts, friendly names, generated covers.
import {
  AudioLines, Check, ChevronDown, CircleAlert, Copy, Disc3, FileAudio, Headphones, Laptop, Link2, Lock, Mic, MicOff,
  MonitorSpeaker, Music, Pause, Play, Radio, RefreshCw, Search, Share2, Smartphone, Sparkles, Speaker, Square,
  Upload, UserRound, Users, WifiOff, Zap, ListMusic, Plus, Trash2, ChevronUp, X, Library, Send, ListPlus,
  createElement, type IconNode,
} from "lucide";

const ICONS = {
  audio: AudioLines, check: Check, chevron: ChevronDown, alert: CircleAlert, copy: Copy, disc: Disc3, file: FileAudio,
  headphones: Headphones, laptop: Laptop, link: Link2, lock: Lock, mic: Mic, micOff: MicOff, tab: MonitorSpeaker,
  music: Music, pause: Pause, play: Play, radio: Radio, refresh: RefreshCw, search: Search, share: Share2,
  phone: Smartphone, sparkles: Sparkles, speaker: Speaker, stop: Square, upload: Upload, user: UserRound, users: Users,
  offline: WifiOff, zap: Zap, list: ListMusic, plus: Plus, trash: Trash2, up: ChevronUp, x: X, library: Library,
  send: Send, queue: ListPlus,
} satisfies Record<string, IconNode>;
export type IconName = keyof typeof ICONS;

/** SVG markup for templates (decorative: aria-hidden). */
export function ic(name: IconName, size = 18): string {
  const el = createElement(ICONS[name], { width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true", class: "ic" });
  return el.outerHTML;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Transient notification, announced politely to screen readers. */
export function toast(msg: string, kind: "info" | "ok" | "warn" = "info") {
  let host = document.getElementById("toasts");
  if (!host) {
    host = Object.assign(document.createElement("div"), { id: "toasts", className: "toasts" });
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.innerHTML = `${ic(kind === "warn" ? "alert" : kind === "ok" ? "check" : "sparkles", 16)}<span>${esc(msg)}</span>`;
  host.append(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 3000);
}

const ADJ = ["cheerful", "sunny", "brave", "mellow", "cosmic", "lucky", "swift", "golden", "velvet", "electric", "quiet", "bouncy", "neon", "breezy", "jolly", "groovy"];
const NOUN = ["dolphin", "otter", "falcon", "panda", "comet", "koala", "lynx", "badger", "heron", "fox", "orca", "gecko", "robin", "yak", "moth", "tiger"];
export function friendlyName(): string {
  const r = crypto.getRandomValues(new Uint8Array(2));
  return `${ADJ[r[0] % ADJ.length]} ${NOUN[r[1] % NOUN.length]}`;
}

/** Stable device name, kept across rooms on this device (best effort). */
export function myName(regenerate = false): string {
  let n: string | null = null;
  try { n = regenerate ? null : localStorage.getItem("unison:name"); } catch { /* storage blocked */ }
  if (!n) {
    n = friendlyName();
    try { localStorage.setItem("unison:name", n); } catch { /* storage blocked */ }
  }
  return n;
}

/** Deterministic two-tone gradient cover for things without artwork (files, tabs). */
export function coverStyle(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + (h >> 9) % 80) % 360;
  return `background: radial-gradient(120% 120% at 20% 10%, hsl(${a} 70% 58%), transparent 60%), linear-gradient(135deg, hsl(${b} 55% 22%), hsl(${a} 45% 12%));`;
}

export function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join("").slice(0, 2);
}
