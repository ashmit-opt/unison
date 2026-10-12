# Unison

Turn every phone and laptop in the room into one synchronized speaker system. A host plays a browser tab, system audio, a local file or an Audius track; friends scan a QR code, tap once, and hear it in sync. No app, no account. Audio is end-to-end encrypted — the server relays ciphertext it cannot read and stores nothing.

> "Unison" is a working name.

- Product intent: [docs/intent/synced-audio.md](docs/intent/synced-audio.md)
- Technical spec: [docs/specs/synced-audio.md](docs/specs/synced-audio.md)
- Decisions: [docs/architecture/decisions/](docs/architecture/decisions/)
- Status, test results, next steps: [docs/progress.md](docs/progress.md)
- Deployment readiness, capacity and cost model: [docs/deployment.md](docs/deployment.md)
- Privacy notice: [PRIVACY.md](PRIVACY.md) · Security policy: [SECURITY.md](SECURITY.md) · Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)
- Real-device test checklist: [docs/testing/manual-checklist.md](docs/testing/manual-checklist.md)

## Quick start
Requires [Bun](https://bun.sh) 1.2+ (and Node 22+ for Playwright and one test).
```bash
bun install
bun run dev            # http://localhost:3000
```
Open it in desktop Chrome or Edge, **Create a room**, then open the room link in another tab or device and tap **Join**.

## Commands
| Command | What it does |
|---|---|
| `bun run dev` | Dev server with hot reload on `PORT` (default 3000) |
| `bun run check` | Typecheck + unit/integration tests (+ WASM decode test under Node) |
| `bun run test:e2e` | Playwright browser tests (Chromium; first run: `npx playwright install chromium`) |
| `bun run build` | Bundle the client to `dist/` (sanity check; production serves from source) |
| `bun run start` | Production mode (bundles the client once at startup) |
| `bun run loadtest [rooms] [listeners/room] [seconds]` | Relay capacity check: local server + simulated clients; prints CPU, memory, per-listener bandwidth |

## Testing with real phones on your Wi-Fi
Phones need HTTPS (WebCrypto, AudioWorklet, microphone and service workers require a secure context):
```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=unison-dev" -keyout certs/key.pem -out certs/cert.pem
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem bun run dev
```
Open `https://<your-computer's-LAN-IP>:3000` on the host computer, accept the certificate warning, create a room, and scan the QR code with the phones (accept the warning there too). Keep phone screens on.

## Deploy (not done yet — needs the owner's go-ahead)
One container, no database. TLS must be terminated in front of it and WebSockets allowed through.
```bash
docker build -t unison .
docker run -p 8080:8080 -v unison-data:/data unison
```
- **Fly.io**: `fly launch` (internal port 8080), add a volume mounted at `/data` for metrics, set `TRUST_PROXY=1` and optionally `STATS_TOKEN`.
- **Any VPS**: run the container behind Caddy (`reverse_proxy localhost:8080` gives automatic HTTPS and WebSocket support).
- Either way, have the proxy add `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` to responses: Bun can't set headers on the HTML page itself.

Environment: `PORT`, `HOST`, `METRICS_FILE` (default `data/metrics.jsonl`), `STATS_TOKEN` (enables `GET /api/stats?token=…`), `TRUST_PROXY=1` (use `Fly-Client-IP`/`X-Forwarded-For` for rate limiting), `TLS_CERT`/`TLS_KEY` (direct HTTPS). Health check: `GET /healthz`.

All rooms live in memory: a restart ends live sessions (SIGTERM closes rooms cleanly). Measured relay cost: ≈ 134 kbps (≈ 60 MB/hour) per listener, ≈ 0.05 % of a core and ≈ 40 KB RAM per listener — bandwidth is the limit. Details in [docs/deployment.md](docs/deployment.md).

## Privacy
Full notice: [PRIVACY.md](PRIVACY.md).
- The room key is generated in the host's browser and only travels in the link's `#fragment`, which browsers never send to servers.
- Every audio chunk and control message is sealed with AES-256-GCM; the server only sees routing headers (room id, sequence numbers, timing).
- The server keeps at most ~10 s of ciphertext per room in memory and never writes audio to disk.
- Metrics are one anonymous line per finished room (counts only: devices, duration, browser families, sources, sync stats). No IPs, room ids, user agents, titles or cookies.
- Anyone who has the full link can listen.
- Auto-sync listens through the host's microphone (and, only if a listener taps "Help sync", that phone's microphone). Microphone audio is analysed on the device and never recorded or sent; helper phones send only timing numbers. Every device adds a very faint signal to what it plays so it can be told apart.

## Browser support (v1)
| Role | Supported |
|---|---|
| Listener | Modern browsers with Web Audio + WebAssembly. iPhone Safari: **not yet verified on a real device**; screen must stay on |
| Host: file / Audius / test clicks | Browsers with WebCodecs Opus encoding (Chrome, Edge, Firefox desktop) |
| Host: tab / system audio | Chrome or Edge on desktop (system audio: Windows/ChromeOS; macOS 14.2+ on recent Chrome) |
| Calibration | Host device with a microphone; listeners on speakers (headphones use the manual fine-tune slider) |

## Credits
Audius tracks are streamed through the public Audius API and credited to their artists with a link back to Audius.
