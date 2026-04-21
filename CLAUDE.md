# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mandatory Reference

Read `AGENTS.md` before any code change. It is the authoritative engineering protocol covering architecture observations, engineering principles, naming conventions, change playbooks, anti-patterns, risk tiers, and validation requirements.

## Build & Test Commands

```bash
# Requires Node.js >= 22, pnpm
pnpm install                    # Install dependencies (native: better-sqlite3, sharp)
pnpm build                      # Build all packages (tsc per package, respects references)
pnpm test                       # Run all unit tests (Vitest workspace)
pnpm lint:security              # ESLint with eslint-plugin-security rules

# Single package
cd packages/core && pnpm test   # Run tests for one package
cd packages/core && pnpm build  # Build one package

cd packages/skills && pnpm test  # Run tests for skills package

# Single test file (from package directory)
pnpm vitest run src/path/to/file.test.ts

# Integration / E2E tests (requires `pnpm build` first — tests import from dist/)
pnpm test:integration           # Run all integration tests (vitest with test/vitest.config.ts)
pnpm test:integration:mock      # Integration tests with mock providers (TEST_PROVIDER_MODE=mock)
pnpm test:orchestrate           # Full orchestration: run all E2E suites + log validation + JSON report
pnpm test:cleanup               # Clean up test artifacts (temp DBs, logs)

# Single integration test file
npx vitest run --config test/vitest.config.ts test/integration/gateway-concurrent.test.ts
```

Primary validation command is `pnpm build && pnpm test && pnpm lint:security` (project-wide).

## Running the Daemon

Data directory: `~/.comis` (config, DB, models, logs).
Requires `pnpm build` first — daemon runs from `dist/`.

The `comis` CLI is **not on PATH** — use `node packages/cli/dist/cli.js` instead.

### pm2 (recommended)

Requires `npm install -g pm2`. The ecosystem config auto-sets `COMIS_CONFIG_PATHS` so env var propagation issues don't apply.

**Always flush ALL pm2 logs before starting/restarting the daemon** to keep log output clean and relevant to the current session:
```bash
pm2 flush
```

```bash
# One-time setup — generates ~/.comis/ecosystem.config.js
node packages/cli/dist/cli.js pm2 setup

# Build + start
pnpm build && pm2 flush && node packages/cli/dist/cli.js pm2 start

# Stop / restart
node packages/cli/dist/cli.js pm2 stop
node packages/cli/dist/cli.js pm2 restart

# After rebuilding, always restart to pick up new code
pnpm build && pm2 flush && pm2 restart comis
```

**Verify startup** — pm2 logs live at `~/.pm2/logs/`, not `~/.comis/`:
```bash
# Claude Code: use run_in_background:true for this command (sleep >= 2s is blocked in foreground)
sleep 5 && pm2 logs comis --lines 10 --nostream
```
Look for `"Comis daemon started"` in stdout. If stderr shows `FATAL: Bootstrap failed`, check the config parse error message — restore last-known-good config if needed:
```bash
cp ~/.comis/config.last-good.yaml ~/.comis/config.yaml && pm2 restart comis
```

**Status:**
```bash
pm2 status comis
```

**Reset restart counter / clean slate:** `pm2 flush` only clears log files — the restart counter persists. To fully reset, delete and recreate the process:
```bash
pm2 delete comis && pm2 flush && node packages/cli/dist/cli.js pm2 start
```

### Direct (alternative)

**CRITICAL: `COMIS_CONFIG_PATHS` must be set on the same command line as the daemon process.** Shell `export` and separate commands do not reliably propagate env vars to backgrounded processes from tool environments.
```bash
pkill -f 'node.*daemon\.js' 2>/dev/null && sleep 1 && COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" nohup node packages/daemon/dist/daemon.js >/dev/null 2>&1 &
```

## Project Overview

Comis is a security-first AI agent assistant platform connecting AI agents to real-time chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). TypeScript monorepo with 13 packages following hexagonal architecture (ports and adapters). Linux-only, targets Node.js >= 22.

## Architecture

The entire codebase is **port-driven**. Core defines port interfaces in `packages/core/src/ports/`; adapters implement them in other packages and are wired through `AppContainer` in `core/src/bootstrap.ts` (composition root). Extending Comis means implementing a port interface and wiring it in bootstrap (see `AGENTS.md` section 7 for playbooks).

See `AGENTS.md` section 4 for the full port-adapter mapping, repository map, and package dependency graph.

### Key Patterns

