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

### Port Interfaces

| Port | Adapters | Package |
|------|----------|---------|
| `ChannelPort` | Telegram, Discord, Slack, WhatsApp, Signal, IRC, LINE, Email, Echo, iMessage | `channels` |
| `ChannelPluginPort` | Per-platform plugin factories | `channels` |
| `MemoryPort` | SqliteMemoryAdapter | `memory` |
| `SkillPort` | SkillRegistry (prompt-only), MCP client | `skills` |
| `EmbeddingPort` | External LLM providers | `skills` |
| `CredentialMappingPort` | Credential mapping CRUD | `core` |
| `MediaResolverPort` | Per-platform resolvers, CompositeResolver | `channels`, `skills` |
| `TranscriptionPort` | OpenAI, Groq, Deepgram STT adapters | `skills` |
| `TTSPort` | OpenAI, ElevenLabs, Edge TTS adapters | `skills` |
| `ImageAnalysisPort` | Vision analysis providers | `skills` |
| `VisionProvider` | Multi-capability vision (image + video) | `skills` |
| `FileExtractionPort` | Document text extraction (PDF, CSV) | `skills` |
| `ImageGenerationPort` | FAL, OpenAI image generation | `skills` |
| `OutputGuardPort` | LLM output secret-leak scanning | `core` |
| `SecretStorePort` | Encrypted secret storage (AES-256-GCM) | `core` |
| `DeviceIdentityPort` | Cryptographic device identity (Ed25519) | `core` |
| `PluginPort` | Plugin registration and lifecycle | `core` |
| `DeliveryQueuePort` | Message delivery queue (SQLite-backed) | `memory` |
| `DeliveryMirrorPort` | Delivery deduplication and mirroring | `memory` |

### Package Dependency Graph

```
shared (Result type, utilities — zero runtime deps)
└── core (domain types, ports, event bus, security, config, plugin system)
    ├── infra (Pino logging)
    ├── memory (SQLite + FTS5 + vector search)
    ├── gateway (Hono HTTP, JSON-RPC, WebSocket, mTLS)
    ├── skills (manifest, prompt skills, MCP, built-in tools, media processing, STT)
    ├── scheduler (cron, heartbeat, task extraction)
    ├── agent (executor, budget, circuit breaker, RAG, sessions) → memory, scheduler, infra
    ├── channels (platform adapters) → agent, infra
    ├── cli (Commander.js, JSON-RPC client) → agent, memory
    └── daemon (orchestrator, observability, systemd) → ALL packages
comis (umbrella package — namespace re-exports of all packages)
web (Lit + Vite + Tailwind, standalone SPA)
```

### Key Patterns

- **Result<T, E>**: All functions return `Result` from `@comis/shared` — no thrown exceptions. Use `ok()`, `err()`, `tryCatch()`, `fromPromise()`.
- **TypedEventBus**: Type-safe event emitter in `core/src/event-bus/` with 80+ strongly-typed events across `AgentEvents`, `ChannelEvents`, `MessagingEvents`, and `InfraEvents`.
- **Composition root**: `core/src/bootstrap.ts` wires the application — creates SecretManager → loads config → builds event bus, plugin registry, and hook runner. Returns `AppContainer`.
- **AsyncLocalStorage context**: `core/src/context/` provides request-scoped context via `runWithContext()`, `getContext()`.
- **Layered config**: defaults → YAML files → env overrides. 100+ Zod schemas in `core/src/config/`. Config file paths specified via `COMIS_CONFIG_PATHS` env var (comma-separated). Runtime changes via `config.write` RPC (in-memory only, no file watch).
- **Factory functions**: Prefer `createXxx()` factory functions returning typed interfaces (e.g., `createCircuitBreaker()` → `CircuitBreaker`).

## Config System

Config loads from YAML files specified via `COMIS_CONFIG_PATHS` env var (comma-separated). Layered resolution: defaults → YAML files → env overrides. No file watcher — config is loaded once at startup. Runtime updates via `config.write` RPC modify in-memory config only. Types are Zod schemas in `core/src/config/` with inferred TypeScript types. All domain types in `core/src/domain/` use Zod schemas with inferred types.

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

### Naming Patterns

