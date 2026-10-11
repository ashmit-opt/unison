# Spec: Synced Multi-Device Audio PWA (v1)

Status: living document. Product intent: `docs/intent/synced-audio.md` (wins on any conflict). Decisions: `docs/architecture/decisions/`.

## 1. Objective
Turn any group of devices into one synchronized speaker system. A **host** plays one source (captured tab/system audio, a local file, or an Audius track); **listeners** open a link or scan a QR code, tap once, and hear it in sync. No accounts. Audio is end-to-end encrypted; the server only relays ciphertext and keeps a few seconds in memory.

Primary use: same room (party). Secondary: remote listening (same engine; drift tolerance is looser, nothing extra is built for it in v1).

## 2. Tech stack (ADR-0001)
| Concern | Choice |
|---|---|
| Runtime, bundler, test runner, package manager, WebSocket server | Bun 1.2 (one tool, one process) |
| Language | TypeScript (strict), checked with `tsc --noEmit` (TypeScript 7) |
| Frontend | Vanilla TS + DOM, one HTML page, CSS file. No framework |
| PWA | Hand-written `manifest.webmanifest` + `sw.js` |
| Encode (host) | WebCodecs `AudioEncoder`, Opus 48 kHz stereo, 20 ms frames, 128 kbps |
| Decode (listener) | `opus-decoder` (WASM libopus) in every browser |
| Playback | Web Audio `AudioBufferSourceNode` chain on a 48 kHz `AudioContext`, `playbackRate` slewing |
| Source tap | One AudioWorklet (`public/tap-worklet.js`) for every source and for the calibration mic |
| Crypto | WebCrypto AES-256-GCM |
| QR | `uqr` (SVG) |
| Browser tests | Playwright (Chromium); unit tests `bun test` |
| Hosting | One container (Dockerfile) on any host with TLS termination (Fly.io documented). Production runs from source: `bun build` of server + HTML import crashes Bun 1.2.6 (observed), while production-mode `Bun.serve` bundles the client at startup and passes the e2e suite |
Lint/format: none in v1 (strict tsc is the gate; revisit if contributors join).

## 3. Commands
```
bun install                 # deps
bun run dev                 # http://localhost:3000 (server restarts on change; client hot-reloads)
bun run check               # tsc --noEmit && bun test src tests && node --test tests/opus-decode.node.mjs
bun run test:e2e            # Playwright via Node (own server on :3100; E2E_NODE_ENV=production tests prod mode)
bun run build               # client bundle sanity check -> dist/
bun run start               # production mode: Bun bundles the HTML import once at startup; PORT (default 3000)
```

## 4. Project structure
```
src/shared/   protocol.ts (wire format + validation), crypto.ts, clock.ts (offset estimator),
              scheduler.ts (chunk placement + slew), calib.ts (chirp + cross-correlation), util.ts
src/server/   server.ts (Bun.serve: static, /api, /ws), rooms.ts (room state, pure, testable), metrics.ts
src/client/   index.html, main.ts (routing + UI), styles.css, net.ts (socket + reconnect + clock),
              player.ts (decrypt → decode → schedule), host.ts (sources → tap → encode → seal),
              calibrate.ts (mic recording + analysis), audius.ts
public/       sw.js, manifest.webmanifest, tap-worklet.js, icons
tests/        integration + e2e tests, fixtures
experiments/  throwaway prototypes (not shipped)
docs/         intent, spec, ADRs, progress
```
Unit tests sit next to the code as `*.test.ts`.

## 5. System architecture
```
 HOST browser                                  SERVER (Bun, one process)            LISTENER browser (xN)
 source ─► AudioNode ─► tap worklet ─► AudioEncoder(Opus) ─► seal(AES-GCM) ─► /ws ─► room ring buffer ─► /ws ─► open ─► WASM Opus ─► scheduler ─► speakers
            (tab/system MediaStream,                                         (ciphertext only,              decode    (server-time
             <audio> for file/Audius)                                         seq/t/epoch header)                       → audio clock)
 local player (host hears the same stream, same path minus network)
```
### 5.1 Responsibilities
- **Server**: creates rooms; relays host messages to listeners; keeps the current epoch's recent chunks in memory for late join/reconnect; answers clock pings with its monotonic time; forwards listener status to the host; aggregates anonymous metrics. It never sees keys or plaintext audio.
- **Host**: owns the room key; turns the chosen source into numbered, timestamped, encrypted chunks; orchestrates calibration with its microphone; optionally plays locally through the same player.
- **Listener**: syncs its clock to the server; decrypts, decodes and schedules each chunk at its target time plus its own device offset; reports status.

