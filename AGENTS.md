# AGENTS.md — Comis Agent Engineering Protocol

This file defines the default working protocol for coding agents in this repository.
Scope: entire repository.

## 1) Project Snapshot (Read First)

Comis is a security-first AI agent assistant platform connecting AI agents to
real-time chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email).

- TypeScript monorepo, 13 packages, ES modules only
- Hexagonal architecture (ports and adapters)
- Node.js >= 22, Linux-only target
- All functions return `Result<T, E>` — no thrown exceptions
- Security rules enforced at lint time via ESLint

Core architecture is **port-driven** and modular. All extension work is done by
implementing port interfaces and wiring them through the composition root.

Key extension points:

- `packages/core/src/ports/` — all port interfaces:
  - **Channel**: `ChannelPort`, `ChannelPluginPort`
  - **Data**: `MemoryPort`, `SkillPort`, `EmbeddingPort`, `CredentialMappingPort`
  - **Media**: `MediaResolverPort`, `TranscriptionPort`, `TTSPort`, `ImageAnalysisPort`, `VisionProvider`, `FileExtractionPort`
  - **Security**: `OutputGuardPort`, `SecretStorePort`, `DeviceIdentityPort`
  - **Plugin**: `PluginPort`
  - **Hooks**: `HookTypes` (lifecycle hook definitions)
- `packages/core/src/domain/` — Zod-validated domain types organized by concern:
  - **Messages**: `NormalizedMessage`, `Attachment`, `VoiceMeta`, `RichButton`, `RichCard`, `RichEffect`, `DeliveryOrigin`
  - **Memory**: `MemoryEntry`, `TrustLevel`, `MemorySource`
  - **Agent**: `AgentResponse`, `ToolCall`, `TokenUsage`, `SessionKey`
  - **Execution**: `ExecutionGraph`, `GraphNode`, `NodeStatus`, `GraphStatus`, `NodeTypeDriver`
  - **Subagents**: `SubagentResult`, `SubagentEndReason`, `SpawnPacket`, `CondensedResult`, `SubagentContextConfig`
  - **Security**: `ApprovalRequest`, `ApprovalResolution`, `CredentialMapping`, `SecretRef`
  - **Interaction**: `PollInput`, `NormalizedPollResult`
  - **Provider**: `ModelCompatConfig`, `ProviderCapabilities`
- `packages/core/src/security/` — 31 security modules (22 main + 9 in patterns/):
  - **Path/Network**: `safePath`, `validateUrl` (SSRF guard)
  - **Secrets**: `SecretManager`, `SecretsCrypto`, `ScopedSecretManager`, `SecretRefResolver`, token generation
  - **Classification**: `ActionClassifier`, `AuditEvent`, `AuditAggregator`
  - **Input/Output**: `InputGuard`, `InputValidator`, `OutputGuard`, `MemoryWriteValidator`
  - **Detection**: 60+ injection patterns, `InjectionRateLimiter`, `CanaryToken`
  - **Sanitization**: `sanitizeLogString`, `redactConfigSecrets`, `SecretsAudit`
  - **Content**: `wrapExternalContent`, `detectSuspiciousPatterns`
- `packages/core/src/bootstrap.ts` — composition root wiring `AppContainer`
- `packages/core/src/event-bus/` — `TypedEventBus` for inter-module communication
- `packages/core/src/hooks/` — `PluginRegistry` + `HookRunner` for plugin lifecycle
- `packages/core/src/config/` — 100+ Zod schemas across 88 files (38 schema definition files), layered config system

Current scale: **~1195 source files, ~953 test files, 13 packages**.

Build and test:

```bash
pnpm install                    # install deps (native: better-sqlite3, sharp)
pnpm build                      # TypeScript compilation (all packages)
pnpm test                       # all unit tests (Vitest workspace)
pnpm lint:security              # security ESLint rules
```

## 2) Deep Architecture Observations (Why This Protocol Exists)

These codebase realities should drive every design decision:

1. **Hexagonal architecture (ports + adapters) is the stability backbone**
   - Extension points are explicit port interfaces in `packages/core/src/ports/`.
   - Adapters implement ports in their respective packages and are wired via `AppContainer` in `core/src/bootstrap.ts`.
   - Most features should be added via port implementations + composition root wiring, not cross-cutting rewrites.

2. **Result<T, E> everywhere — no thrown exceptions**
   - All functions return `Result` from `@comis/shared`. Use `ok()`, `err()`, `tryCatch()`, `fromPromise()`.
   - Never use `throw`. Never use bare `try/catch` for control flow.
   - Error handling is explicit, typed, and composable.

