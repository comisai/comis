# Architecture

**Analysis Date:** 2026-04-17

## Pattern Overview

**Overall:** Hexagonal (Ports & Adapters) architecture with layered composition. Core domain logic defines port interfaces; adapter packages implement them and are wired at startup via the composition root. Strongly typed event bus bridges internal events across layers.

**Key Characteristics:**
- **Port-driven design**: All external integrations (channels, storage, LLMs, skills) are defined as interfaces in `@comis/core/src/ports/` and implemented by adapter packages
- **Composition root**: `@comis/core/src/bootstrap.ts` is the single wiring point — all adapters and services are instantiated here
- **Result type monad**: All functions return `Result<T, E>` from `@comis/shared` — no exceptions, type-safe error propagation
- **AsyncLocalStorage context**: Request-scoped context carries tenant, user, session, trace identity through entire async call chain
- **TypedEventBus**: Strongly-typed inter-module event system with 80+ events across AgentEvents, ChannelEvents, MessagingEvents, InfraEvents
- **Configuration-driven**: Layered config (YAML files → env overrides) with 100+ Zod schemas, no file watching — runtime updates via RPC only

## Layers

**Domain Layer:**
- Purpose: Type definitions, domain logic, port interfaces, event types
- Location: `@comis/core/src/` (domain, ports, event-bus, config, security, context, approval, hooks)
- Contains: Request/AppConfig types, Port interfaces, event schemas, approval workflows, hook types
- Depends on: `@comis/shared` only (Result type, utilities)
- Used by: All other layers for shared types and interfaces

**Security & Configuration Layer:**
- Purpose: Credential management, config loading/parsing, permission/approval logic
- Location: `@comis/core/src/security/`, `@comis/core/src/config/`, `@comis/core/src/approval/`
- Contains: SecretManager (AES-256-GCM encrypted), Zod schema definitions, approval gate logic, audit trail
- Depends on: Domain layer
- Used by: Bootstrap, daemon startup, all packages needing credentials or config

**Infrastructure & Logging Layer:**
- Purpose: Structured logging, observability, health monitoring
- Location: `@comis/infra/src/logging/`, `@comis/daemon/src/observability/`
- Contains: Pino logger setup, log level management, token tracking, latency recording, diagnostics
- Depends on: Domain types
- Used by: All packages via `logLevelManager.getLogger("module")`

**Persistence Layer:**
- Purpose: SQLite-backed storage adapters implementing port interfaces
- Location: `@comis/memory/src/`
- Contains: SqliteMemoryAdapter (MemoryPort), SqliteSecretStore (SecretStorePort), SqliteDeliveryQueue, context store (DAG), observability store
- Depends on: Domain layer
- Used by: Agent execution, message delivery, embedding caching, session persistence

**Agent Execution Layer:**
- Purpose: LLM orchestration, safety controls, context management, session lifecycle
- Location: `@comis/agent/src/`
- Contains: PiExecutor (wraps @mariozechner/pi-coding-agent), budget guard, circuit breaker, RAG retriever, context engine (DAG), session manager, tool assembly
- Depends on: Core types, memory ports, skill ports
- Used by: Daemon for executing user messages and spawning sub-agents

**Channel Adapter Layer:**
- Purpose: Platform-specific messaging adapters (Telegram, Discord, Slack, WhatsApp, Signal, LINE, iMessage, IRC, Email, Echo)
- Location: `@comis/channels/src/`
- Contains: Platform adapters (each with message mapper, media handler, credential validator, resolver), channel registry, auto-reply engine, response filter, delivery engine
- Depends on: Agent executor for message handling, delivery routing
- Used by: Daemon to receive/send messages on all platforms

**Skill System Layer:**
- Purpose: Tool definitions, skill registry, MCP client, built-in tools (web search, file ops, exec, memory, sessions)
- Location: `@comis/skills/src/`
- Contains: Skill manifest parser, SkillRegistry (progressive disclosure), tool bridge (AgentTool → ToolDefinition), MCP client, built-in tools with sandbox detection
- Depends on: Core types, skill ports
- Used by: Agent executor to assemble available tools for each execution

