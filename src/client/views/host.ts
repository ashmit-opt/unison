// Host: get sound playing and devices joined (ADR-0008, spec §5, §8).
import { renderSVG } from "uqr";
import { b64urlEncode, importRoomKey, open } from "../../shared/crypto.ts";
import { KIND_UP, parseBinary, parseUp, type PeerInfo, type Reaction, type RequestMode, type SongRequest, type SourceKind, type Status } from "../../shared/protocol.ts";
import { getTrack, searchTracks, streamUrl, type Track } from "../audius.ts";
import { AutoSyncHost, MicListener } from "../autosync.ts";
import { calibrate, type Target } from "../calibrate.ts";
import { diagnose, summarize, type Action, type Diagnosis, type Level } from "../doctor.ts";
import { Host, UserError, canCapture, canHost } from "../host.ts";
import { Connection } from "../net.ts";
import { Player } from "../player.ts";
import { library, trackTitle, type Playlist } from "../library.ts";
import { Queue, newId, type QItem } from "../queue.ts";
import { loadSamples } from "../samples.ts";
import { $, coverStyle, esc, fmtTime, ic, myName, setInert, toast } from "../ui/dom.ts";
import { Visualizer } from "../ui/visualizer.ts";
import { floatReaction, reactionLimiter } from "../ui/reactions.ts";
import { openParty, type Party } from "./party.ts";
import { debug, fatal, fmtMs, keepAwake, shell } from "./common.ts";

type Tab = "samples" | "audius" | "file" | "tab";

/** Music services that play in a browser tab (shared via tab capture — no integration with the service). */
const SERVICES = [
  { id: "jiosaavn", name: "JioSaavn", url: "https://www.jiosaavn.com", color: "#2bc5b4", hint: "Bollywood & Indian hits" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com", color: "#1ed760", hint: "Free or Premium" },
  { id: "ytmusic", name: "YouTube Music", url: "https://music.youtube.com", color: "#ff4e45", hint: "Songs, albums, mixes" },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com", color: "#ff3355", hint: "Videos & live sets" },
  { id: "apple", name: "Apple Music", url: "https://music.apple.com", color: "#fa586a", hint: "Subscription needed" },
] as const;
type Service = (typeof SERVICES)[number];
const SOURCE_LABEL: Record<SourceKind, string> = { file: "Your file", audius: "Audius", tab: "Browser tab", system: "System audio", clicks: "Test signal" };

/** Audius artwork comes from community-run nodes that sometimes fail: swap in a generated cover. */
function fallbackCover(root: HTMLElement, seed: string) {
  root.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => {
    const d = document.createElement("div");
    d.setAttribute("style", `position:absolute;inset:0;${coverStyle(seed)}`);
    img.replaceWith(d);
  }, { once: true }));
}

