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
core          domain, ports, event bus, security, config, hooks, bootstrap
infra         Pino structured logging
memory        SQLite + FTS5 + vector search (MemoryPort, SecretStorePort, CredentialMappingPort,
              DeliveryQueuePort, DeliveryMirrorPort adapters)
gateway       Hono HTTP, JSON-RPC, WebSocket, mTLS
skills        manifest, prompt skills, MCP, built-in tools, media, STT/TTS/vision/image-gen integrations
scheduler     cron, heartbeat, task extraction
agent         orchestration: executor, planner, RAG, sessions, model, safety, response-filter
channels      platform adapters (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email, Echo)
cli           Commander.js, JSON-RPC client
daemon        orchestrator, observability, systemd (DeviceIdentityPort adapter)
comis         umbrella package — namespace re-exports
web           Lit + Vite + Tailwind standalone SPA
```

Dependency direction: inward to `core`. `daemon` depends on everything; `shared` depends on nothing. Use public exports (`packages/*/dist/index.js`) only — no cross-package internal imports.

## 2) Engineering Principles (Normative)

### 2.1 Result<T, E> everywhere
- All functions return `Result` from `@comis/shared`. Use `ok()`, `err()`, `tryCatch()`, `fromPromise()`.
- Never `throw`. Never use bare `try/catch` for control flow.
- Return `err()` for unsupported/unsafe states — never silently succeed, never silently broaden permissions.
- Every ERROR/WARN log requires `hint` (what to do) and `errorKind` (classification).

### 2.2 Security (ESLint-enforced — violations fail CI)
- No `path.join()` — use `safePath()` from `@comis/core/security` (directory traversal prevention).
- No `process.env` — use `SecretManager` from `@comis/core/security`.
- No `eval()` or `Function()` constructor.
- No empty `.catch(() => {})` — use `suppressError()` from `@comis/shared`.
- Never log credentials, tokens, API keys, message bodies, or env values — at any level including DEBUG. Pino redaction is a safety net, not a substitute.
- Use `sanitizeLogString()` for external error messages.
- Use `wrapExternalContent()` for external data flowing into prompts.
- Stack traces at DEBUG only; error message at INFO/WARN.
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
- Unit tests co-located: `src/component.ts` + `src/component.test.ts`.
- No real network calls in unit tests.
- Integration tests in `test/integration/` import from `dist/` — `pnpm build` first. They run sequentially (`maxConcurrency: 1`, `pool: "forks"`, `retry: 1`) because daemon-based tests bind real ports.

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
3. **Implement minimal patch** — apply KISS/YAGNI/rule-of-three explicitly.
4. **Validate** — `pnpm build && pnpm test && pnpm lint:security` must all pass.
5. **Document impact** — update comments/docs for behavior changes, risk, side effects.

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

### 6.3 Add a Domain Type
Define Zod schema in `core/src/domain/` → infer type with `z.infer<typeof Schema>` → export both schema and type → test valid + invalid inputs.

### 6.4 Add a Config Schema
Create `schema-*.ts` in `core/src/config/` with `.default()` values → wire into parent (typically `AppConfigSchema`) → export from config index → test defaults + valid + invalid inputs.

### 6.5 Add a Skill
Skills are Markdown files with manifest frontmatter. Add to `packages/skills/`, validate frontmatter against manifest Zod schema, test loading + manifest validation.

### 6.6 Security / Gateway / Daemon
Include threat/risk notes in commit message. Add boundary + failure-mode tests. Changes in `core/src/security/` require reviewing all downstream consumers. `injection-patterns.ts` changes require both detection accuracy and false-positive tests.

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
- **Imports**: `.js` extension required (Node ESM). Named imports preferred. Type imports use `import type`.
- **Build output**: `packages/*/dist/` and `*.tsbuildinfo` (gitignored).
- **Package exports**: `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`.
