# Synced Multi-Device Audio PWA — operating manual

A PWA that turns a group of devices into one synchronized speaker system.
Product intent (authoritative): `docs/intent/synced-audio.md`. Technical spec: `docs/specs/synced-audio.md`.

## Session start (every session)
1. Read this file, `docs/intent/synced-audio.md`, `docs/progress.md`, then the spec sections and ADRs (`docs/architecture/decisions/`) relevant to the next task.
2. Check `git status` and the actual code. Notes can be stale — verify claims against code and test runs before trusting them.
3. Resume the first unfinished task in `docs/progress.md` → "Next tasks". Do not re-run finished investigations unless evidence says they were wrong.

## Roles and autonomy
- The user is the product owner: they own `docs/intent/synced-audio.md`. Claude owns technical decisions, implementation, tests and docs.
- Decide technical questions yourself: investigate, check official docs, run a small experiment if needed, pick the most defensible option, record significant choices as an ADR, continue.
- Ask the user only when: a product requirement is missing and cannot be inferred; credentials, hardware or external access are needed; a product trade-off has no defensible default; or an action is destructive, externally visible, security-sensitive or costs money. Ask one concise question with a recommended default, and keep doing independent work meanwhile.
- Never ask the user to pick frameworks/libraries or which task is next when the dependencies decide it.

## Workflow
- Follow the installed `spec-driven-development` skill (Specify → Plan → Tasks → Implement). The user has waived per-phase approval gates for routine engineering; product-intent changes still need their explicit approval.
- Plan and task list live in `docs/progress.md` (designated task-list target); the spec holds the implementation plan. No separate `tasks/` folder.
- Spec first: change `docs/specs/synced-audio.md` before changing behavior it defines. Keep the spec, ADRs and code in sync.
- Small vertical increments. After each: run targeted tests, `bun run check` (typecheck + tests), fix what you broke, add a regression test for every bug.
- Keep the architecture small: one Bun process (static + WebSocket relay), no database, no microservices. No new dependency when a few lines do.

## Testing standards
- Unit tests (`bun test`) for protocol, crypto, clock sync, scheduling, buffering, rooms, calibration math. Browser tests (Playwright) for user flows.
- Report every result honestly as: passed / failed / not run / not possible here / needs real-device validation. Never claim a test passed if it did not run.
- The ~20 ms sync target is reported as passed/failed/unverified against the acceptance criteria in the spec, with acoustic measurements as evidence, never just a software estimate.

## Protect the user and production
- Never overwrite files you have not read, never discard user changes, no destructive git (reset --hard, force push, branch deletion) without explicit approval. Commit only when the user asks.
- Never commit secrets, keys or `.env` files. Room keys must never reach the server or logs.
- No deploys, public releases, paid services or external uploads of source without explicit authorization.
- Keep out-of-scope features (see intent doc) out of the code unless the intent doc is revised.

## Durable state
- `docs/progress.md`: current state, finished milestones, test commands with actual results, known limitations, blockers, next tasks in dependency order. Update it after each milestone and before ending a session.
- If context runs low: finish the current safe unit, update `docs/progress.md` with exact next steps, then stop.

## Definition of done (v1)
All of the following, each verified, or explicitly listed as outstanding with the reason:
architecture implemented; every supported source works end-to-end within documented platform limits; rooms created and joined with no account; chunk protocol and local scheduling work; E2E encryption implemented and tested against the threat model; late join and reconnect work; automatic calibration implemented with limitations documented; sync measured against the acceptance criteria and honestly reported; automated tests pass; supported browser flows validated; no persistent server-side audio; documented build and deploy; security, privacy and operational limits documented; intent, spec, ADRs and progress notes present.

## Commands
- `bun install` — install deps
- `bun run dev` — dev server on http://localhost:3000
- `bun run check` — typecheck + unit tests
- `bun run test:e2e` — Playwright browser tests
- `bun run build` — client bundle check; `bun run start` — production mode (runs from source; see spec §2)
- Bun 1.2.6 quirks (verified): runtime corrupts `opus-decoder` WASM (that test runs under Node); bundling server+HTML crashes; run Playwright via Node, not Bun.