export async function startHost(room: string, keyBytes: Uint8Array, token: string, ctx: AudioContext) {
  void keepAwake();
  const key = await importRoomKey(keyBytes);
  const conn = new Connection(room, "host", token, myName());
  const local = new Player(ctx, conn.clock);
  await local.init();
  const hosting = await canHost();
  const capture = canCapture();
  const link = `${location.origin}/r/${room}#k=${b64urlEncode(keyBytes)}`;
  const peers = new Map<number, { info: PeerInfo; status?: Status }>();
  const announced = new Set<number>();
  let host: Host | null = null;
  let spreadMs: number | undefined;
  let calibrating = false;
  let autoSync: "idle" | "on" | "denied" = "idle";
  let activeTrack = "";
  let tab: Tab = "samples";
  const syncedOnce = new Set<number>();
  const queue = new Queue();
  let reqMode: RequestMode = (sessionStorage.getItem("unison:req") as RequestMode) || "ask";
  const pending: { ref: string; peer: number; name: string; item: QItem }[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  shell(`<span class="chip" id="liveChip"><span class="dot"></span>Connecting</span>`, `
    <main class="room">
      <div class="main-col">
        <section class="card now" aria-label="Now playing">
          <div class="viz" id="viz"><canvas id="cv" aria-hidden="true"></canvas><div class="art" id="art">${ic("music", 40)}</div></div>
          <div class="meta">
            <p class="eyebrow" id="srcLabel">Nothing playing yet</p>
            <h1 class="title" id="npTitle">Pick something to play</h1>
            <p class="artist" id="npArtist">Start with a sample track below — every device in the room plays it in sync.</p>
            <div class="scrub" id="scrub" hidden><span id="cur">0:00</span><input type="range" class="range" id="seek" min="0" max="1000" value="0" aria-label="Seek"><span id="dur">0:00</span></div>
            <div class="transport">
              <button class="btn btn-primary btn-round" id="pp" hidden aria-label="Pause">${ic("pause", 22)}</button>
              <button class="btn" id="stop" disabled>${ic("stop", 16)}Stop</button>
              <button class="btn btn-ghost" id="partyBtn" title="Full-screen display for a TV or laptop (P)">${ic("sparkles", 16)}Party mode</button>
              <label class="switch"><input type="checkbox" id="localOn" checked>Play here too</label>
            </div>
            <p class="err-line" id="hostErr" role="alert" style="margin-top:12px"></p>
          </div>
        </section>
        <section class="card" aria-label="Up next">
          <h2 class="card-title">${ic("list", 16)}Up next<span class="end q-head">
            <label class="select-wrap" title="Who can add songs">${ic("users", 14)}<span class="sr">Song requests</span>
              <select id="reqMode" aria-label="Song requests from guests"><option value="ask">Guests can request · you approve</option><option value="auto">Guests add songs freely</option><option value="off">Requests off</option></select></label>
          </span></h2>
          <ul class="requests" id="requests"></ul>
          <ul class="queue" id="queue"></ul>
          <div class="queue-actions">
            <button class="btn btn-sm btn-ghost" id="qSave">${ic("library", 14)}Save as playlist</button>
            <span class="q-save" id="qSaveRow" hidden><label class="field field-sm"><input id="qName" placeholder="Playlist name" maxlength="60"><button class="btn btn-primary btn-sm" id="qSaveGo">Save</button></label></span>
            <button class="btn btn-sm btn-ghost" id="qClear">${ic("trash", 14)}Clear</button>
          </div>
        </section>
        <section class="card" aria-label="Choose what to play">
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" data-tab="samples">${ic("sparkles", 16)}Samples</button>
            <button class="tab" role="tab" data-tab="audius">${ic("search", 16)}<span>Audius</span></button>
            <button class="tab" role="tab" data-tab="file">${ic("library", 16)}<span><span class="lbl-long">Your </span>music</span></button>
            <button class="tab" role="tab" data-tab="tab">${ic("tab", 16)}<span><span class="lbl-long">Browser </span>tab</span></button>
          </div>
          <p class="note" id="nohost" hidden style="margin-top:16px">${ic("alert", 16)}<span>This browser can't host (no Opus encoder). Open this link in Chrome, Edge or Firefox on a computer.</span></p>
          <div class="panel" data-panel="samples">
            <div class="panel-head"><p class="muted small">Hand-picked tracks from independent artists on Audius. Tap one to play it everywhere.</p></div>
            <div class="grid-tracks" id="samples">${Array.from({ length: 8 }, () => `<div><div class="skeleton cover-sk"></div><div class="skeleton line-sk"></div></div>`).join("")}</div>
          </div>
          <div class="panel" data-panel="audius" hidden>
            <form id="aud" role="search"><label class="field">${ic("search", 18)}<input type="search" id="q" placeholder="Search millions of tracks on Audius" aria-label="Search Audius" aria-keyshortcuts="/"><button class="btn btn-primary btn-sm">Search</button></label></form>
            <ul class="list" id="results"></ul>
          </div>
          <div class="panel" data-panel="file" hidden>
            <label class="drop" id="drop">
              <div class="big">${ic("upload", 26)}</div>
              <div><b>Drop songs here</b> or click to browse</div>
              <div class="faint small">Saved in this browser so you never upload them twice. They never leave this computer — only encrypted audio is sent while playing.</div>
              <input type="file" id="file" accept="audio/*" multiple class="sr">
            </label>
            <div class="lib-head"><h3>Your songs</h3><span class="faint small" id="libUsage"></span></div>
            <ul class="list" id="libList"><li class="empty">Songs you add appear here.</li></ul>
            <div class="lib-head"><h3>Playlists</h3></div>
            <ul class="list" id="plList"><li class="empty">Save the queue as a playlist to keep it for next time.</li></ul>
          </div>
          <div class="panel" data-panel="tab" hidden>
            <div class="tab-flow">
              <div class="note" id="capnote" ${capture ? "hidden" : ""}>${ic("alert", 16)}<span>Sharing a tab needs Chrome or Edge on a computer. On this device, use Samples, Audius or a file.</span></div>
              <div class="step-head"><span class="num">1</span><div><h3>Open your music</h3><p class="faint small">It opens in a new tab — sign in if the service needs it, then press play there.</p></div></div>
              <div class="services">${SERVICES.map((v) => `<a class="svc" href="${v.url}" target="_blank" rel="noopener" data-svc="${v.id}" style="--svc:${v.color}">
                <span class="svc-dot" aria-hidden="true"></span><span class="svc-text"><span class="svc-name">${v.name}</span><span class="svc-hint">${v.hint}</span></span>${ic("link", 14)}</a>`).join("")}</div>
              <div class="step-head"><span class="num">2</span><div><h3>Share that tab</h3><p class="faint small">Pick it in the list and keep “Share tab audio” switched on. You'll stay on this page.</p></div></div>
              <div class="row-btns">
                <button class="btn btn-primary" id="cap" ${capture ? "" : "hidden"}>${ic("tab", 18)}<span id="capLabel">Share a tab</span></button>
                <button class="btn btn-ghost" id="clicks" title="A click every half second, for checking sync by ear">${ic("audio", 18)}Test clicks</button>
              </div>
              <div class="live-tab" id="liveTab" hidden>
                <div class="lt-head"><span class="chip chip-ok"><span class="dot live"></span>Live from <b id="ltSvc">a tab</b></span><span class="meter" role="meter" aria-label="Input level" aria-valuemin="0" aria-valuemax="100" id="ltMeterBox"><i id="ltMeter"></i></span></div>
                <label class="field"><span class="faint small" style="white-space:nowrap">What's playing?</span><input id="ltTitle" placeholder="Song name — shown on every device" maxlength="120" autocomplete="off"></label>
                <div class="note" id="ltSilent" hidden>${ic("alert", 16)}<span>No sound from the tab yet. Press play there, and make sure “Share tab audio” was switched on. <button class="btn btn-sm" id="ltRetry" style="margin-left:6px">Share again</button></span></div>
                <div class="note" id="sysnote" hidden>${ic("alert", 16)}<span>You shared system audio, so this computer's own speakers play slightly ahead of everyone. Mute them, or share a tab instead.</span></div>
              </div>
            </div>
          </div>
          <audio id="el" crossorigin="anonymous" hidden></audio>
        </section>
      </div>
      <aside class="side">
        <section class="card" aria-label="Invite">
          <h2 class="card-title">${ic("link", 16)}Invite friends<span class="chip end">${ic("lock", 12)}Encrypted</span></h2>
          <div class="invite">
            <button class="qr" id="qr" aria-label="Show the QR code full screen"></button>
            <div>
              <p class="small muted">Scan with a phone camera, or share the link.</p>
              <p class="link" id="link"></p>
              <div class="row"><button class="btn btn-sm" id="copy">${ic("copy", 14)}Copy link</button><button class="btn btn-sm" id="share" hidden>${ic("share", 14)}Share</button><button class="btn btn-sm btn-ghost" id="bigQr">${ic("users", 14)}Show big</button></div>
            </div>
          </div>
          <div class="lock-row"><label class="switch"><input type="checkbox" id="lockRoom">Lock room</label><span class="small faint" id="lockHint">Anyone with the link can join.</span></div>
        </section>
        <section class="card" aria-label="Devices and sync">
          <h2 class="card-title">${ic("users", 16)}Devices &amp; sync<span class="chip end" id="count">1</span></h2>
          <p class="health" id="health" aria-live="polite"></p>
          <div class="sync-meter">
            <div><div class="big" id="spread">—</div><div class="label" id="autosync" aria-live="polite"></div></div>
            <span class="chip" id="asChip">${ic("zap", 12)}Auto-sync</span>
          </div>
          <ul class="devices" id="devices"></ul>
          <div class="side-actions">
            <button class="btn btn-sm btn-primary" id="asOn" hidden>${ic("mic", 14)}Turn on auto-sync</button>
            <button class="btn btn-sm" id="cal">${ic("radio", 14)}Calibrate with chirps</button>
          </div>
          <p class="small faint" id="calmsg" aria-live="polite" style="margin-top:12px"></p>
          <div class="rx-layer" id="rx" aria-hidden="true"></div>
          <p class="note" id="calhint" hidden style="margin-top:12px">${ic("alert", 16)}<span>Not synced yet — devices may sound out of step. Turn on auto-sync, or stop the music and calibrate with chirps.</span></p>
        </section>
      </aside>
    </main>`);

  // ---- invite ----
  $("qr").innerHTML = renderSVG(link, { border: 1 });
  const showBigQr = () => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Scan to join");
    ov.innerHTML = `<div class="overlay-inner"><p class="eyebrow">Point a phone camera here</p><h2>Scan to join the room</h2>
      <div class="qr qr-big">${renderSVG(link, { border: 1 })}</div><p class="muted small">Then tap “Tap to join”. Anyone with this code can listen.</p>
      <button class="btn" id="closeQr">Done</button></div>`;
    const close = () => { setInert(false); ov.classList.add("out"); setTimeout(() => ov.remove(), 200); window.removeEventListener("keydown", onKey); $("bigQr").focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    ov.onclick = (e) => { if (e.target === ov) close(); };
    document.body.append(ov);
    setInert(true);
    ov.querySelector<HTMLButtonElement>("#closeQr")!.onclick = close;
    ov.querySelector<HTMLButtonElement>("#closeQr")!.focus();
    window.addEventListener("keydown", onKey);
  };
  $("qr").onclick = showBigQr;
  $("link").textContent = link;
  $("copy").onclick = async () => { await navigator.clipboard?.writeText(link); toast("Invite link copied", "ok"); };
  if (navigator.share) { $("share").hidden = false; $("share").onclick = () => navigator.share({ title: "Join my Unison room", url: link }).catch(() => {}); }
  if (!hosting) $("nohost").hidden = false;
  $("bigQr").onclick = showBigQr;

  const el = $<HTMLAudioElement>("el");
  const err = (msg: string) => { $("hostErr").textContent = msg; };

  // ---- visualizer (taps the local player before the "play here too" mute) ----
  const analyser = ctx.createAnalyser();
  local.out.connect(analyser);
  const viz = new Visualizer($<HTMLCanvasElement>("cv"), analyser);
  viz.start();

  // ---- tabs ----
  const selectTab = (t: Tab) => {
    tab = t;
    document.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t));
    if (t === "audius") setTimeout(() => $("q").focus(), 50);
  };
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab as Tab)));
  selectTab(tab);

  // ---- devices ----
  const seen = new Set<number>();
  // ---- moderation: lock the room (server refuses new devices), remove a guest ----
  let locked = false;
  const removed = new Set<number>(); // so "X left" isn't toasted after we removed them
  const setLocked = (on: boolean) => {
    locked = on;
    $<HTMLInputElement>("lockRoom").checked = on;
    $("lockHint").textContent = on ? "Locked — no new devices can join. Guests already here can reconnect." : "Anyone with the link can join.";
    document.querySelector(".invite")?.classList.toggle("locked", on);
    renderNow();
  };
  $<HTMLInputElement>("lockRoom").onchange = (e) => conn.send({ type: "lock", locked: (e.target as HTMLInputElement).checked });

  // ---- Smart Sync Doctor: per-device diagnosis (src/client/doctor.ts) ----
  const expanded = new Set<number>();
  type G = { t: number; drops: number; jumps: number; under: number; flushes: number };
  const gHist = new Map<number, G[]>();
  const glitchTotals = (st: Status): Omit<G, "t"> => ({ drops: st.drops, jumps: st.jumps ?? 0, under: st.under ?? 0, flushes: st.flushes ?? 0 });
  const noteStatus = (id: number, st: Status) => {
    const h = [...(gHist.get(id) ?? []), { t: performance.now(), ...glitchTotals(st) }].filter((g) => performance.now() - g.t < 65_000);
    gHist.set(id, h);
  };
  const recentOf = (id: number) => {
    const h = gHist.get(id) ?? [];
    if (h.length < 2) return { recentGlitches: 0, recent: { drops: 0, jumps: 0, under: 0 } };
    const a = h[0], b = h[h.length - 1], d = (k: keyof Omit<G, "t">) => Math.max(0, b[k] - a[k]);
    return { recentGlitches: d("drops") + d("jumps") + d("under") + d("flushes"), recent: { drops: d("drops"), jumps: d("jumps"), under: d("under") } };
  };
  const diagnoseDevice = (id: number, st: Status | undefined): Diagnosis => diagnose(st, {
    hostPlaying: !!host?.kind, autoSync: autoSync === "on", heard: sync.heardIds.has(id), ...recentOf(id),
  });
  const LEVEL_CHIP: Record<Level, string> = { good: "chip-ok", warn: "chip-warn", bad: "chip-bad", idle: "" };
  const LEVEL_ICON: Record<Level, "check" | "alert" | "refresh" | "zap"> = { good: "check", warn: "refresh", bad: "alert", idle: "zap" };
  const SOURCE_LABEL_FACT = { measured: "measured", estimate: "estimate", browser: "browser-reported" } as const;
  const ACTION_LABEL: Record<Action, string> = { identify: "Identify", resync: "Re-sync", "help-sync": "How Help sync works" };
  const deviceRow = (id: number, name: string, mobile: boolean, browser: string, st: Status | undefined, isHost: boolean) => {
    const fresh = !seen.has(id);
    seen.add(id);
    const d = diagnoseDevice(id, st), open = expanded.has(id);
    const sub = [isHost ? "This device" : browser, st?.heard ? "helping sync" : "", d.level !== "good" && d.level !== "idle" ? d.title : ""].filter(Boolean).join(" · ");
    return `<li class="device${fresh ? " new" : ""} lvl-${d.level}">
      <div class="av ${st?.state === "playing" ? "on" : ""}">${ic(mobile ? "phone" : "laptop", 18)}</div>
      <div style="min-width:0"><div class="n">${esc(name)}</div><div class="s">${esc(sub)}</div></div>
      <button class="chip ${LEVEL_CHIP[d.level]} chip-btn" data-expand="${id}" aria-expanded="${open}" aria-controls="doc-${id}" title="Sync details">${ic(LEVEL_ICON[d.level], 12)}${esc(d.level === "good" ? "In sync" : d.level === "idle" ? d.title : d.level === "bad" ? "Problem" : "Check")}${ic("chevron", 12)}</button>
      <div class="doctor" id="doc-${id}" ${open ? "" : "hidden"}>
        <p class="doc-title">${esc(d.title)}</p>
        <p class="doc-detail">${esc(d.detail)}</p>
        ${d.facts.length ? `<dl class="facts">${d.facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)} <span class="src src-${f.source}">${SOURCE_LABEL_FACT[f.source]}</span></dd></div>`).join("")}</dl>` : ""}
        <div class="doc-actions">${d.actions.map((a) => `<button class="btn btn-sm${a === "resync" ? "" : " btn-ghost"}" data-act="${a}" data-id="${id}">${ic(a === "identify" ? "speaker" : a === "resync" ? "refresh" : "mic", 14)}${ACTION_LABEL[a]}</button>`).join("")}${isHost ? "" : `<button class="btn btn-sm btn-ghost btn-danger" data-act="remove" data-id="${id}">${ic("x", 14)}Remove</button>`}</div>
      </div>
    </li>`;
  };
  // The list re-renders several times a second (status reports). Never swap it mid-click (a click whose
  // mousedown and mouseup land on different elements is lost) and keep keyboard focus on the same control.
  let pointerDown = false, devicesHtml = "";
  $("devices").onpointerdown = () => { pointerDown = true; };
  $("devices").onpointerup = $("devices").onpointercancel = $("devices").onpointerleave = () => { pointerDown = false; };
  const renderDevices = (html: string) => {
    const list = $("devices");
    if (pointerDown || html === devicesHtml) return;
    const f = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    const key = f?.dataset.expand !== undefined ? `[data-expand="${f.dataset.expand}"]` : f?.dataset.act ? `[data-act="${f.dataset.act}"][data-id="${f.dataset.id}"]` : null;
    list.innerHTML = devicesHtml = html;
    if (key) list.querySelector<HTMLElement>(key)?.focus();
  };
  $("devices").onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-expand],[data-act]");
    if (!t) return;
    if (t.dataset.expand !== undefined) {
      const id = Number(t.dataset.expand);
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      update();
      return;
    }
    const id = Number(t.dataset.id), act = t.dataset.act as Action | "remove";
    if (act === "remove") {
      const name = peers.get(id)?.info.name ?? "That device";
      removed.add(id);
      expanded.delete(id);
      conn.send({ type: "remove", peer: id });
      toast(locked ? `Removed ${name}` : `Removed ${name} — lock the room to keep them from rejoining`, "ok");
      return;
    }
    if (act === "identify") {
      if (id === 0) { local.chime(); toast("Chiming on this device"); } else { host?.sendCtl(id, { type: "identify" }); toast(`Chiming on ${peers.get(id)?.info.name ?? "that device"} — look for its screen`); }
    } else if (act === "resync") {
      if (id === 0) { local.resync(); conn.resyncClock(); } else host?.sendCtl(id, { type: "resync" });
      sync.forget(id);
      gHist.delete(id);
      toast("Re-syncing — it takes a few seconds to settle", "ok");
    } else if (act === "help-sync") {
      toast("On a phone near that device: open Sync settings → Help sync. Its mic then helps line up the speakers around it.", "info");
    }
  };

  // ---- now playing ----
  let artKey = "";
  const renderNow = () => {
    const kind = host?.kind ?? null, m = host?.meta ?? {};
    const live = kind === "tab" || kind === "system" || kind === "clicks";
    $("srcLabel").textContent = kind ? `Now playing · ${SOURCE_LABEL[kind]}` : "Nothing playing yet";
    $("npTitle").textContent = kind ? m.title ?? SOURCE_LABEL[kind] : "Pick something to play";
    $("npArtist").innerHTML = kind
      ? (m.artist ? `<bdi>${esc(m.artist)}</bdi>${kind === "audius" && m.url ? ` · <a href="${esc(m.url)}" target="_blank" rel="noopener">on Audius</a>` : ""}` : live ? "Live from this computer" : "")
      : "Start with a sample track below — every device in the room plays it in sync.";
    $("viz").classList.toggle("playing", !!kind && !el.paused || live);
    const k = `${m.art ?? ""}|${m.title ?? ""}|${kind}`;
    if (k !== artKey) {
      artKey = k;
      $("art").innerHTML = m.art ? `<img src="${esc(m.art)}" alt="">` : kind ? `<div style="position:absolute;inset:0;${coverStyle(m.title ?? kind)}"></div>` : ic("music", 40);
      fallbackCover($("art"), m.title ?? kind ?? "");
    }
    $("scrub").hidden = !(kind === "file" || kind === "audius");
    $("pp").hidden = !(kind === "file" || kind === "audius");
    $("pp").innerHTML = el.paused ? ic("play", 22) : ic("pause", 22);
    $("pp").setAttribute("aria-label", el.paused ? "Play" : "Pause");
    $<HTMLButtonElement>("stop").disabled = !kind;
    $("sysnote").hidden = kind !== "system";
    $("liveTab").hidden = !(kind === "tab" || kind === "system");
    document.querySelectorAll<HTMLElement>(".track").forEach((t) => t.classList.toggle("active", t.dataset.id === activeTrack && kind === "audius"));
    party?.update({
      playing: $("viz").classList.contains("playing"), label: kind ? `Now playing · ${SOURCE_LABEL[kind]}` : "Party mode", title: kind ? $("npTitle").textContent ?? "" : "Waiting for music",
      artist: kind ? m.artist ?? "" : "", artHtml: $("art").innerHTML, listeners: listenerPeers().length, health: roomHealth(), locked,
    });
  };

  const listenerPeers = () => [...peers.values()].filter((p) => p.info.role === "listener");
  const roomHealth = () => summarize([diagnoseDevice(0, local.status()).level, ...listenerPeers().map((p) => diagnoseDevice(p.info.peer, p.status).level)]);
  const update = () => {
    if (!document.getElementById("count")) return; // view replaced (e.g. room ended)
    const listeners = [...peers.values()].filter((p) => p.info.role === "listener");
    const n = listeners.length + 1;
    $("count").textContent = String(n);
    $("liveChip").className = `chip ${conn.connected ? "chip-ok" : "chip-warn"}`;
    $("liveChip").innerHTML = `<span class="dot ${conn.connected ? "live" : ""}"></span>${conn.connected ? `Live · ${n} device${n > 1 ? "s" : ""}` : "Reconnecting"}`;
    renderDevices(deviceRow(0, `${myName()} (you)`, false, "", local.status(), true)
      + listeners.map((p) => deviceRow(p.info.peer, p.info.name ?? `Device ${p.info.peer}`, p.info.mobile, p.info.browser, p.status, false)).join("")
      + (listeners.length ? "" : `<li class="device-empty"><span class="pulse-dots" aria-hidden="true"><i></i><i></i><i></i></span>Waiting for friends — scan the QR code with any phone to add it as a speaker.</li>`));
    const sum = roomHealth();
    $("health").className = `health lvl-${sum.level}`;
    $("health").innerHTML = `${ic(LEVEL_ICON[sum.level], 14)}${esc(sum.text)}`;
    for (const p of listeners) {
      const ok = !!p.status?.calibrated;
      if (ok && !syncedOnce.has(p.info.peer)) { syncedOnce.add(p.info.peer); toast(`${p.info.name ?? "A device"} is in sync`, "ok"); }
    }
    const ids = activeIds();
    const sp = sync.spreadMs;
    $("spread").innerHTML = autoSync === "on" && sp !== null ? `${sp.toFixed(1)}<small>ms</small>` : "—";
    $("asChip").className = `chip ${autoSync === "on" ? "chip-ok" : autoSync === "denied" ? "chip-warn" : ""}`;
    $("autosync").textContent = autoSync === "denied" ? "Microphone blocked — allow it for this site, or calibrate with chirps."
      : autoSync === "idle" ? "Auto-sync starts when you play something (uses this computer's mic)."
      : !host?.kind ? "Auto-sync on — waiting for music."
      : `Measured spread · hears ${sync.heardIds.size} of ${ids.length} device${ids.length > 1 ? "s" : ""}`;
    $("asOn").hidden = autoSync === "on";
    $<HTMLButtonElement>("cal").disabled = calibrating || !navigator.mediaDevices?.getUserMedia;
    const playing = [local.status(), ...listeners.map((p) => p.status)].filter((s) => s?.state === "playing");
    $("calhint").hidden = autoSync === "on" || calibrating || listeners.length === 0 || playing.every((s) => s!.calibrated);
    renderNow();
  };

  // ---- continuous silent auto-sync (spec §8.4) ----
  const activeIds = () => [...($<HTMLInputElement>("localOn").checked ? [0] : []), ...[...peers.values()].filter((p) => p.info.role === "listener").map((p) => p.info.peer)];
  const mic = new MicListener(ctx, conn);
  const sync = new AutoSyncHost(0, {
    adjust: (id, d) => { if (id === 0) { local.offsetMs += d; local.calibrated = true; } else host?.sendCtl(id, { type: "cal-adjust", deltaMs: d }); },
    setLevel: (id, db) => { if (id === 0) local.pn = { id: 0, db }; else host?.sendCtl(id, { type: "pn", db }); },
    chainErrMs: (id) => (id === 0 ? local.stats.errMs : peers.get(id)?.status?.errMs),
    reset: (id) => mic.reset(id),
  });
  mic.ids = activeIds;
  mic.onMeasure = (lags) => { sync.ensure(activeIds()); sync.onHostMic(lags); spreadMs = sync.spreadMs ?? undefined; update(); };
  const startAutoSync = async () => {
    if (mic.running) return;
    try {
      await mic.start();
      autoSync = "on";
      sync.ensure(activeIds());
      toast("Auto-sync is on — devices line up while music plays", "ok");
    } catch {
      autoSync = "denied";
    }
    update();
  };

  // ---- connection ----
  conn.onMessage = async (m) => {
    if (m.type === "welcome" || m.type === "locked") setLocked(m.locked);
    if (m.type === "welcome" && !host) {
      host = new Host(ctx, conn, key, room, m.epoch);
      host.local = local;
      host.onChange = update;
      host.onError = err;
      host.onEnded = () => toast("Tab sharing stopped", "warn");
      await host.init();
      Object.assign(debug, { host });
    } else if (m.type === "peers") {
      const ids = new Set(m.peers.map((p) => p.peer));
      for (const [id, p] of peers) if (!ids.has(id)) {
        peers.delete(id);
        announced.delete(id);
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].peer === id) pending.splice(i, 1);
        if (!removed.delete(id)) toast(`${p.info.name ?? "A device"} left`);
        renderQueue();
      }
      for (const p of m.peers) {
        if (p.role !== "listener") continue;
        if (!peers.has(p.peer)) toast(`${p.name ?? "A device"} joined`, "ok");
        peers.set(p.peer, { info: p, status: peers.get(p.peer)?.status });
        if (!announced.has(p.peer)) { announced.add(p.peer); host?.announceTo(p.peer); host?.sendCtl(p.peer, { type: "queue", mode: reqMode, ...queue.view() }); }
      }
      if (mic.running) sync.ensure(activeIds());
    } else if (m.type === "peer-status") {
      const p = peers.get(m.peer);
      if (p) { p.status = m.status; noteStatus(m.peer, m.status); }
      if (m.status.heard) sync.onHelper(m.peer, m.status.heard);
    }
    update();
  };
  conn.onFatal = (code) => { party?.close(); viz.stop(); timers.forEach(clearInterval); mic.stop(); fatal(code); };
  conn.onState = update;
  conn.connect();
  timers.push(setInterval(() => { const ls = local.status(); noteStatus(0, ls); conn.send({ type: "status", ...ls, source: host?.kind ?? undefined, spreadMs }); update(); }, 2000));

  // ---- sources ----
  const guard = (f: () => Promise<unknown> | unknown) => async () => {
    err("");
    if (!host) return err("Still connecting…");
    try { await f(); } catch (e) {
      const name = (e as Error)?.name;
      err(e instanceof UserError ? e.message : name === "NotAllowedError" ? "Permission was denied." : `Something went wrong: ${(e as Error)?.message ?? e}`);
    }
    update();
  };
  // ---- queue & playback ----
  const fromTrack = (t: Track, by?: string): QItem => ({ id: newId(), source: "audius", title: t.title, artist: t.artist, art: t.art, durationS: t.durationS, audiusId: t.id, url: t.url, by });
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const broadcastQueue = () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => host?.sendCtl(0, { type: "queue", mode: reqMode, ...queue.view() }), 150);
  };
  const playItem = (it: QItem): Promise<void> => guard(async () => {
    void startAutoSync();
    queue.playNow(it);
    activeTrack = it.audiusId ?? "";
    if (it.source === "audius") {
      host!.useElement(el, "audius", { title: it.title, artist: it.artist, url: it.url, art: it.art });
      el.src = streamUrl(it.audiusId!);
    } else {
      const t = await library.track(it.fileId!);
      if (!t) { toast(`“${it.title}” is no longer in your library`, "warn"); await playNext(); return; }
      host!.useElement(el, "file", { title: it.title });
      el.src = URL.createObjectURL(t.blob);
    }
    renderQueue();
    broadcastQueue();
    await el.play();
  })();
  const playNext = async (): Promise<void> => { const it = queue.next(); renderQueue(); broadcastQueue(); if (it) await playItem(it); };
  const enqueue = (it: QItem, quiet = false) => {
    queue.add(it);
    if (!host?.kind && !queue.current) void playNext();
    else if (!quiet) toast(`Added “${it.title}” to the queue`, "ok");
    renderQueue();
    broadcastQueue();
  };
  const playTrack = (t: Track) => playItem(fromTrack(t));
  const trackCard = (t: Track, i: number) => {
    const w = document.createElement("div");
    w.className = "track-wrap";
    w.style.animationDelay = `${i * 40}ms`;
    const b = document.createElement("button");
    b.className = "track";
    b.dataset.id = t.id;
    b.setAttribute("aria-label", `Play ${t.title} by ${t.artist}`);
    b.innerHTML = `<div class="cover">${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : `<div style="position:absolute;inset:0;${coverStyle(t.title)}"></div>`}<span class="play">${ic("play", 18)}</span></div>
      <div class="t"><bdi>${esc(t.title)}</bdi></div><div class="a"><bdi>${esc(t.artist)}</bdi> · ${fmtTime(t.durationS)}</div>`;
    fallbackCover(b, t.title);
    b.onclick = () => playTrack(t);
    const add = document.createElement("button");
    add.className = "qadd";
    add.title = "Add to queue";
    add.setAttribute("aria-label", `Add ${t.title} to the queue`);
    add.innerHTML = ic("plus", 16);
    add.onclick = () => enqueue(fromTrack(t));
    w.append(b, add);
    return w;
  };
  loadSamples().then((tracks) => {
    const grid = $("samples");
    grid.innerHTML = tracks.length ? "" : `<p class="empty">Couldn't load the sample tracks right now. Try Audius search or a file.</p>`;
    tracks.forEach((t, i) => grid.append(trackCard(t, i)));
    renderNow();
  });
  $("aud").onsubmit = (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>("q").value.trim();
    if (!q) return;
    const list = $("results");
    list.innerHTML = Array.from({ length: 4 }, () => `<li class="row-item"><div class="thumb skeleton"></div><div><div class="skeleton line-sk" style="margin:0 0 8px"></div><div class="skeleton line-sk" style="width:50%;margin:0"></div></div></li>`).join("");
    searchTracks(q).then((tracks) => {
      list.innerHTML = tracks.length ? "" : `<li class="empty">No streamable tracks found for “${esc(q)}”.</li>`;
      tracks.forEach((t, i) => {
        const li = document.createElement("li");
        li.className = "row-item";
        li.style.animationDelay = `${i * 30}ms`;
        li.innerHTML = `<div class="thumb">${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : ""}</div>
          <div style="min-width:0"><div class="t"><bdi>${esc(t.title)}</bdi></div><div class="a"><bdi>${esc(t.artist)}</bdi> · ${fmtTime(t.durationS)}</div></div>`;
        fallbackCover(li, t.title);
        const btns = document.createElement("div");
        btns.className = "row-btns";
        const play = document.createElement("button");
        play.className = "btn btn-sm";
        play.innerHTML = `${ic("play", 14)}Play`;
        play.onclick = () => playTrack(t);
        const add = document.createElement("button");
        add.className = "btn btn-sm btn-ghost btn-icon";
        add.setAttribute("aria-label", `Add ${t.title} to the queue`);
        add.innerHTML = ic("plus", 16);
        add.onclick = () => enqueue(fromTrack(t));
        btns.append(play, add);
        li.append(btns);
        list.append(li);
      });
    }).catch((er) => (list.innerHTML = `<li class="empty">${esc(String(er.message ?? er))}</li>`));
  };
  // ---- local library (saved in this browser) ----
  const fileItem = (id: string, name: string): QItem => ({ id: newId(), source: "file", title: trackTitle(name), fileId: id });
  const addFiles = async (files: File[]) => {
    const audio = files.filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(f.name));
    if (!audio.length) return toast("Those don't look like audio files", "warn");
    for (const f of audio) {
      try {
        const t = await library.addFile(f);
        enqueue(fileItem(t.id, t.name), audio.length > 1);
      } catch {
        toast("Couldn't save to this browser's storage — playing without saving", "warn");
        host?.useElement(el, "file", { title: trackTitle(f.name) });
        el.src = URL.createObjectURL(f);
        void el.play();
        break;
      }
    }
    if (audio.length > 1) toast(`Added ${audio.length} songs to your library and the queue`, "ok");
    void refreshLibrary();
  };
  $<HTMLInputElement>("file").onchange = () => { const fs = [...($<HTMLInputElement>("file").files ?? [])]; if (fs.length) void addFiles(fs); $<HTMLInputElement>("file").value = ""; };
  const drop = $("drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); const fs = [...(e.dataTransfer?.files ?? [])]; if (fs.length) void addFiles(fs); };
  const rowBtn = (icon: "play" | "plus" | "trash", label: string, onClick: () => void, cls = "btn-ghost btn-icon") => {
    const b = document.createElement("button");
    b.className = `btn btn-sm ${cls}`;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = icon === "play" ? `${ic("play", 14)}Play` : ic(icon, 16);
    if (icon === "play") b.className = "btn btn-sm";
    b.onclick = onClick;
    return b;
  };
  async function refreshLibrary() {
    let tracks, lists: Playlist[];
    try { [tracks, lists] = await Promise.all([library.tracks(), library.playlists()]); } catch {
      $("libList").innerHTML = `<li class="empty">This browser isn't letting us save songs (private window?). You can still play files one at a time.</li>`;
      return;
    }
    const lib = $("libList");
    lib.innerHTML = tracks.length ? "" : `<li class="empty">Songs you add appear here.</li>`;
    for (const t of tracks) {
      const li = document.createElement("li");
      li.className = "row-item";
      li.innerHTML = `<div class="thumb" style="${coverStyle(t.name)}"></div><div style="min-width:0"><div class="t"><bdi>${esc(trackTitle(t.name))}</bdi></div><div class="a">${(t.size / 1e6).toFixed(1)} MB · added ${new Date(t.addedAt).toLocaleDateString()}</div></div>`;
      const btns = document.createElement("div");
      btns.className = "row-btns";
      btns.append(
        rowBtn("play", `Play ${t.name}`, () => playItem(fileItem(t.id, t.name))),
        rowBtn("plus", `Add ${t.name} to the queue`, () => enqueue(fileItem(t.id, t.name))),
        rowBtn("trash", `Remove ${t.name} from your library`, async () => { await library.removeTrack(t.id); toast("Removed from your library"); void refreshLibrary(); }),
      );
      li.append(btns);
      lib.append(li);
    }
    const pl = $("plList");
    pl.innerHTML = lists.length ? "" : `<li class="empty">Save the queue as a playlist to keep it for next time.</li>`;
    for (const p of lists) {
      const li = document.createElement("li");
      li.className = "row-item";
      const art = p.items.find((i) => i.art)?.art;
      li.innerHTML = `<div class="thumb">${art ? `<img src="${esc(art)}" alt="">` : `<div style="width:100%;height:100%;${coverStyle(p.name)}"></div>`}</div><div style="min-width:0"><div class="t"><bdi>${esc(p.name)}</bdi></div><div class="a">${p.items.length} song${p.items.length === 1 ? "" : "s"}</div></div>`;
      fallbackCover(li, p.name);
      const btns = document.createElement("div");
      btns.className = "row-btns";
      btns.append(
        rowBtn("play", `Play playlist ${p.name}`, () => { queue.clear(); p.items.forEach((i) => queue.add({ ...i, id: newId() })); void playNext(); toast(`Playing “${p.name}”`, "ok"); }),
        rowBtn("plus", `Add playlist ${p.name} to the queue`, () => { p.items.forEach((i) => enqueue({ ...i, id: newId() }, true)); toast(`Queued “${p.name}”`, "ok"); }),
        rowBtn("trash", `Delete playlist ${p.name}`, async () => { await library.removePlaylist(p.id); void refreshLibrary(); }),
      );
      li.append(btns);
      pl.append(li);
    }
    $("libUsage").textContent = await library.usage().catch(() => "");
  }
  void refreshLibrary();

  // ---- queue UI ----
  const renderQueue = () => {
    if (!document.getElementById("queue")) return;
    const reqs = $("requests");
    reqs.innerHTML = "";
    for (const r of pending) {
      const li = document.createElement("li");
      li.className = "request";
      li.innerHTML = `<div class="thumb">${r.item.art ? `<img src="${esc(r.item.art)}" alt="">` : ""}</div><div style="min-width:0"><div class="t"><b class="who">${esc(r.name)}</b> wants to add</div><div class="a"><bdi>${esc(r.item.title)}</bdi>${r.item.artist ? ` · <bdi>${esc(r.item.artist)}</bdi>` : ""}</div></div>`;
      fallbackCover(li, r.item.title);
      const btns = document.createElement("div");
      btns.className = "row-btns";
      const yes = document.createElement("button");
      yes.className = "btn btn-sm btn-primary";
      yes.innerHTML = `${ic("check", 14)}Add`;
      yes.onclick = () => decide(r.ref, true);
      const no = document.createElement("button");
      no.className = "btn btn-sm btn-ghost btn-icon";
      no.setAttribute("aria-label", "Decline request");
      no.innerHTML = ic("x", 16);
      no.onclick = () => decide(r.ref, false);
      btns.append(yes, no);
      li.append(btns);
      reqs.append(li);
    }
    const ul = $("queue");
    ul.innerHTML = queue.items.length ? "" : `<li class="empty small">${pending.length ? "" : "Nothing queued. Tap + on any track — or let guests request songs from their phones."}</li>`;
    queue.items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "row-item q-item";
      li.innerHTML = `<div class="thumb">${it.art ? `<img src="${esc(it.art)}" alt="">` : `<div style="width:100%;height:100%;${coverStyle(it.title)}"></div>`}</div>
        <div style="min-width:0"><div class="t"><bdi>${esc(it.title)}</bdi></div><div class="a">${it.artist ? `<bdi>${esc(it.artist)}</bdi>` : it.source === "file" ? "Your music" : ""}${it.by ? ` · <span class="by">requested by ${esc(it.by)}</span>` : ""}</div></div>`;
      fallbackCover(li, it.title);
      const btns = document.createElement("div");
      btns.className = "row-btns";
      const mk = (icon: "up" | "chevron" | "x" | "play", label: string, fn: () => void, disabled = false) => {
        const b = document.createElement("button");
        b.className = icon === "play" ? "btn btn-sm" : "btn btn-sm btn-ghost btn-icon";
        b.setAttribute("aria-label", label);
        b.title = label;
        b.disabled = disabled;
        b.innerHTML = icon === "play" ? `${ic("play", 14)}Play` : ic(icon, 16);
        b.onclick = fn;
        return b;
      };
      btns.append(
        mk("play", `Play ${it.title} now`, () => playItem(it)),
        mk("up", "Move up", () => { queue.move(it.id, -1); renderQueue(); broadcastQueue(); }, i === 0),
        mk("chevron", "Move down", () => { queue.move(it.id, 1); renderQueue(); broadcastQueue(); }, i === queue.items.length - 1),
        mk("x", "Remove from queue", () => { queue.remove(it.id); renderQueue(); broadcastQueue(); }),
      );
      li.append(btns);
      ul.append(li);
    });
    $<HTMLButtonElement>("qClear").disabled = !queue.items.length;
    $<HTMLButtonElement>("qSave").disabled = !queue.items.length && !queue.current;
  };
  const sel = $<HTMLSelectElement>("reqMode");
  sel.value = reqMode;
  sel.onchange = () => { reqMode = sel.value as RequestMode; sessionStorage.setItem("unison:req", reqMode); broadcastQueue(); toast(reqMode === "off" ? "Song requests are off" : reqMode === "auto" ? "Guests can add songs freely" : "Guests can request songs — you approve", "ok"); };
  $("qClear").onclick = () => { queue.clear(); renderQueue(); broadcastQueue(); };
  $("qSave").onclick = () => { $("qSaveRow").hidden = false; $("qSave").hidden = true; $<HTMLInputElement>("qName").value = `Party · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`; $<HTMLInputElement>("qName").select(); };
  $("qSaveGo").onclick = async () => {
    const items = [...(queue.current ? [queue.current] : []), ...queue.items].map(({ by: _by, ...rest }) => rest);
    const name = $<HTMLInputElement>("qName").value.trim() || "Playlist";
    try { await library.savePlaylist({ id: newId(), name, items, updatedAt: Date.now() }); toast(`Saved “${name}” to your library`, "ok"); } catch { toast("Couldn't save the playlist in this browser", "warn"); }
    $("qSaveRow").hidden = true;
    $("qSave").hidden = false;
    void refreshLibrary();
  };
  el.onended = () => { failures = 0; if (host?.kind === "file" || host?.kind === "audius") void playNext(); };
  // A track that can't load (deleted on Audius, flaky node, unsupported/corrupt file) must not leave the room in
  // silence: skip it, and stop after a few consecutive failures instead of looping through a broken queue.
  let failures = 0;
  el.onerror = () => {
    if (!(host?.kind === "file" || host?.kind === "audius") || !el.src) return;
    failures++;
    const t = queue.current?.title ?? "This track";
    if (failures >= 3) { toast("Several tracks in a row couldn't play — stopped. Check your connection or try another source.", "warn"); failures = 0; host.stop(); return; }
    toast(`Couldn't play “${t}” — skipping`, "warn");
    if (queue.items.length) void playNext(); else host.stop();
  };
  el.onplaying = () => { failures = 0; };

  // ---- guest song requests (sealed listener → host messages) ----
  const reply = (peer: number, ref: string, ok: boolean, reason?: string) => host?.sendCtl(peer, { type: "request-result", ref, ok, reason });
  const vetting = new Set<number>(); // peers with a request being checked
  const handleRequest = async (peer: number, up: SongRequest) => {
    const name = peers.get(peer)?.info.name ?? "A guest";
    if (reqMode === "off") return reply(peer, up.ref, false, "Song requests are off right now");
    if (queue.has(up.audiusId) || pending.some((p) => p.item.audiusId === up.audiusId)) return reply(peer, up.ref, true, "It's already in the queue");
    if (vetting.has(peer) || pending.filter((p) => p.peer === peer).length >= 3) return reply(peer, up.ref, false, "You have requests waiting — give the host a moment");
    // Don't trust the guest's title/artwork (spoofing, or making this browser fetch arbitrary URLs):
    // look the track up on Audius ourselves.
    vetting.add(peer);
    const t = await getTrack(up.audiusId).catch(() => null);
    vetting.delete(peer);
    if (!t) return reply(peer, up.ref, false, "That track isn't available to stream");
    if (!peers.has(peer)) return;
    const item: QItem = { ...fromTrack(t), by: name };
    up = { ...up, title: t.title };
    if (reqMode === "auto") { enqueue(item, true); reply(peer, up.ref, true); toast(`${name} added “${up.title}”`, "ok"); return; }
    pending.push({ ref: up.ref, peer, name, item });
    toast(`${name} requested “${up.title}”`);
    renderQueue();
  };
  const decide = (ref: string, ok: boolean) => {
    const i = pending.findIndex((p) => p.ref === ref);
    if (i < 0) return;
    const [r] = pending.splice(i, 1);
    if (ok) enqueue(r.item, true);
    reply(r.peer, r.ref, ok, ok ? undefined : "The host passed on this one");
    renderQueue();
  };
  conn.onBinary = async (buf) => {
    const b = parseBinary(buf);
    if (!b || b.kind !== KIND_UP) return;
    const pt = await open(key, room, b.header, b.body);
    const up = pt && parseUp(new TextDecoder().decode(pt));
    if (up?.type === "react") onReaction(b.from, up.r);
    else if (up) void handleRequest(b.from, up);
  };

  // ---- party mode + reactions ----
  let party: Party | null = null;
  const canReact = reactionLimiter();
  const onReaction = (peer: number, r: Reaction) => {
    if (!peers.has(peer) || !canReact(peer)) return;
    const name = peers.get(peer)!.info.name;
    if (party) party.react(r, name ?? "A guest"); else floatReaction($("rx"), r, name);
  };
  const togglePartyMode = () => {
    if (party) { party.close(); return; }
    viz.stop();
    party = openParty(link, analyser, () => { party = null; if (document.getElementById("cv")) viz.start(); });
    renderNow();
  };
  $("partyBtn").onclick = togglePartyMode;
  renderQueue();
  // ---- tab sharing ----
  let svc: Service | undefined = SERVICES.find((v) => v.id === sessionStorage.getItem("unison:svc"));
  const setSvc = (v: Service | undefined) => {
    svc = v;
    if (v) sessionStorage.setItem("unison:svc", v.id);
    $("capLabel").textContent = v ? `Share your ${v.name} tab` : "Share a tab";
    document.querySelectorAll<HTMLElement>(".svc").forEach((a) => a.classList.toggle("picked", a.dataset.svc === v?.id));
  };
  document.querySelectorAll<HTMLAnchorElement>(".svc").forEach((a) => (a.onclick = () => setSvc(SERVICES.find((v) => v.id === a.dataset.svc))));
  setSvc(svc);
  let capturedAt = 0;
  const share = guard(async () => {
    void startAutoSync();
    activeTrack = "";
    el.pause();
    const kind = await host!.useCapture(svc ? { title: svc.name, artist: `via ${svc.name}` } : {});
    capturedAt = performance.now();
    $<HTMLInputElement>("ltTitle").value = "";
    $("ltSvc").textContent = kind === "system" ? "system audio" : svc?.name ?? "a tab";
    toast(kind === "system" ? "Sharing system audio" : `Sharing ${svc?.name ?? "your tab"} with the room`, "ok");
  });
  $("cap").onclick = share;
  $("ltRetry").onclick = share;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>("ltTitle").oninput = (e) => {
    clearTimeout(titleTimer);
    const v = (e.target as HTMLInputElement).value.trim(), name = svc?.name;
    titleTimer = setTimeout(() => host?.setMeta(v ? { title: v, artist: name ? `via ${name}` : "Shared tab" } : { title: name ?? "Shared tab", artist: name ? `via ${name}` : undefined }), 500);
  };
  timers.push(setInterval(() => { // live input meter + "is the tab actually making sound?"
    const live = host?.kind === "tab" || host?.kind === "system";
    if (!live || !document.getElementById("ltMeter")) return;
    const pct = Math.min(100, Math.round((host!.level ** 0.5) * 220));
    $("ltMeter").style.width = `${pct}%`;
    $("ltMeterBox").setAttribute("aria-valuenow", String(pct));
    $("ltSilent").hidden = !(host!.level < 0.002 && performance.now() - capturedAt > 6000);
  }, 120));
  $("clicks").onclick = guard(() => { void startAutoSync(); activeTrack = ""; el.pause(); host!.useClicks(); });
  $("stop").onclick = guard(() => { activeTrack = ""; host!.stop(); });
  $("asOn").onclick = () => void startAutoSync();
  $("pp").onclick = () => { if (el.paused) void el.play(); else el.pause(); };
  // Shortcuts: Space = play/pause (files and Audius), "/" = search Audius.
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (!document.getElementById("pp") || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
    if (e.key === " " && !$("pp").hidden) { e.preventDefault(); $("pp").click(); }
    else if (e.key === "/") { e.preventDefault(); selectTab("audius"); }
    else if (e.key === "p" || e.key === "P") togglePartyMode();
  });

  // ---- transport ----
  const seek = $<HTMLInputElement>("seek");
  let seeking = false;
  const tick = () => {
    const d = el.duration, c = el.currentTime;
    $("cur").textContent = fmtTime(c);
    $("dur").textContent = fmtTime(d);
    if (!seeking && Number.isFinite(d) && d > 0) { seek.value = String(Math.round((c / d) * 1000)); seek.style.setProperty("--p", `${(c / d) * 100}%`); }
  };
  el.ontimeupdate = tick;
  el.onplay = el.onpause = () => renderNow();
  seek.oninput = () => { seeking = true; seek.style.setProperty("--p", `${Number(seek.value) / 10}%`); };
  seek.onchange = () => { if (Number.isFinite(el.duration)) el.currentTime = (Number(seek.value) / 1000) * el.duration; seeking = false; };
  $<HTMLInputElement>("localOn").onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    // Mute by disconnecting (not gain 0) so the visualizer still sees the music.
    if (on) local.out.connect(ctx.destination); else local.out.disconnect(ctx.destination);
    if (mic.running) sync.ensure(activeIds());
  };

  // ---- manual chirp calibration (fallback) ----
  $("cal").onclick = guard(async () => {
    calibrating = true;
    update();
    try {
      el.pause();
      const targets: Target[] = [...peers.values()].filter((p) => p.info.role === "listener").map(({ info: { peer, name } }) => ({
        id: name ?? `device ${peer}`,
        play: (at, round) => host!.sendCtl(peer, { type: "cal-play", round, at }),
        adjust: (deltaMs) => host!.sendCtl(peer, { type: "cal-adjust", deltaMs }),
      }));
      if ($<HTMLInputElement>("localOn").checked) targets.push({ id: "this device", play: (at) => local.playChirp(at), adjust: (d) => { local.offsetMs += d; local.calibrated = true; } });
      const r = await calibrate(ctx, conn, host!, targets, (msg) => ($("calmsg").textContent = msg));
      const missed = r.lags.filter((l) => l.lagMs === null).map((l) => l.id);
      spreadMs = r.spreadMs ?? undefined;
      $("calmsg").textContent = r.spreadMs === null ? "Couldn't hear any device. Turn volumes up, keep the room quiet and try again."
        : `Measured spread: ${r.spreadMs.toFixed(1)} ms across ${r.lags.length - missed.length} device(s)${missed.length ? `. Not heard: ${missed.join(", ")}` : ""}.`;
    } finally {
      calibrating = false;
    }
  });
  update();
  Object.assign(debug, { local, conn, ctx, peers, Player, calibrate, mic, sync, MicListener, AutoSyncHost, selectTab });
}
