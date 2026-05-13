# AGENTS.md — Comis Engineering Protocol

Default working protocol for coding agents. Scope: entire repository.

## 1) Architecture

Hexagonal (ports + adapters). Core defines port interfaces; adapters implement them; everything is wired via `AppContainer` in `packages/core/src/bootstrap.ts` (composition root). Extending Comis means implementing a port interface and wiring it in bootstrap — not cross-cutting rewrites.

Extension points in `packages/core/src/`:

- `ports/` — port interfaces (`*Port` suffix): `ChannelPort`, `ChannelPluginPort`, `MemoryPort`, `SkillPort`, `EmbeddingPort`, `MediaResolverPort`, `TranscriptionPort`, `TTSPort`, `ImageAnalysisPort`, `VisionPort`, `FileExtractionPort`, `OutputGuardPort`, `SecretStorePort`, `DeviceIdentityPort`, `CredentialMappingPort`, `PluginPort`, `DeliveryQueuePort`, `DeliveryMirrorPort`, hook types.
- `domain/` — Zod-validated domain types (`NormalizedMessage`, `MemoryEntry`, `AgentResponse`, `ExecutionGraph`, `SubagentResult`, `ApprovalRequest`, `CredentialMapping`, `SecretRef`, etc.). Define schema → infer type with `z.infer`.
- `security/` — security primitives: `safePath`, `validateUrl` (SSRF), `SecretManager`, `SecretsCrypto` (AES-256-GCM), `ScopedSecretManager`, `SecretRefResolver`, `ActionClassifier`, `AuditAggregator`, `InputSecurityGuard`, `validateInput`, `OutputGuard`, `MemoryWriteValidator`, `wrapExternalContent`, `sanitizeLogString`, `CanaryToken`, injection patterns + rate limiter.
- `config/` — Zod schemas, layered config (defaults → YAML files → env overrides). Paths via `COMIS_CONFIG_PATHS` (comma-separated). Runtime changes via `config.write` RPC (in-memory only).
- `event-bus/` — `TypedEventBus` with strongly-typed events across `AgentEvents`, `ChannelEvents`, `MessagingEvents`, `InfraEvents`. Logging supplements events, does not replace them.
- `hooks/` — `PluginRegistry` + `HookRunner` for plugin lifecycle.
- `context/` — AsyncLocalStorage request-scoped context via `runWithContext()` / `getContext()`.
- `bootstrap.ts` — composition root → `AppContainer`.

### Package Map

```
shared        Result type, utilities — zero runtime deps
core          domain, ports, event bus, security, config, hooks, bootstrap, ComisLogger structural contract, FileLockPort, ContextStorePort + SessionStorePort + row DTOs (CtxConversationRow..CtxExpansionGrantRow, SessionData, SessionListEntry, SessionDetailedEntry), OAuth helpers, master-key helpers
infra         Pino structured logging implementation (assignable to core's ComisLogger contract)
memory        SQLite-backed ContextStorePort + SessionStorePort impls (return types
              from core) + MemoryApi + FTS5 + vector search (MemoryPort, SecretStorePort,
              CredentialMappingPort, DeliveryQueuePort, DeliveryMirrorPort, OAuth-store,
              observability/embedding adapters). Row DTOs re-exported from core (single
              source of truth after Phase 31). Daemon consumes; agent + cli now consume
              port types from @comis/core.
gateway       Hono HTTP, JSON-RPC, WebSocket, mTLS
skills        manifest, prompt skills, MCP, built-in tools, media, STT/TTS/vision/image-gen integrations
scheduler     cron, heartbeat, task extraction; createFileLock(): FileLockPort factory backed by proper-lockfile
agent         orchestration: executor, planner, RAG, sessions, model, safety, response-filter (no longer references @comis/infra; OAuth helpers moved to @comis/core)
channels      platform adapters (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email, Echo) (no longer references @comis/infra)
orchestrator  inbound pipeline, execution coordination, channel-manager, command queue, routing, cross-session messaging (carved out from agent + channels in Phase 32)
cli           Commander.js, JSON-RPC client
daemon        orchestrator, observability, systemd (DeviceIdentityPort adapter)
comis         umbrella package — namespace re-exports
web           Lit + Vite + Tailwind standalone SPA
```

