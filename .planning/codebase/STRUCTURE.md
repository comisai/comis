# Codebase Structure

**Analysis Date:** 2026-04-17

## Directory Layout

```
comis/
├── packages/               # Monorepo packages (13 total)
│   ├── shared/            # Foundation types (Result, utilities, zero runtime deps)
│   ├── core/              # Domain types, ports, bootstrap, security, config
│   ├── infra/             # Logging infrastructure (Pino)
│   ├── memory/            # SQLite persistence (MemoryPort, SecretStorePort, etc.)
│   ├── gateway/           # HTTP server (mTLS, JSON-RPC, WebSocket)
│   ├── agent/             # Agent execution (PiExecutor, safety controls)
│   ├── channels/          # Platform adapters (Telegram, Discord, Slack, WhatsApp, etc.)
│   ├── skills/            # Tool system (skill registry, MCP, built-ins)
│   ├── scheduler/         # Cron, heartbeat, task extraction
│   ├── cli/               # Command-line interface
│   ├── daemon/            # Daemon orchestrator (startup, wiring, RPC bridge)
│   ├── web/               # Browser dashboard (Lit + Tailwind)
│   └── comis/             # Umbrella package (namespace re-exports)
├── test/                  # Integration tests (vitest)
│   ├── integration/       # Full daemon tests (sequential, fork pools)
│   ├── config/           # Test config files
│   ├── dist/             # Compiled dist imports for tests
│   └── support/          # Test utilities (startTestDaemon, createLogCapture, etc.)
├── docs/                  # User documentation (Markdown)
├── docker/               # Docker build files
├── website/              # Marketing website (Astro)
├── pnpm-workspace.yaml   # Monorepo workspace definition
├── tsconfig.base.json    # Shared TypeScript configuration
├── eslint.config.js      # ESLint flat config (security rules)
└── CLAUDE.md             # Project engineering protocol
```

## Directory Purposes