**Scheduler Layer:**
- Purpose: Cron scheduling, heartbeat polling, task extraction, background job coordination
- Location: `@comis/scheduler/src/`
- Contains: Cron runner, heartbeat manager, task extraction from messages, system event queue, wake coalescer
- Depends on: Domain types
- Used by: Daemon for periodic operations and scheduled commands

**Gateway Layer:**
- Purpose: HTTP API server (mTLS, WebSocket, JSON-RPC 2.0), webhook endpoints, OpenAI compatibility, service discovery
- Location: `@comis/gateway/src/`
- Contains: Hono HTTP server, mTLS auth, token-based auth, WebSocket handler, JSON-RPC method router, rate limiting, mDNS advertiser
- Depends on: Core types, RPC adapters
- Used by: Daemon to expose daemon functionality over HTTP/WebSocket

**CLI Layer:**
- Purpose: Command-line interface for daemon management, configuration, diagnostics
- Location: `@comis/cli/src/`
- Contains: Commander.js command definitions, JSON-RPC client wrapper, credential wizard, doctor diagnostics, output formatters
- Depends on: Gateway client for RPC communication
- Used by: Users to manage daemon lifecycle and configuration

**Daemon Orchestrator:**
- Purpose: Startup, service wiring, lifecycle coordination, graceful shutdown
- Location: `@comis/daemon/src/`
- Contains: Main entry point (setupXxx() factories in sequence), RPC bridge (maps domain operations to HTTP methods), sub-agent runner, announcement dead-letter queue, context handlers
- Depends on: All layer implementations
- Used by: `node packages/daemon/dist/daemon.js` or pm2

**Web SPA:**
- Purpose: Browser-based dashboard for daemon monitoring and configuration
- Location: `@comis/web/src/`
- Contains: Lit web components, TailwindCSS styling, WebSocket client, daemon control UI
- Depends on: Gateway HTTP API
- Used by: Users via `http://localhost:3000` (or configured port)

## Data Flow

**Inbound Message Flow (Channel → Agent → Delivery):**

1. Platform adapter receives message (Telegram bot, Discord webhook, Slack event, etc.)
2. Adapter maps platform-specific message to normalized NormalizedMessage type in `@comis/core/src/domain/`
3. Adapter creates RequestContext via `runWithContext()` with tenant, user, session, traceId, channelType
4. Message routed to agent executor via MessageRouter.resolveAgent()
5. Agent executor runs prompt with PiExecutor → wraps @mariozechner/pi-coding-agent with safety controls:
   - Budget guard pre-checks cost
   - Circuit breaker checks provider health
   - Context engine assembles RAG + system prompt
   - Tool assembly bridges skill registry to agent tools
6. Agent streams response: tool calls, text, thinking (cached via Gemini cache manager)
7. Tools executed with injection rate limiting, secret guard, approval gate if configured
8. Final response delivered back to channel via `deliverToChannel()` with chunking, retry, typing indicators
9. Delivery tracked in ObservabilityStore (tokens, latency, provider, channel) for metrics
10. Events emitted on TypedEventBus (MessagingEvents, ChannelEvents, AgentEvents) for observability and plugins

**State Management:**

- **Session state**: Per-session JSONL files stored in `~/.comis/{dataDir}/sessions/` with write-lock serialization
- **Memory/embeddings**: SQLite database (`~/.comis/{dataDir}/comis.db`) with hybrid search (FTS5 text + vector index)
- **Credentials**: Encrypted in SQLite (SecretStorePort) using AES-256-GCM with master key from `SECRETS_MASTER_KEY` env var
- **Config**: Loaded once at startup from YAML files (paths in `COMIS_CONFIG_PATHS` env var), in-memory mutations via RPC, no file watching
- **Delivery queue**: SQLite-backed queue for failed deliveries, status tracking (pending, delivered, failed, retry)
- **Observability**: SQLite store for token usage, delivery metrics, diagnostics, pruned on schedule
- **Context/DAG**: SQLite schema for conversation trees (DAG mode), compaction, integrity checking

