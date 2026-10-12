# Progress

Last updated: 2026-10-11 (end of session 1).

## Current state
v1 is implemented and passes every automated check available on this machine. All three sources (tab/system capture, file, Audius) work end-to-end in desktop Chromium; rooms, encryption, late join, reconnect, stop, calibration, PWA and metrics are in place. **Not yet validated on real phones, Bluetooth speakers or with acoustic measurement** — those need hardware the owner has to provide. Not deployed (needs owner authorization).

## Milestones
- [x] Phase 0: `CLAUDE.md`, intent, durable docs
- [x] iOS/streamed-audio experiment — desktop Chromium measured; WebKit-on-Windows unusable (no Web Audio); real iPhone **not run** (`experiments/ios-audio/README.md`)
- [x] Stack + ADRs 0001–0006, spec `docs/specs/synced-audio.md` (kept in sync with the code)
- [x] Shared core: protocol, crypto, clock (estimator, drift tracker), scheduler, calibration math
- [x] Server: rooms, relay, buffer, lifecycle, limits, metrics, static + headers, optional TLS
- [x] Client: listener (tap-to-join, player, nudge, wake lock, audio session), host (file, Audius, capture, test clicks, local player), calibration, QR/share, errors, "Host your own room", PWA
- [x] Capture verified in automation (headless auto-selects screen + system audio); tab-specific selection needs a manual check in real Chrome
- [x] Audius verified live in the browser pane: search → play → listener RMS 0.30, 128 chunks, 0 drops/decode/auth errors, credited title
- [x] Production mode verified (e2e suite passes with `E2E_NODE_ENV=production`); Dockerfile + README deploy guide (Docker build **not run**: no Docker here)
- [ ] Real-device validation + acoustic sync measurement (spec §10.1) — needs hardware
- [ ] Deploy — needs owner authorization and a target

## Test commands and latest results (2026-10-11)
| Command | Result |
|---|---|
| `bun run check` (tsc + `bun test src tests` + Node decode test) | **passed** — typecheck clean; 40 unit + 5 integration; WASM decode of a real WebCodecs Opus fixture |
| `npx playwright test` (Chromium, dev mode) | **passed** — 7/7 |
| `E2E_NODE_ENV=production npx playwright test` | **passed** — 7/7 |
| `npx playwright test -g calibration --repeat-each 4` | **passed** — 8/8 |
| `bun run build` (client bundle) | **passed** — 133.5 KB JS (incl. 85 KB WASM decoder), 2.9 KB CSS |
| Docker build | **not run** (Docker not installed) |
| iPhone Safari experiment | **not possible here** — requires real device |
| ~20 ms acoustic sync (spec §10.1) | **unverified** — requires real devices and a recorder |

E2E coverage: file source with encrypted metadata; listener decode/auth error counts = 0; late joiner playing within 1.5 s with |err| < 2 ms; two listeners' predicted emission times within 5 ms (software estimate, same machine); reconnect resumes; capture path; clicks + stop; calibration graceful failure with a fake mic; calibration loopback measures an injected 25 ms gap to ±1 ms and verifies ≤ 2 ms spread; incomplete link / missing room errors; service worker controls the page.

## Bugs found and fixed (each with a regression test)
- Scheduler could overlap audio on a backward resync → trims instead.
- Host drift correction keyed off the first chunk → spurious 10 ms steps → percentile-based `DriftTracker` (also robust to start-up render bursts seen on real audio hardware in the pane).
- Late joiner scheduled replayed chunks before clock sync → chain minutes in the future → every later chunk dropped. Now players/hosts wait for clock readiness and the scheduler flushes on > 200 ms backward jumps.
- Calibration missed the first chirp (mic not flowing yet), used a too-tight window, and reported "0 ms spread" with one device heard.
- `[hidden]` buttons were still visible (CSS `display` override) → capture button showed on phones.

## Session 2 (overnight sprint, 2026-10-12) — handoff
Baseline at start (commit b52da07): `bun run check` 68/68 + Node decode 1/1; client build OK (JS 200 KB, CSS 125 KB because fonts are inlined); Playwright 11/11.