Dependency direction: inward to `core`. `daemon` depends on everything; `shared` depends on nothing. Use public exports (`packages/*/dist/index.js`) only — no cross-package internal imports.

## 2) Engineering Principles (Normative)

### 2.1 Result<T, E> everywhere
- All functions return `Result` from `@comis/shared` (`ok`, `err`, `tryCatch`, `fromPromise`). Internal/domain code returns `Result` — never `try/catch` for control flow. `throw` is allowed only at narrow boundary wrappers that immediately translate to `Result` (wrapping SDKs that throw), in CLI/web user-facing flows where the throw is caught at the entry handler, and in tests — always with a local rationale.
- Chain by early-return: `if (!result.ok) return result;`. No `Result.map`/`flatMap` helpers exist. Use `tryCatch`/`fromPromise` only at boundaries with throwing APIs (Node fs, `new URL()`, third-party SDKs).
- `err()` for unsupported/unsafe states — never silently succeed, never silently broaden permissions.
- ERROR/WARN logs require `hint` (operator-actionable next step) and `errorKind`.
- `errorKind` is the closed union from `LogFields.ErrorKind` in `@comis/core`: `config | network | auth | validation | timeout | resource | dependency | internal | platform`. Write literals as `"validation" as const`. Heuristic: bad input → `validation`; external API → `dependency`; chat platform → `platform`; bad config → `config`; assertion → `internal`.

### 2.2 Security (ESLint-enforced — violations fail CI; rules apply to `packages/*/src/**` only)
- No `path.join()` — use `safePath(base, ...segments)` from `@comis/core/security`. `base` must be absolute; every dynamic segment (including filenames) goes through `safePath`. Compose: `safePath(safePath(dataDir, agentId), file)`.
- No `process.env` — use `SecretManager`. To seed config from env, extend `buildGatewayEnvLayer()` plus the schema; never read env at the consumer. Exception: top-level entry points (CLI commands, daemon entrypoint, env-layer projection, test fault injectors) may read `process.env` with `eslint-disable-next-line` and a one-line rationale.
- No `eval()` or `Function()` constructor.
- No empty `.catch(() => {})` — use `suppressError(promise, reason, logger?)` from `@comis/shared`. `reason` is logged verbatim; include the handler name.
- No `module:` in log payloads — bind via `getLogger("…")`, scope further with `submodule:` at call sites.
- Never log credentials, tokens, message bodies, or env values — at any level. Pino redaction is a safety net, not a substitute. Stack traces at DEBUG only; message at INFO/WARN.
- `sanitizeLogString()` is for unstructured free-text only (error messages, captured stdout) — Pino structured fields are already redacted.
- `wrapExternalContent()` (or `wrapWebContent()` for web tools) on every external text flowing into a prompt: email, webhooks, web-fetch, transcriptions, untrusted user content.
- `validateUrl()` is a pure check — call it, then fetch with `result.value.url`. Never fetch without it.
- `validateMemoryWrite(content)` before every agent-visible memory store: `clean` → store; `warn` → store with `trustLevel: "external"`; `critical` → block (return `err`).
- Platform secrets (`container.platformSecretNames`) must never resolve through user-facing secret-ref tools.
- Test fixtures use neutral placeholders: `"test-key"`, `"example.com"`, `"user_a"`.

### 2.3 KISS / YAGNI / DRY
- No config keys, port methods, or feature flags without a concrete caller.
- No speculative abstractions. Duplicate small local logic when it preserves clarity.
- Extract shared helpers only after the rule of three; preserve package boundaries.

