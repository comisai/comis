# Comis

## What This Is

Comis is a security-first, self-hosted platform that connects AI agents to real-time chat channels (Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email). It is built for individuals and small teams who want to run their own AI assistant across every chat platform they use — without surrendering their secrets, messages, or control to a SaaS vendor.

## Core Value

**Security wins tradeoffs.** If a feature would weaken isolation, secret handling, or permission boundaries, it waits. Trust — in the form of provable credential hygiene, redaction, and sandboxing — is the product.

## Requirements

### Validated

<!-- Capabilities already shipped in the codebase. Inferred from .planning/codebase/ and verified against ARCHITECTURE.md, STACK.md, INTEGRATIONS.md. -->

- ✓ Hexagonal port/adapter architecture with composition root wiring (`packages/core/src/bootstrap.ts`) — existing
- ✓ Channel adapters for Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email, and Echo — existing
- ✓ Agent execution runtime with budget guard, circuit breaker, RAG retriever, context DAG, session manager — existing
- ✓ Skill system: manifest parser, progressive-disclosure registry, MCP client, built-in tools, media/STT/TTS/vision/image-gen — existing
- ✓ Memory layer: SQLite + FTS5 + sqlite-vec vector search, delivery queue, observability store — existing
- ✓ Scheduler: cron, heartbeat, task extraction, wake coalescer — existing
- ✓ Gateway: Hono HTTP server with JSON-RPC 2.0, WebSocket, mTLS, rate limiting, mDNS — existing
- ✓ CLI (`node packages/cli/dist/cli.js`) with JSON-RPC client against the daemon — existing
- ✓ Daemon orchestrator with observability, structured logging, systemd and pm2 integration — existing
- ✓ Security substrate: AES-256-GCM encrypted SecretStore, Ed25519 DeviceIdentity, OutputGuard leak scanner, CredentialMapping — existing
- ✓ Layered config system: YAML files via `COMIS_CONFIG_PATHS` → env overrides, 100+ Zod schemas — existing
- ✓ Structured logging via Pino with automatic credential redaction — existing
- ✓ Result<T,E> error model across all packages (no thrown exceptions at boundaries) — existing
- ✓ Web SPA (Lit + Vite + Tailwind) for local admin/visualization — existing

### Active

<!-- Pre-release hardening toward a "release" state in weeks. Security, service reliability, and operator UX. -->

- [ ] One-command install on a fresh Linux box that works without hand-holding (native deps resolved, service registered, config scaffolded)
- [ ] Reliable service lifecycle under systemd and pm2 — survives reboots, self-recovers from common failures, clean start/stop/restart semantics
- [ ] Observability sufficient to debug a production issue without reading source — structured logs with useful hints, health endpoints, basic metrics
- [ ] Operator-friendly config and secrets UX — reduce YAML/Zod schema friction, clear error messages when config is wrong
- [ ] Clean uninstall path that removes service, data, and credentials predictably

### Out of Scope

- **Hosted / SaaS version** — Comis's value is ownership. A managed cloud offering would undermine the core promise of self-hosting with your own secrets.

## Context

- **Brownfield project.** TypeScript monorepo, 13 packages plus an umbrella `comis` package and a `web` SPA. Hexagonal ports/adapters throughout. See `.planning/codebase/` for full map.
- **Primary runtime.** Linux daemon, long-running under systemd or pm2. Node.js ≥ 22, pnpm workspace, native dependencies (`better-sqlite3`, `sharp`, optionally `node-llama-cpp`).
- **Data directory.** `~/.comis/` holds config, SQLite databases, encrypted secret store, models, and logs.
- **Security posture.** No plaintext secrets in config files — all credentials pass through `SecretManager`. `OutputGuard` scans LLM output for secret leaks before delivery. Pino redaction covers `apiKey`, `token`, `botToken`, `privateKey`, nested to 3 levels.
- **In-flight work (as of initialization).** Installer redesign, systemd service template, uninstall command, pm2 integration polish, `comisai` 1.0.3 npm package. Two working documents already exist: `INSTALLER-SERVICE-REDESIGN.md`, `INSTALLER-TEST-PLAN.md`.
- **Operator persona.** The initial user is the maintainer — a single developer running Comis on their own box. Pre-release hardening is about getting a stranger-on-a-fresh-VM to a working daemon without support.

## Constraints

- **Platform**: Linux-only for the daemon — macOS/Windows only for development. No cross-platform service work is funded.
- **Runtime**: Node.js ≥ 22, pnpm, ES modules only, TypeScript strict mode with `composite: true` project references.
- **Architecture**: New capabilities must land as port implementations wired through `AppContainer` in `packages/core/src/bootstrap.ts`. No direct adapter-to-adapter coupling.
- **Security**: Zero plaintext secrets in files. All credential access through `SecretManager`. Secret store encrypted with `SECRETS_MASTER_KEY` (AES-256-GCM). ESLint rules enforce: no raw `path.join` (use `safePath`), no direct `process.env` (use `SecretManager`), no empty `.catch(() => {})` (use `suppressError`).
- **Error model**: `Result<T,E>` from `@comis/shared` — no thrown exceptions at module boundaries.
- **Horizon**: Weeks, not months, to "released". Scope decisions favor finishing existing threads over starting new capabilities.
- **Validation command**: `pnpm build && pnpm test && pnpm lint:security` is the canonical green-light for any change.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Security wins when values collide | Trust is the product. A feature that weakens isolation/secrets/permissions waits, even if it delays reach or capability. | — Pending |
| Self-host only, no SaaS | Managed cloud would undermine the ownership promise that distinguishes Comis from existing chat-bot platforms. | — Pending |
| Linux-only daemon target | Concentrate effort on the platform that matters for self-hosted deployments. No fragmentation across OSes. | — Pending |
| Pre-release hardening = install + service + observability (all three) | A release-ready state is gated on a stranger being able to install, run it reliably as a service, and debug it in prod without source. | — Pending |
| Hexagonal ports/adapters with single composition root | Keeps the blast radius of each new integration small and preserves the ability to swap adapters for testing. | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-17 after initialization*
