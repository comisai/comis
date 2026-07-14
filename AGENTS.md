# AGENTS.md — Comis Engineering Protocol

Default working protocol for coding agents. Scope: entire repository.

## 1) Architecture

Hexagonal (ports + adapters). Core defines port interfaces; adapters implement them; everything is wired via `AppContainer` in `packages/core/src/bootstrap.ts` (composition root). Extending Comis means implementing a port interface and wiring it in bootstrap — not cross-cutting rewrites.

Extension points in `packages/core/src/`:

- `ports/` — port interfaces (`*Port` suffix): `ChannelPort`, `ChannelPluginPort`, `MemoryPort`, `SkillPort`, `EmbeddingPort`, `MediaResolverPort`, `TranscriptionPort`, `TTSPort`, `ImageAnalysisPort`, `VisionPort`, `FileExtractionPort`, `OutputGuardPort`, `SecretStorePort`, `DeviceIdentityPort`, `CredentialMappingPort`, `PluginPort`, `DeliveryQueuePort`, `DeliveryMirrorPort`, `ClockPort`, `EnvPort`, `TimerPort` (+ `TimerHandle`), `ContextStorePort`, `SessionStorePort`, `FileLockPort`, hook types. Adapters live in the consumer package (e.g., `@comis/memory` for store ports) or `@comis/infra` for runtime adapters (`createSystemClock`, `createSystemEnv`, `createSystemTimers`).
- `runtime/` — sanctioned-root in-package helpers (`system-time.ts`: `systemNowMs`, `systemNowDate`, `systemDateFrom`, `systemSleep`, `systemSetTimeout`/`systemClearTimeout`, `systemSetInterval`/`systemClearInterval`, `systemScheduleTimeout`, `systemGetEnv`, `systemEnvSnapshot`). Use these only at trust-boundary call sites that genuinely cannot accept an injected port (top-level loggers, OAuth poll loops). Secrets must still go through `SecretManager`.
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
core          domain, ports, event bus, security, config, hooks, bootstrap, ComisLogger structural contract, FileLockPort, ContextStorePort (the LCD lossless-store port) + SessionStorePort + row DTOs (LcdMessage, LcdMessagePart, LcdPartMetadata, LcdPartKind, LcdRole, ContextStoreScope, AppendMessageInput, SessionData, SessionListEntry, SessionDetailedEntry) + parts-codec (messageToParts/partsToMessage), OAuth helpers, master-key helpers
infra         Pino structured logging implementation (assignable to core's ComisLogger contract)
observability Diagnostics substrate: queued writer, payload bounding, sanitization, path guards, cache-trace runtime + EventBus bridge, cache-stats aggregation/RPC
observability-otel opt-in OTel extension: OTLP traces/metrics/logs + a standalone Prometheus /metrics exporter (single MeterProvider, two readers); subscribes the bus, content-free; the ONLY @opentelemetry/*-dependent package; daemon lazy-loads it (dynamic import) only when observability.otel/prometheus is enabled → core/daemon build OTel-free
memory        SQLite-backed ContextStorePort + SessionStorePort impls (return types
              from core) + MemoryApi + FTS5 + vector search (MemoryPort, SecretStorePort,
              CredentialMappingPort, DeliveryQueuePort, DeliveryMirrorPort, OAuth-store,
              observability/embedding adapters). Row DTOs re-exported from core (single
              source of truth). Daemon consumes; agent + cli consume port types from @comis/core.
gateway       Hono HTTP, JSON-RPC, WebSocket, mTLS
skills        manifest, prompt skills, MCP, built-in tools, media, STT/TTS/vision/image-gen integrations
scheduler     cron, heartbeat, task extraction; createFileLock(): FileLockPort factory backed by proper-lockfile
agent         orchestration: executor, planner, RAG, sessions, model, safety, response-filter (does not reference @comis/infra; OAuth helpers live in @comis/core)
channels      platform adapters (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email, Echo) (does not reference @comis/infra)
orchestrator  inbound pipeline, execution coordination, channel-manager, command queue, routing, cross-session messaging
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
- `errorKind` is the closed union from `LogFields.ErrorKind` in `@comis/core`: `config | network | auth | validation | precondition | timeout | resource | dependency | internal | platform` (10 members). Write literals as `"validation" as const`. Heuristic: bad input → `validation`; unmet precondition / guard → `precondition`; external API → `dependency`; chat platform → `platform`; bad config → `config`; assertion → `internal`.

### 2.2 Security (ESLint-enforced — violations fail CI; rules apply to `packages/*/src/**` only)
- No `path.join()` — use `safePath(base, ...segments)` from `@comis/core/security`. `base` must be absolute; every dynamic segment (including filenames) goes through `safePath`. Compose: `safePath(safePath(dataDir, agentId), file)`.
- No `process.env` — secrets go through `SecretManager`; non-secret env reads go through `EnvPort` (`env.get(KEY)`). `BootstrapOptions.env` is required at the composition root and is the only sanctioned `process.env` consumer; everywhere else accepts an injected `EnvPort` or — at narrow trust-boundary call sites that cannot accept DI — calls `systemGetEnv()` from `packages/core/src/runtime/system-time.ts`. To seed config from env, extend `buildGatewayEnvLayer()` plus the schema; never read env at the consumer. The architecture test `test/architecture/globals.test.ts` enforces this — `globalsAllowlist` is empty modulo the `packages/web/src/api/` carve-outs.
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
- Before adding a dependency, climb the ladder: stdlib / Node built-in → native platform or language feature → a dep already in the tree → a few lines of our own. A new package must clear a bar those rungs can't — every dependency is supply-chain attack surface (see CLAUDE.md "Supply-chain invariants"). "Saves a few lines" is not that bar.
- Minimalism never buys simplicity with correctness. YAGNI deletes speculative features and abstractions — never input validation, error/`Result` handling, edge cases, or the security/observability floor (§2.1, §2.2, §2.7). Between two equally small options, take the one that's correct on the edges.

### 2.4 Composition root + factories
- Wire dependencies in `bootstrap.ts` — never import sibling packages directly.
- Prefer factory functions (`createXxx()`) returning typed interfaces over class instantiation.
- Inject logger via `Deps` interface — never import `@comis/infra` directly. No `console.log` outside `packages/cli`.

### 2.5 Determinism
- Unit tests co-located: `src/component.ts` + `src/component.test.ts`. No real network calls.
- Mock external modules at file top with `vi.mock(...)`. For partial internal types, use hand-built objects with `as unknown as T` — only the methods the SUT calls.
- Local `make<X>(overrides: Partial<X> = {}): X` factories at file top for `Deps`, config, domain objects. Cross-package test helpers live in `test/support/`.
- Time / env / timers in tests: use the fixtures in `test/support/` — `createFakeClock(initialMs)`, `createFakeEnv(seed)`, `createFakeTimers()`. `FakeTimers` exposes `unrefRecord()` for shutdown assertions. Daemon-harness opts in via `useFakeTimers: true` and surfaces `handle.getTimerRecord()` (see `test/integration/daemon-shutdown.test.ts`).
- Integration tests in `test/integration/` import from `dist/` — `pnpm build` first. They run sequentially (`pool: "forks"`, `maxConcurrency: 1`) because daemon-based tests bind real ports.
- Test naming: behavior-named (≥20 chars); `test/architecture/test-naming.test.ts` rejects generic names like `"works"`, `"happy path"`, `"sanity"`, `"test N"`.

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
| AUDIT | Security-decision trail (custom level 35): secret access, injection detection, command blocks. Durable scrubbed sink (`obs_audit_events` + `0600` `security-audit.jsonl`) — content-free (name + outcome, never the value). Emit via `logger.audit(...)`. |

- Object-first: `logger.info({ agentId, durationMs }, "Execution complete")`. Never string-interpolate in the message; never pass JSON-stringified objects.
- Once-per-request → INFO. N-per-request → DEBUG (aggregate count in the INFO summary).
- Pipeline stages tag log lines with `step: "<stage-name>"` (canonical examples in `packages/channels/src/shared/`) — per-step analogue of `submodule:`.
- Events vs logs: emit on `eventBus` for state transitions, lifecycle outcomes, observability snapshots, and safety/health signals (e.g., `tool:executed`, `execution:aborted`, `provider:degraded`). Logs describe; events announce. Logging supplements events — it does not replace them.
- **Instrument for troubleshooting.** Every code path that crosses a boundary (channel inbound, RPC, tool call, external API, queue hop) must be reconstructable from logs + events alone — no debugger, no live repro required. Minimum coverage on any new boundary: an INFO completion line carrying `durationMs`, an ERROR/WARN with `hint` + `errorKind` on every failure branch, and a `step:`-tagged DEBUG per intermediate stage. `traceId` (auto-injected) ties a single request together across packages — never swallow it by starting a new context mid-flow. When a path can fail in a way an operator must act on, both log it (with an actionable `hint`) and emit the matching `eventBus` health/state event so observability snapshots stay complete. Litmus test: if you cannot describe how a future failure in the code you just wrote would be diagnosed from its logs, it is under-instrumented. And the converse is a standing obligation: when a real investigation shows the instrumentation was insufficient (you needed a debugger, a raw-log grep, a hand-join, or an error's `hint` named the wrong knob), closing that gap is part of *that* fix — done unprompted, not deferred to a future ask.

**Contract vs implementation.** `ComisLogger`, `LogFields`, and `ErrorKind` are **structural type contracts** that live in `@comis/core/src/logging/log-fields.ts`. The Pino-backed runtime implementation lives in `@comis/infra` and is assignable to the contract (`expectTypeOf<PinoComisLogger>().toExtend<ComisLogger>()` proves this in `packages/infra/src/logging/__tests__/logger-contract.test.ts`). Type-only consumers (agent, channels, gateway, skills, scheduler) import the contract from `@comis/core`. Only the daemon (composition root) and infra itself import the Pino runtime. Pino's auto-redaction (`apiKey`, `token`, `password`, etc., 3 levels deep) is a runtime feature of the Pino implementation; the structural contract does not (and cannot) enforce redaction.

#### User-authored channel message retrieval

When asked to retrieve prompts or messages sent by users through a channel, use the offline `comis messages` CLI instead of grepping daemon or session logs manually. For Telegram:

`comis messages --channel telegram --limit 10000 --format json`

Run it on the target host as the Comis service user. The command excludes internal cron, sub-agent, heartbeat, and system dispatches by default. Treat its session-record timestamps as authoritative and redact credentials before displaying output.

### 2.8 Source Rules (architecture tests — shrink-only allowlists)

Eight allowlist arrays live in `test/support/architecture-allowlist.ts` and are enforced by `test/architecture/*.test.ts`. The arrays are **shrink-only** (`allowlist-shrink.test.ts` gates a base..head git-ref comparison) and entries carry a `removedIn: "phase-X" | "permanent" | "deferred"` template-literal tag that fails `tsc` if stale.

| Rule | Test | What it forbids | Escape hatches |
|------|------|------------------|----------------|
| `ALLOWLIST` (boundary) | `source-rules.test.ts` and friends | Cross-package internal imports and other boundary violations | Empty — closed set. New L-ID requires shrink-test allowance. |
| `fileSizeAllowlist` | `file-size.test.ts` | Production `.ts` files >800 lines (and tighter caps inside `agent/executor/`: request-body ≤600L, pi-executor ≤400L, prompt-runner ≤500L, cache-detection ≤350L) | `*.generated.ts` rule (excludes `web/src/api/contracts.generated.ts`); allowlist entry tagged with closing phase |
| `rawThrowAllowlist` | `raw-throw.test.ts` | `throw new Error(...)` / `throw err` outside `security/`, `safety/`, `error-mapper.ts` boundary modules | `// @allow-throw: <reason>` file-level annotation for sanctioned boundary throws |
| `untypedSqliteAllowlist` | `untyped-sqlite.test.ts` | `db.prepare(...).all() as Foo[]` and similar untyped SQLite casts in `packages/memory/` | None — go through `createRowMapper(schema)` instead |
| `optionalFieldAllowlist` | `optional-field-bloat.test.ts` | Interfaces with ≥12 optional fields without justification | Allowlist entry classifying each as (a) genuinely conditional or (b) cluster-split candidate |
| `globalsAllowlist` | `globals.test.ts` (AST-classified) | `Date.now()`, `new Date()`, `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, `process.env[…]` outside sanctioned roots | Sanctioned roots only: `packages/core/src/bootstrap.ts`, `packages/core/src/runtime/`, `packages/infra/src/runtime/`, daemon composition root, `packages/web/src/api/` carve-outs |
| `noBackwardCompatAllowlist` | `no-backward-compat.test.ts` | `/backward.?compat\|backcompat\|legacy.?(alias\|mode\|fallback)/i` text and `@deprecated` JSDoc in production source | Permanent allowlist entries for annotated migration code and historical-reference comments |
| `coverageWaiver` | `coverage-gate.test.ts` | Production files with no test neighbor | Test-impractical files only, with permanent documented reason |

**File-level annotations** (override architecture rules; cite reason on the same line):
- `// @allow-throw: <reason>` — file may throw at boundary; expected at `security/`, `safety/`, `error-mapper.ts`, daemon RPC handlers, and Lit `requireGlobalState()` (caught at framework boundary).
- `// eslint-disable-next-line no-restricted-syntax, security/detect-object-injection -- <reason>` — narrow per-line escape for sanctioned-root helpers (see `packages/core/src/runtime/system-time.ts:120`).

**Closed-union discriminators.** New `kind:` fields use closed string-literal unions plus an exhaustive `const _exhaustive: never = kind;` at switch defaults — never `kind: string`. See `packages/scheduler/src/heartbeat/agent-heartbeat-source.ts:82`, `packages/daemon/src/wiring/daemon-utils.ts:54`, `packages/skills/src/tools/browser/playwright-actions.ts:328`.

**Non-null clusters.** No `identifier!.method()` chains in production source. In Lit views, replace `this._globalState!.X` with `requireGlobalState(this).X` (typed `GlobalStateNotInitializedError` from `packages/web/src/state/global-state.ts`).

**`SubAgentRunnerDeps` audit pattern.** When a `Deps` interface accumulates >10 optional fields, write a co-located `AUDIT.md` (mirror `packages/agent/AUDIT.md` and `packages/orchestrator/AUDIT.md`) classifying each field as `required` / `optional` with a `when-absent` cell and an evidence-link to the source line. CI sync test enforces bidirectional set equality between the audit table and the interface.

### 2.9 Backward compatibility

Not supported. Per the project's no-BC policy, never add migration code, default-to-old-behavior fallbacks, alias re-exports, deprecated-parameter shims, or `@deprecated` JSDoc — `no-backward-compat.test.ts` keeps them out. Intentional behavior breaks are released in the changelog, not absorbed by a shim. When a rename or signature change is needed, change the call sites in the same diff.

### 2.10 Test-Driven Development (Red → Green → Refactor)

Every behavior change in production source (`packages/*/src/**`) starts with a failing test. Bug fixes get a regression test that fails on the current codebase; new features get a contract test that pins the new behavior. The test is written, runs RED, and then the production patch flips it to GREEN — in that order, never the reverse.

- **Scope.** Applies to fixes and feature work. Pure docs, comments, formatting, and build-tooling-only changes (CI YAML, tsconfig, `.vscode`) are exempt because they have nothing to assert against. When in doubt, the change needs a test.
- **Commit ordering.** Prefer landing the RED commit first (test-only, failing on current `main`) and the GREEN commit second (the production patch). Combining RED + GREEN into one commit is acceptable when the test would not compile against the pre-patch code, when the bug is too narrow to surface from a separate commit, or when shipping a security patch — the rationale belongs in the commit message either way.
- **What the test must prove.** A test that passes both before and after the patch proves nothing — it must demonstrably FAIL on the pre-patch code. If a reviewer cannot reproduce the RED state by checking out the test commit alone, the test does not satisfy this rule.
- **Refactor (optional third step).** After GREEN, simplify if the patch leaves duplication or awkward seams. Refactor commits keep all tests green; if behavior shifts, that is a new fix or feature and the cycle restarts.
- **Pure refactor PRs.** A refactor that does not change behavior preserves the existing tests as the green signal. New tests are not required, but no existing test may be deleted or weakened to make a refactor pass.
- **Filesystem-layout resolvers need a real-layout test.** Code that resolves the live `~/.comis` / workspace tree (session, trajectory, metadata, or pointer paths) must have a test that builds the **actual nested layout** — `workspace/sessions/<tenant>/<channel>/<file>.jsonl[.trajectory.jsonl]` + the co-located `.trajectory-path.json` pointer + `<file>_session-metadata.json` — and drives the **real resolver**. A test that only injects a fixture reader (clean flat paths) proves the *logic*, not the *path resolution*. Fixture-only coverage shipped two production-breaking `obs.explain` reader bugs that every unit + integration gate passed: the wrong `<dataDir>/sessions/<id>` base path (real is `<dataDir>/workspace/sessions/<tenant>/<channel>/…` resolved via the pointer) → an empty `IncidentReport` for *every* real session; and reading `diskPath` where the writer emits `diskPathRel` → `"<offloaded>"` drill-down pointers. If a reader's input is the on-disk layout, the layout **is** the contract — pin it, and sanity-check the assembled output against a real `~/.comis` session before calling it done.

Architecture and lint rules are enforced by their own tests — that is the same Red → Green loop applied to the protocol itself.

### 2.11 Root-cause before patching

A bug is often a **layer mismatch** — two parts of the system disagreeing — not a defect at the site that throws. Before writing a fix: read the docs/design for the *intended* behavior (you may be about to contradict it), trace the mechanism **end-to-end across every layer** it touches, and fix the **authoritative** layer — never a parallel guard/allowlist/special-case at a convenient layer that hides the symptom and leaves two layers inconsistent. Prove the fix against **ground truth** (the real artifact or a live run), not a green mock that can pass while the real wiring stays broken. When the right fix is a genuine design/product tradeoff, settle it with the maintainer before coding.

### 2.12 Self-contained comments, docs, tests, and runtime strings

Comments, docs, test titles, and runtime strings (log messages, `hint`s, tool/CLI output) must read cleanly for someone with **only this repo** — no build pre-history is visible in the public source. State the *constraint*, never its origin (`// WR-01: never claim success on a keyless run` → `// never claim success on a keyless run`). Never introduce:

- **Process / traceability IDs** — requirement or finding markers (`WR-01`, `SEC-02`, `KNOB-02-1`), phase/plan/review refs (`Phase 193`, `Plan 128-03`, `R7 #1`, dated `(30uc-…)` tags), or `.planning/…` / `design §…` shorthand.
- **Version pre-history** — Comis's own past versions (`v2.31`, "since 1.0.25", "added in vX", "NEW in …") or migration framing. Describe current behavior unconditionally (matches §2.9's no-BC policy).
- **Milestone codenames** — "Glass Box" and the like; name the mechanism, not the release.
- **Reference-project names** — Hermes, OpenClaw / clawdbot, Deer-Flow. Keep any license-required attribution in `NOTICE`, not in a source comment.

**Runtime strings carry ZERO of the above** — a residue-carrying string is a behavior change: clean it and its asserting test in the same commit. **Keep-list** (these are API/contracts, not prose): third-party/dependency/model versions, standards tokens (SHA-256, TLS-1.3, ES2023, BCP-47), GitHub `#refs`, and real code identifiers such as the `SEC-GW-003` security-check codes, live-test scenario IDs, and the `architecture-allowlist` `phase-X` template types.

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
3. **Test-first (TDD)** — write the failing test before the production patch (regression test for bugs, contract test for new behavior). Co-located unit test by default; integration test only for daemon-level flows. RED must be reproducible on the pre-patch code; the patch is the GREEN step.
4. **Implement minimal patch** — make the test pass. Apply KISS/YAGNI/rule-of-three explicitly.
5. **Validate** — `pnpm validate` (= `pnpm build && pnpm test && pnpm lint:security && pnpm cycles`) must all pass.
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

**Runtime ports (`ClockPort` / `EnvPort` / `TimerPort`).** These are the canonical precedent for hexagonal time/env/timer access:

- Type-only interfaces in `packages/core/src/ports/{clock,env,timer}.ts`.
- Adapters in `packages/infra/src/runtime/` (`createSystemClock`, `createSystemEnv`, `createSystemTimers`) plus contract tests in `packages/infra/src/__tests__/runtime.contract.test.ts`.
- Test fakes in `test/support/{fake-clock,fake-env,fake-timers}.ts` (`createFakeClock(initialMs).advance(ms)`; `FakeTimers.unrefRecord()` for leak assertions).
- `TimerHandle` is opaque: `cancelled` / `cancel()` / `unref()` only. **Never** reach inside it to call raw `clearTimeout`; that breaks `.unref()` accounting and cancel-safety. In retargets, `clearTimeout/clearInterval` becomes `handle.cancel()`; `.unref()` is preserved on the handle.
- In-package consumers that cannot accept DI (top-level loggers, OAuth poll loops) use `packages/core/src/runtime/system-time.ts` helpers (`systemNowMs`, `systemScheduleTimeout`, `systemSetInterval(...).unref()`, `systemGetEnv`). Adding new sanctioned-root call sites must be justified — the architecture test only exempts the listed roots.

### 6.3 Add a Domain Type
`z.strictObject({...})` schema in `core/src/domain/` (domain layer is strict — loosening is a compat break) → infer type with `z.infer<typeof Schema>` → export schema, type, and a paired `parseX(raw): Result<T, z.ZodError>` helper wrapping `safeParse()`. Call sites use `parseX()` — never `.parse()` (throws) or raw `.safeParse()`.

### 6.4 Add a Config Schema
`schema-*.ts` in `core/src/config/` with `.default()` on every field → wire into parent (typically `AppConfigSchema`) → export from config index. Consumers see a fully-defaulted `AppConfig` — never `config.x ?? fallback` at call sites; fallbacks belong in `.default()`. Layer precedence: schema defaults < env-layer projection < YAML (later YAML wins). Keys in `immutable-keys.ts` are rejected by `config.write`. New top-level sections register a single entry in the `SECTION_REGISTRY` in `core/src/config/section-registry.ts` (the consolidated source of truth). Per-view derivations (`SECTION_SCHEMAS` in `schema-serializer.ts`, the metadata map in `field-metadata.ts`, the managed-section redirect map in `managed-sections.ts`) are derived from the registry — no per-file edit needed beyond the registry entry.

### 6.5 Add a Skill
Skills are Markdown files with manifest frontmatter. Add to `packages/skills/`, validate frontmatter against manifest Zod schema, test loading + manifest validation.

### 6.6 Security / Gateway / Daemon
Include threat/risk notes in commit message. Add boundary + failure-mode tests. Changes in `core/src/security/` require reviewing all downstream consumers. `injection-patterns.ts` changes require both detection accuracy and false-positive tests.

**Capability gate + deny-by-origin.** The in-process agent loop is authorized by a single **capability gate** — `requireCapability(held, "orch:*")` on every privileged handler (`core/src/security/capability.ts`), an axis **orthogonal** to the gateway `Scope`. Hard invariants, each guarded by an arch-test: (1) the `AgentCapability` union is **disjoint** from `Scope` and no member implies `admin`/`rpc`/`*` — `checkCapability` is a plain membership test with **no wildcard branch** (do not copy `checkScope`'s asterisk-implies-all rule); (2) every gated handler carries the gate (a missing one fails the build); (3) admin-scoped handlers **deny-by-origin**, **trust-tiered**: a **non-admin** `_agentId`-carrying call is rejected (the confused-deputy floor — a guest/user/prompt-injected turn can never reach the control plane), but an **admin-trust** agent turn (the operator's explicit `elevatedReply.senderTrustMap` grant) **inherits** that admin and is allowed through to the handler. Sound because both signals are external-stripped + in-process-injected — inbound `INTERNAL_FIELD_NAMES` (incl. `_agentId`/`_capabilities`/`_trustLevel`) are stripped from external callers at the gateway (`stripInternalFields`, `wiring/setup-gateway-api.ts`), and `createAgentRpcCall` re-injects `_trustLevel` from the framework ALS trust **post-spread** so a tool- or agent-supplied value cannot forge it (`runWithContext` stores the raw context — an absent trust is non-admin, never the schema's `admin` default). Capabilities are granted by the named **autonomy profile** (`config/schema-agent/schema-agent-autonomy.ts`); the agent cannot self-raise. A failed jail precondition **downshifts to `assistant` and says so** (a WARN + a doctor finding, `errorKind:"precondition"`) — never a silent unjailed fallback. Denials audit content-free (`kind:"capability_denied"`).

**Diagnosing an autonomous/unattended run (the capability-observability surface).** Every capability-gated call (allow AND deny) emits a content-free per-cap audit at the single gate chokepoint, riding the durable `obs_audit_events` sink — query it with `node packages/cli/dist/cli.js security audit-log` (filter by kind/agent/outcome). The same emit also lands a `capability.audited` trajectory record, which `obs.explain` folds into the `spawnTree` IncidentReport section: `node packages/cli/dist/cli.js explain "<sessionKey|traceId>"` reconstructs the run's root→children authorization topology offline — one node per `leaseId`, each surfacing its attenuated caps, the tool NAMES it invoked, and any `CapabilityDeniedError` cap. That is **"one call to root-cause an unattended run"** (the post-mortem TOPOLOGY — what it was allowed to do and what it tried). For an **in-flight** run's *remaining* budget/quota — which is live in-memory daemon state, never on disk, so the offline tree omits it — use `node packages/cli/dist/cli.js whoami` (the `capabilities.introspect` read: self-scoped resolved caps + remaining tokens/wall-clock/$/outward-quota; LIVE-only, no `--offline`). Read-order: `explain` for the finished-run topology and verdicts → `whoami` for an active run's headroom → `security audit-log` for the durable per-decision trail.

### 6.7 Add or Change an Agent Tool
Register metadata via `registerToolMetadata(name, meta)` in `packages/skills/src/bridge/tool-metadata-registry.ts`. The `ComisToolMetadata` shape (`packages/core/src/tool-metadata.ts`) covers: `maxResultSizeChars` (result cap), `isReadOnly` / `isConcurrencySafe` (parallel-execution safety), `searchHint` (BM25 deferred-discovery), `validActions` / `validKeys` / `requiredByAction` (action-discriminated tool gating — shape mirrors `ManagedSectionRedirect.schemaFragment` in `config/managed-sections.ts`), `validateInput` (pre-flight validator), `outputSchema` (structured output), `coDiscoverWith` (paired discovery). When the tool manages a config section, add the redirect to `config/managed-sections.ts` so immutable-path rejections include a parameter-correct example.

### 6.8 SQLite reads / discord.js narrowing

**SQLite rows go through `createRowMapper(schema)`** (`packages/memory/src/row-mapper.ts`). Define a Zod schema in `row-schemas.ts`, build the mapper once at module top, call `mapper.parseRow` / `mapper.parseOptionalRow` / `mapper.parseRows` on statement results. The mapper returns `Result<TRow, MapperError>` (path-indexed errors) — chain with early-return. No `as Foo[]` / `as Foo | undefined` casts in `packages/memory/src/`.

**discord.js narrowing uses `asTextLike()`** (`packages/channels/src/discord/discord-adapter-types.ts`). `DiscordTextLikeChannel` is a structural subset of the discord.js channel union covering the runtime methods `discord-actions.ts` actually uses. Returns `null` (not a `Result`) when the channel isn't text-like — `null` is the correct "not text-like" signal that callers branch on. No `as any` in discord adapter files.

## 7) Validation

Required before any commit:
```bash
pnpm validate  # = pnpm build && pnpm test && pnpm lint:security && pnpm cycles
```

By change type:
- Security/gateway/daemon: include at least one boundary/failure-mode test.
- Port additions: test contract + adapter implementation.
- Channel adapters: test credential validation, message mapping, lifecycle.
- Config schemas: test defaults, valid inputs, validation errors.
- Injection patterns: test detection accuracy and false positives.
- Integration tests: `pnpm build` first; run via `pnpm test:integration` (or `:mock` / `test:orchestrate`). Required per-commit when retargeting a production caller from a global to a port, and when splitting executor files.

Coverage: `pnpm test --coverage` enforces `lines: 90 / branches: 85 / functions: 90` on `packages/*/src/**/*.ts` via `@vitest/coverage-v8`; integration tier ≥80% line. `coverageWaiver` is for test-impractical files only.

If full validation is impractical, document what was run and what was skipped.

## 8) Anti-Patterns (Do Not)

- Use `path.join()`, `process.env`, `eval()` / `Function()`, or empty `.catch(() => {})`.
- Use `Date.now()` / `new Date()` / `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` directly — go through `ClockPort` / `TimerPort` or the sanctioned-root `packages/core/src/runtime/system-time.ts` helpers. `clearTimeout/clearInterval` is `handle.cancel()` on a `TimerHandle`.
- Cast SQLite results — `db.prepare(...).all() as Foo[]` is banned in `packages/memory/`. Use `createRowMapper(schema)`.
- Use `as any` in the Discord adapter — use `asTextLike()` from `discord-adapter-types.ts`.
- Use `identifier!.method()` non-null clusters in production source. In Lit views, use `requireGlobalState(this)`.
- Declare `kind: string` discriminators — use closed string-literal unions with an `assertNever` / `const _exhaustive: never = kind;` default branch.
- Add backward-compatibility shims, alias re-exports, deprecated-parameter wrappers, or `@deprecated` JSDoc — change call sites in the same diff.
- Throw exceptions — return `Result` with `err()`. Sanctioned boundary throws are file-tagged with `// @allow-throw: <reason>`.
- Import `@comis/infra` directly — inject logger via `Deps`.
- Use `console.log` outside `packages/cli`.
- Import cross-package internals — use public exports only.
- Modify unrelated packages "while here" — one concern per change.
- Skip `pnpm build` before integration tests.
- Add speculative config keys or feature flags "just in case".
- Add a new dependency for what stdlib, a native platform feature, an already-present dep, or a few lines can do — every package is supply-chain surface.
- Use string interpolation in structured log calls — Pino object-first only.
- Include personal identity or sensitive data in tests, examples, docs, or commits.
- Add entries to architecture allowlists (`test/support/architecture-allowlist.ts`) — they are shrink-only. Closing a violation requires deleting the entry, not adding a new one.
- Patch a symptom at a convenient layer (a parallel guard/allowlist/special-case) instead of root-causing across layers and fixing the authoritative one (§2.11) — a fix that leaves two layers disagreeing is not a fix.
- Land a fix or feature commit without a test that demonstrably failed on the pre-patch code. "I tested it locally" is not a substitute for an automated RED → GREEN cycle.

## 9) Conventions

- **Commits**: Conventional Commits — `feat(agent): description`, `fix(channels): description`.
- **Branches (branch-first)**: never commit directly to the default branch (`main`). Cut a working branch off `main` before the first change — `feature/<desc>`, `fix/<desc>`, `docs/<desc>` — and land the work via PR. Commit or push only when the user asks; approval to make a change is not approval to push it. If you find yourself on `main` with uncommitted work, branch before committing.
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
