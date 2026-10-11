// Landing: get someone to start a room in < 10 s (ADR-0008).
import { b64urlEncode, newRoomKey } from "../../shared/crypto.ts";
import { canHost } from "../host.ts";
import { $, ic } from "../ui/dom.ts";
import { audioContext, shell } from "./common.ts";

const DEVICES: ["phone" | "laptop" | "speaker" | "headphones", number, number][] = [
  ["phone", 50, 3.5], ["laptop", 92, 36], ["speaker", 80, 84], ["headphones", 20, 84], ["phone", 8, 36],
];

/** Lines from the core to each device, with a pulse travelling out on every beat. */
function beams(devs: typeof DEVICES) {
  const lines = devs.map(([, x, y]) => {
    const dx = x - 50, dy = y - 50, d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
    const [x1, y1, x2, y2] = [50 + ux * 12, 50 + uy * 12, 50 + ux * (d - 9), 50 + uy * (d - 9)].map((v) => v.toFixed(2));
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="pulse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  });
  return `<svg class="beams" viewBox="0 0 100 100" aria-hidden="true">${lines.join("")}</svg>`;
}

export function renderLanding(startHost: (room: string, key: Uint8Array, token: string, ctx: AudioContext) => Promise<void>) {
  shell(
    `<a class="btn btn-ghost btn-sm" href="#how">How it works</a><a class="btn btn-ghost btn-sm" href="#privacy">Privacy</a><button class="btn btn-sm" id="createTop">Start a room</button>`,
    `<main>
      <section class="hero">
        <div>
          <p class="live-pill reveal" id="live" hidden><span class="chip chip-ok"><span class="dot live"></span><span id="liveText"></span></span></p>
          <h1 class="reveal d1">Every device.<br><em>One sound.</em></h1>
          <p class="lede reveal d2">Turn the phones and laptops around you into one big speaker system, perfectly in sync. No app. No account. Just a link.</p>
          <div class="ctas reveal d3">
            <button class="btn btn-primary btn-lg" id="create">${ic("play", 18)}Start a room</button>
            <a class="btn btn-lg" href="#how">See how it works</a>
          </div>
          <p class="note-line" id="createNote" role="status"></p>
          <div class="fine reveal d4">
            <span>${ic("lock", 14)}End-to-end encrypted</span><span>${ic("zap", 14)}Auto-sync in milliseconds</span><span>${ic("users", 14)}Up to 32 devices</span>
          </div>
        </div>
        <div class="stage reveal d2" aria-hidden="true">
          <div class="orbit"></div>${beams(DEVICES)}<div class="wave"></div><div class="wave"></div><div class="wave"></div><div class="core"></div>
          ${DEVICES.map(([n, x, y]) => `<div class="dev" style="left:${x}%;top:${y}%">${ic(n, 24)}</div>`).join("")}
        </div>
      </section>
      <section class="proof" aria-label="Why Unison">
        ${[
          ["zap", "Syncs itself", "Every device lines itself up while the music plays — silently, down to a few milliseconds."],
          ["music", "Play anything", "Share a browser tab, drop in a file, or pick from millions of tracks on Audius."],
          ["lock", "Private by design", "End-to-end encrypted. Our server relays audio it can't hear, and keeps nothing."],
          ["phone", "No app, no account", "Friends scan a QR code and tap once. Works on phones, tablets and laptops."],
        ].map(([i, t, d]) => `<div class="item"><div class="badge">${ic(i as "zap", 20)}</div><h3>${t}</h3><p>${d}</p></div>`).join("")}
      </section>
      <section class="steps" id="how">
        <p class="eyebrow">How it works</p>
        <h2>From one laptop to a room full of sound.</h2>
        <ol>
          <li><h3>Start a room</h3><p>On a computer, tap Start a room. You get a QR code and a link — nothing to install.</p></li>
          <li><h3>Friends tap to join</h3><p>Everyone scans the code and taps once. Their phone becomes part of the speaker system.</p></li>
          <li><h3>Press play</h3><p>Pick a sample track, search Audius, drop a file or share a tab. Unison keeps every device in time.</p></li>
        </ol>
      </section>
      <section class="cta-band" id="privacy">
        <div><h2>Your music stays yours.</h2><p class="muted" style="margin-top:8px;max-width:56ch">The room key lives only in the invite link. Audio is encrypted on the host and decrypted on each device; the server only ever sees scrambled packets, and no audio is stored.</p></div>
        <button class="btn btn-primary btn-lg" id="createBottom">${ic("play", 18)}Start a room</button>
      </section>
      <footer class="footer"><span>Made for parties, study sessions and road trips.</span><span>Sample tracks streamed from Audius, credited to their artists.</span></footer>
    </main>`,
  );

  fetch("/api/live").then((r) => r.json()).then(({ listeners }: { listeners: number }) => {
    if (listeners > 0) {
      $("liveText").textContent = `${listeners} ${listeners === 1 ? "person" : "people"} listening right now`;
      $("live").hidden = false;
    }
  }).catch(() => {});

  void canHost().then((ok) => {
    if (!ok) $("createNote").textContent = "This browser can't host (no Opus encoder). Use Chrome, Edge or Firefox on a computer — you can still join rooms here.";
  });

  const create = async (btn: HTMLButtonElement) => {
    const ctx = audioContext(); // inside the gesture
    btn.disabled = true;
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error(res.status === 429 ? "Too many rooms created — try again in a minute." : "Couldn't create a room. Check your connection.");
      const { room, hostToken } = (await res.json()) as { room: string; hostToken: string };
      const key = newRoomKey();
      sessionStorage.setItem(`host:${room}`, hostToken);
      history.pushState(null, "", `/r/${room}#k=${b64urlEncode(key)}`);
      const go = () => startHost(room, key, hostToken, ctx);
      const vt = (document as Document & { startViewTransition?: (cb: () => Promise<void>) => unknown }).startViewTransition;
      if (vt) vt.call(document, go); else await go();
    } catch (e) {
      btn.disabled = false;
      $("createNote").textContent = String((e as Error).message ?? e);
    }
  };
  for (const id of ["create", "createTop", "createBottom"]) $<HTMLButtonElement>(id).onclick = (e) => create(e.currentTarget as HTMLButtonElement);
}
