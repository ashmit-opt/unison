# ADR-0001: Stack — Bun, vanilla TypeScript, one process, no database
Status: accepted (2026-10-11)

## Context
Solo builder, small UI (landing, host panel, listener panel), real-time relay, transient state only. The intent asks for few moving parts.

## Decision
- **Bun 1.2** as runtime, WebSocket server (`Bun.serve`), HTML bundler (HTML imports), test runner and package manager. Already installed on the dev machine.
- **Vanilla TypeScript** frontend, no framework. **`tsc --noEmit` (TypeScript 7)** for type checking. No linter/formatter in v1.
- **One process**, rooms in memory, **no database**. Metrics are an append-only JSONL file of aggregates.
- **Playwright** for browser tests, run through Node: Playwright's pipe transport hung under Bun 1.2.6 on Windows (observed while running the experiment).

## Alternatives
- Node + `ws` + Vite + Vitest: mature, but four tools instead of one. Kept as the fallback: only `src/server/server.ts` uses Bun APIs.
- Cloudflare Workers + Durable Objects: good fan-out and cost, but vendor lock-in and harder local testing for v1.
- React/Preact: unnecessary for ~4 screens.
- Redis/Postgres: nothing needs to survive a restart.

## Consequences
A restart drops live rooms (acceptable: sessions are transient). Vertical scaling only; relay egress (~140 kbps per listener) is the practical limit, not CPU.
