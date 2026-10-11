// Listener: a live invite, one tap to join, then trust that it's in sync (ADR-0008, spec §5, §8.4).
import { importRoomKey, open, seal } from "../../shared/crypto.ts";
import { KIND_CTL, parseBinary, parseCtl, upHeader, type QueueView, type RequestMode, type SourceKind, type Up } from "../../shared/protocol.ts";
import { searchTracks, type Track } from "../audius.ts";
import { loadSamples } from "../samples.ts";
import { MicListener, type Lag } from "../autosync.ts";
import { Connection } from "../net.ts";
import { Player } from "../player.ts";
import { $, coverStyle, esc, fmtTime, ic, myName, toast } from "../ui/dom.ts";
import { Visualizer } from "../ui/visualizer.ts";
import { audioContext, debug, fatal, fmtMs, keepAwake, shell } from "./common.ts";

type Meta = { title?: string; artist?: string; kind?: SourceKind; art?: string };
type RoomInfo = { hostOnline: boolean; hostName?: string; devices: number; peerIds: number[]; meta: Meta; mode?: RequestMode; next?: QueueView[] };

const SOURCE_LABEL: Record<SourceKind, string> = {
  file: "From the host's music", audius: "On Audius", tab: "Shared from a browser tab", system: "System audio from the host", clicks: "Sync test signal",
};
const titleOf = (m: Meta) => m.title || (m.kind === "tab" ? "Shared tab" : m.kind === "system" ? "System audio" : m.kind ?? "");
const artHtml = (m: Meta) => {
  const t = titleOf(m);
  return m.art ? `<img src="${esc(m.art)}" alt="">` : t ? `<div style="position:absolute;inset:0;${coverStyle(t)}"></div>` : ic("music", 36);
};
const onArtError = (box: HTMLElement, m: Meta) =>
  box.querySelector("img")?.addEventListener("error", () => { box.innerHTML = `<div style="position:absolute;inset:0;${coverStyle(titleOf(m) || "x")}"></div>`; }, { once: true });