## Key Abstractions

**Port Interface Pattern:**

| Port | Purpose | Implementations |
|------|---------|-----------------|
| `ChannelPort` | Send/receive messages on platform | TelegramAdapter, DiscordAdapter, SlackAdapter, etc. |
| `MemoryPort` | Persistent message search & storage | SqliteMemoryAdapter |
| `SkillPort` | Tools available to agent | SkillRegistry (prompt-only + MCP) |
| `EmbeddingPort` | Vector embedding generation | External LLM providers (OpenAI, local llama.cpp) |
| `SecretStorePort` | Encrypted credential storage | SqliteSecretStore |
| `DeliveryQueuePort` | Failed message queue | SqliteDeliveryQueue |
| `DeliveryMirrorPort` | Delivery deduplication | SqliteDeliveryMirror |
| `OutputGuardPort` | Secret leak scanning | LLM-based output guard |
| `DeviceIdentityPort` | Cryptographic device identity | Ed25519-based key pair |
| `PluginPort` | Dynamic hook/tool registration | PluginRegistry |
| `VisionProvider` | Image + video analysis | Vision providers (Claude, GPT-4V) |
| `TranscriptionPort` | Audio → text (STT) | OpenAI, Groq, Deepgram |
| `TTSPort` | Text → audio | OpenAI, ElevenLabs, Edge TTS |
| `ImageGenerationPort` | Text → image | FAL, OpenAI DALL-E |
| `FileExtractionPort` | PDF/CSV text extraction | Local extraction (pdfjs-dist, csv-parse) |

**Request Context (AsyncLocalStorage):**
```typescript
interface RequestContext {
  tenantId: string;            // Multi-tenant identifier
  userId: string;              // User/bot identity
  sessionKey: string;          // Session identifier
  traceId: UUID;               // Distributed tracing
  startedAt: number;           // Unix timestamp
  trustLevel: "admin"|"user"|"guest"; // Auth level
  contentDelimiter?: string;   // External content wrapping
  channelType?: string;        // "telegram", "discord", etc.
  deliveryOrigin?: DeliveryOrigin; // Channel routing metadata
  resolvedModel?: string;      // "provider:modelId" for sub-agents
}
```
Flows through entire async chain via `runWithContext(ctx, () => ...)`. Available in any code via `getContext()` or `tryGetContext()`.

**AppContainer (Composition Root Output):**
```typescript
interface AppContainer {
  config: AppConfig;           // Loaded + validated config
  eventBus: TypedEventBus;     // Strongly-typed event system
  secretManager: SecretManager; // Credential access
  pluginRegistry: PluginRegistry; // Hook storage
  hookRunner: HookRunner;      // Hook execution engine
  shutdown: () => Promise<void>; // Graceful cleanup
}
```
Created by `bootstrap(options: BootstrapOptions)` in `@comis/core/src/bootstrap.ts`. Daemon startup wires all adapters into this container.

## Entry Points

**Daemon Startup:**
- Location: `packages/daemon/src/daemon.ts` — `main(overrides?: DaemonOverrides)`
- Triggers: Process startup, pm2 restart, systemd service start
- Responsibilities:
  1. Load environment variables (COMIS_CONFIG_PATHS, SECRETS_MASTER_KEY, etc.)
  2. Call `bootstrap(configPaths)` to create AppContainer
  3. Run `setupXxx()` factory sequence: logging, health, memory, agents, channels, gateway, monitors, etc.
  4. Bind HTTP server to port (default 3000)
  5. Register graceful shutdown handlers (SIGTERM, SIGINT)
  6. Return `DaemonInstance` with `shutdown()` method