- **Files**: `kebab-case.ts` (e.g., `secret-manager.ts`, `typed-event-bus.ts`, `context-engine.ts`)
- **Schema files**: `schema-agent-model.ts`, `schema-delivery-timing.ts`, `schema-context-engine.ts`
- **Test files**: Co-located with source, suffix `.test.ts` (e.g., `context.test.ts` alongside `context.ts`)
- **Factory/builder files**: `*-factory.ts`, `*-builder.ts`, `*-harness.ts`
- **Port/interface definitions**: `*-port.ts` or `ports/*.ts`
- **Functions/variables**: `camelCase` — `getContext()`, `tryGetContext()`, `runWithContext()`, `createSecretManager()`
- **Factory functions**: `createXxx()` pattern returning typed interfaces (e.g., `createCircuitBreaker()` → `CircuitBreaker`)
- **Predicate functions**: `isXxx()` or `hasXxx()` (e.g., `isReadOnlyTool()`, `hasProvider()`)
- **Validators**: `validateXxx()`, `checkXxx()` (e.g., `validatePartial()`, `checkApprovalsConfig()`)
- **Private/internal helpers**: `_clearRegistryForTest()` with leading underscore; ESLint configured to allow underscore-prefixed vars
- **Constants**: `SCREAMING_SNAKE_CASE` — `DEFAULT_REDACT_PATHS`, `HEALTH_POLL_ATTEMPTS`, `MAX_STEPS`
- **Defensive naming**: `_isMinimal`, `_encoding` for intentionally unused parameters (underscore prefix)
- **Type narrowing variables**: `msgHandler`, `skillHandler`, `chanHandler` (domain-specific suffixes)
- **Types/interfaces**: `PascalCase` — `SecretManager`, `RequestContext`, `CircuitBreaker`, `OutputGuardPort`
- **Schema types**: `XxxSchema` (e.g., `BudgetConfigSchema`, `RequestContextSchema`, `DeliveryOriginSchema`)
- **Inferred types**: `type XxxConfig = z.infer<typeof XxxConfigSchema>`
- **Event types**: `XxxEvents` (e.g., `MessagingEvents`, `AgentEvents`, `ChannelEvents`)
- **Domain types**: Plain PascalCase (e.g., `AppConfig`, `ComisToolMetadata`, `RunHandle`)

### Code Style

- No `.prettierrc` enforced — ESLint is the primary linter
- TypeScript strict mode enabled
- ES2023 target, NodeNext module resolution
- `"type": "module"` in all packages (ES modules only)
- Config: `eslint.config.js` at project root (ESLint flat config)
- Rules enforced:
  - Empty `.catch(() => {})` → must use `suppressError(promise, reason)` from `@comis/shared`
  - Raw `path.join()` → must use `safePath()` from `@comis/core/security`
  - Direct `process.env` access → must use `SecretManager` from `@comis/core/security`
  - `Function()` constructor → equivalent to eval(), banned

### Import Organization

- Used in integration tests only (`test/vitest.config.ts`): `@comis/core` → `packages/core/dist/index.js`
- Source packages use direct relative imports or explicit package names
- Aliases resolve at test time (imports from `dist/` after build)
- All imports use `.js` extension (required for Node.js ES modules)
- Named imports preferred: `import { ok, err } from "@comis/shared"`
- Type imports: `import type { Result } from "@comis/shared"` or `import type { AppConfig } from "./config/types.js"`
- Barrel files: Each package exports via `index.ts` re-exporting from subdirectories

### Error Handling

- **Result type**: All functions return `Result<T, E>` from `@comis/shared` — no thrown exceptions
- **Result constructors**: `ok(value)` and `err(error)` from `@comis/shared`
- **Async wrapping**: `fromPromise(promise)` for async operations
- **Sync wrapping**: `tryCatch(() => riskySync())` for synchronous code
- **Error suppression**: `suppressError(promise, reason)` for intentional ignoring (banned empty `.catch()`)
- **Custom error types**: Domain errors are inferred via Zod schemas (`ConfigError`, `ValidationError`)

### Comments

- Complex business logic: Explain the "why", not the "what"
- Non-obvious algorithmic decisions: Trade-offs, performance rationale
- Security decisions: Threat model, mitigation approach
- Workarounds: Why a naive approach won't work, what the constraint is
- Functions: Always include docstring with purpose, parameters, return value
- Complex types/interfaces: Document intent and constraints
- @param, @returns tags for clarity on complex signatures
- @module tag for file-level documentation of responsibilities

### Function Design