### 5.2 Rooms
- `POST /api/rooms` → `{ room, hostToken }`. `room`: 10 chars of Crockford base32 (50 bits). `hostToken`: 16 random bytes, base64url. Rate limited to 20 creations/min per client IP (in-memory window, IP never persisted).
- Host browser generates the 32-byte room key and navigates to `/r/<room>#k=<base64url key>`; `hostToken` lives in `sessionStorage["host:<room>"]` (so a reload keeps the host role).
- Share link = the same URL without host token. QR encodes the full URL including the fragment.
- Limits: 32 peers per room, 2000 rooms per process.
- Lifecycle: room is deleted when (a) no host connected for 10 min, or (b) nobody connected for 60 s, or (c) 12 h after creation. Deletion closes sockets with `room-closed` and drops the buffer.

### 5.3 Sources (one pipeline)
All sources become a Web Audio node feeding the same tap worklet → encoder:
| Source | Node | Browsers | Notes |
|---|---|---|---|
| Tab audio | `getDisplayMedia` audio track → `MediaStreamAudioSourceNode` | Chrome/Edge desktop | `suppressLocalAudioPlayback: true` so the tab is silent locally; host hears it via the local player |
| System audio | same, user picks a screen with "share system audio" | Chrome/Edge on Windows/ChromeOS; macOS 14.2+ with recent Chrome | Local system output cannot be suppressed → host device plays the original ahead of everyone; UI warns to mute host speakers or use tab audio |
| File | `<input type=file>` → object URL → `<audio>` → `MediaElementAudioSourceNode` | any browser with AudioEncoder | Native `<audio controls>` provides play/pause/seek. File never leaves the device unencrypted |
| Audius | search `api.audius.co/v1/tracks/search` → `<audio crossorigin=anonymous src=.../v1/tracks/{id}/stream?app_name=syncaudio>` | same as file | No API key needed; CORS `*` on the whole redirect chain (verified 2026-10-11). Only `is_streamable` tracks listed. Title + artist credited in UI with link to Audius |
Kind is labeled from the capture (`displaySurface` = `browser` → tab, `monitor`/`window` → system).
Pause/seek in file/Audius produce silence/jumps in the *media*, not protocol events: the stream keeps flowing (Opus silence is tiny), so there is one code path. Changing source or pressing Stop ends the epoch.
Hosting requires `AudioEncoder` with Opus (`isConfigSupported`); otherwise the UI explains hosting isn't available in this browser.

