# Security policy

## Reporting a vulnerability
Please report privately — don't open a public issue for anything that could put users at risk. *(Owner: add a contact address or enable GitHub private vulnerability reporting before public launch.)* Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement within a few days. Please give us reasonable time to fix before disclosure. There is no bug bounty.

Out of scope: denial of service by flooding, issues needing a compromised device or browser, missing best-practice headers without a demonstrated impact, and reports from automated scanners without a working proof.

## Security model (summary — details in [docs/specs/synced-audio.md §9](docs/specs/synced-audio.md))
- **Confidentiality from the server:** AES-256-GCM with a random 96-bit IV per message; the 256-bit room key is generated in the host's browser and travels only in the URL fragment. The additional authenticated data binds each message to its room and clear header, so the server can't read, alter, reorder across rooms or forge content.
- **Trusted members:** anyone holding the full link can decrypt and could forge host messages for that room. Guests' messages to the host (song requests, reactions) are stamped by the server with the sender's peer id, which is part of the authenticated header; the host re-checks requested tracks with Audius instead of trusting guest-supplied metadata, and reactions are a fixed allowlist.
- **Host authority:** a 128-bit host token (compared in constant time) is required to host; lock/remove/stop are host-only and enforced by the server. Reclaiming a peer id after a reconnect requires a per-device 128-bit resume token.
- **Server hardening:** strict CSP (no third-party scripts), static files served from an allowlist, input validation on every message, per-socket rate limits and junk counters, backpressure cut-off, bounded rooms/peers/buffers, room creation limited per IP, no request logging.
- **Known limits:** a malicious server could replay an entire old epoch of the same room to a new member, and can see metadata (room sizes, timing, names). Removing a guest can't revoke the room key. The HTML document's anti-framing headers must be added by the deployment proxy ([docs/deployment.md](docs/deployment.md)).

## Supported versions
Only the latest deployed version is supported.