3. **Security rules are ESLint-enforced — violations fail CI**
   - No `path.join()` — use `safePath()` from `@comis/core/security` (prevents directory traversal).
   - No `process.env` — use `SecretManager` from `@comis/core/security`.
   - No `eval()` or `Function()` constructor — banned entirely.
   - No empty `.catch(() => {})` — use `suppressError()` from `@comis/shared`.

4. **TypedEventBus is the inter-module communication layer**
   - Type-safe event emitter in `core/src/event-bus/` using `EventMap` interface.
   - Logging supplements events, does not replace them.
   - Subscribe to events for cross-module reactions; do not import other packages directly.

5. **Composition root wires everything — AppContainer is the DI mechanism**
   - `core/src/bootstrap.ts` creates SecretManager, loads config, builds event bus, plugin registry, and hook runner.
   - Factory functions (`createXxx()`) return typed interfaces — prefer these over class instantiation.
   - `AsyncLocalStorage` context in `core/src/context/` provides request-scoped data via `runWithContext()` / `getContext()`.

6. **Deep security layering — defense in depth**
   - Input validation chain: `InputGuard` → `InputValidator` → injection pattern detection → rate limiting.
   - Output protection: `OutputGuard` with canary token leak detection.
   - Memory safety: `MemoryWriteValidator` prevents injection via stored content.
   - Secret lifecycle: `SecretsCrypto` (AES-256-GCM) → `ScopedSecretManager` → `SecretRef` resolution.
   - Content safety: `wrapExternalContent()` for all external data, `sanitizeLogString()` for logs.
   - Network safety: SSRF guard with blocked IP ranges and cloud metadata protection.

## 3) Engineering Principles (Normative)

These principles are mandatory. They are implementation constraints, not suggestions.

### 3.1 KISS

Required:
- Prefer straightforward control flow over meta-programming.
- Prefer explicit typed interfaces over hidden dynamic behavior.
- Keep error paths obvious and localized — `Result` makes this natural.

### 3.2 YAGNI

Required:
- Do not add config keys, port methods, or feature flags without a concrete caller.
- Do not introduce speculative abstractions.
- Keep unsupported paths explicit (`err("not supported")`) rather than silent no-ops.

### 3.3 DRY + Rule of Three

Required:
- Duplicate small local logic when it preserves clarity.
- Extract shared helpers only after repeated, stable patterns (rule-of-three).
- When extracting, preserve package boundaries and avoid hidden coupling.

### 3.4 Fail Fast (Result Pattern)

Required:
- Return `err()` for unsupported or unsafe states — never silently succeed.
- Never silently broaden permissions or capabilities.
- Chain Results with `tryCatch()` and `fromPromise()` for async operations.
- Every `ERROR`/`WARN` log must include `hint` (what to do) and `errorKind` (classification).

### 3.5 Secure by Default (ESLint Enforcement)

Required:
- Security rules are enforced at lint time — no exceptions without documented justification.
- Deny-by-default for access and exposure boundaries.
- Never log credentials, tokens, API keys, message bodies, or env var values — at ANY level including DEBUG.
- Use `sanitizeLogString()` from `@comis/core/security` for external error messages.
- Pino redaction (45 paths) is a safety net, not a substitute for not logging secrets.

### 3.6 Determinism (Vitest, Co-located Tests)

Required:
- Unit tests co-located with source: `src/component.ts` alongside `src/component.test.ts`.
- Tests must be reproducible and deterministic — no real network calls in unit tests.
- Integration tests live in `test/integration/` and require `pnpm build` first (they import from `dist/`).
- Integration tests run sequentially (`maxConcurrency: 1`) because daemon-based tests bind real ports.

## 4) Repository Map (High-Level)

