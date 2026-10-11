# ADR-0007: Continuous silent calibration with per-device pseudo-noise codes
Status: accepted (2026-10-11); extends ADR-0005 (chirp calibration stays as a fallback)

## Context
The product owner revised the intent: calibration must be automatic and continuous, with optional listener microphones for devices far from the host. Chirps need a quiet room, interrupt the music, and need the host mic to hear every device.

## Decision
- **Signal**: every device mixes its own pseudo-noise code (seeded by its peer id; ±1 sequence at 16 kHz, band-passed 0.8–6 kHz, 4 s period) into what it plays, at −30 dB relative to the music in each 100 ms chunk (silent when the music is silent). The code is phase-locked to the shared timeline: its value is a function of the chunk's target server time, so it is emitted exactly when the music is.
- **Measurement**: a microphone is decimated to 16 kHz, whitened (GCC-PHAT-style, so coloured music stops dominating), and cross-correlated with each code via FFT over ±300 ms; correlations of 4 consecutive 1.5 s windows are summed (processing gain grows while timing is stable). Peak picking prefers the earliest strong arrival (direct path over reflections); accepted at peak/RMS ≥ 6.
- **Solving**: `lag[mic][dev] = e[dev] + b[mic] + d`; least squares over all microphones. Two mic-enabled devices that each hear themselves and the other cancel the travel time (two-way ranging); a device heard by only one microphone is aligned at that microphone. Between two active microphones only complete two-way measurements are used.
- **Control loop** (host, every 1.5 s): median-of-3 per mic/device, full correction for |error| ≥ 1 ms relative to the median device, then the device is excluded until it finished slewing and 3 s (helpers: 7.5 s) passed. Code levels adapt per device between −36 and −24 dB.
- **Helpers**: a listener can opt in ("Help sync"); its phone measures all codes it hears and sends only the lag numbers in its status message.

## Evidence
- DSP unit tests: two devices at −30 dB under shared music located to < 0.2 ms; a faint far device in white-noise-like music found by summing 4 windows; direct path preferred over a stronger reflection.
- Browser tests (real Web Audio graph, digital loopback "microphones"): a 25 ms late device aligned in ~3 s, steady-state measured spread 0.03–1.2 ms (5/5 + 3/3 runs); two mic devices 20 ms of travel apart with one emitting 15 ms late converge to a 0.02–0.5 ms emission gap (5/5) — travel time cancels.
- Not yet: real rooms (reverb, phone mics/speakers, background noise), audibility of the −30 dB code. Owner listening test and real-device runs required.

## Alternatives
- Chirps on join / periodically: audible, interrupt music (kept as manual fallback).
- Ultrasonic (18–20 kHz) beacons: phone speakers and mics roll off unpredictably there.
- Fingerprinting the music itself: all devices play the same music, so devices can't be told apart.

## Consequences
- The host (and helpers) need microphone permission; the host is prompted when it first plays something.
- ~20–30 ms of main-thread work per device per 1.5 s window on each listening device (ponytail note in code: move to a Worker if rooms grow).
- The −30 dB code may be faintly audible in very quiet passages; level is a constant (`PN.db`) to tune by ear.
