# ADR-0005: Acoustic calibration with the host microphone
Status: accepted (2026-10-11)

## Decision
The host records its microphone while each device plays a 40 ms 1.5–7 kHz chirp in its own time slot, scheduled through the normal playback path. Cross-correlation gives each device's arrival lag; offsets are adjusted relative to the median; a verification round reports the **measured spread**. Mic input latency cancels because only lag differences matter. Headphones use a manual nudge.

## Alternatives
- Trust `outputLatency` only: unreliable for Bluetooth, absent before Safari 18.4.
- Each listener measures itself with its own mic: that measures output + input latency of one device, which can't be separated.
- Continuous ultrasonic calibration: phone speakers/mics roll off above ~18 kHz, more complexity. Maybe later.

## Consequences
Alignment is exact at the mic position only (2.9 ms per metre of path difference elsewhere). Needs a quiet moment, mic permission on the host, and audible devices.
