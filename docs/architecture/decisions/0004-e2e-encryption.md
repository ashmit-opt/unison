# ADR-0004: End-to-end encryption — AES-256-GCM, key in the URL fragment
Status: accepted (2026-10-11)

## Decision
WebCrypto AES-256-GCM. The host generates a 32-byte key and shares it only in `#k=…`. Each binary message has a random 96-bit IV and AAD = room id ‖ clear header (version, kind, epoch, seq, t / target). The server sees only routing headers. Players reject duplicate/old `(epoch, seq)` and past `t`.

## Alternatives
- Counter nonces: need per-sender state; random IVs are safe far beyond a 12 h room's ~4.5·10⁵ messages.
- Host signatures (ECDSA) so members can't forge host messages: members are trusted in the threat model, and URLs get longer. Deferred.
- libsodium: extra dependency; WebCrypto is native in every secure context.

## Consequences
Anyone with the full link can listen (and could forge host messages). A malicious server can replay a whole old epoch of the same room with new timing; it cannot read, alter or inject content. See spec §9.