```
packages/
  shared/        Result type, utilities — zero runtime deps
  core/          domain types, ports, event bus, security, config, plugin system
    src/ports/       21 port interface files (ChannelPort, MemoryPort, SkillPort, etc.)
    src/domain/      16 domain modules (~17 Zod schemas + inferred types)
    src/security/    31 security modules (path, secrets, input/output guards, injection detection, pattern library)
    src/config/      100+ Zod schemas across 88 files (38 schema definitions), layered config system
    src/event-bus/   TypedEventBus with EventMap interface
    src/context/     AsyncLocalStorage request-scoped context
    src/hooks/       PluginRegistry, HookRunner
    src/bootstrap.ts composition root → AppContainer
  infra/         Pino structured logging
  memory/        SQLite + FTS5 + vector search (MemoryPort, SecretStorePort, CredentialMappingPort adapters)
  gateway/       Hono HTTP, JSON-RPC, WebSocket, mTLS
  skills/        manifest, prompt skills, MCP, built-in tools, media, STT, TTS, vision
    src/audit/       tool execution audit logging
    src/bridge/      MCP client ↔ tool bridge
    src/browser/     browser automation tools
    src/builtin/     40+ built-in tool files (exec, file ops, web-fetch, web-search, sandbox, etc.)
    src/integrations/ STT (OpenAI, Groq, Deepgram), TTS (OpenAI, ElevenLabs, Edge), Vision (Gemini), Image Gen (FAL, OpenAI)
    src/manifest/    skill manifest schemas and loading
    src/media/       media processing (audio conversion, MIME, SSRF safety, temp storage)
    src/policy/      tool execution policies and audit
    src/prompt/      prompt-only skill definitions
    src/registry/    SkillRegistry implementation (SkillPort adapter)
  scheduler/     cron, heartbeat, task extraction
  agent/         22 subsystems:
    src/background/  background worker management
    src/bootstrap/   agent bootstrap wiring
    src/bridge/      external tool bridges
    src/budget/      cost tracking, budget guard
    src/commands/    command routing
    src/context-engine/ RAG context injection
    src/envelope/    message wrapping
    src/executor/    PiExecutor, model retry, MCP deferral, overflow recovery
    src/greeting/    session greeting logic
    src/identity/    agent identity/persona
    src/memory/      agent memory subsystem
    src/model/       LLM model selection + auth storage
    src/planner/     agent planning logic
    src/provider/    provider capabilities, model compat, response sanitization, tool schema normalization
    src/queue/       message queueing
    src/rag/         RAG retriever, hybrid memory injection
    src/response-filter/ streaming thinking tag filter, code-region detection, reasoning tags
    src/routing/     message routing
    src/safety/      circuit breaker, schema pruning, provider health monitor
    src/session/     session management
    src/spawn/       agent spawning/lifecycle
    src/workspace/   workspace state management
  channels/      platform adapters (10 channels: Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email, Echo)
  cli/           Commander.js, JSON-RPC client
  daemon/        orchestrator, observability, systemd (DeviceIdentityPort adapter)
  comis/         umbrella package — namespace re-exports
  web/           Lit + Vite + Tailwind standalone SPA

test/
  integration/   E2E tests (daemon harness, log verification, WS helpers)
  support/       shared test utilities (daemon-harness, log-capture, etc.)
  config/        per-suite YAML configs
```

### Package Dependency Direction

```
shared (zero deps)
└── core (domain, ports, security, config, events)
    ├── infra (logging)
    ├── memory (SQLite adapter)
    ├── gateway (HTTP/RPC)
    ├── skills (tools, media, MCP)
    ├── scheduler (cron, heartbeat)
    ├── agent → memory, scheduler
    ├── channels → agent, infra
    ├── cli → agent
    └── daemon → ALL packages
```

### Port–Adapter Mapping

| Port | Adapters | Package |
|------|----------|---------|
| `ChannelPort` | Telegram, Discord, Slack, WhatsApp, Signal, IRC, LINE, Email, Echo, iMessage | `channels` |
| `ChannelPluginPort` | Per-platform plugin wrappers | `channels` |
| `MemoryPort` | SqliteMemoryAdapter | `memory` |
| `SkillPort` | SkillRegistry (prompt-only), MCP client | `skills` |
| `EmbeddingPort` | External LLM providers | `skills` |
| `MediaResolverPort` | 7 per-platform resolvers, CompositeResolver | `channels`, `skills` |
| `TranscriptionPort` | OpenAI, Groq, Deepgram STT adapters | `skills` |
| `TTSPort` | OpenAI, ElevenLabs, Edge TTS adapters | `skills` |
| `ImageAnalysisPort` | Gemini vision adapter | `skills` |
| `FileExtractionPort` | Document text extraction (PDF, CSV, plain text) | `skills` |
| `OutputGuardPort` | Built-in (secret/canary leak detection) | `core` |
| `SecretStorePort` | SqliteSecretStore (AES-256-GCM encryption) | `memory` |
| `DeviceIdentityPort` | Ed25519 keypair manager | `daemon` |
| `CredentialMappingPort` | CredentialMappingStore (CRUD bindings) | `memory` |
| `PluginPort` | Plugin registration and hooks | `core` |
| `DeliveryQueuePort` | SQLite-backed message delivery queue | `memory` |
| `DeliveryMirrorPort` | Delivery deduplication and mirroring | `memory` |
| `ImageGenerationPort` | FAL, OpenAI image generation | `skills` |
| `VisionProvider` | Multi-capability vision (image + video analysis) | `skills` |

