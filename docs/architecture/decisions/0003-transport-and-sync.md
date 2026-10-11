# ADR-0003: WebSocket relay with server clock and host-stamped target times
Status: accepted (2026-10-11)

## Decision
- One WebSocket per device to a single server; JSON text frames for control, binary frames for sealed payloads.
- The **server's monotonic clock** is the shared timeline. Clients estimate their offset with NTP-style pings using minimum-RTT filtering.
- The **host stamps every chunk with its target play time** `t` on the server timeline (anchor + sample index). Listeners place chunks on their own audio clock via the output-timestamp mapping and slew to stay locked. Host-side clock drift is fixed by small anchor steps that listeners slew away.
- Stream **epochs** separate sources; pause/seek inside a file is media content (silence/jumps), not protocol state.
- The server keeps ≤ 100 chunks of the current epoch in memory for late join and reconnect; a joining device receives them immediately.

## Alternatives
- Host as clock master over WebRTC data channels: NAT traversal/TURN, mesh fan-out from a phone. Rejected.
- Wall-clock (`Date.now`) stamps: NTP steps and low resolution. Rejected in favour of `performance.now`.

## Addendum 2026-10-12
Clock probes are sent in pairs (25 ms apart) and a pair is accepted only when the server-side gap matches (±5 ms), adopted from Beatsync's Huygens-style filter; it complements the min-RTT selection. `GET /api/live` exposes anonymous totals (devices, active rooms) for the landing page.

## Consequences
Constant per-device biases (path asymmetry, output latency) are not removed by clock sync; acoustic calibration handles them (ADR-0005). Everything travels via the server even inside one room: simple, works remotely, costs egress.