### 2.4 Composition root + factories
- Wire dependencies in `bootstrap.ts` — never import sibling packages directly.
- Prefer factory functions (`createXxx()`) returning typed interfaces over class instantiation.
- Inject logger via `Deps` interface — never import `@comis/infra` directly. No `console.log` outside `packages/cli`.

### 2.5 Determinism
- Unit tests co-located: `src/component.ts` + `src/component.test.ts`. No real network calls.
- Mock external modules at file top with `vi.mock(...)`. For partial internal types, use hand-built objects with `as unknown as T` — only the methods the SUT calls.
- Local `make<X>(overrides: Partial<X> = {}): X` factories at file top for `Deps`, config, domain objects. Cross-package test helpers live in `test/support/`.
- Integration tests in `test/integration/` import from `dist/` — `pnpm build` first. They run sequentially (`pool: "forks"`, `maxConcurrency: 1`) because daemon-based tests bind real ports.

### 2.6 Request context propagation
- `RequestContext` propagates via AsyncLocalStorage. `runWithContext(ctx, fn)` once per inbound request at channel/gateway/scheduler entry — never inside business logic.
- `getContext()` (throws outside scope) inside request paths; `tryGetContext()` (returns `undefined`) for code that may run outside (startup, timers).
- `traceId` and `contentDelimiter` ride on the context — `traceId` auto-injects onto log lines via the Pino mixin; `wrapExternalContent()` reads `contentDelimiter`. Don't thread either through args.

### 2.7 Logging & Observability

| Level | Use For |
|-------|---------|
| ERROR | Broken functionality. Required: `hint`, `errorKind`. |
| WARN  | Degraded but functional. Required: `hint`, `errorKind`. |
| INFO  | Boundary events (request arrived, execution complete) — 2–5/req. Include `durationMs` on operation completion. |
| DEBUG | Internal steps, individual tool/LLM calls, intermediate state. |

- Object-first: `logger.info({ agentId, durationMs }, "Execution complete")`. Never string-interpolate in the message; never pass JSON-stringified objects.
- Once-per-request → INFO. N-per-request → DEBUG (aggregate count in the INFO summary).
- Pipeline stages tag log lines with `step: "<stage-name>"` (canonical examples in `packages/channels/src/shared/`) — per-step analogue of `submodule:`.
- Events vs logs: emit on `eventBus` for state transitions, lifecycle outcomes, observability snapshots, and safety/health signals (e.g., `tool:executed`, `execution:aborted`, `provider:degraded`). Logs describe; events announce. Logging supplements events — it does not replace them.

**Contract vs implementation.** `ComisLogger`, `LogFields`, and `ErrorKind` are **structural type contracts** that live in `@comis/core/src/logging/log-fields.ts`. The Pino-backed runtime implementation lives in `@comis/infra` and is assignable to the contract (`expectTypeOf<PinoComisLogger>().toExtend<ComisLogger>()` proves this in `packages/infra/src/logging/__tests__/logger-contract.test.ts`). Type-only consumers (agent, channels, gateway, skills, scheduler) import the contract from `@comis/core`. Only the daemon (composition root) and infra itself import the Pino runtime. Pino's auto-redaction (`apiKey`, `token`, `password`, etc., 3 levels deep) is a runtime feature of the Pino implementation; the structural contract does not (and cannot) enforce redaction.

## 3) Naming Contract

| Kind | Convention | Example |
|------|------------|---------|
| Functions, variables | `camelCase` | `createCircuitBreaker`, `sessionKey` |
| Types, interfaces, classes | `PascalCase` | `NormalizedMessage`, `ChannelPort` |
| Port interfaces | `*Port` suffix | `ChannelPort`, `MemoryPort` |
| Adapter implementations | `*Adapter` suffix | `SqliteMemoryAdapter`, `TelegramAdapter` |
| Factory functions | `createXxx()` returning typed interface | `createCircuitBreaker(): CircuitBreaker` |
| Constants | `SCREAMING_SNAKE_CASE` (true constants), `camelCase` (config defaults) | |
| Files | `kebab-case.ts` | `message-mapper.ts` |
| Tests | Co-located `*.test.ts`, named by behavior | |