**End state (all executed in this session, not committed — owner reviews first):**
- `bun run check`: typecheck clean, **79/79** unit + integration, Node decode 1/1.
- `bun run build`: OK — JS 214 KB, CSS **38 KB** (was 125 KB).
- Playwright (Chromium): **15/15 in dev, 15/15 in production mode** (`E2E_NODE_ENV=production`); suite time 4.1 → 2.3 min after closing leaked browser contexts between tests.
- Load test (`bun run loadtest`): see 12 below.
- Not run: Docker build (no Docker here), any real phone/iPhone, any public deployment.
- New user-facing features: Smart Sync Doctor, Party Mode + reactions, Lock room / Remove guest.
- Security fixes: guest requests no longer trust guest-supplied metadata/artwork; disconnected guests' peer ids can't be taken over (resume tokens); moderation is server-enforced.
- Reliability fixes: unplayable tracks no longer stall the room; stale requests from departed guests removed; graceful shutdown; device list no longer swallows clicks / drops focus.

### Backlog (prioritised; ✓ = done this session)
1. ✓ Reliability: unplayable track (deleted Audius id, flaky node, corrupt file) left the room silent and stalled the queue → skip with toast, stop after 3 consecutive failures (+ e2e regression).
2. ✓ Security: guest requests trusted guest-supplied title/artwork (spoofing; host browser fetching attacker-chosen URLs) → host re-resolves the track on Audius by id.
3. ✓ Reliability: pending requests from guests who left lingered → removed on leave.
4. ✓ Ops: graceful shutdown on SIGTERM/SIGINT (rooms closed → clients see "room ended", metrics records written).
5. ✓ Feature: **Smart Sync Doctor** (spec §8.4 item 8) — room summary line; per-device chip expands to cause + fix + facts labelled measured / estimate / browser-reported (no sub-ms false precision); Identify (chime + vibrate + full-screen name on the device) and Re-sync (flush + clock restart + host forgets auto-sync history). Also fixed: the devices list was rebuilt several times a second, which could swallow clicks and drop keyboard focus. Tests: `doctor.test.ts` (6), `forget()` unit test, e2e expand → identify → collapse/reopen → re-sync keeps playing.
6. ✓ Feature: **Party Mode + reactions** (spec §5.11) — host full-screen display (visualizer, now playing, QR, "N phones listening", sync health; Fullscreen API, Esc/Exit, `P` shortcut, portrait layout) and five fixed guest reactions over sealed KIND_UP frames (guest throttle 500 ms, host cap 6/5 s per guest, allowlisted values). Fixed on the way: focus return after fullscreen exit; visualizer glow clipped to a visible square on the plain party background. Tests: protocol (allowlist), limiter unit test, e2e (reaction on card → party screen with QR/count → reaction with name → exit restores focus).
7. ✓ Moderation (spec §5.2): host "Lock room" (server refuses new devices; members reconnect) and "Remove" per device (socket closed with `removed`, resume token revoked; clear end screens for locked/removed guests). **Security fix on the way**: any client could claim a disconnected guest's peer id (no secret) → per-listener resume tokens, constant-time compared. Tests: rooms unit tests (resume token, lock/remove authz), e2e (locked join refused → member reconnects while locked → remove → unlock → join).
8. ✓ Metrics: room records gain `reconnects` (joins now count unique devices); `/api/stats` adds a funnel (created → joined → played → real session), reconnects and failure signals (unit-tested).
9. ✓ Performance: fonts were inlined as base64 into the render-blocking stylesheet (131 KB) → served from `public/fonts/` (7-day cache) and registered with the FontFace API; stylesheet now 37 KB. Verified in Chromium: both faces load, no CSP errors.
10. ✓ Trust docs: [PRIVACY.md](../PRIVACY.md) (audited against the code: storage, network calls, server logging), [SECURITY.md](../SECURITY.md), [troubleshooting](troubleshooting.md), [manual device checklist](testing/manual-checklist.md). Owner must add a contact address before launch.
11. ✓ Accessibility: keyboard walk of host + listener pages → the request-mode select had no focus indicator (fixed); modal overlays (party, big QR, request sheet) now make the page behind them inert (focus can't escape; e2e-asserted); touch screens get 40 px small buttons/quick-add/chips and a 30 px slider hit area with a 26 px thumb (verified on emulated Pixel 7: a tap 12 px off the track moves the slider). Existing: global focus ring, reduced motion, labelled icon buttons.
12. ✓ Deployment readiness: [docs/deployment.md](deployment.md) — env table, proxy requirements, deploy checklist, operations, cost model; `bun run loadtest` (new) measured ≈ 134 kbps per listener, 1,000 listeners/200 rooms at ≈ 49 % of one core and +45 MB, 0 dropped sockets (Windows dev machine, loopback — indicative). Docker image not built (no Docker here).

Feature decision (from candidates A–J): Sync Doctor (B) and Party Mode (A, with Lightweight Reactions C as its social layer) give the most user value for the effort and build on existing data/UI. One-Tap Rejoin (E) is largely present (link + saved offsets + host resume); Device Labels (G) are covered by friendly names + identify ping; Crowd Picks (D) overlaps requests; Source handoff (I) and synced visuals (F) have weak value/effort; Privacy panel (J) is folded into trust docs + Doctor.

## Session 1d (2026-10-12): tab experience, queue + guest requests, local library
- Tab sharing: service tiles (JioSaavn, Spotify, YouTube Music, YouTube, Apple Music), picker opens on tabs, focus stays on Unison (CaptureController), live input meter, silent-tab hint with "Share again", editable "What's playing?" that updates every device, toast when sharing stops.
- Queue (ADR-0009): host queue with play now / reorder / remove / clear / auto-advance; "+" quick-add on samples and Audius results; guests see "Up next".
- Guest requests: "Request a song" sheet on phones (samples + Audius search) → sealed KIND_UP frames → host approve/decline cards (or auto-add / off), result toasts on the guest.
- Library: songs saved in the host's browser (IndexedDB), multi-file drop, playlists from the queue, play/queue/delete; survives reloads; no server storage, no accounts.
- JioSaavn API: declined again on owner's repeated request (circumvention); owner said they'll pursue it separately. Not in this codebase.
- Tests: 68 unit/integration, Node decode, 11/11 Playwright (new: guest request→approve→plays; library persists + auto-advance).

## Session 1c (2026-10-12): product UI overhaul + Beatsync-informed backend
- New design system and views (ADR-0008): animated landing (sync orb, beams, proof points, how-it-works, privacy band, live listener count), host room (now-playing hero with circular visualizer + cover art + transport/scrubber, source tabs Samples/Audius/File/Tab, big-QR overlay, devices with friendly names, sync meter, empty state, toasts, Space and "/" shortcuts), listener (live invite card before tapping, join orb, player with visualizer, volume, sync chip with "in sync" pop + haptics, sync settings, Media Session). Screenshots checked at 1440/1024/390/375.
- Sample tracks: 8 original Audius uploads (not Beatsync's commercial files), artwork fallback for failing community nodes.
- Backend: probe-pair clock sync, friendly device names in hello/peers, `/api/live`, artwork in encrypted meta (https-only validation).
- Fixes found while doing it: Bun CSS printer breaks @fontsource rules (declared fonts directly); ambient glow hidden by body background; timers wrote to replaced views after "room ended"; late joiner UI only refreshed every 2 s; first chunk scheduled before the audio-clock mapping was warm (10 ms startup offset, regression-guarded by the e2e emission check).
- JioSaavn integration requested and **declined** (decrypts protected streams; see intent decision record). Tab launchers added instead.
- Tests: 63 unit/integration, Node decode test, 9/9 Playwright (dev).

## Session 1b (2026-10-11): continuous silent auto-sync (intent revised by owner)
- Built per ADR-0007 / spec §8.4: per-device pseudo-noise codes at −30 dB under the music, whitened FFT correlation with 4-window accumulation, multi-mic least-squares solver with two-way ranging, control loop with settling, adaptive levels, opt-in "Help sync" phone mics. Chirp calibration kept as "Calibrate with chirps".
- Tests: 60 unit/integration (`bun test`) incl. DSP feasibility, solver, decision logic; 9/9 Playwright in dev and production. Auto-sync loopback: 25 ms offset aligned in ~3 s, steady-state spread 0.03–1.2 ms (5/5, 3/3); two-way helper test: 20 ms travel cancels, gap 0.02–0.5 ms (5/5).
- Bugs found and fixed on the way: settle window shorter than slew time (spread measured mid-correction); 80 % damping made convergence threshold-dependent (3 s vs 45 s); a single missed detection made the solver fall back to one-way equations (20 ms error); level adapter starved helper mics; fresh players estimated timing from a single sample (3 ms chirp error, 1/5 runs).
- Also: glitch counter now split by cause (late chunks, timing jumps, fell behind, big resets, skipped while in background) and shown per device; restarts after Stop/Calibrate no longer count.
- **Unverified**: real rooms (reverb, phone speakers/mics, noise), and whether the −30 dB code is audible — owner listening test needed.

## Real-device observations (informal, not acceptance evidence)
- 2026-10-11, owner: Android phone (Chrome) as listener + Windows Chrome host on the LAN over self-signed HTTPS. Heard a constant buzz/crackle before calibration; gone after **Calibrate**. Most likely the two devices playing tens of ms apart (comb/echo effect). A desktop Chromium check showed zero sample discontinuities at chunk joins (steady and while slewing), so chunk joins are not the cause there. Follow-ups shipped: host shows a "not calibrated" warning while devices play, and per-device glitch counters (late + drops + extra resyncs). Measured spread from that calibration: not yet reported.

## Known limitations / unverified assumptions
- **iOS Safari untested.** APIs used are long-standing (WASM, AudioBufferSourceNode, AES-GCM), but scheduling precision, `getOutputTimestamp` behaviour and ringer-switch handling (`navigator.audioSession`) need a device.
- **~20 ms target unverified**; only software estimates and a digital loopback exist.
- Bun 1.2.6 quirks: runtime corrupts `opus-decoder`'s embedded WASM (test runs under Node); `bun build` of server + HTML import crashes (production runs from source); `--hot` crashed after a bind-option change (dev uses `--watch`); production asset URLs render as `/../../chunk-*.js` on Windows (browsers normalize; works).
- Claude desktop browser pane refuses service-worker registration; real Chromium registers it.
- HTML document can't carry `X-Frame-Options`/`frame-ancestors` from Bun routes → set at the proxy (README).
- System-audio capture can't mute the host's own speakers (UI warns). Tab-capture selection only manually testable.
- Anyone with the full link can listen and could forge host messages (trusted-member model, ADR-0004); a malicious server could replay a whole old epoch of the same room.
- Product name "Unison" is a placeholder.

## Blockers (owner)
1. Real devices: ≥ 1 iPhone, ≥ 1 Android phone, ≥ 1 laptop, ≥ 1 Bluetooth speaker, plus a phone/recorder for the independent measurement.
2. Deployment: choose a target (Fly.io or a VPS) and authorize the deploy and any cost.

## Next tasks (dependency order)
Owner first: review the uncommitted diff of session 2 and commit it if happy (nothing was committed or pushed). Then work through [docs/testing/manual-checklist.md](testing/manual-checklist.md) — sections 2 (sync) and 3–4 (new features) matter most.

0. Owner: real-room auto-sync check — play music with phone + laptop + old laptop; watch "Auto-sync on · hears N of M · measured spread"; listen for any hiss from the −30 dB code in quiet passages; try "Help sync" on a phone far from the host.
1. Owner: run `experiments/ios-audio` on an iPhone (README has the HTTPS steps); commit results in `experiments/ios-audio/results/`.
2. Owner + Claude: LAN session with real devices (`TLS_CERT/TLS_KEY`, README) → calibrate → record the §10.1 measurement → report p50/p95/max honestly in this file.
3. If iOS scheduling misbehaves: switch the player to an AudioWorklet ring buffer behind the `Player` API (ADR-0002 consequence).
4. After authorization: deploy per [docs/deployment.md](deployment.md) (Docker/Fly or VPS + Caddy), set `STATS_TOKEN`, add proxy headers, smoke test over HTTPS; add a contact address to PRIVACY.md and SECURITY.md first.
5. Early users: share with a few friend groups; watch `/api/stats` (funnel created → joined → played → real, reconnects, failure signals, calibration rate, median spread).
6. Candidates for the next sprint: relay reactions to all guests' screens (currently host screen + sender only); "rotate link" (new room key + room, carry the queue) for a hard removal; One-Tap Rejoin polish on flaky networks; a privacy panel in the app linking PRIVACY.md.
