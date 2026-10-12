// Entry: fonts, PWA bits, routing (landing → host or listener). Views live in ./views.
import { b64urlDecode } from "../shared/crypto.ts";
import { ROOM_RE } from "../shared/protocol.ts";
import { $, ic } from "./ui/dom.ts";
import { audioContext, shell, stateScreen } from "./views/common.ts";
import { startHost } from "./views/host.ts";
import { renderLanding } from "./views/landing.ts";
import { listenerGate } from "./views/listener.ts";

// Added from JS: Bun's HTML bundler would try to bundle these public/ paths.
for (const [rel, href] of [["manifest", "/manifest.webmanifest"], ["icon", "/icons/icon-192.png"], ["apple-touch-icon", "/icons/apple-touch-icon.png"]]) {
  document.head.append(Object.assign(document.createElement("link"), { rel, href }));
}
// Fonts (OFL, Latin subset, licences in public/fonts/). From JS too: in styles.css Bun inlined them as base64,
// making the render-blocking stylesheet 125 KB. Here they load alongside the first render (font-display: swap).
for (const [family, file, weight] of [["Inter Variable", "inter-latin-wght", "100 900"], ["Space Grotesk Variable", "space-grotesk-latin-wght", "300 700"]]) {
  const f = new FontFace(family, `url(/fonts/${file}.woff2) format("woff2")`, { weight, display: "swap" });
  document.fonts.add(f);
  f.load().catch(() => {}); // offline before first visit → system fonts
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
document.body.insertAdjacentHTML("afterbegin", `<div class="ambient" aria-hidden="true"></div>`);

function route() {
  const m = location.pathname.match(/^\/r\/([^/]+)$/);
  if (!m) return renderLanding(startHost);
  const room = m[1];
  const key = b64urlDecode(new URLSearchParams(location.hash.slice(1)).get("k") ?? "");
  if (!ROOM_RE.test(room) || !key || key.length !== 32) {
    return stateScreen("This link is incomplete", "The part after “#” is missing — it carries the room's encryption key. Ask the host to share the link again.", "alert", { label: "Host your own room", href: "/" });
  }
  const token = sessionStorage.getItem(`host:${room}`);
  if (!token) return listenerGate(room, key);
  shell("", `<main class="solo"><div class="inner">
    <p class="eyebrow">Your room</p><h1>Welcome back</h1>
    <p class="muted">Tap to reconnect as the host. Devices in the room stay connected and pick up where they left off.</p>
    <button class="orb" id="go" aria-label="Resume hosting"><span>${ic("play", 36)}Resume hosting</span></button>
  </div></main>`);
  $("go").onclick = () => void startHost(room, key, token, audioContext());
}

addEventListener("popstate", route);
route();