## 4) Risk Tiers

- **Low**: docs, comments, test additions, minor formatting.
- **Medium**: most `packages/*/src/` behavior changes without boundary/security impact.
- **High**: `core/src/security/*`, `core/src/ports/*`, `gateway/*`, `daemon/*`, `core/src/config/`, `core/src/domain/`, `core/src/bootstrap.ts`, `core/src/security/injection-patterns.ts`.

When uncertain, classify higher.

## 5) Workflow

1. **Read before write** — inspect existing port interfaces, adapter patterns, and adjacent tests before editing.
2. **Define scope** — one concern per change; no mixed feature+refactor+infra patches.
3. **Test-first** — write the failing test before the code (regression test for bugs, contract test for new behavior). Co-located unit test by default; integration test only for daemon-level flows. Red → green → refactor.
4. **Implement minimal patch** — make the test pass. Apply KISS/YAGNI/rule-of-three explicitly.
5. **Validate** — `pnpm build && pnpm test && pnpm lint:security` must all pass.
6. **Document impact** — update comments/docs for behavior changes, risk, side effects.

## 6) Change Playbooks

### 6.1 Add a Channel Adapter
Create `packages/channels/src/<platform>/`:
- `*-adapter.ts` (implements `ChannelPort`), `*-plugin.ts` (`ChannelPluginPort`)
- `message-mapper.ts` (→ `NormalizedMessage`), `media-handler.ts`, `credential-validator.ts`
- `*-resolver.ts` (`MediaResolverPort`), `voice-sender.ts`
- Platform-specific extras as needed: `*-actions.ts`, `format-*.ts` / `rich-renderer.ts`, utilities (e.g., `jid-utils.ts`).

Register in package exports. Test credential validation, message mapping, and adapter lifecycle.

### 6.2 Add a Port
Define interface in `core/src/ports/` → export from core index → add to `AppContainer` in `bootstrap.ts` → implement adapter in relevant package → wire in composition root → test contract + adapter.

`bootstrap()` returns `Result<AppContainer, ConfigError>` (never throws); register cleanup in the existing `shutdown:` closure — single shutdown path. SQLite-owning adapters use `openSqliteDatabase()` from `@comis/memory` (handles `0o700` dir, WAL pragmas, `0o600` chmod); adapters receiving a pre-opened `db` skip it.

### 6.3 Add a Domain Type
`z.strictObject({...})` schema in `core/src/domain/` (domain layer is strict — loosening is a compat break) → infer type with `z.infer<typeof Schema>` → export schema, type, and a paired `parseX(raw): Result<T, z.ZodError>` helper wrapping `safeParse()`. Call sites use `parseX()` — never `.parse()` (throws) or raw `.safeParse()`.

### 6.4 Add a Config Schema
`schema-*.ts` in `core/src/config/` with `.default()` on every field → wire into parent (typically `AppConfigSchema`) → export from config index. Consumers see a fully-defaulted `AppConfig` — never `config.x ?? fallback` at call sites; fallbacks belong in `.default()`. Layer precedence: schema defaults < env-layer projection < YAML (later YAML wins). Keys in `immutable-keys.ts` are rejected by `config.write`. New top-level sections register a single entry in the `SECTION_REGISTRY` in `core/src/config/section-registry.ts` (the consolidated source of truth post-Phase-30 CONFIG-DELIV-01/-02). Per-view derivations (`SECTION_SCHEMAS` in `schema-serializer.ts`, the metadata map in `field-metadata.ts`, the managed-section redirect map in `managed-sections.ts`) are derived from the registry — no per-file edit needed beyond the registry entry.