## 5) Risk Tiers by Path (Review Depth Contract)

- **Low risk**: docs, comments, test additions, minor formatting
- **Medium risk**: most `packages/*/src/` behavior changes without boundary/security impact
- **High risk**: `core/src/security/*`, `core/src/ports/*`, `gateway/*`, `daemon/*`, config schemas (`core/src/config/`), domain types (`core/src/domain/`), bootstrap wiring (`core/src/bootstrap.ts`), injection patterns (`core/src/security/injection-patterns.ts`)

When uncertain, classify as higher risk.

## 6) Agent Workflow (Required)

1. **Read before write** — inspect existing port interfaces, adapter patterns, and adjacent tests before editing.
2. **Define scope boundary** — one concern per change; avoid mixed feature+refactor+infra patches.
3. **Implement minimal patch** — apply KISS/YAGNI/DRY rule-of-three explicitly.
4. **Validate** — `pnpm build && pnpm test && pnpm lint:security` must all pass.
5. **Document impact** — update comments/docs for behavior changes, risk, and side effects.

### 6.1 Code Naming Contract (Required)

Apply these naming rules consistently:

- Functions and variables: `camelCase` (e.g., `createCircuitBreaker`, `sessionKey`).
- Types, interfaces, classes: `PascalCase` (e.g., `NormalizedMessage`, `ChannelPort`).
- Factory functions: `createXxx()` returning typed interfaces (e.g., `createCircuitBreaker()` returns `CircuitBreaker`).
- Port interfaces: `*Port` suffix (e.g., `ChannelPort`, `MemoryPort`, `SkillPort`).
- Adapter implementations: `*Adapter` suffix (e.g., `SqliteMemoryAdapter`, `TelegramAdapter`).
- Constants: `SCREAMING_SNAKE_CASE` for true constants, `camelCase` for config defaults.
- Files: `kebab-case.ts` (e.g., `message-mapper.ts`, `credential-validator.ts`).
- Tests: named by behavior, co-located with source as `*.test.ts`.

### 6.2 Architecture Boundary Contract (Required)

- Extend capabilities by adding port implementations + composition root wiring first.
- Keep dependency direction inward to core: concrete implementations depend on ports/domain/config, not on each other.
- Avoid cross-package internal imports — use public exports (`packages/*/dist/index.js`) only.
- Keep module responsibilities single-purpose: orchestration in `agent/`, transport in `channels/`, model I/O in `skills/`, policy in `core/security/`, scheduling in `scheduler/`.
- Inject logger via `Deps` interface — never import `@comis/infra` directly.
- No `console.log` outside `packages/cli`.

## 7) Change Playbooks

### 7.1 Adding a Channel Adapter

- Create directory `packages/channels/src/<platform>/` with the standard file set:
  - `*-adapter.ts` — implements `ChannelPort`
  - `*-plugin.ts` — bootstrap/wiring for the platform (implements `ChannelPluginPort`)
  - `message-mapper.ts` — normalizes platform messages to `NormalizedMessage`
  - `media-handler.ts` — platform-specific attachment handling
  - `credential-validator.ts` — validates platform credentials
  - `*-resolver.ts` — per-platform media download (implements `MediaResolverPort`)
  - `voice-sender.ts` — per-platform voice message sending
- Some platforms add extras: `*-actions.ts` (business logic), `format-*.ts` / `rich-renderer.ts` (message formatting), platform-specific utilities (e.g., `jid-utils.ts` for WhatsApp, `emoji-fallback.ts` for Telegram).
- Register in the channels package exports.
- Add tests for credential validation, message mapping, and adapter lifecycle.

### 7.2 Adding a Port

- Define interface in `packages/core/src/ports/` following existing patterns.
- Export from core package index.
- Add to `AppContainer` type in `core/src/bootstrap.ts`.
- Implement adapter in the relevant package.
- Wire in composition root.
- Add tests for the port contract and adapter implementation.

### 7.3 Adding a Skill

- Skills are Markdown instruction files (prompt skills) with manifest frontmatter.
- Add to `packages/skills/` following existing manifest schema.
- Validate frontmatter against skill manifest Zod schema.
- Add tests for skill loading and manifest validation.

### 7.4 Adding a Domain Type

- Define Zod schema in `packages/core/src/domain/`.
- Infer TypeScript type from schema: `type MyType = z.infer<typeof MyTypeSchema>`.
- Export both schema and type from core package index.
- Add tests for schema validation (valid and invalid inputs).

