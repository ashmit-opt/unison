# Experiment: streamed Opus decode + Web Audio scheduling (iOS Safari risk)

Throwaway. Not part of the app. Answers: can a listener decode raw Opus packets as they arrive (WASM `opus-decoder`) and schedule them gaplessly against the Web Audio clock?

## Run
```bash
bun experiments/ios-audio/serve.ts            # http://localhost:5173
```
Open the page, tap **Start**, wait ~70 s. Results are saved to `results/<timestamp>.json`.

### On a real iPhone (needs HTTPS for AudioWorklet and WebCrypto)
```bash
mkdir -p experiments/ios-audio/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=syncaudio-dev" -keyout experiments/ios-audio/certs/key.pem -out experiments/ios-audio/certs/cert.pem
bun experiments/ios-audio/serve.ts
```
On the iPhone (same Wi-Fi) open `https://<your-PC-LAN-IP>:5173`, accept the certificate warning, tap Start. During phase E lock the screen ~10 s, then unlock. Also try once with the ringer switch on silent. Results come back to `results/` on the PC.

## What it measures
Capabilities (before the tap): AudioContext state, 48 kHz honoured, `getOutputTimestamp`, `outputLatency`, AudioWorklet, WebCodecs Opus decode/encode, `navigator.audioSession`, Wake Lock, AES-GCM speed. Then five playback phases of a 440 Hz tone sent as 100 ms chunks (5 × 20 ms Opus packets) through a simulated network: lead 300/100/40 ms, late-chunk injection, and a 30 s background phase. An AudioWorklet counts silent blocks and sample discontinuities inside each phase's active window (graph level, not hardware output).

## Results so far (2026-10-11)
| Environment | Result |
|---|---|
| Chromium 152, Windows 11, real audio device (Claude browser pane) | All verdicts true. 0 decode errors; decode p95 0.9 ms per 100 ms chunk; zero dropouts/discontinuities at 300, 100 and 40 ms lead; late chunks (>100 ms late) dropped cleanly as gaps. `currentTime` advances in 10.67 ms steps. `getOutputTimestamp` contextTime trails currentTime by ~52 ms ≈ outputLatency 40 + baseLatency 10, i.e. it reflects the audible frame. Background phase not exercised (pane stayed visible). File: `results/2026-10-11T15-24-45-478Z.json`. |
| Playwright WebKit 27.2 (Windows build) | **Not usable**: `AudioContext` is undefined in this build. No Safari evidence can come from it. |
| Real iPhone Safari | **Not run** — no device available. Required before claiming iOS support. |

Conclusion so far: the pipeline (raw Opus → WASM decode → AudioBufferSourceNode chain) works on desktop Chromium. iOS remains a real-device validation item, see `docs/architecture/decisions/0002-audio-pipeline.md`.