**RPC Entry Points (HTTP):**
- Location: `packages/gateway/src/rpc/` — JSON-RPC 2.0 methods exposed via `createDynamicMethodRouter()`
- Typical paths: `POST /rpc`, `GET /ws` (WebSocket upgrade)
- Methods: `agent.execute`, `session.list`, `memory.search`, `config.write`, etc.
- Auth: Bearer token validation via `checkScope()`

**Channel Adapters (Inbound Messages):**
- Location: `packages/channels/src/{platform}/{platform}-adapter.ts`
- Telegram: Webhook path `/telegram/{botId}` or long-polling
- Discord: Webhook or WebSocket gateway
- Slack: Event subscription via `events_url` configuration
- Each adapter calls MessageRouter to route message to agent executor

**Scheduled Jobs:**
- Location: `packages/scheduler/src/` — cron, heartbeat, task extraction, wake events
- Triggers: Time-based (cron), wake-up events (new message), polling (heartbeat)
- Responsibilities: Run background jobs, extract scheduled commands, publish system events

## Error Handling

**Strategy:** No exceptions — all functions return `Result<T, E>` from `@comis/shared`. Type-safe error propagation via result chaining.

**Patterns:**

1. **Result constructors** (src/shared):
```typescript
ok(value: T): Result<T, E>
err(error: E): Result<T, E>
tryCatch(() => riskySync()): Result<T, Error>
fromPromise(promise): Result<T, Error>
```

2. **Error suppression** (intentional ignoring):
```typescript
suppressError(promise, "reason") // Required — empty .catch() is banned
```

3. **Custom error types** — Defined via Zod schemas in `@comis/core/src/config/`:
   - `ConfigError` — Invalid YAML, missing required fields
   - `ValidationError` — Zod schema mismatch
   - `PermissionError` — Approval gate denied
   - Domain-specific errors per feature (BudgetError, ContextWindowError, etc.)

4. **Error logging** — Always includes `hint` (actionable guidance) + `errorKind` (classification):
```typescript
logger.error({ err, hint: "Check config file syntax", errorKind: "ConfigError" }, "Config load failed");
```

5. **Provider failures** — Caught by circuit breaker (marks provider unhealthy), not propagated as exceptions

## Cross-Cutting Concerns

**Logging:**
- Framework: Pino structured JSON via `@comis/infra`
- Level strategy: ERROR/WARN for broken functionality, INFO for boundaries (request start/complete), DEBUG for internals
- Canonical fields: `agentId`, `traceId`, `durationMs`, `toolName`, `method`, `err`, `hint`, `errorKind`, `module`
- Automatic redaction: `apiKey`, `token`, `password`, `secret`, `botToken`, `privateKey`, `cookie`, `webhookSecret`

**Validation:**
- Framework: Zod schemas in `@comis/core/src/config/` for all configuration types
- Inferred types: `type XxxConfig = z.infer<typeof XxxConfigSchema>`
- Partial validation: `validatePartial()` for runtime config updates
- User input: Sanitized via `InputSecurityGuard` (prevents injection attacks)

**Authentication & Authorization:**
- Config-based approval gates for sensitive operations (tool execution, session termination)
- Trust levels: admin (full access), user (standard), guest (read-only)
- Credential access: SecretManager (never plaintext in process.env after startup)
- Token auth: Bearer tokens stored in tokenStore with scope-based checks

**Security:**
- Secret master key (AES-256-GCM): `SECRETS_MASTER_KEY` env var
- Safe path validation: `safePath()` prevents directory traversal in file tools
- Output guard: Scans LLM responses for secret leakage before delivery
- Sandbox detection: Exec tool detects bubblewrap/seccomp and uses safe restrictions
- Injection rate limiter: Rate-limits tool invocations per session to prevent spam

---

*Architecture analysis: 2026-04-17*