- Prefer small, focused functions (< 50 lines typical)
- Extract internal helpers as separate functions when logic exceeds one concern
- Factory functions can be larger (100+ lines) if they're purely assembly
- Typed via TypeScript (no untyped `any`)
- Destructuring for options objects (more readable, allows optional fields)
- Minimal positional parameters (max 2-3); prefer options object for > 2 related params
- Unused parameters marked with `_` prefix: `function (_isMinimal: boolean): string[] { ... }`
- Always typed explicitly
- Use `Result<T, E>` for functions that can fail
- Return typed interfaces, not concrete classes (e.g., `CircuitBreaker`, not `CircuitBreakerImpl`)
- No implicit undefined — if optional, encode in return type (e.g., `Result<T | undefined, E>`)

### Module Design

- Public API via `export` declarations at module level
- Internal helpers prefixed with `_` (e.g., `_clearRegistryForTest()`) or unmarked (not exported)
- Type exports via `export type { TypeName }` for clarity
- Each package has `src/index.ts` re-exporting public APIs
- Build outputs: `packages/*/dist/index.js` and `packages/*/dist/index.d.ts`
- Integration tests alias imports to `dist/` packages (not source)
- Hexagonal architecture: Core defines port interfaces, other packages implement adapters
- Composition root: `core/src/bootstrap.ts` wires the application
- No circular dependencies; strict acyclic module graph (enforced via `tsconfig.json` project references)

## Technology Stack

### Languages
- TypeScript 5.9.3 - Entire codebase (backend, frontend, CLI, daemon)
- ES2023 target with strict mode enabled
- JavaScript (configuration, build scripts, GitHub Actions)
- Shell (docker-setup.sh, deployment scripts)

### Runtime
- Node.js >= 22 (required, ES modules only)
- Linux (primary target, Windows/macOS for development only)
- pnpm (latest, via corepack)
- Lockfile: pnpm-lock.yaml (present, frozen lockfile in CI)

### Frameworks
- zod 4.3.6 - Schema validation and runtime type safety (throughout codebase)
- yaml 2.8.2 - Config file parsing and generation
- hono 4.12.5 - Lightweight HTTP server/router (gateway, daemon)
- @hono/node-server 1.19.11 - Node.js adapter for Hono
- @hono/node-ws 1.3.0 - WebSocket support for Hono
- hono-rate-limiter 0.5.3 - Rate limiting middleware
- @homebridge/ciao 1.3.5 - mDNS for service discovery
- json-rpc-2.0 1.7.1 - JSON-RPC 2.0 protocol implementation
- @agentclientprotocol/sdk 0.15.0 - Agent Client Protocol (gateway)
- better-sqlite3 12.6.2 - Synchronous SQLite with native bindings (required: native compilation)
- sqlite-vec 0.1.7-alpha.2 - Vector search extension for SQLite
- lru-cache 11.2.6 - LRU cache for embeddings
- commander 14.0.0 - Command-line interface parser
- @clack/prompts 1.1.0 - Interactive CLI prompts
- @clack/core 1.1.0 - Core prompt components
- chalk 5.6.2 - Terminal color formatting
- cli-table3 0.6.5 - ASCII table formatting
- ora 9.0.0 - Spinner/progress indicators
- ws 8.19.0 - WebSocket client for CLI
- pino 10.3.1 - Structured JSON logging (all packages)
- pino-pretty 13.1.3 - Pretty-print formatter (dev only)
- pino-roll 4.0.0 - Log rotation (daemon)
- vitest 4.0.0 - Workspace test runner (all packages)
- happy-dom 20.8.3 - Lightweight DOM for web tests
- typescript 5.9.3 - Compiler with strict mode, composite projects, isolatedModules
- eslint 10.0.3 - Linting
- @eslint/js 10.0.1 - ESLint JavaScript config
- typescript-eslint 8.56.1 - TypeScript linting rules
- eslint-plugin-security 4.0.0 - Security-focused lint rules
- vite 7.0.0 - Web SPA bundler (packages/web)
- @tailwindcss/vite 4.2.1 - Tailwind CSS bundler integration (web)
- lit 3.3.2 - Lightweight web components (packages/web)
- tailwindcss 4.2.1 - Utility CSS framework (web)
- @dagrejs/dagre 2.0.4 - Graph/DAG layout (web visualization)

