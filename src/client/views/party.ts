// Party Mode (host): a full-screen display for a TV or laptop — big visualizer, what's playing, a QR
// code to join, how many are listening, sync health, and guests' reactions floating up.
import { renderSVG } from "uqr";
import type { Reaction } from "../../shared/protocol.ts";
import type { Level } from "../doctor.ts";
import { esc, ic, setInert } from "../ui/dom.ts";
import { floatReaction } from "../ui/reactions.ts";
import { Visualizer } from "../ui/visualizer.ts";

export type PartyState = { playing: boolean; label: string; title: string; artist: string; artHtml: string; listeners: number; health: { level: Level; text: string }; locked: boolean };
export type Party = { update(s: PartyState): void; react(r: Reaction, by: string): void; close(): void };

export function openParty(link: string, analyser: AnalyserNode, onClose: () => void): Party {
  const opener = document.activeElement as HTMLElement | null;
  const ov = document.createElement("div");
  ov.className = "party";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", "Party mode");
  ov.innerHTML = `
    <div class="viz party-viz" id="pViz"><canvas id="pcv" aria-hidden="true"></canvas><div class="art" id="pArt"></div></div>
    <div class="party-now">
      <p class="eyebrow" id="pLabel"></p>
      <h2 class="party-title" id="pTitle"></h2>
      <p class="party-artist" id="pArtist"></p>
    </div>
    <div class="party-join" id="pJoin">
      <div class="qr">${renderSVG(link, { border: 1 })}</div>
      <div><p class="party-join-h" id="pJoinH">Scan to join</p><p class="party-count" id="pCount" aria-live="polite"></p><p class="party-health" id="pHealth"></p></div>
    </div>
    <button class="btn btn-ghost btn-sm party-exit" id="pExit">${ic("x", 16)}Exit party mode</button>
    <div class="rx-layer" id="pRx" aria-hidden="true"></div>`;
  document.body.append(ov);
  setInert(true);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => ov.querySelector<T>(`#${id}`)!; // a closing copy may still be fading out
  ov.requestFullscreen?.().catch(() => {}); // windowed if the browser says no
  const viz = new Visualizer($<HTMLCanvasElement>("pcv"), analyser);
  viz.start();
  let art = "";

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement) close(); };
  window.addEventListener("keydown", onKey);
  function close() {
    setInert(false);
    viz.stop();
    window.removeEventListener("keydown", onKey);
    if (document.fullscreenElement === ov) document.exitFullscreen().catch(() => {});
    ov.classList.add("out");
    setTimeout(() => { ov.remove(); if (opener?.isConnected) opener.focus(); }, 250);
    onClose();
  }
  $("pExit").onclick = close;
  $("pExit").focus();

  return {
    update(s) {
      if (!ov.isConnected) return;
      $("pViz").classList.toggle("playing", s.playing);
      $("pLabel").textContent = s.label;
      $("pTitle").textContent = s.title;
      $("pArtist").textContent = s.artist;
      if (s.artHtml !== art) $("pArt").innerHTML = art = s.artHtml;
      $("pJoin").classList.toggle("locked", s.locked);
      $("pJoinH").textContent = s.locked ? "Room locked" : "Scan to join";
      $("pCount").innerHTML = s.listeners ? `<b>${s.listeners}</b> ${s.listeners === 1 ? "phone" : "phones"} listening` : "Be the first to join";
      $("pHealth").className = `party-health lvl-${s.health.level}`;
      $("pHealth").innerHTML = s.listeners ? `${ic(s.health.level === "good" ? "check" : s.health.level === "bad" ? "alert" : "refresh", 14)}${esc(s.health.text)}` : "";
    },
    react(r, by) { floatReaction($("pRx"), r, by); },
    close,
  };
}
