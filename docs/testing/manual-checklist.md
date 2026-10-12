# Manual device test checklist

Automated tests run in desktop Chromium only (fake microphone, loopback audio). Everything below needs real devices and ears. Record results in [docs/progress.md](../progress.md) → *Real-device observations* with date, devices, browser versions and network.

**Setup:** host on desktop Chrome/Edge over HTTPS (README → *Testing with real phones*), same Wi-Fi for all devices unless stated. Note each device's model and browser version.

## 1. Join and play (every device type)
| # | Check | iPhone Safari | Android Chrome | Laptop Chrome | Other |
|---|---|---|---|---|---|
| 1.1 | QR scan opens the invite showing host name and what's playing | ☐ | ☐ | ☐ | ☐ |
| 1.2 | One tap → sound within 3 s while music plays | ☐ | ☐ | ☐ | ☐ |
| 1.3 | Volume slider and reactions are easy to hit with a thumb | ☐ | ☐ | — | ☐ |
| 1.4 | Screen stays on while listening (wake lock) | ☐ | ☐ | — | ☐ |
| 1.5 | iPhone with ringer switch on silent still plays | ☐ | — | — | — |
| 1.6 | Lock phone 10 s, unlock: playback recovers; Doctor showed "background" meanwhile | ☐ | ☐ | — | ☐ |
| 1.7 | Toggle Wi-Fi off/on: reconnects and resumes without the host doing anything | ☐ | ☐ | ☐ | ☐ |

## 2. Sync (the product's core claim — be strict)
- 2.1 Two phones + laptop side by side playing a sample: no audible echo after ~10 s. ☐
- 2.2 Host Devices card: "hears N of M" counts each speaker device; measured spread shown. ☐ (value: ____ ms)
- 2.3 **Independent measurement (spec §10.1 B):** record the devices playing *Test clicks* with a separate phone's voice recorder at the listening position; measure click onset differences in an audio editor. ☐ (p50 ____ / max ____ ms; devices/distances: ____)
- 2.4 Compare 2.3 to the app's measured spread. Note disagreement. ☐
- 2.5 Bluetooth speaker paired to a phone: does auto-sync hear and fix it? If not, does Fine-tune fix it, and does the Doctor mention Bluetooth? ☐
- 2.6 Far device (other side of a large room / another room): turn on Help sync on a phone near it; does it get lined up? ☐
- 2.7 Listening test for the auto-sync code (−30 dB pseudo-noise under the music): play a quiet acoustic track; can anyone hear a hiss? ☐
- 2.8 30-minute session: any audible resyncs or drift? Count glitches in the Doctor. ☐

## 3. Sync Doctor and moderation
- 3.1 Identify: the chosen phone chimes, vibrates (Android) and shows its name. ☐
- 3.2 Re-sync a device mid-song: brief restart, then back in sync within ~10 s. ☐
- 3.3 Walk a phone to the edge of Wi-Fi: Doctor reports late audio / glitches with a sensible fix. ☐
- 3.4 Lock room: a new phone sees "This room is locked"; a member toggling airplane mode gets back in. ☐
- 3.5 Remove a guest: it sees "You were removed"; with the room locked it can't rejoin. ☐

## 4. Party mode and reactions
- 4.1 Party mode on a laptop connected to a TV: fullscreen, readable from across the room, QR scannable from 2–3 m. ☐
- 4.2 Several guests tapping reactions: they float up with names; spamming is capped. ☐
- 4.3 Esc / Exit returns to the room. ☐

## 5. Sources
- 5.1 Tab: Spotify / YouTube Music / YouTube / Apple Music / JioSaavn web tab with "Share tab audio" → guests hear it; silent-tab hint appears if the tab is paused. ☐
- 5.2 System audio (Windows): works; host speakers early as warned. ☐
- 5.3 Files: MP3, M4A, WAV, FLAC dropped into *Your music*; survive a reload. ☐
- 5.4 Audius search and samples play; a broken track is skipped with a toast. ☐
- 5.5 Guest requests: approve/decline round trip; auto-add mode. ☐

## 6. Install and offline
- 6.1 Add to Home Screen (iOS) / Install (Android, desktop) works; icon and name correct. ☐
- 6.2 Offline launch shows the app shell and an offline message, not a browser error. ☐

## 7. Accessibility spot checks
- 7.1 Host page fully usable with keyboard only (Tab, Enter/Space, Esc closes dialogs, focus visible). ☐
- 7.2 VoiceOver (iOS) / TalkBack (Android) on the listener: join button, reactions, volume, request sheet are announced sensibly. ☐
- 7.3 Reduce Motion on: no spinning/rising animations. ☐