- **Result<T, E>**: All functions return `Result` from `@comis/shared` — no thrown exceptions. Use `ok()`, `err()`, `tryCatch()`, `fromPromise()`.
- **TypedEventBus**: Type-safe event emitter in `core/src/event-bus/` with 80+ strongly-typed events across `AgentEvents`, `ChannelEvents`, `MessagingEvents`, and `InfraEvents`.
- **Composition root**: `core/src/bootstrap.ts` wires the application — creates SecretManager → loads config → builds event bus, plugin registry, and hook runner. Returns `AppContainer`.
- **AsyncLocalStorage context**: `core/src/context/` provides request-scoped context via `runWithContext()`, `getContext()`.
- **Layered config**: defaults → YAML files → env overrides. 100+ Zod schemas in `core/src/config/`. Config file paths specified via `COMIS_CONFIG_PATHS` env var (comma-separated). Runtime changes via `config.write` RPC (in-memory only, no file watch). All domain types in `core/src/domain/` use Zod schemas with inferred types.
- **Factory functions**: Prefer `createXxx()` factory functions returning typed interfaces (e.g., `createCircuitBreaker()` → `CircuitBreaker`).

## Logging Rules

All packages use Pino structured logging via `@comis/infra`.

### Level Selection

| Level | Use For | Budget |
|-------|---------|--------|
| **ERROR** | Broken functionality. Always include `hint` + `errorKind`. | Unbounded |
| **WARN** | Degraded but functional. Always include `hint` + `errorKind`. | Unbounded |
| **INFO** | Boundary events only: request arrived, execution complete, component started/stopped. | 2-5 lines per request |
| **DEBUG** | Internal steps, individual tool/LLM calls, intermediate state. | Unbounded |

**Rule:** Once per request = INFO. N times per request = DEBUG. Aggregate count goes in the INFO summary line.

Always use Pino object-first syntax:
```typescript
logger.info({ agentId, durationMs, toolCalls: 3 }, "Execution complete");
```

### Canonical Fields

| Field | Type | When |
|-------|------|------|
| `agentId` | string | Agent-scoped operations |
| `traceId` | string | Auto-injected via AsyncLocalStorage mixin |
| `channelType` | string | Channel adapter logs |
| `durationMs` | number | Any timed operation |
| `toolName` | string | Tool execution |
| `method` | string | RPC/HTTP method |
| `err` | unknown | Error objects (**not** `error` — matches Pino serializer) |
| `hint` | string | Actionable guidance (required on ERROR/WARN) |
| `errorKind` | ErrorKind | Error classification (required on ERROR/WARN) |
| `module` | string | Set via `logLevelManager.getLogger("module")` |

### Redaction

Pino automatically redacts credential fields: `apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, etc. Nested redaction to 3 levels deep (e.g., `config.telegram.botToken`). Cookies and webhook secrets redacted via `cookie`, `webhookSecret` patterns.

## Testing Conventions

- **Unit tests** co-located with source: `src/component.ts` alongside `src/component.test.ts`.
- Each package has its own `vitest.config.ts` with `include: ["src/**/*.test.ts"]`.
- **Integration tests** in `test/integration/` require `pnpm build` first (import from `dist/`).
- Integration tests run sequentially (`maxConcurrency: 1`, `pool: "forks"`, `retry: 1`) — daemon-based tests bind real ports.
- Key test utilities in `test/support/`: `startTestDaemon()`, `createLogCapture()`, `openAuthenticatedWebSocket()`, `createEventAwaiter()`, `createChaosEchoAdapter()`.

## Worktree Cleanup

After merging a worktree-based agent's branch back to the working branch, immediately remove the worktree and its tracking branch:
```bash
git worktree remove .claude/worktrees/<name> --force
git branch -D worktree-<name>
```
Do not leave stale worktrees behind — they accumulate disk usage and orphaned branches.

## Conventions

- **Commits**: Conventional Commits — `feat(agent): description`, `fix(channels): description`
- **Branches**: `feature/<desc>`, `fix/<desc>`, `docs/<desc>` from `main`
- **Modules**: ES modules only (`"type": "module"`)
- **TypeScript**: Strict mode, ES2023 target, NodeNext module resolution, `composite: true` with project references, `isolatedModules: true`
- **Build output**: `packages/*/dist/` and `*.tsbuildinfo` (gitignored, built on CI)
- **Package exports**: Each package exports via `"main": "./dist/index.js"` and `"types": "./dist/index.d.ts"`
- **Imports**: All imports use `.js` extension (required for Node.js ES modules). Named imports preferred. Type imports use `import type`.
- **ESLint enforced rules**: No empty `.catch()` (use `suppressError()`), no `path.join()` (use `safePath()`), no `process.env` (use `SecretManager`), no `Function()` constructor.

See `AGENTS.md` sections 3, 6, and 10 for the full engineering principles, naming contract, architecture boundaries, and anti-patterns.
