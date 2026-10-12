# Privacy

Unison (working name) has no accounts, no cookies, no ads and no third-party analytics. This page says exactly what each part of the system can see. It describes the code in this repository; if you run your own copy, you are the operator.

## The short version
- **Your music is end-to-end encrypted.** The room key is created in the host's browser and travels only in the part of the link after `#`, which browsers never send to servers. The server relays ciphertext it cannot read and never writes audio to disk.
- **Anyone with the full link (or QR code) can listen.** Share it like a house key. The host can lock the room and remove devices.
- **Microphones never record.** Auto-sync analyses the host's microphone (and, only if a guest taps *Help sync*, that phone's microphone) on the device itself. Only timing numbers leave the device.

## What the server sees
| Data | Why | Kept |
|---|---|---|
| Encrypted audio chunks and encrypted control messages (track title/artist/artwork, queue, song requests, reactions, sync commands) | To relay them | In memory, the last couple of seconds of audio per room (never more than 100 chunks); gone when the room ends |
| Routing headers: room id, sequence numbers, timing, message sizes | To relay and order chunks | In memory while the room exists |
| Device display names (random "brave otter"-style names you can change), coarse browser family (chrome/safari/firefox/edge/other) and phone-or-computer | Shown to the host and room; device counts | In memory while the room exists |
| Playback diagnostics each device reports (buffer, latency, glitch counters, sync offsets) | Sync Doctor on the host's screen | In memory while the room exists |
| Your IP address | Network connection; limiting room creation to 20/min per address | In memory only, cleared every minute; never logged or written |
| One anonymous line per finished room: day (no time), duration, peak devices, joins, reconnects, whether audio played and for how long, source types, browser-family counts, phone/computer counts, glitch totals, whether it was synced and the measured spread | Knowing whether the product works | On disk, indefinitely. No room ids, IPs, names, user agents, titles or keys |

The server does not log requests. It cannot read what you play, what you request, or which reactions you send.

## What other services see
- **Audius** (`api.audius.co` and its content nodes): when the host plays an Audius or sample track, browses samples or searches, and when a guest searches or requests a song, that device talks to Audius directly. Audius sees that device's IP address and the search terms / track ids, under Audius's own privacy policy. Artwork images are loaded from Audius's servers. Nothing goes to Audius if you only play files or share a tab.
- **The streaming service in a shared tab** (Spotify, YouTube, …) sees whatever it normally sees; Unison only captures the tab's audio output with your permission.
- Fonts and all code are served by the Unison server itself. No CDNs, trackers or embedded third-party scripts.

## What stays on your device
- `localStorage`: your display name.
- `sessionStorage` (cleared when the tab closes): the host token that lets a reload keep hosting, per-room sync offsets, the request mode and last streaming-service choice.
- IndexedDB (host only): songs you add to *Your music* and playlists. They never leave the browser except as encrypted audio while you play them.
- The service worker caches the app shell for offline loading. Audio is never cached.

## Guests and removal
Room members are trusted to listen. The host can **lock** the room (no new devices) and **remove** a device. Removal disconnects it; the link's key can't be revoked, so a removed guest who kept the link could rejoin once the room is unlocked. For a fresh start, end the room and create a new one.

## Children
Unison is not directed at children and collects no personal information beyond what is listed above.

## Contact
Privacy questions or concerns: open an issue in the project repository, or for anything sensitive follow [SECURITY.md](SECURITY.md). *(Owner: add a contact address before public launch.)*