### 7.5 Security / Gateway / Daemon Changes

- Include threat/risk notes in the commit message.
- Add boundary tests and failure-mode tests.
- Keep observability useful but non-sensitive — no secrets in logs or error messages.
- Use `sanitizeLogString()` for any external error content.
- Security changes in `core/src/security/` require review of all downstream consumers.
- Injection pattern changes (`injection-patterns.ts`) require testing against both detection and false-positive scenarios.

### 7.6 Adding a Config Schema

- Create `schema-*.ts` file in `packages/core/src/config/` following naming convention.
- Define Zod schema with sensible defaults via `.default()`.
- Wire into parent schema (typically `AppConfigSchema` or a subsection schema).
- Export from config index.
- Add tests for default values, valid inputs, and invalid inputs.

## 8) Validation Matrix

Required before any code commit:

```bash
pnpm build              # TypeScript compilation (all packages)
pnpm test               # all unit tests must pass (Vitest workspace)
pnpm lint:security      # security ESLint rules must pass
```

Additional expectations by change type:

- **Docs/comments only**: no build required, but verify no broken code references.
- **Security/gateway/daemon**: include at least one boundary/failure-mode test.
- **Port additions**: test port contract + adapter implementation.
- **Channel adapters**: test credential validation, message mapping, adapter lifecycle.
- **Config schemas**: test defaults, valid inputs, and validation error cases.
- **Injection patterns**: test detection accuracy and false-positive rates.
- **Integration tests**: require `pnpm build` first — they import from `dist/`.

```bash
pnpm test:integration           # all integration tests
pnpm test:integration:mock      # integration tests with mock providers
pnpm test:orchestrate           # full E2E + log validation + JSON report
```

If full validation is impractical, document what was run and what was skipped.

### 8.1 Git Hooks

Commit conventions: Conventional Commits format — `feat(agent): description`, `fix(channels): description`.

Branch conventions: `feature/<desc>`, `fix/<desc>`, `docs/<desc>` from `main`.

## 9) Privacy and Sensitive Data (Required)

- Never commit real API keys, tokens, credentials, personal data, or private URLs.
- Use `SecretManager` from `@comis/core/security` — never access `process.env` directly.
- Use `sanitizeLogString()` from `@comis/core/security` for external error messages.
- Pino redaction (45 paths) is a safety net, not a substitute for not logging secrets.
- Never log credentials, tokens, API keys, message bodies, or env var values — at ANY level including DEBUG.
- Stack traces at DEBUG only; error message at INFO/WARN.
- Test fixtures use neutral placeholders: `"test-key"`, `"example.com"`, `"user_a"`.
- Review `git diff --cached` before push for accidental sensitive strings.

## 10) Anti-Patterns (Do Not)

- Do not use `path.join()` — use `safePath()` from `@comis/core/security` (directory traversal prevention).
- Do not access `process.env` — use `SecretManager` from `@comis/core/security`.
- Do not use `eval()` or `Function()` constructor — banned entirely.
- Do not use empty `.catch(() => {})` — use `suppressError()` from `@comis/shared`.
- Do not throw exceptions — return `Result` with `err()`.
- Do not import `@comis/infra` directly — inject logger via `Deps` interface.
- Do not use `console.log` outside `packages/cli`.
- Do not import cross-package internals — use public exports only.
- Do not modify unrelated packages "while here" — one concern per change.
- Do not skip `pnpm build` before running integration tests — they import from `dist/`.
- Do not add speculative config keys or feature flags "just in case".
- Do not use string interpolation in structured log calls — use Pino object-first syntax.
- Do not include personal identity or sensitive information in tests, examples, docs, or commits.

## 11) Handoff Template (Agent to Agent / Maintainer)

When handing off work, include:

1. What changed
2. What did not change
3. Validation run and results (`pnpm build`, `pnpm test`, `pnpm lint:security`)
4. Remaining risks / unknowns
5. Next recommended action

## 12) Vibe Coding Guardrails

When working in fast iterative mode:

- Keep each iteration reversible (small commits, clear rollback).
- Validate assumptions with code search before implementing.
- Prefer the `Result` pattern over try/catch for all new code.
- Do not "ship and hope" on security-sensitive paths.
- Check existing port implementations before creating new ones.
- Check CLAUDE.md logging rules before adding log statements.
- If uncertain about architecture, read the port interface definition before implementing.
- If uncertain about conventions, search `src/` for existing usage patterns before guessing.
