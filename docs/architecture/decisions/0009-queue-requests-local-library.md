# ADR-0009: Shared queue with guest requests; library kept in the host's browser
Status: accepted (2026-10-12), intent revision 2026-10-12

## Context
The owner asked for profiles/accounts with uploaded songs and playlists, plus a queue that guests can add to with the room owner's permission (Beatsync has a queue and admin roles). Accounts and a cloud library would add an auth system, a database, paid storage and a copyright takedown process, and would break the "no account / no stored audio" promises. The owner chose the recommended scope: queue + requests + a library saved locally.

## Decision
- **Queue** lives on the host (`src/client/queue.ts`, pure and unit-tested): add, play now, move, remove, clear, auto-advance when a file/Audius track ends. Listeners get a snapshot (`ctl: queue {mode, now, next[≤30]}`) — titles, artists, artwork URLs and requester names only; file data never leaves the host.
- **Guest requests**: new sealed frame kind `KIND_UP` (3), header `v | 3 | from u32`, payload `{type:"request", ref, audiusId, title, artist?, art?, durationS?}`. The server accepts it only from listeners, only when `from` equals the sender's peer id, and forwards it only to the host; the header is AEAD-authenticated, so the host knows who asked. Host replies `ctl: request-result {ref, ok, reason?}`. Modes: ask (default, approve/decline cards), auto-add, off. Limits: 3 pending per guest; duplicates answered "already in the queue". Guests can request Audius tracks (samples or search) — not files.
- **Local library** (`src/client/library.ts`): IndexedDB stores `tracks` (file blobs, deduplicated by name+size) and `playlists` (queue items). `navigator.storage.persist()` is requested. Nothing is uploaded; if storage is unavailable (private window), files play once without saving.

## Consequences
- The library is per browser/device; a cross-device library would need accounts (deferred until users ask).
- Any room member could forge a request from someone else only by also being the server (header checked by server, authenticated by AEAD) — consistent with ADR-0004's trusted-member model.
- Evidence: unit tests (queue logic, protocol validation, server routing incl. impersonation and non-host up frames), e2e (guest request → approve → plays on host and guest; two files saved to the library survive a reload and the queue auto-advances).