### Key Dependencies
- @mariozechner/pi-agent-core 0.65.0 - Agent execution (core)
- @mariozechner/pi-ai 0.65.0 - AI model integration (agent, daemon)
- @mariozechner/pi-coding-agent 0.65.0 - Code generation agent (skills, agent)
- @modelcontextprotocol/sdk 1.27.1 - MCP (Model Context Protocol) client (skills)
- @google/genai 1.47.0 - Google Gemini API client (agent)
- @fal-ai/client 1.9.5 - FAL image generation API (skills)
- discord.js 14.25.1 - Discord API client (channels)
- grammy 1.41.1 - Telegram Bot API client (channels)
- @grammyjs/auto-retry 2.0.2 - Retry middleware for grammy (channels)
- @grammyjs/runner 2.0.3 - Long-polling runner for grammy (channels)
- @grammyjs/files 1.2.0 - File handling for grammy (channels)
- @slack/bolt 4.6.0 - Slack bot framework (channels)
- @slack/web-api 7.14.1 - Slack REST API client (channels)
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp client (channels)
- @line/bot-sdk 10.6.0 - LINE Messaging API SDK (channels)
- irc-framework 4.14.0 - IRC protocol client (channels)
- @elevenlabs/elevenlabs-js 2.38.1 - ElevenLabs TTS API client (skills)
- edge-tts-universal 1.4.0 - Microsoft Edge TTS (fallback, skills)
- openai 6.27.0 - OpenAI API client (embedding, TTS, transcription, vision)
- node-llama-cpp 3.17.1 - Local LLM inference via GGUF (memory, embeddings)
- sharp 0.34.5 - Image processing and resizing (agent, skills)
- @napi-rs/canvas 0.1.96 - Canvas drawing for image generation (skills)
- pdfjs-dist 5.5.207 - PDF text extraction (skills)
- music-metadata 11.12.1 - Audio metadata parsing (skills)
- file-type 21.3.0 - MIME type detection (channels, skills)
- chardet 2.1.1 - Character encoding detection (skills)
- iconv-lite 0.7.2 - Character encoding conversion (skills)
- @mozilla/readability 0.6.0 - Article content extraction (skills)
- linkedom 0.18.12 - Lightweight DOM implementation (skills)
- playwright-core 1.58.2 - Headless browser automation (skills)
- undici 7.22.0 - HTTP client (fetch polyfill, skills)
- proper-lockfile 4.1.2 - File-based locking (agent, scheduler)
- p-queue 9.1.0 - Async task queue (agent, memory, skills)
- impit 0.8.2 - Runtime code injection for proxies (skills)
- chokidar 5.0.0 - File system watcher (skills)
- ignore 7.0.5 - .gitignore-pattern matching (skills)
- diff 8.0.4 - Text diffing (agent)
- @sinclair/typebox 0.34.48 - Type-based schema validation (skills)
- ipaddr.js 2.3.0 - IP address utilities (core)
- safe-regex2 5.0.0 - Regular expression safety checking (core)
- @hapi/boom 10.0.1 - HTTP error generation (channels)

### Configuration
- Layered config system: YAML files (via `COMIS_CONFIG_PATHS` env var, comma-separated) → env var overrides
- No file watcher — config loaded once at startup, runtime updates via RPC only
- 100+ Zod schemas across 88 files in `packages/core/src/config/` (38 schema definition files)
- Config paths specified via environment variable: `COMIS_CONFIG_PATHS=/path/to/config.yaml`
- `tsconfig.base.json` - Shared TypeScript config (strict, ES2023, NodeNext)
- `packages/*/tsconfig.json` - Per-package configs with project references
- `packages/web/vite.config.ts` - Web SPA build config (Vite)
- `eslint.config.js` - Centralized ESLint configuration
- `pnpm-workspace.yaml` - Monorepo workspace definition
- `.env` file (one-time load at startup, never watched)
- `SECRETS_MASTER_KEY` env var (AES-256-GCM encryption of secret database)
- SecretManager handles credential access — no plaintext in config files
- API keys referenced by SecretManager key name, not stored inline

### Platform Requirements
- Node.js >= 22
- pnpm (latest)
- Native build tools (for better-sqlite3, sharp):
- Linux container (Debian Bookworm)
- Docker/Dockerfile support for multi-platform builds (amd64, arm64)
- Node 22 slim image as base
- Data directory: `~/.comis` (configurable)

### Native Dependencies
- better-sqlite3 (requires C++ compilation)
- sharp (requires libvips)
- @napi-rs/canvas (requires build-essential)
- node-llama-cpp (optional, local embeddings)
