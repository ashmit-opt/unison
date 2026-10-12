# Troubleshooting

Start with **Devices & sync** on the host: each device's chip opens the Sync Doctor, which names the likely cause, the fix, and the numbers behind it (labelled *measured*, *estimate* or *browser-reported*).

## Joining
| Symptom | Cause | Fix |
|---|---|---|
| "This link is incomplete" | The part after `#` (the encryption key) was cut off when copying | Share again with *Copy link* / *Share*, or scan the QR |
| "This room doesn't exist" / "has ended" | Host closed it, was away > 10 min, or everyone left > 60 s ago | The host creates a new room |
| "This room is locked" | The host turned on *Lock room* | Ask the host to unlock, then *Try again* |
| "This room is full" | 32 devices max | — |
| Page won't load on a phone on the LAN | Phones need HTTPS | See README → *Testing with real phones* |

## No sound on a guest
- Tap **Tap to join** — browsers only allow sound after a tap.
- iPhone: turn the ringer switch off silent mode if the volume seems stuck at zero; keep the screen on and Unison in front.
- Sync Doctor says *Screen off or app in the background* → phones pause web audio when locked or switched away.
- Sync Doctor says *Can't decrypt the audio* → the device has a damaged link; rejoin with the full link.
- Sync Doctor says *Not playing — audio arrives too late* → weak connection: move closer to the router, turn off mobile data / VPN.

## Out of sync, echo, buzzing
- A metallic/comb or echo sound means devices are tens of ms apart. Wait ~10 s after starting music: auto-sync lines devices up once the host's microphone hears them.
- Sync Doctor *Not heard by the microphone yet* → turn that device's volume up, move it closer to the host, or turn on **Help sync** on a phone near it. Headphones and Bluetooth speakers far from the mic can't be heard: use **Fine-tune this device** on that phone (Sync settings).
- Still off → **Re-sync** in its Sync Doctor panel (restarts its clock and timing), or **Calibrate with chirps** (stop the music first; quiet room).
- Bluetooth adds 100–300 ms that browsers often misreport; the Doctor mentions Bluetooth when a device reports ≥ 100 ms output latency.

## Glitches (clicks, gaps)
Sync Doctor shows *N glitches in the last minute* and the dominant cause:
- *Audio is arriving late* → busy or weak Wi-Fi (2.4 GHz in a crowded building is the usual suspect).
- *The device is falling behind* → close other apps/tabs on it; low-power mode can throttle it.
- *Its clock estimate keeps jumping* → unstable network; Re-sync.

## Host problems
| Symptom | Fix |
|---|---|
| Tab sharing: "No sound from the tab yet" | Press play in that tab, and make sure **Share tab audio** was switched on in the picker; *Share again* |
| System audio: host's own speakers are early | Expected — mute the computer's speakers or share a tab instead |
| "Microphone blocked" | Allow the microphone for this site (lock icon in the address bar) to use auto-sync, or calibrate with chirps |
| A track is skipped with a toast | It couldn't be played (removed from Audius, unsupported file). Three failures in a row stop the queue |
| Reloading the host tab | Keeps hosting (same tab). Hosting from another tab/device isn't possible: the host token lives in this tab only |

## Privacy questions
See [PRIVACY.md](../PRIVACY.md).