/** The invite: connects right away (no audio yet) so the guest sees whose room it is and what's playing. */
export function listenerGate(room: string, keyBytes: Uint8Array) {
  let name = myName();
  const info: RoomInfo = { hostOnline: false, devices: 0, peerIds: [], meta: {} };
  const conn = new Connection(room, "listener", undefined, name);
  const keyP = importRoomKey(keyBytes);
  shell(`<a class="btn btn-ghost btn-sm" href="/">Host your own room</a>`, `
    <main class="solo"><div class="inner">
      <div class="invite-card reveal" id="inviteCard">
        <div class="mini-art" id="gArt">${ic("music", 26)}</div>
        <div style="min-width:0;text-align:left">
          <p class="eyebrow" id="gHost">You're invited</p>
          <p class="g-title" id="gNow">Connecting to the room…</p>
          <p class="small faint" id="gDevs"></p>
        </div>
        <span class="chip" id="gLive"><span class="dot"></span>…</span>
      </div>
      <h1 class="reveal d1">Listen together</h1>
      <p class="muted reveal d2">Your device becomes one of the speakers in the room. Turn the volume up.</p>
      <button class="orb reveal d2" id="go" aria-label="Tap to join"><span>${ic("play", 36)}Tap to join</span></button>
      <p class="name-line reveal d3">Joining as <b id="nm"></b><button class="btn btn-ghost btn-sm" id="rename" aria-label="Pick a new name">${ic("refresh", 14)}New name</button></p>
      <p class="faint small reveal d4">Keep this screen on while you listen.</p>
    </div></main>`);
  $("nm").textContent = name;
  let shownArt = "";
  const render = () => {
    if (!document.getElementById("gNow")) return;
    const t = titleOf(info.meta);
    $("gHost").textContent = info.hostName ? `${info.hostName}'s room` : "You're invited";
    $("gNow").innerHTML = !conn.connected ? "Connecting to the room…" : !info.hostOnline ? "The host is away right now"
      : t ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span> <bdi>${esc(t)}</bdi>` : "Nothing playing yet";
    $("gDevs").textContent = info.devices ? `${info.devices} device${info.devices === 1 ? "" : "s"} in the room${info.meta.artist ? ` · ${info.meta.artist}` : ""}` : "";
    $("gLive").className = `chip ${conn.connected && info.hostOnline ? "chip-ok" : ""}`;
    $("gLive").innerHTML = conn.connected && info.hostOnline ? `<span class="dot live"></span>Live` : `<span class="dot"></span>${conn.connected ? "Waiting" : "…"}`;
    const k = `${info.meta.art}|${t}`;
    if (k !== shownArt) { shownArt = k; $("gArt").innerHTML = artHtml(info.meta); onArtError($("gArt"), info.meta); }
  };
  conn.onMessage = (m) => {
    if (m.type === "welcome") info.hostOnline = m.hostOnline;
    else if (m.type === "host") info.hostOnline = m.online;
    else if (m.type === "stop") info.meta = {};
    else if (m.type === "peers") {
      info.devices = m.peers.length;
      info.peerIds = m.peers.map((p) => p.peer);
      info.hostName = m.peers.find((p) => p.role === "host")?.name;
    }
    render();
  };
  // Before joining we only read encrypted control messages (what's playing); audio chunks are ignored.
  conn.onBinary = async (buf) => {
    const b = parseBinary(buf);
    if (!b || b.kind !== KIND_CTL) return;
    const pt = await open(await keyP, room, b.header, b.body);
    const c = pt && parseCtl(new TextDecoder().decode(pt));
    if (c && c.type === "meta") { info.meta = { title: c.title, artist: c.artist, kind: c.kind, art: c.art }; render(); }
    if (c && c.type === "queue") { info.mode = c.mode; info.next = c.next; }
  };
  conn.onState = render;
  conn.onFatal = fatal;
  conn.connect();
  $("rename").onclick = () => { name = myName(true); $("nm").textContent = name; conn.rename(name); };
  $<HTMLButtonElement>("go").onclick = (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    navigator.vibrate?.(18);
    startListener(room, keyBytes, conn, info).catch((err) => toast(String(err?.message ?? err), "warn"));
  };
}

async function startListener(room: string, keyBytes: Uint8Array, conn: Connection, info: RoomInfo) {
  const ctx = audioContext();
  void keepAwake();
  const key = await importRoomKey(keyBytes);
  const player = new Player(ctx, conn.clock, key, room);
  await player.init();
  const saved = JSON.parse(sessionStorage.getItem(`offset:${room}`) ?? "null");
  if (saved) Object.assign(player, saved);
  const save = () => sessionStorage.setItem(`offset:${room}`, JSON.stringify({ offsetMs: player.offsetMs, nudgeMs: player.nudgeMs, calibrated: player.calibrated }));
  let { hostOnline, devices, peerIds, meta } = info;
  let routeChanged = false, wasSynced = false;
  let reqMode: RequestMode = info.mode ?? "ask", upNext: QueueView[] = info.next ?? [];
  const myRequests = new Set<string>(); // audius ids requested from this device (for button state)
  let heard: Record<string, number> = {}, heardAt = 0;
  const calLatency = ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000;
  const helper = new MicListener(ctx, conn);
  helper.ids = () => peerIds;
  helper.onMeasure = (lags: Map<number, Lag>) => {
    heard = Object.fromEntries([...lags].map(([id, l]) => [String(id), Math.round(l.lagMs * 100) / 100]));
    heardAt = performance.now();
  };

  const go = () => shell(`<span class="chip" id="conn"><span class="dot"></span>Connecting</span>`, `
    <main class="solo player-solo"><div class="inner">
      <div class="status-row"><span class="chip" id="syncChip"></span><span class="chip" id="devs"></span></div>
      <div class="viz" id="viz"><canvas id="cv" aria-hidden="true"></canvas><div class="art" id="art">${ic("music", 40)}</div></div>
      <p class="status-line muted" id="st" aria-live="polite">Connecting…</p>
      <h1 class="title" id="title">Waiting for music</h1>
      <p class="muted" id="np"></p>
      <button class="btn btn-sm" id="reqBtn" style="margin-top:8px">${ic("send", 15)}<span id="reqLbl">Request a song</span></button>
      <div class="upnext" id="upnext" hidden><p class="eyebrow">Up next</p><ul class="list" id="upList" style="margin:0"></ul></div>
      <div class="volume"><span aria-hidden="true">${ic("speaker", 18)}</span><input type="range" class="range" id="vol" min="0" max="150" value="100" aria-label="Volume on this device"><b id="volVal">100%</b></div>
      <details class="settings">
        <summary>${ic("zap", 16)}Sync settings${ic("chevron", 16)}</summary>
        <div class="body">
          <div class="setting"><p id="sync" class="muted" style="margin:0"></p></div>
          <div class="setting">
            <div class="row"><h3><label for="nudge">Fine-tune this device</label></h3><b id="nudgeVal"></b></div>
            <input type="range" class="range" id="nudge" min="-300" max="300" step="1" value="${Math.round(player.nudgeMs)}">
            <p>Only needed with headphones, or if this device still sounds early or late.</p>
          </div>
          <div class="setting">
            <div class="row"><h3>Help sync</h3><label class="switch"><span id="helpSt"></span><input type="checkbox" id="help" aria-label="Help sync with this microphone"></label></div>
            <p>Far from the host? Lend this device's microphone so the speakers around you get lined up too. Only timing numbers leave this device — no audio is recorded or sent.</p>
          </div>
        </div>
      </details>
      <a class="btn" href="/" style="margin-top:8px">Host your own room</a>
    </div></main>`);
  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { updateCallbackDone: Promise<void> } }).startViewTransition;
  if (vt) await vt.call(document, go).updateCallbackDone; else go();

  const analyser = ctx.createAnalyser();
  player.out.connect(analyser);
  const viz = new Visualizer($<HTMLCanvasElement>("cv"), analyser);
  viz.start();
  let artShown = "";
  const timers: ReturnType<typeof setInterval>[] = [];

  const update = () => {
    if (!document.getElementById("st")) return; // view replaced (e.g. room ended)
    const s = player.status();
    const playing = s.state === "playing";
    $("st").textContent = !conn.connected ? "Reconnecting…" : !hostOnline ? "Waiting for the host…"
      : playing ? "Playing" : s.state === "stopped" ? "Host stopped playback" : "Connected — waiting for audio";
    $("conn").className = `chip ${conn.connected ? "chip-ok" : "chip-warn"}`;
    $("conn").innerHTML = `<span class="dot ${conn.connected ? "live" : ""}"></span>${conn.connected ? "Live" : "Reconnecting"}`;
    const synced = player.calibrated && !routeChanged;
    const chip = $("syncChip");
    chip.className = `chip ${synced ? "chip-ok" : player.pn && playing ? "chip-warn" : ""}${synced && !wasSynced ? " pop" : ""}`;
    chip.innerHTML = synced ? `${ic("check", 14)}In sync` : player.pn && playing ? `${ic("refresh", 14)}Lining up…` : `${ic("zap", 14)}Auto-sync ready`;
    if (synced && !wasSynced && playing) navigator.vibrate?.([10, 40, 10]);
    wasSynced = synced;
    $("devs").innerHTML = `${ic("users", 14)}${devices || 1} device${devices === 1 ? "" : "s"}`;
    const title = titleOf(meta);
    $("title").textContent = title || (hostOnline ? "Waiting for music" : "Waiting for the host");
    $("np").innerHTML = title ? `<bdi>${esc(meta.artist ?? SOURCE_LABEL[meta.kind ?? "file"])}</bdi>` : "";
    $("viz").classList.toggle("playing", playing);
    const artKey = `${meta.art ?? ""}|${title}`;
    if (artKey !== artShown) {
      artShown = artKey;
      $("art").innerHTML = title ? artHtml(meta) : ic("music", 40);
      onArtError($("art"), meta);
      setMediaSession(meta);
    }
    $("sync").textContent = player.pn
      ? (synced ? `Auto-sync is keeping this device in time (offset ${fmtMs(s.offsetMs)}).` : "Auto-sync is lining this device up with the others…")
      : routeChanged ? "Audio output changed — the host will re-sync automatically while music plays."
      : synced ? `Calibrated (offset ${fmtMs(s.offsetMs)}).` : "Sync starts automatically when the host plays something.";
    const n = player.nudgeMs;
    $("nudgeVal").textContent = `${n > 0 ? "+" : ""}${Math.round(n)} ms`;
    $<HTMLInputElement>("nudge").style.setProperty("--p", `${((n + 300) / 600) * 100}%`);
    $<HTMLInputElement>("help").checked = helper.running;
    $("helpSt").textContent = helper.running ? `Hears ${Object.keys(heard).length}` : "";
  };

  $<HTMLInputElement>("nudge").oninput = (e) => { player.nudgeMs = Number((e.target as HTMLInputElement).value); save(); update(); };
  const vol = $<HTMLInputElement>("vol");
  const setVol = () => {
    const v = Number(vol.value);
    player.out.gain.setTargetAtTime(v / 100, ctx.currentTime, 0.03);
    vol.style.setProperty("--p", `${(v / 150) * 100}%`);
    $("volVal").textContent = `${v}%`;
  };
  vol.oninput = setVol;
  setVol();
  $<HTMLInputElement>("help").onchange = async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    try {
      if (on) { await helper.start(); toast("Thanks — your mic is helping keep everyone in sync", "ok"); }
      else { helper.stop(); heard = {}; }
    } catch {
      toast("Microphone permission was denied", "warn");
    }
    update();
  };

  conn.onBinary = (b) => player.receive(b);
  player.onCtl = (c) => {
    if (c.type === "meta") meta = { title: c.title, artist: c.artist, kind: c.kind, art: c.art };
    else if (c.type === "cal-play") player.playChirp(c.at);
    else if (c.type === "cal-adjust") { player.offsetMs += c.deltaMs; player.calibrated = true; routeChanged = false; save(); }
    else if (c.type === "pn") player.pn = c.db === null || conn.peer === undefined ? null : { id: conn.peer, db: c.db };
    else if (c.type === "queue") { reqMode = c.mode; upNext = c.next; renderUpNext(); }
    else if (c.type === "request-result") toast(c.ok ? c.reason ?? "Added to the queue" : c.reason ?? "The host passed on this one", c.ok ? "ok" : "warn");
    update();
  };

  // ---- up next + song requests ----
  const renderUpNext = () => {
    if (!document.getElementById("upList")) return;
    $("upnext").hidden = !upNext.length;
    $("upList").innerHTML = upNext.slice(0, 4).map((q) => `<li class="row-item"><div class="thumb">${q.art ? `<img src="${esc(q.art)}" alt="">` : `<div style="width:100%;height:100%;${coverStyle(q.title)}"></div>`}</div>
      <div style="min-width:0"><div class="t"><bdi>${esc(q.title)}</bdi></div><div class="a">${q.artist ? `<bdi>${esc(q.artist)}</bdi>` : ""}${q.by ? ` · <span style="color:var(--mint)">${esc(q.by)}</span>` : ""}</div></div></li>`).join("");
    $<HTMLButtonElement>("reqBtn").disabled = reqMode === "off";
    $("reqLbl").textContent = reqMode === "off" ? "Requests are off" : reqMode === "auto" ? "Add a song" : "Request a song";
  };
  const sendRequest = async (t: Track) => {
    if (conn.peer === undefined) return;
    const up: Up = { type: "request", ref: crypto.randomUUID(), audiusId: t.id, title: t.title, artist: t.artist, art: t.art, durationS: t.durationS };
    conn.sendBinary(await seal(key, room, upHeader(conn.peer), new TextEncoder().encode(JSON.stringify(up))));
    myRequests.add(t.id);
    toast(reqMode === "auto" ? `Adding “${t.title}”…` : `Requested “${t.title}” — waiting for the host`);
  };
  const openSheet = () => {
    const scrim = Object.assign(document.createElement("div"), { className: "scrim" });
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Request a song");
    sheet.innerHTML = `<div class="sheet-head"><h2>${reqMode === "auto" ? "Add a song" : "Request a song"}</h2><button class="btn btn-ghost btn-icon btn-sm" id="sheetClose" aria-label="Close">${ic("x", 18)}</button></div>
      <form id="sheetForm" role="search"><label class="field">${ic("search", 18)}<input type="search" id="sheetQ" placeholder="Search Audius" aria-label="Search Audius"><button class="btn btn-primary btn-sm">Search</button></label></form>
      <ul class="list" id="sheetList"><li class="empty">Loading picks…</li></ul>`;
    const close = () => { scrim.remove(); sheet.remove(); removeEventListener("keydown", onKey); $("reqBtn").focus(); };
    const onKey = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") close(); };
    scrim.onclick = close;
    document.body.append(scrim, sheet);
    addEventListener("keydown", onKey);
    sheet.querySelector<HTMLButtonElement>("#sheetClose")!.onclick = close;
    const list = sheet.querySelector<HTMLUListElement>("#sheetList")!;
    const show = (tracks: Track[], empty: string) => {
      list.innerHTML = tracks.length ? "" : `<li class="empty">${esc(empty)}</li>`;
      for (const t of tracks) {
        const li = document.createElement("li");
        li.className = "row-item";
        const cover = `<div style="width:100%;height:100%;${coverStyle(t.title)}"></div>`;
        li.innerHTML = `<div class="thumb">${t.art ? `<img src="${esc(t.art)}" alt="">` : cover}</div><div style="min-width:0"><div class="t"><bdi>${esc(t.title)}</bdi></div><div class="a"><bdi>${esc(t.artist)}</bdi> · ${fmtTime(t.durationS)}</div></div>`;
        li.querySelector("img")?.addEventListener("error", (e) => { (e.target as HTMLElement).outerHTML = cover; }, { once: true });
        const b = document.createElement("button");
        b.className = "btn btn-sm btn-primary";
        const done = myRequests.has(t.id);
        b.disabled = done;
        b.innerHTML = done ? `${ic("check", 14)}Sent` : `${ic("send", 14)}${reqMode === "auto" ? "Add" : "Request"}`;
        b.onclick = async () => { b.disabled = true; b.innerHTML = `${ic("check", 14)}Sent`; await sendRequest(t); };
        li.append(b);
        list.append(li);
      }
    };
    loadSamples().then((t) => show(t, "Search for a song to request."));
    const q = sheet.querySelector<HTMLInputElement>("#sheetQ")!;
    q.focus();
    sheet.querySelector<HTMLFormElement>("#sheetForm")!.onsubmit = (e) => {
      e.preventDefault();
      if (!q.value.trim()) return;
      list.innerHTML = `<li class="empty">Searching…</li>`;
      searchTracks(q.value.trim()).then((t) => show(t, `No streamable tracks for “${q.value.trim()}”.`)).catch(() => show([], "Search isn't available right now."));
    };
  };
  $("reqBtn").onclick = openSheet;
  renderUpNext();
  conn.onMessage = (m) => {
    if (m.type === "welcome") hostOnline = m.hostOnline;
    else if (m.type === "host") { if (hostOnline && !m.online) toast("The host disconnected — music resumes when they're back", "warn"); hostOnline = m.online; }
    else if (m.type === "stop") { player.stop(m.epoch); meta = {}; }
    else if (m.type === "peers") { devices = m.peers.length; peerIds = m.peers.map((p) => p.peer); }
    update();
  };
  conn.onState = update;
  conn.onFatal = (code) => { viz.stop(); timers.forEach(clearInterval); helper.stop(); fatal(code); };
  timers.push(setInterval(() => {
    const fresh = helper.running && performance.now() - heardAt < 4000;
    conn.send({ type: "status", ...player.status(), ...(fresh ? { heard } : {}) });
    update();
  }, 2000));
  const watchRoute = () => {
    const lat = ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000;
    if (player.calibrated && Math.abs(lat - calLatency) > 5) { routeChanged = true; update(); }
  };
  navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (player.calibrated) { routeChanged = true; update(); } });
  timers.push(setInterval(watchRoute, 5000));
  timers.push(setInterval(update, 400)); // UI reflects playback state promptly (status messages stay at 2 s)
  conn.send({ type: "status", ...player.status() });
  update();
  Object.assign(debug, { player, conn, ctx, helper });
}

/** Lock-screen / notification metadata where the platform shows it for web audio. */
function setMediaSession(m: Meta) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  const t = titleOf(m);
  navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t, artist: m.artist ?? "Unison", album: "Listening together", artwork: m.art ? [{ src: m.art, sizes: "480x480" }] : [] }) : null;
}
