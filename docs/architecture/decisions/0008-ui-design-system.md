# ADR-0008: Product UI — own design system, vanilla TS views, motion with restraint
Status: accepted (2026-10-11)

## Context
The owner wants a polished, memorable product UI. Stack stays vanilla TypeScript (ADR-0001). References studied: beatsync.gg (dark centred card, live listener count, friendly names, room list), music-player conventions (now-playing hero, cover art, transport), and our own sync metaphor (many devices, one wave).

## Design contract
- **Identity**: "Unison" (working name). Metaphor: rings that line up. Dark-only, near-black ink background; accent **signal mint** `#6EF2C4` for "in sync / go", **warm amber** `#FFB45C` for attention; no purple/indigo defaults, no heavy shadows, gradients only as soft ambient glow behind the hero visual.
- **Type**: Space Grotesk (display, headings, numbers), Inter (UI text), both self-hosted (OFL). Scale 12/14/16/20/28/44/64 px. Spacing scale 4/8/12/16/24/32/48/64. Radii: 8 (controls), 14 (cards), 999 (chips).
- **Screens**
  - *Landing* — job: make someone start a room in < 10 s. Primary action: **Start a room**. Hero with an animated "devices in sync" visual, live listener count, four proof points (no app/no account; auto-sync; end-to-end encrypted; play anything), three-step how-it-works, footer.
  - *Host* — job: get sound playing and devices joined. Primary: pick something to play. Layout: now-playing hero (cover art or generated cover + live visualizer + transport) with source tabs (Samples · Audius · File · Tab); side panel: invite (QR, copy, share) and devices (friendly names, device type, state, sync, glitches) with auto-sync status.
  - *Listener* — job: join with one tap and trust that it's in sync. Primary: **Tap to join** (pulsing orb). Then: cover art + visualizer, title/artist, sync chip ("In sync" / "Lining up…"), collapsible sync settings (fine-tune, Help sync), "Host your own room".
- **States** for every view: connecting, waiting for host, playing, stopped, host offline, room ended, errors (permission denied, browser can't host), empty search, loading (skeletons), offline.
- **Motion**: CSS transitions/keyframes and one canvas visualizer per page; ≤ 300 ms UI transitions; ambient loops only in hero/visualizer; everything disabled under `prefers-reduced-motion`.
- **Responsive**: mobile-first; single column < 900 px; host two-column ≥ 900 px; verified at 320/375/768/1024/1440.
- **Accessibility**: real buttons/labels, visible focus rings, contrast ≥ 4.5:1 for text, state never by colour alone (icons + text), `aria-live` for status and toasts.
- **Reject**: generic stock card grids, lorem copy, emoji as icons, purple gradients, shadow stacks, full-page spinners.

## Decision
- Views split into `src/client/views/{landing,host,listener}.ts`, small DOM/icon/toast helpers in `src/client/ui/`, canvas visualizer `src/client/ui/visualizer.ts`. Logic modules unchanged.
- Icons: `lucide` (ISC), imported per icon. Fonts: `@fontsource-variable/*` (the two Latin woff2 files are copied to `public/fonts/` and loaded with the FontFace API — see spec §5.11).
- Sample tracks: curated Audius ids in `src/client/samples.ts`, metadata/artwork fetched live (bulk endpoint), hidden if unavailable.

## Consequences
Bundle grows by fonts (~100 KB woff2) and a few KB of icons. Visual regressions are checked by screenshots at fixed widths during development (no pixel-diff CI in v1).