**packages/shared/**
- Purpose: Foundation types and utilities — zero external runtime dependencies
- Contains: `Result<T, E>` type and constructors, timeout utilities, TTL cache, abort checking, suppress-error helper
- Key files: `src/result.ts`, `src/suppress-error.ts`, `src/timeout.ts`, `src/ttl-cache.ts`
- Why separate: Imported by all other packages; keeps dependency graph acyclic

**packages/core/**
- Purpose: Domain logic, port interfaces, bootstrap, security, configuration
- Contains:
  - `src/domain/` — Core types (NormalizedMessage, SessionKey, AppConfig, etc.)
  - `src/ports/` — 20+ port interfaces (ChannelPort, MemoryPort, SkillPort, etc.)
  - `src/bootstrap.ts` — Composition root (creates AppContainer)
  - `src/security/` — SecretManager, safe-path validation, output guard, device identity
  - `src/config/` — 38 Zod schema files (100+ schemas, ~4000 lines)
  - `src/event-bus/` — TypedEventBus (AgentEvents, ChannelEvents, MessagingEvents, InfraEvents)
  - `src/context/` — RequestContext, AsyncLocalStorage utilities
  - `src/hooks/` — Plugin registry, hook runner, lifecycle hooks
  - `src/approval/` — Approval gate logic, audit trail

**packages/infra/**
- Purpose: Infrastructure code — logging setup, observability
- Contains: Pino logger initialization, log level manager, redaction rules, JSON formatters
- Key files: `src/logging/pino-setup.ts`, `src/logging/log-level-manager.ts`

**packages/memory/**
- Purpose: SQLite-backed persistence adapters implementing MemoryPort and other storage ports
- Contains:
  - `src/sqlite-adapter-base.ts` — Shared DB lifecycle (open, chmod, close)
  - `src/sqlite-memory-adapter.ts` — MemoryPort (search, store, retrieve, memory/embeddings)
  - `src/sqlite-secret-store.ts` — SecretStorePort (encrypted AES-256-GCM storage)
  - `src/session-store.ts` — Session metadata + JSONL file management
  - `src/embedding-*.ts` — Embedding provider factory, OpenAI, caching (LRU + SQLite L2)
  - `src/context-store.ts` — DAG conversation tree (Phase 411+)
  - `src/observability-store.ts` — Token usage, delivery metrics, diagnostics
  - `src/schema.ts` — SQLite schema initialization (FTS5, vector search)

**packages/gateway/**
- Purpose: HTTP API server (mTLS, JSON-RPC 2.0, WebSocket, webhooks)
- Contains:
  - `src/server/hono-server.ts` — Hono HTTP server, port binding, middleware stack
  - `src/rpc/` — JSON-RPC 2.0 method router, WebSocket connection manager
  - `src/auth/` — Bearer token validation, scope checking
  - `src/rate-limit/` — Rate limiting per endpoint/IP
  - `src/webhook/` — Telegram/platform webhook endpoints
  - `src/web/` — Media routes (avatar, file downloads)
  - `src/openai/` — OpenAI-compatible endpoints (completions, models, embeddings)
  - `src/discovery/` — mDNS service advertiser (Bonjour)

**packages/agent/**
- Purpose: Agent execution with safety controls
- Contains:
  - `src/executor/` — PiExecutor (wraps @mariozechner/pi-coding-agent), stream wrappers, overflow recovery
  - `src/safety/` — Circuit breaker, budget guard, context window guard, tool output sanitization
  - `src/context-engine/` — Context assembly (RAG + system prompt), token budgeting, DAG compaction
  - `src/session/` — Session lifecycle, latch (concurrency control), label store, reset policy
  - `src/model/` — Auth provider facade, profile rotation, model catalog, image router
  - `src/budget/` — Cost tracker, turn budget, overflow policy
  - `src/commands/` — Slash command parsing, skill matching
  - `src/memory/` — Memory review job (session history extraction)
  - `src/rag/` — RAG retriever, hybrid memory injector
  - `src/queue/` — Message debouncing, priority scheduler, command queue
  - `src/spawn/` — Sub-agent spawning, packet builder, result condensing
  - `src/identity/` — Identity file loading, link resolution, updating

**packages/channels/**
- Purpose: Platform-specific messaging adapters
- Contains one subdirectory per platform:
  - `src/{platform}/{platform}-adapter.ts` — Platform-specific adapter implementing ChannelPort
  - `src/{platform}/message-mapper.ts` — Maps platform message → NormalizedMessage
  - `src/{platform}/media-handler.ts` — Downloads/uploads files for platform
  - `src/{platform}/credential-validator.ts` — Validates API credentials/tokens
  - `src/{platform}/{platform}-resolver.ts` — Pre-download size checks, format validation
  - `src/{platform}/{platform}-plugin.ts` — ChannelPluginPort implementation (lifecycle hooks)
- Shared utilities:
  - `src/shared/channel-registry.ts` — Adapter registry, lifecycle management
  - `src/shared/deliver-to-channel.ts` — Message chunking, retry engine, typing indicators
  - `src/shared/auto-reply-engine.ts` — Skip certain messages (groups, automated)
  - `src/shared/response-filter.ts` — NO_REPLY token, heartbeat suppression
  - `src/shared/approval-notifier.ts` — Sends approval requests to channels
  - `src/shared/lifecycle-reactor.ts` — Tool phase emoji reactions, stall detection
- Platforms: Telegram, Discord, Slack, WhatsApp, Signal, LINE, iMessage, IRC, Email, Echo (test)

**packages/skills/**
- Purpose: Tool system — skill registry, MCP client, built-in tools
- Contains:
  - `src/registry/skill-registry.ts` — SkillRegistry (manifest parsing, tool loading, progressive disclosure)
  - `src/bridge/tool-bridge.ts` — Assembles tool pipeline (AgentTool → ToolDefinition)
  - `src/bridge/credential-injector.ts` — Injects SecretManager credentials into tools
  - `src/builtin/` — Built-in tools (web-search, web-fetch, exec, file ops, memory, sessions)
  - `src/builtin/sandbox/` — Sandbox detection (bubblewrap, seccomp)
  - `src/integrations/` — STT factory, media preprocessor, embedding providers
  - `src/prompt/` — Skill expansion, content scanning

**packages/scheduler/**
- Purpose: Cron scheduling, heartbeat polling, task extraction, background jobs
- Contains:
  - `src/cron/` — Cron runner (node-cron integration)
  - `src/heartbeat/` — Periodic polling for messages/tasks
  - `src/execution/` — Job executor, error handling
  - `src/tasks/` — Extract scheduled commands from messages

**packages/cli/**
- Purpose: Command-line interface for daemon management
- Contains:
  - `src/commands/` — Commander.js command definitions (daemon, config, doctor, etc.)
  - `src/client/` — JSON-RPC client wrapper (connects to gateway)
  - `src/wizard/` — Interactive credential setup
  - `src/doctor/` — Diagnostics and troubleshooting
  - `src/output/` — Pretty-print formatters (tables, colors)

**packages/daemon/**
- Purpose: Daemon orchestrator — startup, service wiring, RPC bridge
- Contains:
  - `src/daemon.ts` — `main()` entry point, setupXxx() factory sequence, graceful shutdown
  - `src/wiring/` — Factory functions (setupLogging, setupMemory, setupAgents, setupChannels, setupGateway, etc.)
  - `src/rpc/` — RPC bridge (maps domain operations to HTTP methods)
  - `src/sub-agent-runner.ts` — Sub-agent spawning, limits, disk sweep
  - `src/announcement-dead-letter.ts` — Failed announcement queue
  - `src/observability/` — Latency recording, token tracking, trace logging
  - `src/health/` — Watchdog, process monitor
  - `src/process/` — Graceful shutdown, signal handling
  - `src/config/` — Last-known-good backup, rollback, Git-based change tracking

**packages/web/**
- Purpose: Browser-based dashboard (SPA)
- Contains:
  - `src/components/` — Lit web components (session list, message log, agent controls)
  - `src/pages/` — Page layouts (main, settings, docs)
  - `src/state/` — Reactive state management (daemon connection, session data)
  - `src/utils/` — WebSocket client, API helpers

**packages/comis/**
- Purpose: Umbrella package (namespace re-exports)
- Contains: `src/index.ts` re-exports all public APIs from other packages
- Usage: Allows `import { createAgent, ... } from "@comis/comis"` instead of multiple imports

**test/**
- Purpose: Integration tests (full daemon tests, sequential execution)
- Contains:
  - `integration/` — E2E test files (gateway, channels, agent execution)
  - `config/` — Test daemon config files
  - `support/` — Test utilities (startTestDaemon, createLogCapture, createEventAwaiter, createChaosEchoAdapter)
  - `vitest.config.ts` — Sequential pool config, fork isolation

## Key File Locations

**Entry Points:**

| File | Purpose |
|------|---------|
| `packages/daemon/src/daemon.ts` | Daemon startup: `main(overrides?)` |
| `packages/cli/src/index.ts` | CLI entry: Commands and client |
| `packages/web/src/` | SPA entry: index.html (built by Vite) |
| `packages/gateway/src/server/hono-server.ts` | HTTP server: `createGatewayServer()` |

**Configuration:**

| File | Purpose |
|------|---------|
| `~/.comis/config.yaml` | Runtime config (YAML format) |
| `packages/core/src/config/schema.ts` | Root config schema definition |
| `packages/core/src/config/loader.ts` | Config file loading + layering |
| `tsconfig.base.json` | Shared TypeScript settings |
| `eslint.config.js` | ESLint rules (security, naming) |
| `pnpm-workspace.yaml` | Monorepo package definitions |

**Core Logic:**

| File | Purpose |
|------|---------|
| `packages/core/src/bootstrap.ts` | Composition root: `bootstrap()` creates AppContainer |
| `packages/agent/src/executor/pi-executor.ts` | Agent execution: `PiExecutor` (wraps pi-coding-agent) |
| `packages/channels/src/shared/deliver-to-channel.ts` | Message delivery: chunking, retry, typing |
| `packages/agent/src/context-engine/` | Context assembly: RAG, system prompt, token budget |
| `packages/memory/src/sqlite-memory-adapter.ts` | Persistent search & storage (MemoryPort impl.) |

**Testing:**

| File | Purpose |
|------|---------|
| `test/vitest.config.ts` | Integration test runner config (sequential, forks) |
| `test/support/daemon-harness.ts` | `startTestDaemon()` utility |
| `test/support/event-awaiter.ts` | `createEventAwaiter()` for event-driven tests |
| `test/integration/gateway.test.ts` | Gateway HTTP/WebSocket tests |
| `src/**/*.test.ts` | Unit tests (co-located with source) |

## Naming Conventions

**Files:**
- `kebab-case.ts` — Source files (e.g., `secret-manager.ts`, `typed-event-bus.ts`)
- `schema-xxx.ts` — Zod schema definitions (e.g., `schema-agent-model.ts`, `schema-delivery.ts`)
- `*-factory.ts` — Factory functions (e.g., `skill-registry-factory.ts`)
- `*-adapter.ts` — Port implementations (e.g., `telegram-adapter.ts`)
- `*-port.ts` or `ports/` — Port/interface definitions
- `*-test.ts` — Unit tests (co-located: `foo.ts` + `foo.test.ts`)

**Directories:**
- `src/` — TypeScript source
- `dist/` — Compiled output (gitignored, built by `pnpm build`)
- `test/` — Integration tests
- `src/{domain}/` — Domain-specific subdirectories (e.g., `src/executor/`, `src/session/`)

**Functions & Variables:**
- `camelCase` — Standard functions (e.g., `getContext()`, `createSecretManager()`)
- `createXxx()` — Factory functions returning typed interfaces
- `isXxx()` / `hasXxx()` — Predicates (e.g., `isReadOnlyTool()`, `hasProvider()`)
- `validateXxx()` / `checkXxx()` — Validators (e.g., `validatePartial()`)
- `_privateHelper()` — Internal/private helpers (underscore prefix)
- `SCREAMING_SNAKE_CASE` — Constants (e.g., `DEFAULT_REDACT_PATHS`, `MAX_STEPS`)

**Types & Interfaces:**
- `PascalCase` — Types/interfaces (e.g., `SecretManager`, `CircuitBreaker`, `ChannelPort`)
- `XxxSchema` — Zod schemas (e.g., `AppConfigSchema`, `DeliveryQueueEntrySchema`)
- `type XxxConfig = z.infer<typeof XxxConfigSchema>` — Inferred types
- `XxxEvents` — Event type unions (e.g., `MessagingEvents`, `AgentEvents`)

**Exports:**
- Each package exports via `src/index.ts` (barrel file)
- Grouped by concern: domain, ports, security, event-bus, config, hooks, bootstrap
- Build output: `dist/index.js` + `dist/index.d.ts` (per package)
- Integration tests use `dist/` imports (not source) to test built artifacts

## Where to Add New Code

**New Channel Adapter:**
1. Create `packages/channels/src/{platform}/` directory
2. Implement `{platform}-adapter.ts` (ChannelPort interface)
3. Add message mapper: `message-mapper.ts` (normalize platform message)
4. Add media handler: `media-handler.ts` (download/upload files)
5. Add credential validator: `credential-validator.ts` (validate token)
6. Add resolver: `{platform}-resolver.ts` (size checks, format validation)
7. Add plugin: `{platform}-plugin.ts` (ChannelPluginPort hooks)
8. Wire in daemon: `packages/daemon/src/wiring/setup-channels.ts`

**New Tool/Skill:**
1. If built-in: add to `packages/skills/src/builtin/{tool-name}.ts`
2. If prompt-based: add YAML file to workspace `skills/` directory
3. If MCP-based: configure MCP server URL in config
4. Bridge via `packages/skills/src/bridge/tool-bridge.ts` (AgentTool → ToolDefinition)

**New RPC Method:**
1. Implement handler: `packages/daemon/src/rpc/{handler-name}.ts`
2. Export handler function
3. Wire in `packages/daemon/src/wiring/setup-rpc-bridge.ts` (methodRouter.register())
4. Gateway auto-discovers via dynamic method router

**New Configuration Option:**
1. Add Zod schema: `packages/core/src/config/schema-{domain}.ts`
2. Add schema fields to root schema in `packages/core/src/config/schema.ts`
3. Infer TypeScript type via `z.infer<>`
4. Load via `AppConfig` in bootstrap
5. Access in code via `config.{path}` from AppContainer

**New Event Type:**
1. Define in `packages/core/src/event-bus/events-{domain}.ts`
2. Add to `EventMap` union in `packages/core/src/event-bus/events.ts`
3. Emit via `eventBus.emit(eventName, eventData)`
4. Listen via `eventBus.on(eventName, handler)`
5. Automatic type inference prevents typos

**New Unit Test:**
1. Co-locate: `src/component.ts` + `src/component.test.ts`
2. Use Vitest (already configured per package)
3. Run: `cd packages/{pkg} && pnpm test` or `pnpm test` from root
4. Coverage: `pnpm vitest run --coverage`

**New Integration Test:**
1. Add to `test/integration/` directory
2. Use `startTestDaemon()` from `test/support/daemon-harness.ts`
3. Config: `test/config/` YAML files
4. Utilities: Event awaiter, log capture in `test/support/`
5. Run: `pnpm test:integration` (sequential with fork pools)

## Special Directories

**~/.comis/**
- Purpose: Data directory (default, can be changed via config)
- Generated: Yes
- Committed: No
- Contains:
  - `config.yaml` — Runtime configuration
  - `config.last-good.yaml` — Backup of last successful config
  - `comis.db` — SQLite database (memory, embeddings, credentials, observability, context)
  - `sessions/` — Per-session JSONL files (conversation history)
  - `.pm2/` — pm2 ecosystem config and logs (if using pm2)
  - `logs/` — Rotated daemon logs (pino-roll)

**dist/ (all packages)**
- Purpose: Compiled TypeScript output
- Generated: Yes (by `pnpm build`)
- Committed: No (in .gitignore)
- Contains: `*.js` + `*.d.ts` (type definitions)
- Integration tests import from `dist/` to test built artifacts

**test/dist/**
- Purpose: Compiled integration test source
- Generated: Yes (by `pnpm build`)
- Committed: No
- Note: Integration tests import packages from `dist/` (not `src/`)

**docs/**
- Purpose: User documentation (Markdown)
- Format: Markdown with Astro frontmatter
- Structure: Architecture, setup, operation, configuration, developer guide

**website/**
- Purpose: Marketing/public website
- Framework: Astro static site generator
- Hosted: Deployed to Cloudflare Pages
- Build: `pnpm build` in website package

---

*Structure analysis: 2026-04-17*
