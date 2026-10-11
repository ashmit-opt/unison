# Product intent: Synced Multi-Device Audio PWA

Owner: the user (product owner). Only the product owner changes this file. Confirmed in conversation on 2026-10-11.

## Outcome
Build a Progressive Web App that turns a group of devices into one synchronized speaker system.

Audio sources:
1. Captured browser-tab or system audio, subject to browser support.
2. Uploaded audio files.
3. Audius.

Listeners join through a link or QR code without creating an account.
Audio must be end-to-end encrypted, and the application must not store audio persistently on its servers.

## Target users
- First: people physically together in the same room, including parties and casual hangouts.
- Later: friends listening together remotely.

## Why this product
Beatsync demonstrated the appeal of synchronized multi-device audio but is limited to uploaded files. This product additionally supports audio that is already playing elsewhere, where browser and platform restrictions permit.

## Success criteria
1. In-room audio synchronization of approximately 20 ms across mixed devices, including Bluetooth audio output, with automatic per-device calibration.
2. A few hundred strangers running real sessions within one year, measured through privacy-conscious anonymous metrics.

Neither outcome counts as achieved merely because the application runs.

## Product constraints
- PWA only.
- Capturing browser-tab or system audio requires an appropriate desktop browser, initially Chrome or Edge.
- Uploaded-file and Audius hosting should work in modern browsers wherever the required APIs and integrations are supported.
- Solo-builder project.
- No fixed deadline.
- Early real users are important.
- No user accounts are required.

## Foundations required in v1
- One common audio-processing and playback pipeline for all supported sources.
- WebSocket relay architecture.
- Each listener schedules its own playback locally.
- Per-device delay correction and automatic calibration.
- Numbered audio chunks.
- A server-side transient buffer that supports late joins and reconnects without persistent audio storage.
- End-to-end encryption, with the decryption key in the URL fragment.
- Protocol versioning.
- Privacy-conscious anonymous metrics.
- Wake lock where supported.
- Tap-to-join interaction.
- A "Host your own room" button to support organic growth.

## Revision 2026-10-11 (product owner decisions)
- Calibration must be **automatic and continuous**: no button press needed. Devices stay aligned during playback using faint, inaudible per-device signals measured by microphones, adapting when outputs change (e.g. Bluetooth reconnects). A manual chirp calibration may remain as a fallback for when nothing is playing.
- **Listener microphones are optional opt-in** ("Help sync"): the host's microphone is used by default; listeners may lend their microphone so devices far from the host (same room, far apart) can be aligned. Listeners who only want to listen are never prompted.

## Revision 2026-10-11 (b) (product owner decisions)
- The site must look and feel like a polished, eye-catching product people enjoy staying on (rich visuals, animation), not a basic page.
- **Sample tracks** to try instantly, like Beatsync's "default tracks". Beatsync's own sample files are commercial recordings (not covered by its MIT code licence), so samples are curated original tracks streamed from Audius with artist credit instead.
- Backend improvements informed by Beatsync and similar open-source projects where they fit this product (e.g. probe-pair clock sync, live listener count, friendly device names).

## Revision 2026-10-12 (product owner decisions)
- **Shared queue with guest requests**: listeners can request songs (Audius search or samples); the room owner approves or declines (or chooses auto-add / requests off); the queue auto-advances. This lifts "Playlists and queues" from the out-of-scope list.
- **Local library**: uploaded songs and playlists are saved in the host's own browser so they don't need re-uploading. Still **no user accounts and no server-side audio storage**; a cloud library with accounts is deferred until people ask for cross-device access.
- **Better tab experience** for JioSaavn, Spotify, YouTube Music, YouTube and Apple Music (service launchers, live input meter, editable "what's playing"), using tab capture only — no integration with those services.

## Decision record 2026-10-12 (Claude, technical owner)
- **JioSaavn integration declined.** The owner asked to integrate `sumitkolhe/jiosaavn-api`. That project decrypts JioSaavn's `encrypted_media_url` with a key extracted from JioSaavn's app (`DES-ECB`, hard-coded key in `link.helper.ts`) to produce direct download links to licensed commercial music. Integrating it would circumvent access protection and re-stream unlicensed copyrighted recordings to listeners, so Claude will not build it. Alternatives shipped/offered: the Browser-tab source with one-tap launchers for JioSaavn, Spotify and YouTube Music; a licensed catalogue (e.g. Jamendo, needs an owner-registered key); an official JioSaavn licence/partnership.

## Explicitly out of scope for v1
- Revenue and monetization.
- Native applications.
- Mobile or TV capture hosting.
- Spotify, Apple Music, Tidal, and Deezer integrations.
- YouTube embed.
- ~~Playlists and queues~~ — lifted 2026-10-12 (see revision above).
- Chat.
- Left/right channel splitting.
- User accounts.
- Background playback on locked iPhones.

These features are not introduced unless this intent is explicitly revised by the product owner.

## Background research (from the intent conversation, 2026-10-11)
- Streaming-service integrations: Spotify development mode is capped at 5 allowlisted users and its policy bans one-source-to-many-listeners apps; Apple Music's MusicKit terms on synchronization are unclear; Tidal web SDK plays previews only. Audius allows free streaming via its API and returns raw audio, so it fits the sync engine.
- Capture: Chrome/Edge desktop can capture tab audio on all desktop OSes; system audio on Windows/ChromeOS, and on macOS only on recent Chrome with macOS 14.2+. Mobile browsers cannot capture.
