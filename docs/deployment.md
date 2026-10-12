# Deployment readiness

Status: **not deployed.** Everything below is prepared so the owner can deploy in under an hour after choosing a host and approving any cost. Nothing here has been run against a public host.

## What runs
One Bun process (`src/server/server.ts`) serving the PWA, the room API and the WebSocket relay. No database. Rooms live in memory (a restart ends live sessions; clients show "room ended"). The only file written is the anonymous metrics log (`METRICS_FILE`, one JSON line per finished room). `Dockerfile` builds it (`oven/bun:1.2.6-alpine`, non-root, health check on `/healthz`). The image has **not** been built in this environment (no Docker here).

## Environment
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 (image: 8080) | Listen port |
| `HOST` | 0.0.0.0 | Listen address |
| `NODE_ENV` | — | `production` = bundle the client once at startup, no dev HMR |
| `METRICS_FILE` | `data/metrics.jsonl` (image: `/data/metrics.jsonl`) | Anonymous per-room records; put it on a volume |
| `STATS_TOKEN` | unset | Enables `GET /api/stats?token=…` (funnel, joins, reconnects, failure signals, sync stats). Use a long random value |
| `TRUST_PROXY` | unset | `1` = take the client IP from `Fly-Client-IP` / `X-Forwarded-For` for the room-creation rate limit. Only set behind a proxy you control |
| `PUBLIC_DIR` | `./public` | Static files (allowlisted at startup) |
| `TLS_CERT`, `TLS_KEY` | unset | Direct HTTPS (LAN testing). In production terminate TLS at the platform/proxy |

## Proxy requirements
- HTTPS (phones require a secure context for WebCrypto, AudioWorklet, the microphone and service workers).
- WebSocket upgrade on `/ws`, idle timeout ≥ 60 s (clients ping every second).
- Add `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` to all responses (Bun can't set headers on the HTML-import page; the CSP itself is in a meta tag).
- Optional: gzip/brotli for HTML/JS/CSS (fonts and audio are already compressed).
- Caddy example: `unison.example.com { reverse_proxy localhost:8080 header X-Frame-Options DENY header Content-Security-Policy "frame-ancestors 'none'" }`.

## Measured capacity (indicative)
`bun run loadtest <rooms> <listenersPerRoom> <seconds>` — real server in-process, simulated hosts (128 kbps Opus-sized sealed chunks, 10/s) and listeners (pings, status reports) in a child process. Measured on the owner's Windows dev machine over loopback, 2026-10-12:

| Rooms × listeners | Server CPU (one core) | RSS idle → peak | Relay buffers | Per listener | Egress | Dropped sockets |
|---|---|---|---|---|---|---|
| 10 × 4 | 2.6 % | 163 → 174 MB | 0.3 MB | 133.5 kbps* | 4.9 Mbps | 0 |
| 100 × 5 | 27 % | 164 → 194 MB | 2.8 MB | 133.8 kbps* | 60 Mbps | 0 |
| 200 × 5 | 48.8 % | 165 → 210 MB | 5.4 MB | 134.2 kbps* | 119 Mbps | 0 |

\* normalised to 10 chunks/s (Windows timers let the simulated hosts send ~9/s).

Reading: ≈ 0.05 % of a core and ≈ 40 KB of memory per connected listener, ≈ 27 KB of buffered ciphertext per playing room. **Bandwidth is the limit, not CPU or memory**: each listener receives ≈ 134 kbps ≈ **60 MB per listener-hour**; the host uploads the same once per room. A single small VM (1 shared vCPU, 256–512 MB) should hold a few hundred concurrent listeners if its network allows ~50 Mbps sustained egress. Not measured: real internet paths, TLS overhead (~2–5 %), a Linux VM, browser clients at this scale.

## Cost model (no prices assumed — check the provider's current pricing)
- Egress GB/month ≈ `listener-hours/month × 0.06`. Example: 50 rooms/day × 4 listeners × 1.5 h × 30 days = 9,000 listener-hours ≈ **540 GB/month**.
- Compute: one small always-on VM (memory above is ~200 MB at 1,000 listeners). Scale vertically; a second region would need room affinity (out of scope for v1).
- Storage: metrics log grows by ~400 bytes per room (≈ 0.6 MB/month at 50 rooms/day).
- Abuse ceiling built in: 2,000 rooms per process, 32 devices per room, 20 room creations/min per IP, 12 h max room lifetime, per-socket message rate limit and backpressure cut-off.

## Deploy checklist (owner)
1. Choose the host (Fly.io or a VPS + Caddy) and approve the cost. *(blocked on owner)*
2. Pick the domain/name ("Unison" is a placeholder). *(owner)*
3. Build and run the image locally once: `docker build -t unison . && docker run -p 8080:8080 unison`, open `http://localhost:8080/healthz`.
4. Set `STATS_TOKEN` (random), `TRUST_PROXY=1` (behind Fly/Caddy), a volume for `/data`.
5. Add the two proxy headers above; confirm `wss://…/ws` connects.
6. Smoke test on the public URL: create a room on desktop Chrome, join from two phones on mobile data and Wi-Fi, play a sample, check Sync Doctor shows round trips, lock/unlock, end the room, then `GET /api/stats?token=…` shows one record.
7. Optional: run `bun run loadtest 100 5 30` on the VM itself (it starts its own server on a random local port) to see that machine's headroom.
8. Publish the privacy notice ([PRIVACY.md](../PRIVACY.md)) and security contact ([SECURITY.md](../SECURITY.md)) on the site/repo before sharing the link with strangers.

## Operations
- Health: `GET /healthz` (200). Live counts: `GET /api/live` (`{listeners, rooms}`, cached 5 s).
- Deploys: SIGTERM closes every room cleanly (clients see "room ended"; metrics records are written) and exits within ~300 ms. Expect live sessions to end on each deploy; deploy at quiet hours.
- Logs: startup line and shutdown summary only; nothing per request, no room ids or IPs.
- Metrics: `GET /api/stats?token=…` → funnel (created → second device joined → played → real session ≥ 2 devices and ≥ 60 s), device joins, reconnects, failure signals (late chunks, drops, playback resyncs, rooms with decryption failures), calibration rate, median measured spread.