### 5.4 Encoding and chunks
- Host `AudioContext` at 48 kHz. Tap worklet posts 960-frame stereo blocks (20 ms). Each block → `AudioData` (`f32-planar`, timestamp = sampleIndex/48 kHz) → `AudioEncoder` (`opus`, 128 kbps, frameDuration 20 ms).
- Five consecutive Opus packets form one **chunk** (100 ms). Chunk target time `t` (server ms) = epoch anchor `A` + firstSample/48.
- The host encodes nothing until its clock estimate is ready (§7.1); otherwise every timestamp would be wrong.
- Anchor: at epoch start `A = serverNow + LEAD` with `LEAD = 800 ms`. Host drift correction (`DriftTracker`): at each tap block record `x = serverNow − audioTime`; over a 10 s window take the 10th percentile (main-thread delays only add positive noise; a percentile, unlike the minimum, ignores rare early outliers such as start-up render bursts). After a 10 s warm-up the first value is the baseline; at most once per second, if the percentile moved ≥ 5 ms, `A += Δ` and the baseline moves. Listeners absorb the step by slewing, all by the same amount, so inter-device sync is unaffected. (The first implementation compared against the first chunk's slack and produced spurious 10 ms steps from encoder start-up; replaced, with regression tests.)
- Epoch: u32, starts at `welcome.epoch + 1` and increments for every new source or after Stop.

### 5.5 Transport
One WebSocket per tab at `/ws`. Text frames carry JSON control; binary frames carry sealed (encrypted) host payloads. See §6.

### 5.6 Playback scheduling (listener and host local player)
See §7. One `AudioContext({ sampleRate: 48000 })` per device, created inside the tap-to-join gesture.

### 5.7 Encryption boundary
Everything inside binary payloads (Opus packets, track metadata, calibration commands) is encrypted end-to-end. Visible to the server: room id, epoch, seq, target time, message sizes and timing, peer count, listener status numbers, coarse browser family, source category. See §9.

### 5.8 Disconnect / reconnect
- Client reconnects with backoff 0.5 s × 2^n up to 5 s, forever while the page is open. `hello` includes the previous `peer` id; the server reuses it if free.
- On (re)join the server sends `welcome`, then every buffered chunk of the current epoch with `t > serverNow − 100 ms`. The player drops duplicates by `(epoch, seq)`.
- Host reload: same `hostToken` reclaims the host role (an older host socket is closed with `replaced`). The host starts a new epoch.
- Host offline: listeners get `host {online:false}` and show "Host disconnected"; buffered audio plays out, then silence.

### 5.9 Browser-specific limitations (v1)
- Capture hosting: Chrome/Edge desktop only (no mobile or TV capture — out of scope).
- iOS Safari: playback stops when the screen locks or the page is backgrounded (out of scope; UI asks to keep the screen on; Wake Lock requested). `navigator.audioSession.type = "playback"` is set where available so the ringer switch does not mute playback. iOS support is **unverified until tested on a real device** (experiment in `experiments/ios-audio`).
- Bluetooth output adds 100–300 ms; browsers report it unreliably → acoustic calibration (speakers) or manual nudge (headphones).
- Secure context required (WebCrypto, AudioWorklet, mic, capture, SW): production must be HTTPS; local dev uses `localhost`.

### 5.10 Deployment and operations
- Single container; `PORT` env; TLS terminated by the platform (Fly.io) or a reverse proxy (Caddy). WebSockets must be allowed through the proxy.
- One process holds all rooms in memory → scale vertically; rooms die on restart (acceptable: sessions are transient). Health: `GET /healthz`.
- Env: `PORT`, `METRICS_FILE` (default `data/metrics.jsonl`), `STATS_TOKEN` (enables `/api/stats`), `TRUST_PROXY=1` (use `Fly-Client-IP`/`X-Forwarded-For` for the creation rate limit).
- Response headers: strict CSP (§9.7), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: microphone=(self), display-capture=(self)`.

### 5.11 UI (ADR-0008)
Design system, screens, states and motion rules are in ADR-0008. Views: `src/client/views/{landing,host,listener,common}.ts`; helpers `src/client/ui/{dom,visualizer}.ts`. Highlights: live invite (the listener page connects before the tap and shows host name, what's playing, device count; dead rooms show "room ended" immediately), circular spectrum visualizer around cover art, source tabs (Samples · Audius · File · Tab), sample tracks (`src/client/samples.ts`, Audius ids, artwork fetched live with generated-cover fallback), big-QR overlay, per-device friendly names (`hello.name`, validated `[\p{L}\p{N} _-]{1,32}`), volume + haptics on listeners, toasts for join/leave/in-sync, keyboard shortcuts (Space, `/`), Media Session metadata. Fonts are declared in `styles.css` directly because Bun 1.2.6's CSS printer corrupts `unicode-range` and unquoted `format()` values from the @fontsource CSS.

## 6. Protocol (version 1)
Constant `PROTOCOL_VERSION = 1`. Bump on any incompatible change.

### 6.1 JSON messages (text frames, ≤ 4 KiB)
Client → server:
| type | fields | rules |
|---|---|---|
| `hello` | `v:int, room:string(10), role:"host"\|"listener", hostToken?:string, peer?:int` | must be the first message, within 5 s of connect; `v` must equal server version else `error{code:"bad-version", v}` and close |
| `ping` | `id:int, t0:number, pair?:int, idx?:0\|1` | ≤ 20/s; pong echoes `pair`/`idx` |
| `status` | `state, bufferMs, errMs, rate, late, drops, resyncs, authFail, rttMs, uncMs, outLatMs, offsetMs, calibrated:bool, map:"ots"\|"env"`; host adds `source?: kind`, `spreadMs?: number` | numbers clamped to sane ranges; ≤ 2/s |
| `stop` | `epoch:int` | host only; clears buffer, broadcast |
Server → client:
| type | fields |
|---|---|
| `welcome` | `v, peer:int, role, epoch:int, hostOnline:bool` |
| `pong` | `id, t0, ts:number` (server monotonic ms) |
| `peers` | `peers:[{peer, role, browser, mobile, name?}]` (to everyone on change) |
| `peer-status` | `peer, status` (host only) |
| `stop` | `epoch` |
| `host` | `online:bool` (listeners) |
| `error` | `code: bad-version\|no-room\|bad-token\|room-full\|bad-message\|replaced\|room-closed\|rate-limit, v?` |

### 6.2 Binary messages (sealed, host → server → listeners, ≤ 64 KiB)
Header (big-endian), followed by `iv(12) ‖ AES-GCM ciphertext+tag(16)`:
```
CHUNK: u8 v=1 | u8 kind=1 | u32 epoch | u32 seq | f64 t        (18 bytes)
CTL:   u8 v=1 | u8 kind=2 | u32 to (0 = all listeners)        (6 bytes)
AAD  = utf8(room) ‖ header
```
CHUNK plaintext: `u8 n | n × (u16 len | Opus packet)`. CTL plaintext: UTF-8 JSON, one of
`{type:"meta", epoch, kind, title?, artist?, url?}` (sent at epoch start and to every newly joined peer),
`{type:"cal-play", round, at}` (play the chirp at server time `at`), `{type:"cal-adjust", deltaMs}`,
`{type:"pn", db}` (auto-sync code level for the receiving device, −60…−10 dB, or `null` = off; §8.4).

Queue & requests (ADR-0009): CTL `{type:"queue", mode:"ask"|"auto"|"off", now?, next:[{title, artist?, art?, by?}] (≤30)}` and `{type:"request-result", ref, ok, reason?}`. Listener → host frames use kind 3 (`KIND_UP`): header `v | 3 | from u32`, payload `{type:"request", ref, audiusId, title, artist?, art?, durationS?}`; the server accepts them only from listeners whose peer id equals `from` and forwards them only to the host. CTL JSON may be up to 16 KiB.

Status (§6.1) also carries optional diagnostics: `starts, jumps, under, flushes, bgDrops, maxJumpMs, hidden` (restart causes, background skips) and, for helpers, `heard: {peerId: lagMs}` (≤ 40 entries, |lag| ≤ 2000).

Server validation of binary: only from the host socket; size 24..65536; `v` and `kind` known; CHUNK: `epoch ≥ room.epoch`, `seq` strictly increasing within the epoch, `t` finite. A higher epoch resets the buffer. Invalid messages are dropped and counted; > 50 invalid messages closes the socket with `bad-message`.

### 6.3 Buffering, backpressure, timeouts
- Room buffer: current epoch only; keep chunks with `t ≥ serverNow − 1000 ms`, max 100 chunks. Memory only.
- Per-socket backpressure: Bun `backpressureLimit` 512 KiB with `closeOnBackpressureLimit` → slow client is dropped and resumes via reconnect + buffer.
- `idleTimeout` 30 s (clients ping every 1 s). Hello timeout 5 s. Message rate cap 200/s per socket (close on abuse).

## 7. Synchronization
### 7.1 Clocks
- **Server time S**: server `performance.now()` (ms). Room-scoped meaning only.
- **Client offset θ = S − P** (P = client `performance.now()`), estimated from pings: `θᵢ = ts − (t0 + t1)/2`, `rttᵢ = t1 − t0`. Pings go out as **probe pairs** 25 ms apart (Huygens-style, as in Beatsync): a pair is used only if the server saw the same gap ±5 ms (neither probe was queued), and then only its faster probe; if almost nothing is pure (> 20 impure, < 10 % pure) impure pairs are accepted so a degraded network still syncs. Pairs every 100 ms for the first 10, then every 1 s. The estimate is "ready" after 5 samples; players hold incoming chunks and hosts hold encoding until then (a late joiner once scheduled replayed chunks with θ = 0, i.e. minutes in the future — regression-tested). Keep the last 15 samples; estimate θ = mean θᵢ of samples with `rtt ≤ minRtt + max(2 ms, 0.2·minRtt)`; uncertainty `u = minRtt/2`. Asymmetric delay biases θ by a constant per path — absorbed by acoustic calibration.
- **Output mapping**: ctx time ↔ P at the *speaker*. Preferred: `getOutputTimestamp()` → `(contextTime, performanceTime)` (Chromium evidence: contextTime trails currentTime by ≈ outputLatency + baseLatency, so it describes the audible frame). Accepted only if `contextTime ∈ (currentTime − 0.5 s, currentTime]` and `performanceTime ∈ (now − 500 ms, now]`. Fallback ("env"): sample `currentTime·1000 − now` and keep the maximum over the last 2 s (currentTime is stale between updates, so the max is the tightest bound), then subtract `outputLatency` if exposed. The mapping offset `m = ctx·1000 − P` is median-filtered over the last 15 readings.
### 7.2 Target emission time
Chunk with target `t`: desired speaker time `P* = t − θ − o`, where `o` = device offset (calibration + manual nudge, ms). Desired ctx start `D = (P* + m)/1000`.
### 7.3 Scheduler (pure function, `src/shared/scheduler.ts`)
State `{ next: ctx seconds | null }`. For each chunk (duration `d` = 0.1 s) with desired start `D`, current ctx time `now`:
1. `safe = now + 0.010`.
2. If `next − D > 200 ms` (far behind already-scheduled audio, e.g. a corrected clock) → **flush**: the player stops all scheduled sources, then resyncs at `D`.
3. If `next` is null, `|D − next| > 25 ms`, or `next < safe` → **resync** with floor `max(safe, next)`: if `D ≥ floor` start at `D`; else if `D + d > floor` start at `floor` with buffer offset `floor − D` (late join, late chunk, small backward jump: trimmed, never overlapping); else **drop**. Rate 1.
4. Else **chain**: `err = D − next`. If `|err| < 0.5 ms` → rate 1; else rate `r = d / (d + err·min(1, d/2 s))` clamped to `1 ± 0.002`. Start at `next`.
5. `next = start + (d − offset)/r`.
Properties (unit-tested): converges and holds |err| < 1 ms under 100 ppm drift and ±1 ms mapping jitter; never overlaps chunks; late chunks are trimmed or dropped; a gap (lost chunk) causes one resync, not drift.
Max slew 0.2 % (≈ 3.5 cents pitch, inaudible) corrects up to 2 ms/s. Larger errors resync (audible glitch, counted).
### 7.4 Drift, jumps, late join
- Audio-clock vs system-clock drift and server-vs-client drift both show up as slow changes in `D`; the chain slews them away.
- Host anchor steps (≤ ~10 ms) are slewed; source changes start a new epoch → listeners flush (stop all future sources, reset decoder) and resync.
- Late join / reconnect: buffered chunks have `t` in the future → normal resync at the first playable chunk.
### 7.5 Software time ≠ sound
Scheduling at the right ctx time only guarantees the *browser's* idea of output time. Output latency (DAC, OS mixer, Bluetooth) is partially reported (`outputLatency`, `getOutputTimestamp`) and partially invisible. The remaining per-device constant is measured acoustically (§8). The UI and metrics distinguish "software error" (`errMs`, `uncMs`) from "measured spread" (acoustic).

## 8. Automatic calibration
### 8.1 What software can and can't know
| Latency | Visible to software? |
|---|---|
| Scheduling (JS → audio thread) | yes, handled by scheduling ahead |
| Browser/OS mixer (`baseLatency`, part of `outputLatency`) | partially |
| DAC + device buffers | partially via `outputLatency` (Chrome 102+, Firefox 70+, Safari 18.4+) |
| Bluetooth codec/radio (100–300 ms, varies per connection) | usually not, or inaccurately |
| Clock-sync path asymmetry | no (constant bias) |
| Acoustic path (≈ 2.9 ms per metre) | no |
Therefore: physical measurement with a microphone.
### 8.2 Flow (host is the measuring device)
1. Host taps **Calibrate**. Stream is stopped (quiet room gives best results). Host gets mic with `echoCancellation/noiseSuppression/autoGainControl: false`; `audioSession.type = "play-and-record"` where available. UI: "Put this device where people will listen."
2. Players = all listeners + the host's local player (if enabled). Chirps are scheduled only once the mic is delivering audio (≥ 10 blocks; otherwise "microphone isn't delivering audio"). Slot `i` at `Sᵢ = serverNow + 1500 + 900·i` ms. Host sends sealed `cal-play {round, at:Sᵢ}` to each peer; each device schedules the chirp exactly like audio (same `θ`, `m`, `o`).
3. Chirp: 40 ms linear sweep 1.5→7 kHz, amplitude 0.8, 2 ms fades. Deterministic (shared code).
4. Host records the mic through the tap worklet; each block carries its ctx frame index, so every mic sample has a ctx time (input latency is unknown but identical for all slots, so it cancels).
5. For slot `i`: search window `[Sᵢ − 200, Sᵢ + 600]` ms (a device bias of −30…−45 ms was observed in Chromium, so a −50 ms edge missed chirps; 900 ms slots keep neighbours out of each window) (server → host ctx via host `θ`, `m`); normalized cross-correlation with the chirp; arrival = peak with parabolic interpolation. Accept if peak-to-median ratio ≥ 8 and normalized peak ≥ 0.3; otherwise the device "wasn't heard".
6. `lagᵢ = arrivalᵢ − Sᵢ`. Reference = median of accepted lags. Send `cal-adjust {deltaMs: lagᵢ − ref}` → device adds it to `o` (a late device starts earlier).
7. Verification rounds (same procedure; adjust again while the residual is > 2 ms or a device wasn't heard; max 4 rounds in total). **Measured spread** = max − min of residual lags of accepted devices, defined only when ≥ 2 devices were heard (a single heard device is not "0 ms"). Shown in the host UI (with devices not heard) and reported (`spreadMs`) to metrics.
8. Browser evidence: a digital loopback test (two players into a `MediaStreamDestination` used as the "mic", one 25 ms late) measures the gap as 25 ± 1 ms and verifies ≤ 2 ms spread (4/4 runs). This validates the algorithm on a real audio graph, not acoustic accuracy.
### 8.3 Limits and fallbacks
- Aligns arrival at the *microphone position*; other positions differ by path length differences (2.9 ms/m).
- Headphones / earbuds cannot be heard → manual nudge slider (±300 ms, 1 ms steps) on the listener; Bluetooth speakers are measured normally.
- Route change (`devicechange` event, or `outputLatency` changes by > 5 ms) marks the device "recalibrate".
- Offsets live in `sessionStorage` per room (reload-safe; not reused across rooms because path bias differs).
- Failure (no mic permission, not heard, noisy room) → message + manual nudge; playback still works uncalibrated.

### 8.4 Continuous silent auto-sync (ADR-0007, intent revision 2026-10-11)
Primary calibration method; §8.2 chirps remain as a manual fallback ("Calibrate with chirps").
1. **Codes** (`src/shared/pn.ts`): device `id` (peer id; host = 0) has a deterministic ±1 pseudo-noise code at 16 kHz, band-passed 0.8–6 kHz, RMS 1, period 4 s. `pnAt(code, ms)` = value at shared time `ms` (linear interpolation).
2. **Emission** (player): for each chunk with target time `t`, add `amp · pnAt(code, t + i/48)` to both channels, `amp = chunkRMS · 10^(db/20)` (default −30 dB; 0 when the chunk is silent). Enabled by `pn` control messages from the host; the host's local player uses id 0.
3. **Measurement** (`MicListener`, host and opt-in helpers): mic (no AEC/NS/AGC) → tap worklet → every 1.5 s take the newest complete 1.5 s window → 31-tap FIR low-pass + decimate to 16 kHz → whitened FFT spectrum → per code: correlation over lags ±300 ms → sum with the previous 3 windows → peak (earliest arrival within 10 ms that is ≥ 0.6 × max), accepted if peak/RMS ≥ 6. Window start time on the shared timeline from the mic's frame index, the env mapping and θ (input latency is a per-mic constant).
4. **Solve** (`solveOffsets`): least squares on `lag[m][i] = e[i] + b[m] + d[m][i]` with `d[m][m] = 0`, symmetric unknown `d` for two-way pairs, gauge mean(e)=0 per connected group; only the largest group is corrected. Between two active microphones only complete two-way sets (each hears itself and the other) are used.
5. **Control** (`AutoSyncHost`): per mic/device median of the last 3 accepted lags; entries live 4 s. A device is measurable only when its last correction is ≥ 3 s old (helpers' data ≥ 7.5 s, as their accumulations aren't reset) and its scheduler chain error ≤ 1.5 ms (slew finished). Correction = `e[i] − median(e)` when ≥ 1 ms (full step; ≤ 25 ms slews inaudibly, larger resyncs once). Measured spread = max − min of `e` over the group (held 8 s through gaps).
6. **Levels**: per device, start at −30 dB; +3 dB (max −24) if not heard by any mic for 6 s; −3 dB (min −36) after 3 consecutive windows with peak ratio > 20 at the host mic, only while no helper is active.
7. **UI**: host is asked for the microphone when it first plays something; status line shows how many devices are heard and the measured spread; per-device "synced"/"not heard yet". Listener card "Help sync with this microphone" (opt-in); only timing numbers leave the phone.
8. **Limits**: needs music (silence carries no code); aligns at the microphones (two-way pairs: at the source); reverb, noisy rooms and audibility of the code are untested on real devices.

## 9. Encryption and privacy
### 9.1 Threat model
Protect audio content and track metadata from the server operator, network observers and anyone without the full link. Room members (anyone holding the full URL) are trusted. Out of scope: malicious room members, traffic analysis, server denial of service.
### 9.2 Keys
- Host generates 32 random bytes (`crypto.getRandomValues`), imports as AES-GCM 256 (non-extractable after import).
- Transferred only in the URL fragment `#k=<base64url>`. Browsers never send fragments in HTTP requests or `Referer`. The client never sends `location.href` anywhere; analytics are server-side counts.
- Key is never put in `localStorage`; it stays in the URL (needed for reload/reconnect). Leaving the room page clears it from memory.
### 9.3 Sealing
AES-256-GCM, 96-bit random IV per message, 128-bit tag, AAD = room id ‖ clear header (version, kind, epoch, seq, t / target). The server can't read or modify payloads or headers without detection. IV uniqueness: random IVs are safe up to 2³² messages per key; a room lasts ≤ 12 h ≈ 4.5·10⁵ messages, so collision probability is negligible (< 2⁻⁵⁰). No key rotation needed in v1.
### 9.4 Replay / injection
- Injection: impossible without the key (GCM tag).
- Cross-room: AAD contains the room id; different rooms also have different keys.
- Replay: players drop `(epoch, seq)` ≤ last seen and chunks whose `t` is already past. Known limit: a malicious server could replay an *entire* old epoch of the same room with fresh timing to a newly joined member (it controls the clock). Documented, accepted for v1.
- Control messages a server could forge are unauthenticated JSON (`stop`, `peers`, `host`) → availability only, never content.
### 9.5 No persistent audio
The server holds ciphertext chunks in memory only, ≤ 100 per room, deleted on epoch change, stop or room deletion. No disk writes except the aggregate metrics file. Files and Audius tracks are decoded on the host device; nothing is uploaded except encrypted Opus chunks.
### 9.6 Anonymous metrics
On room deletion the server appends one JSON line to `METRICS_FILE`:
`{v:1, day, durationS, peakPeers, joins, played, playedS, sources[], browsers{family:n}, mobile, desktop, late, drops, resyncs, authFail, calibrated, spreadMs}`.
No room ids, IPs, user agents, keys, titles or exact timestamps. `/api/stats?token=…` (only if `STATS_TOKEN` set) returns totals: rooms, rooms with ≥ 2 devices and ≥ 60 s played ("real sessions"), device joins, calibration rate, median spread.
### 9.7 Web hardening
CSP (meta tag in the HTML): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.audius.co; media-src 'self' blob: https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'`. No third-party scripts. Other responses carry `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Permissions-Policy`. Known gap: Bun HTML-import routes can't set response headers, so the HTML document itself has no `X-Frame-Options` / `frame-ancestors` (not settable via meta); the deployment proxy adds them (README).

## 10. Acceptance criteria
### 10.1 In-room sync (~20 ms target)
- **Definition**: for a set of devices playing the same stream, sync error = difference between their acoustic emission times of the same audio sample, observed at one listening position. Reported as spread = max − min across devices.
- **Measurement A (built-in acoustic)**: the app's verification round (§8.2 step 7): mic at the listening position, all devices ≤ 3 m from it at roughly equal distance (distance differences add 2.9 ms/m and are recorded). Uncertainty ±1 ms (correlation) plus geometry.
- **Measurement B (independent)**: record the room with a separate recorder (phone voice memo at 48 kHz) while all devices play a click track (generated by the app's "Test clicks" source: 5 ms clicks every 500 ms); measure onset differences in an audio editor. Used to cross-check A on at least one session.
- **Device matrix**: ≥ 4 devices including ≥ 1 iPhone (Safari), ≥ 1 Android (Chrome), ≥ 1 laptop (Chrome), ≥ 1 Bluetooth speaker; host on Chrome desktop.
- **Duration / sample size**: after calibration, a 30-minute session; spread measured every 5 minutes (≥ 7 samples) plus once after a forced listener reconnect.
- **Transients**: first 10 s after join/resync excluded and reported separately.
- **Pass**: p95 spread ≤ 20 ms and max ≤ 30 ms over the samples, with zero audible resyncs per 10 min per device on stable Wi-Fi. Report p50/p95/max, failures, and geometry.
- Software-only numbers (`errMs`, `uncMs`) are diagnostics, never evidence of the target.
- **Status today**: unverified (needs physical devices).
### 10.2 Functional
| Area | Criterion | How verified |
|---|---|---|
| Join | Opening the share link or scanning the QR, then one tap, starts playback within 3 s when a stream is running | e2e (link); QR = same URL (unit: QR payload equals link) |
| No account | No signup, login, cookies or identifiers required | e2e + code review |
| Sources | Tab capture, file, Audius each reach listeners with 0 decode errors | e2e (file, synthetic stream); manual (tab, Audius) |
| Late join | Listener joining mid-stream plays within 1.5 s, aligned (|errMs| < 2 after 5 s) | e2e |
| Reconnect | Socket drop + reconnect within 5 s resumes without restart of the host | integration + e2e |
| E2E crypto | Server-side buffers contain no plaintext; tampered header/payload/room → rejected; key never in any HTTP request | unit + integration |
| No storage | No audio bytes written to disk by the server | code review + integration (fs writes limited to metrics) |
| Capabilities | Unsupported features (capture, hosting, mic) are hidden or explained, never crash | unit + manual matrix |
| Lifecycle | Rooms deleted per §5.2 rules; sockets closed with reason | unit (fake clock) |
| Metrics | One record per room, only §9.6 fields | unit |
| Auto-sync | With music playing, a device 25 ms off is aligned to ≤ 2 ms measured spread without user action; far-apart mic devices align at the source | e2e (digital loopback); real rooms: owner test |
| PWA | Installable (manifest, icons, SW); offline load shows the app shell and an offline message | e2e (SW registered) + Lighthouse-style manual |
| Errors | bad version → "update" prompt; room closed / host offline / mic denied / not heard → clear message | unit + e2e |

## 11. Testing strategy
- `bun test`: protocol encode/decode + validation, crypto (round trip, tamper, wrong room/key), clock estimator (synthetic asymmetric jitter), scheduler (drift, jitter, late, gaps), calibration correlation (synthetic delayed chirp + noise), rooms (join/leave/buffer/epoch/limits/cleanup with fake clock), Opus decode of a real WebCodecs fixture, server integration over real WebSockets.
- Playwright (Chromium): create room → host plays a generated file → listener joins → playing; late join; reconnect; SW registration. WebKit on Windows has no Web Audio (verified) → iOS only on real devices.
- Manual/real-device checklist in `docs/progress.md`.

## 12. Boundaries
- Always: keep tests green; validate every network input; keep the server blind to keys/plaintext; update spec/ADRs with design changes.
- Ask first: deploys, paid services, new major dependencies, product-intent changes.
- Never: persist audio, log URLs with fragments, add out-of-scope features, weaken crypto or tests to get green.

## 13. Implementation plan (dependency order)
1. Shared core: protocol, crypto, clock, scheduler, calib (+ unit tests).
2. Server: rooms + WS relay + API + static + headers + metrics (+ unit/integration tests).
3. Client player (listener) + net + join flow.
4. Host: file source → tap → encoder → seal; local player. **Vertical slice: file plays on two tabs.** e2e.
5. Tab/system capture; Audius search/play.
6. Calibration (mic, chirp, correlation, adjust, verify) + manual nudge.
7. PWA (manifest, icons, SW), wake lock, audio session, error/capability UX, "Host your own room".
8. Metrics + stats endpoint. Dockerfile + deploy docs.
9. Real-device validation (iPhone experiment, sync measurement) — needs hardware.

## 14. Open questions
- None blocking. Real-device results may change §7.1 fallback details for iOS.