### 6.5 Add a Skill
Skills are Markdown files with manifest frontmatter. Add to `packages/skills/`, validate frontmatter against manifest Zod schema, test loading + manifest validation.

### 6.6 Security / Gateway / Daemon
Include threat/risk notes in commit message. Add boundary + failure-mode tests. Changes in `core/src/security/` require reviewing all downstream consumers. `injection-patterns.ts` changes require both detection accuracy and false-positive tests.

### 6.7 Add or Change an Agent Tool
Register metadata via `registerToolMetadata(name, meta)` in `packages/skills/src/bridge/tool-metadata-registry.ts`. The `ComisToolMetadata` shape (`packages/core/src/tool-metadata.ts`) covers: `maxResultSizeChars` (result cap), `isReadOnly` / `isConcurrencySafe` (parallel-execution safety), `searchHint` (BM25 deferred-discovery), `validActions` / `validKeys` / `requiredByAction` (action-discriminated tool gating — shape mirrors `ManagedSectionRedirect.schemaFragment` in `config/managed-sections.ts`), `validateInput` (pre-flight validator), `outputSchema` (structured output), `coDiscoverWith` (paired discovery). When the tool manages a config section, add the redirect to `config/managed-sections.ts` so immutable-path rejections include a parameter-correct example.

## 7) Validation

Required before any commit:
```bash
pnpm build && pnpm test && pnpm lint:security
```

By change type:
- Security/gateway/daemon: include at least one boundary/failure-mode test.
- Port additions: test contract + adapter implementation.
- Channel adapters: test credential validation, message mapping, lifecycle.
- Config schemas: test defaults, valid inputs, validation errors.
- Injection patterns: test detection accuracy and false positives.
- Integration tests: `pnpm build` first; run via `pnpm test:integration` (or `:mock` / `test:orchestrate`).

If full validation is impractical, document what was run and what was skipped.

## 8) Anti-Patterns (Do Not)

- Use `path.join()`, `process.env`, `eval()` / `Function()`, or empty `.catch(() => {})`.
- Throw exceptions — return `Result` with `err()`.
- Import `@comis/infra` directly — inject logger via `Deps`.
- Use `console.log` outside `packages/cli`.
- Import cross-package internals — use public exports only.
- Modify unrelated packages "while here" — one concern per change.
- Skip `pnpm build` before integration tests.
- Add speculative config keys or feature flags "just in case".
- Use string interpolation in structured log calls — Pino object-first only.
- Include personal identity or sensitive data in tests, examples, docs, or commits.

## 9) Conventions

- **Commits**: Conventional Commits — `feat(agent): description`, `fix(channels): description`.
- **Branches**: `feature/<desc>`, `fix/<desc>`, `docs/<desc>` from `main`.
- **Modules**: ES modules only (`"type": "module"`).
- **TypeScript**: Strict mode, ES2023 target, NodeNext resolution, `composite: true` with project references, `isolatedModules: true`.
- **Project references**: list every cross-package import in the importing package's `tsconfig.json` `references` array — missing entries break `tsc --build` ordering silently.
- **Imports**: `.js` suffix on relative imports in `.ts` source (NodeNext requires it). Bare-package imports need no suffix; never `@comis/core/dist/...` subpaths. Named imports preferred; `import type` for types.
- **Build output**: `packages/*/dist/` and `*.tsbuildinfo` (gitignored).
- **Package exports**: `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`.

## 10) Companion Agent Files

- `AGENTS.md` is the authoritative protocol for all coding agents in this repository.
- `CLAUDE.md` may contain Claude-specific operational shortcuts, daemon notes, or release notes, but it must not weaken or override this file.
- If `CLAUDE.md` and `AGENTS.md` conflict, follow `AGENTS.md` and update the stale companion file.
- **Self-correction loop**: when the user corrects an approach in a way that would apply to future sessions, propose the `AGENTS.md` or `CLAUDE.md` edit before moving on.
