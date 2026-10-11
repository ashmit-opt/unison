# ADR-0006: Server-side aggregate metrics; single-container hosting
Status: accepted (2026-10-11)

## Decision
- Metrics: one JSON line per finished room with coarse counts only (no ids, IPs, user agents, titles or exact times), computed from data the server already sees. `/api/stats` is enabled only when `STATS_TOKEN` is set. No client analytics SDK, no cookies.
- Hosting: one Docker image (`oven/bun`), TLS at the platform edge. Fly.io documented; any VPS with Caddy works. Nothing is deployed without the owner's authorization.

## Alternatives
Plausible/Umami (an extra service, page-view oriented); client beacons (more data than needed).

## Consequences
"Strangers" are counted as rooms with ≥ 2 devices and ≥ 60 s played; unique people can't be counted, by design.
