# ADR-0002: Audio pipeline — WebCodecs Opus encode, WASM Opus decode, BufferSource chain
Status: accepted (2026-10-11); iOS part provisional pending a real-device test

## Context
One pipeline for tab/system capture, files and Audius. Listeners include iPhones. Bandwidth matters because the server relays every listener's stream.

## Decision
- Every source becomes a Web Audio node → **tap AudioWorklet** (20 ms stereo blocks) → **WebCodecs AudioEncoder** (Opus 48 kHz, 128 kbps, 20 ms) → 100 ms chunks of 5 raw packets.
- Files and Audius play through an `<audio>` element routed only into Web Audio (`MediaElementAudioSourceNode`), so they are paced in real time like capture. No whole-file decode: a 1 h mix would be ~1.4 GB of PCM.
- Listeners decode with **`opus-decoder` (WASM libopus)** in every browser: one code path, works without WebCodecs (iOS < 26), and testable in `bun test` with a real fixture.
- Playback: **AudioBufferSourceNode chain** on a 48 kHz context; drift corrected by tiny `playbackRate` slews (spec §7.3).

## Evidence (experiments/ios-audio, Chromium 152 on Windows)
WebCodecs-encoded raw Opus decoded incrementally by WASM with 0 errors, p95 0.9 ms per 100 ms chunk; gapless at 300/100/40 ms scheduling lead; late chunks dropped cleanly. Playwright WebKit on Windows has no Web Audio, so **iOS Safari is not yet tested**.

## Alternatives
- WebCodecs AudioDecoder: native, but missing on older Safari and would need a fallback anyway → two paths.
- Raw PCM: 1.5 Mbps per listener, too expensive to relay.
- Ogg/WebM chunks + `decodeAudioData`: gaps at chunk boundaries, codec priming issues, inconsistent Safari Opus support in `decodeAudioData`.
- AudioWorklet ring-buffer player: sample-exact but more code and messaging; the BufferSource chain met the experiment's gapless criteria.
- WebRTC: designed for low latency; its jitter buffer owns playout timing, which fights explicit sync scheduling.

## Consequences
Hosting needs AudioEncoder with Opus (Chrome/Edge/Firefox desktop; Safari 26+ unverified). If iPhone testing shows BufferSource scheduling problems, the player switches to an AudioWorklet ring buffer behind the same `Player` interface.
