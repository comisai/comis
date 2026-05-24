# CLAUDE.md

Read `AGENTS.md` before any code change — it is the authoritative engineering protocol.

This file is a Claude-specific operational supplement. If anything here conflicts with `AGENTS.md`, follow `AGENTS.md` and update this file.

## TDD-First

Every fix and every feature in `packages/*/src/**` starts with a failing test that demonstrably fails on the pre-patch code (RED), then a production patch that flips it to green (GREEN). Land the test commit first when practical so the RED state is reproducible from that commit alone. Exempt only: pure docs, comments, formatting, and build-tooling/CI/config edits — when in doubt, write the test. "I tested it locally" is not a substitute. Full normative rule: AGENTS.md §2.10.

## Project

Comis is a security-first AI agent platform connecting agents to chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). TypeScript monorepo, 15 packages, hexagonal architecture (ports + adapters). Node.js >= 22, Linux-only.

## Build & Test

```bash
pnpm install                    # native deps: better-sqlite3, sharp
pnpm build                      # all packages (tsc + project references)
pnpm test                       # unit tests (Vitest workspace)
pnpm test --coverage            # @vitest/coverage-v8; floor = lines 90 / branches 85 / functions 90 on packages/*/src/**/*.ts
pnpm lint:security              # security ESLint rules
pnpm cycles                     # madge dist-mode .d.ts circular-dep check
pnpm validate                   # build && test && lint:security && cycles (one-shot pre-commit chain)
```

Single package or file:
```bash
cd packages/<pkg> && pnpm test
pnpm vitest run src/path/to/file.test.ts
```

Integration (requires `pnpm build` first — imports from `dist/`):
```bash
pnpm test:integration
pnpm test:orchestrate           # full E2E + log validation + JSON report
pnpm test:cleanup               # clean test artifacts
```

Vitest aliases `@comis/*` → `packages/*/dist/index.js` for integration tests — use bare-package imports, never `../packages/*/src/*`. **Stale `dist/` silently masks `src/` changes**: if a test passes after editing only `src/`, you forgot `pnpm build`.

Primary validation: `pnpm validate` (= `pnpm build && pnpm test && pnpm lint:security && pnpm cycles`).

## Daemon

Data dir: `~/.comis`. The `comis` CLI is **not on PATH** — use `node packages/cli/dist/cli.js`.

### pm2 (development only)

For local dev convenience — auto-restart on crash, log tailing via `pm2 logs`, easy `pm2 flush`. **Not the production path.** Production VPS / install-script deployments invoke the daemon directly (see below); pm2 is not part of that pipeline.

Requires `npm install -g pm2`. Ecosystem config auto-sets `COMIS_CONFIG_PATHS`.

```bash
node packages/cli/dist/cli.js pm2 setup           # one-time → ~/.comis/ecosystem.config.js
pnpm build && pm2 flush && pm2 restart comis     # rebuild + restart (`pm2 start` first time)
pm2 status comis
```

Always `pm2 flush` before start/restart to keep logs clean. Verify startup (use `run_in_background: true`):
```bash
sleep 5 && pm2 logs comis --lines 10 --nostream
```
Look for `"Comis daemon started"`. On `FATAL: Bootstrap failed`, restore last-known-good:
```bash
cp ~/.comis/config.last-good.yaml ~/.comis/config.yaml && pm2 restart comis
```

Full reset (clears restart counter — `pm2 flush` only clears logs):
```bash
pm2 delete comis && pm2 flush && node packages/cli/dist/cli.js pm2 start
```

### Direct (production)

How VPS deployments and the published `comisai` package run the daemon — Node directly with `--permission` flags. Do not assume pm2 is present when debugging a production install; expect a bare `node …/daemon.js` process.

`COMIS_CONFIG_PATHS` must be set on the same command line — `export` does not propagate to backgrounded processes from tool environments:
```bash
pkill -f 'node.*daemon\.js' 2>/dev/null && sleep 1 && COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" nohup node packages/daemon/dist/daemon.js >/dev/null 2>&1 &
```

## Logging (Pino via `@comis/infra`)

Levels, syntax, event-bus rules: see AGENTS.md §2.1 (errorKind), §2.2 (redaction), §2.7 (levels & observability).

Canonical fields: `agentId`, `traceId` (auto-injected via AsyncLocalStorage mixin), `channelType`, `durationMs`, `toolName`, `method`, `err` (**not** `error` — matches Pino serializer), `hint`, `errorKind`, `module` (bound once via `getLogger("…")`), `submodule` (call-site scope; reuse via `deps.logger.child({ submodule: "completion-runner" })`), `step` (pipeline-stage tag).

Pino auto-redacts credentials (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`) up to 3 levels deep. Redaction is a safety net — never log secrets, message bodies, or env values at any level.

## Worktree Cleanup

After merging a worktree branch back, remove the worktree and its tracking branch — do not leave stale worktrees:
```bash
git worktree remove .claude/worktrees/<name> --force
git branch -D worktree-<name>
```

## Releases

Steps to ship `vX.Y.Z`:

1. **Bump all 15 `packages/*/package.json` to `X.Y.Z`** — they must move together. The umbrella `comisai` package (in `packages/comis/`) bundles the others, so version drift between them surfaces at publish time, not in local builds.

2. **Update version-pinned docs.** Sweep with:
   ```bash
   grep -rn '<old-version>' --include='*.json' --include='*.mdx' --include='*.md' . \
     | grep -v node_modules | grep -v 'dist/' | grep -v package-lock | grep -v CHANGELOG
   ```
   Files that pin the current version (update every bump):
   - `docs/get-started/quickstart.mdx`
   - `docs/installation/install-linux.mdx`
   - `docs/installation/install-vps.mdx`
   - `docs/installation/install-render.mdx`
   - `docs/reference/cli.mdx`
   - `docker/README-comis.md`
   - `docker/README-comis-web.md`

   `docs/operations/docker.mdx` mentions a version illustratively (`pushing vX.Y.Z produces …`) and is **not** bumped per release.

3. **Validate:** `pnpm validate` — build, test, lint:security, and cycles must all pass before the bump commit. (Skipping the cycles step is what let v1.0.38 ship with a missing `@comis/core` dep in `packages/web/package.json` and the latent 17-cycle backlog go unnoticed for days.)

4. **Commit, push, tag:**
   ```bash
   git commit -m "chore(release): X.Y.Z"
   git push origin main
   gh release create vX.Y.Z --title vX.Y.Z --notes "<notes>"
   ```
   The `vX.Y.Z` tag triggers four workflows in `.github/workflows/`:
   - `npm-publish.yml` — `pnpm publish -r --provenance` (sigstore attestation via GitHub OIDC). Runs `packages/comis/scripts/prepack.js`, which bundles `@comis/*` into `node_modules/@comis/` for inclusion in the tarball.
   - `docker-release.yml`, `dockerhub-release.yml` — multi-arch images (`linux/amd64` + `linux/arm64`), both `default` and `slim` variants. arm64 builds on a native runner (not QEMU).
   - `release.yml` — GitHub release artifacts.

### Supply-chain invariants (do not regress)

These are load-bearing for `npm install -g comisai`:

- **All `dependencies` / `devDependencies` are exact-pinned** (no `^` / `~`) across every `packages/*/package.json` and `website/package.json`. `workspace:*` is the only allowed non-numeric specifier — `prepack.js` rewrites it to literal versions for the published tarball.
- **`@comis/*` workspace packages are `"private": true` and bundled** via `bundledDependencies`. Never publish them to the npm registry.

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Comis**

Comis is a security-first AI agent platform that connects AI agents to chat channels (Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email). It is a TypeScript monorepo of 15 packages built on hexagonal architecture (ports + adapters), runs as a daemon on Node.js ≥ 22 (Linux-only), and ships as the `comisai` npm package plus Docker images.

The **current Active scope** is *Comis Observability & Troubleshooting* — closing a class of fleet-wide bugs that hide between the channel, queue, agent, and delivery layers. The initiative is documented in full at `.planning/design/OBSERVABILITY_DESIGN.md`.

**Core Value:** A fleet-wide bug (today's worked example: the 2026-05-24 duplicate Telegram adapter that double-fired every inbound) must be diagnosable from **one structured artifact with one command in under five minutes** — not 30 minutes of `grep | jq | python` across three log streams.

Everything else in this scope is in service of that one outcome.

### Constraints

- **TDD-first**: Every fix and every feature in `packages/*/src/**` starts with a failing test that demonstrably fails on pre-patch code (RED), then a production patch flipping it to green (GREEN). Test commit lands first when practical. Exempt only: pure docs, comments, formatting, and build-tooling/CI/config edits. *(AGENTS.md §2.10)*
- **No backward-compat shims in production code**: Schema evolution lives ONLY in the reader (bundle exporter, future replay tool). Writer ships in same diff as call-site changes. Additive optional fields stay on `schemaVersion: 1`; breaking changes bump to `2` and the writer stops producing `1`. *(AGENTS.md §2.9, design §6.4)*
- **Architecture tests are shrink-only**: New allowlist entries are forbidden. Existing entries can be removed when the underlying issue is resolved, never added. *(AGENTS.md §2.8)*
- **Coverage floors**: lines 90 / branches 85 / functions 90 on `packages/*/src/**/*.ts`. Per-package: orchestrator 93/81/92, observability ≥ 90/85/90 (raised by this work). *(CLAUDE.md, AGENTS.md §2.7)*
- **`errorKind` closed union at every WARN/ERROR**, plus a non-empty `hint`. *(AGENTS.md §2.1)*
- **Pino logging hygiene**: Use `getLogger("module").child({ submodule, step })` discipline. Never log message bodies, prompts, or env values at any level. Pino auto-redaction is a safety net, not the primary defense. *(AGENTS.md §2.2 / §2.7)*
- **Runtime**: Node.js ≥ 22.19.0, Linux-only for production. pnpm 10.7.1. ES2023 target, `NodeNext` module resolution.
- **Trajectory size**: per-event 256 KB cap; per-file 10 MB soft / 50 MB hard cap; runtime events ≤ 200,000; total events ≤ 250,000; session file ≤ 50 MB at export. *(design §5 D5/D7)*
- **Bus event mapping**: Every new mapped event lands in the architecture test (`packages/observability/src/trajectory/event-bus-bridge.ts:47` + arch test). No silent additions. *(AGENTS.md §2.8)*
- **Privacy at bundle boundary**: Platform-aware regex redaction at export time (long-decimal-IDs catches Telegram chat IDs; JWT; AWS keys; URL userinfo; email; basic-auth; cookie). Path substitution to `$WORKSPACE_DIR` / `$HOME` / `$STATE_DIR`.
- **Bundle handoff is owner-gated**: `/export-trajectory` in a group chat returns the bundle in a DM, never inline. *(design §M2.7)*
- **Planning docs stay local**: `.planning/` is gitignored per project policy (commit `2e3630b`). Decisions and design docs are not pushed; code commits carry the audit trail.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 5.9.3 — all 15 packages under `packages/*/src/`
- JavaScript (ESM) — build scripts (`packages/*/scripts/`, `scripts/`)
- Python — pre-warmed venv inside Docker image (`matplotlib`, `numpy`, `pandas` for agent workspace)
## Runtime
- Node.js >= 22.19.0 (exact constraint; Linux-only for production)
- ES2023 target, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` — see `tsconfig.base.json`
- pnpm 10.7.1 (pinned via `"packageManager"` field in `package.json`)
- Lockfile: `pnpm-lock.yaml` present
- Workspace: `pnpm-workspace.yaml` declares `packages/*`
- `onlyBuiltDependencies`: `better-sqlite3`, `sharp`, `@whiskeysockets/baileys`, `isolated-vm` (native build boundary)
## Frameworks
- Hono 4.12.18 — HTTP server framework (`packages/gateway/`, `packages/daemon/`)
- `@hono/node-server` 1.19.14 — Node.js HTTP adapter
- `@hono/node-ws` 1.3.1 — WebSocket upgrade support
- `hono-rate-limiter` 0.5.3 — per-route rate limiting
- Lit 3.3.2 — Web Components-based SPA (`packages/web/src/`)
- Vite 8.0.10 — build tool (`packages/web/`)
- Astro 6.2.1 — static site generator (`website/`)
- Tailwind CSS 4.2.4 — styling
- Vitest 4.1.5 — test runner and assertion library (workspace-wide)
- `@vitest/coverage-v8` 4.1.5 — V8 coverage provider
- Playwright 1.59.1 — browser automation and E2E tests (`packages/web/`)
- `happy-dom` 20.9.0 — DOM environment for web package unit tests
- TypeScript `tsc` (project references, `"composite": true`) — each package builds independently
- esbuild 0.28.0 — available at workspace root for bundling
- `tsx` 4.21.0 — TypeScript script runner for `scripts/` and `test/`
- madge 8.0.0 — circular dependency checker (`pnpm cycles`)
## Key Dependencies
- `@earendil-works/pi-agent-core` 0.75.3 — core agent loop and tool dispatch (`packages/agent/`)
- `@earendil-works/pi-ai` 0.75.3 — LLM provider abstraction layer
- `@earendil-works/pi-coding-agent` 0.75.3 — coding agent capabilities
- `@google/genai` 1.50.1 — Google Gemini SDK (`packages/agent/`, `packages/comis/`)
- `openai` 6.34.0 — OpenAI SDK, used for completions, embeddings, STT, TTS (`packages/memory/`, `packages/skills/`)
- `node-llama-cpp` 3.18.1 — local LLM embedding inference (`packages/memory/`)
- `better-sqlite3` 12.9.0 — synchronous SQLite, native binary (`packages/memory/`, `packages/daemon/`)
- `sqlite-vec` 0.1.9 — SQLite vector extension for RAG/semantic search (`packages/memory/`)
- `lru-cache` 11.3.5 — in-process embedding cache (`packages/memory/`)
- `discord.js` 14.26.4 — Discord bot (`packages/channels/`)
- `grammy` 1.42.0 + `@grammyjs/*` — Telegram bot (`packages/channels/`)
- `@slack/bolt` 4.7.2 + `@slack/web-api` 7.15.1 — Slack app (`packages/channels/`)
- `@whiskeysockets/baileys` 7.0.0-rc.9 — WhatsApp Web multi-device (`packages/channels/`)
- `@line/bot-sdk` 10.8.0 — LINE Messaging API (`packages/channels/`)
- `irc-framework` 4.14.0 — IRC (`packages/channels/`)
- `imapflow` 1.3.3 + `nodemailer` 8.0.7 + `mailparser` 3.9.8 — Email IMAP/SMTP (`packages/channels/`)
- `@modelcontextprotocol/sdk` 1.29.0 — MCP server/client (`packages/skills/`)
- `@agentclientprotocol/sdk` 0.21.0 — ACP (IDE integration) (`packages/gateway/`)
- `json-rpc-2.0` 1.7.1 — JSON-RPC 2.0 dispatcher (`packages/gateway/`)
- `ws` 8.20.1 — raw WebSocket client
- `playwright-core` 1.59.1 — browser automation tool (`packages/skills/src/tools/browser/`)
- `@fal-ai/client` 1.9.6 — fal.ai image generation (`packages/skills/`)
- `@elevenlabs/elevenlabs-js` 2.45.0 — ElevenLabs TTS (`packages/skills/`)
- `@mozilla/readability` 0.6.0 — article extraction from HTML
- `@napi-rs/canvas` 0.1.100 — server-side canvas rendering
- `pdfjs-dist` 5.6.205 — PDF parsing
- `linkedom` 0.18.12 — lightweight DOM parser for web fetch
- `music-metadata` 11.12.3 — audio file metadata
- `sharp` 0.34.5 — native image processing (resize, format conversion)
- `impit` 0.13.0 — HTTP client with TLS fingerprinting
- `undici` 8.1.0 — fast Node.js HTTP client
- `chokidar` 5.0.0 — file system watcher
- `p-queue` 9.2.0 — async concurrency queue
- `croner` 10.0.1 — cron scheduler (`packages/scheduler/`)
- `pino` 10.3.1 — structured JSON logging (`packages/infra/`, `packages/daemon/`)
- `pino-roll` 4.0.0 — log file rotation
- `zod` 4.4.3 — schema validation (workspace-wide)
- `yaml` 2.8.4 — YAML config parsing
- `typebox` 1.1.37 — TypeBox JSON schema (pinned override)
- `commander` 14.0.3 — CLI argument parsing
- `@clack/prompts` 1.2.0 + `@clack/core` 1.2.0 — interactive CLI prompts
- `chalk` 5.6.2 — terminal coloring
- `ora` 9.4.0 — terminal spinners
- `cli-table3` 0.6.5 — ASCII table output
- `@homebridge/ciao` 1.3.7 — mDNS/Bonjour service advertisement (`packages/gateway/src/discovery/`)
- `ipaddr.js` 2.3.0 — IP address parsing and SSRF guard
- `iconv-lite` 0.7.2 — character encoding
- `proper-lockfile` 4.1.2 — file locking for concurrent process safety
- `ignore` 7.0.5 — `.gitignore`-style pattern matching for sandbox
- `chardet` 2.1.1 — charset detection
## Configuration
- Config is YAML-based, loaded from path(s) in `COMIS_CONFIG_PATHS` env var
- Default config path: `~/.comis/config.yaml`
- Config values support `${VAR_NAME}` env-var interpolation — see `packages/core/src/config/env-substitution.ts`
- **Direct `process.env` access is banned** by ESLint; all credential access goes through `SecretManager` — see `packages/core/src/security/secret-manager.ts`
- `COMIS_CONFIG_PATHS` — colon-delimited config file paths
- `COMIS_DATA_DIR` — persistent data directory (default: `~/.comis`)
- `COMIS_GATEWAY_HOST` — bind host (default: `127.0.0.1`; Docker: `0.0.0.0`)
- `COMIS_GATEWAY_PORT` — HTTP/WS port (default: `4766`)
- `COMIS_LOG_PATH` — log file path
- `SECRETS_MASTER_KEY` — hex-encoded AES-256 master key for encrypted secret store
- `tsconfig.base.json` — shared compiler options; each package extends this
- Per-package `tsconfig.json` with `"composite": true` for project references
- `eslint.config.js` — flat ESLint config with security plugin + custom rules
## Platform Requirements
- Node.js >= 22.19.0
- pnpm 10.7.1 (`npm install -g pnpm@10.7.1` or via corepack)
- Linux recommended (some channel adapters are Linux-only at runtime)
- `python3` + `venv` for agent workspace features (pre-warmed in Docker)
- Chrome/Chromium for browser tool (auto-detected by `chrome-detection.ts`)
- Linux-only (daemon contract; iMessage adapter is macOS-only but flagged accordingly)
- Deployed as Docker image (`ghcr.io/comisai/comis`, Docker Hub `comisai/comis`)
- Also published to npm as `comisai` package (installs all 14 workspace packages as bundledDependencies)
- Gateway port 4766 (HTTP + WebSocket)
- Data volume at `/home/comis/.comis` (Docker) or `~/.comis` (bare metal)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- `kebab-case.ts` everywhere (e.g., `message-mapper.ts`, `completion-runner.ts`, `discord-adapter.ts`)
- Branch-gap companion files: `<file>-branches.test.ts` alongside `<file>.test.ts` (22 such files across the codebase)
- Contract tests: `<file>.contract.test.ts` for port-assignability proofs (`packages/memory/src/__tests__/context-store.contract.test.ts`)
- `camelCase` for all functions: `createCircuitBreaker`, `parseMessage`, `runMemoryReview`
- Factory functions always named `createXxx()` returning a typed interface (never class instantiation): `createDeliveryService()`, `createBackgroundCompletionRunner()`, `createFakeClock()`
- Parser helpers named `parseXxx(raw: unknown): Result<T, z.ZodError>` for every domain type
- `camelCase` for mutable variables and function-scope constants
- `SCREAMING_SNAKE_CASE` for true module-level constants: `VALID_LOG_LEVELS`, `WAKE_PRIORITY`, `BLOCKLIST_RE`
- Intentionally unused function params/vars prefixed with `_` (enforced by ESLint `argsIgnorePattern: "^_"`)
- `PascalCase`: `NormalizedMessage`, `ChannelPort`, `DeliveryService`, `BackgroundCompletionRunner`
- Port interfaces always carry `*Port` suffix: `ChannelPort`, `MemoryPort`, `ClockPort`, `EnvPort`, `TimerPort`, `FileLockPort`
- Adapter implementations carry `*Adapter` suffix: `SqliteMemoryAdapter`, `DiscordAdapter` (implied by files like `discord-adapter.ts`)
- Dependency injection bundles named `*Deps`: `BackgroundCompletionRunnerDeps`, `DeliveryServiceDeps`, `MemoryReviewDeps`
- True constants: `SCREAMING_SNAKE_CASE` (e.g., `VALID_LOG_LEVELS`, `WAKE_PRIORITY`)
- Config/default constants: `camelCase`
## Code Style
- No Prettier or Biome config — formatting is not mechanically enforced; follow existing indentation (2-space) and brace style visible in source
- License header required on every source file: `// SPDX-License-Identifier: Apache-2.0` as the first line
- Tool: `eslint` with `typescript-eslint` + `eslint-plugin-security`
- Config: `eslint.config.js` at repo root
- Applies only to `packages/*/src/**/*.ts` (not tests, not config files)
- Key enforced rules (violations fail CI via `pnpm lint:security`):
- Strict mode (`"strict": true`), ES2023 target, NodeNext resolution, `isolatedModules: true`
- `composite: true` with project references — every cross-package import must appear in the consuming `tsconfig.json` `references` array
- `import type` for type-only imports (preferred)
- `.js` suffix on all relative imports in `.ts` source (NodeNext requires it): `import { ok } from "./result.js"`
- Bare-package imports for cross-package: `import { ok } from "@comis/shared"` (no `.js`, no `dist/` subpaths)
## Import Organization
- No path aliases in production source — bare `@comis/*` workspace imports only
- Integration tests use Vitest aliases: `@comis/*` → `packages/*/dist/index.js` (configured in `test/vitest.config.ts`)
- Architecture tests use selective aliases for compiled runtime values (see `test/architecture/vitest.config.ts`)
- Only public exports: `packages/*/dist/index.js` via `@comis/*` package names
- Never import cross-package internals: `@comis/core/dist/...` subpaths are banned
- `packages/infra` (Pino implementation) is imported ONLY by daemon and infra itself; all other packages import the `ComisLogger` structural contract from `@comis/core`
## Error Handling
- `tryCatch(() => ...)` for synchronous throwing APIs (Node `fs`, `new URL()`, third-party SDKs)
- `fromPromise(promise)` for async throwing APIs
- Raw `throw` is banned in production source except in files annotated with `// @allow-throw: <reason>` (security primitives, safety modules, `error-mapper.ts`)
- `"config"` — config parsing, missing keys, schema violations
- `"network"` — TCP/HTTP failures, DNS resolution
- `"auth"` — 401/403, bad token
- `"validation"` — bad request body, invalid params
- `"precondition"` — resource not in expected state
- `"timeout"` — LLM call, HTTP request, DB query exceeded deadline
- `"resource"` — OOM, disk full, file descriptor limit
- `"dependency"` — external service unavailable (LLM provider, embedding API)
- `"internal"` — assertion failures, logic bugs
- `"platform"` — chat platform API errors (Discord, Telegram, Slack rate limits)
## Logging
- Structural: `agentId`, `traceId` (auto-injected via AsyncLocalStorage), `channelType`, `durationMs`, `toolName`, `method`
- Error: `err` (not `error` — matches Pino serializer), `hint`, `errorKind`
- Scope: `module` (bound once via `getLogger("…")`), `submodule` (call-site scope via `logger.child({ submodule: "name" })`)
- Pipeline: `step` (stage tag, analogous to `submodule` at pipeline level)
- `ERROR`: broken functionality; requires `hint` + `errorKind`
- `WARN`: degraded but functional; requires `hint` + `errorKind`
- `INFO`: boundary events only (2-5 per request); include `durationMs` on completion
- `DEBUG`: internal steps, tool/LLM calls, intermediate state
- Bind `module` once via `getLogger("module-name")`
- Scope further with `logger.child({ submodule: "component-name" })` at call sites
- Never use `module:` inside a log payload call (ESLint-enforced — it duplicates parent binding)
## Security Constraints (ESLint-enforced)
- **Path operations:** `safePath(base, ...segments)` from `@comis/core/security` only — never `path.join()`; `base` must be absolute
- **Environment access:** `SecretManager` for secrets; `EnvPort.get(KEY)` for non-secrets; `systemGetEnv()` only at sanctioned roots; never `process.env` directly
- **External content:** `wrapExternalContent()` or `wrapWebContent()` on all external text flowing into prompts
- **URL fetching:** `validateUrl()` before every fetch
- **Memory writes:** `validateMemoryWrite(content)` before every agent-visible memory store
- **SQLite results (in `packages/memory/`):** `createRowMapper(schema)` from `packages/memory/src/row-mapper.ts` — never `db.prepare(...).all() as Foo[]`
- **Time/timers:** `ClockPort` / `TimerPort` via injection; never raw `Date.now()`, `setTimeout`, `setInterval`; cancel via `handle.cancel()` not `clearTimeout`
## Domain Types
## Discriminated Unions
## Composition and Factory Pattern
- Wire all dependencies in `packages/core/src/bootstrap.ts` (composition root) — never import sibling packages directly
- Prefer factory functions returning typed interfaces over class instantiation
- Inject `logger` via `Deps` interface — never import `@comis/infra` directly from non-daemon packages
- No `console.log` outside `packages/cli`
## Non-Null Access
- No `identifier!.method()` chains in production source
- In Lit views: use `requireGlobalState(this)` instead of `this._globalState!.X`
## Backward Compatibility
## Comments
- JSDoc on exported functions, interfaces, and types
- `@module` JSDoc comment on every file (documents module purpose)
- Inline comments for non-obvious decisions, security rationale, and architecture cross-references (e.g., "see AGENTS.md §2.1")
- File-level annotations for architecture rule exceptions: `// @allow-throw: <reason>`, `// eslint-disable-next-line no-restricted-syntax -- <reason>`
## Commits and Branches
- **Commits:** Conventional Commits — `feat(agent): description`, `fix(channels): description`, `chore(deps): description`
- **Branches:** `feature/<desc>`, `fix/<desc>`, `docs/<desc>` from `main`
- **Modules:** ES modules only (`"type": "module"` in all `package.json` files)
## File Size Limits (Architecture-Enforced)
- General production `.ts` files: ≤800 lines
- `agent/executor/` request-body file: ≤600 lines
- `agent/executor/` pi-executor file: ≤400 lines
- `agent/executor/` prompt-runner file: ≤500 lines
- `agent/executor/` cache-detection file: ≤350 lines
- Allowlist entries for current exceptions carry a `removedIn:` tag
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
```
## Component Responsibilities
| Component | Responsibility | File / Path |
|-----------|----------------|-------------|
| `shared` | `Result<T,E>` type, `ok`/`err`/`tryCatch`, `suppressError`, utilities | `packages/shared/src/` |
| `core` | Domain types, port interfaces, security, config, event-bus, hooks, bootstrap | `packages/core/src/` |
| `infra` | Pino logger runtime (implements core's `ComisLogger` contract) | `packages/infra/src/logging/logger.ts` |
| `observability` | Trajectory recorder, cache-trace, queued file writer, payload bounding | `packages/observability/src/` |
| `memory` | SQLite adapters for `MemoryPort`, `ContextStorePort`, `SessionStorePort`, `SecretStorePort`, `DeliveryQueuePort`, embedding | `packages/memory/src/` |
| `gateway` | Hono HTTP server, JSON-RPC 2.0 router, WebSocket handler, mTLS, REST API for web | `packages/gateway/src/` |
| `skills` | Skill registry, MCP client manager, built-in tools, prompt skills, media/STT/TTS/vision/image-gen | `packages/skills/src/` |
| `scheduler` | Cron scheduler, heartbeat runner, wake coalescer, execution tracker | `packages/scheduler/src/` |
| `agent` | AgentExecutor, PiExecutor (LLM execution), context engine, safety controls, session, budget, spawn | `packages/agent/src/` |
| `channels` | Platform adapters implementing `ChannelPort` for all 9 chat platforms + Echo | `packages/channels/src/` |
| `orchestrator` | Inbound pipeline, execution pipeline, channel-manager, routing, command queue, cross-session | `packages/orchestrator/src/` |
| `cli` | Commander.js CLI; WebSocket JSON-RPC client to daemon | `packages/cli/src/` |
| `daemon` | Process entry point; composition root wiring all packages; 5-stage boot chain | `packages/daemon/src/daemon.ts` |
| `comis` | Umbrella npm package (`comisai`); namespace re-exports | `packages/comis/` |
| `web` | Lit + Vite + Tailwind standalone SPA; REST/SSE/JSON-RPC client to gateway | `packages/web/src/` |
## Pattern Overview
- `packages/core/src/ports/` defines port interfaces (`*Port` suffix); all adapters implement these.
- `packages/core/src/bootstrap.ts` is the composition root — returns `AppContainer`; `packages/daemon/src/daemon.ts` is the process entry point that calls it.
- Dependency direction is strictly inward to `core`: `shared` → `core` ← adapters. `daemon` depends on everything; `shared` depends on nothing.
- All functions return `Result<T,E>` from `@comis/shared`. No `try/catch` for control flow.
- `TypedEventBus` (in `packages/core/src/event-bus/`) is the primary inter-module state transition mechanism; logs supplement, not replace.
## Layers
- Purpose: Zero-dependency primitives and all port contracts, domain types, security utilities, config schema, event types.
- Location: `packages/shared/src/`, `packages/core/src/`
- Contains: `Result<T,E>`, `NormalizedMessage`, `ChannelPort`, `MemoryPort`, `SecretManager`, `TypedEventBus`, `AppContainer`, `AppConfig` (Zod-validated), `AsyncLocalStorage` context propagation, `safePath`, `validateUrl`, `wrapExternalContent`.
- Depends on: Nothing (shared), only `shared` (core).
- Used by: Every other package.
- Purpose: Concrete implementations of core port interfaces.
- Location: `packages/infra/src/` (Pino logger, runtime clock/env/timers), `packages/memory/src/` (SQLite), `packages/channels/src/` (platform adapters), `packages/gateway/src/` (HTTP/WS)
- Contains: `SqliteMemoryAdapter`, `TelegramAdapter`, `DiscordAdapter`, `createSystemClock`, `createSystemEnv`, `createSystemTimers`, Pino logger.
- Depends on: `core`, `shared`.
- Used by: `daemon` (wires them at the composition root).
- Purpose: Business logic — executing LLM calls, routing messages, assembling tools, scheduling tasks.
- Location: `packages/agent/src/`, `packages/orchestrator/src/`, `packages/skills/src/`, `packages/scheduler/src/`
- Contains: `PiExecutor`, `InboundPipeline`, `ExecutionPipeline`, `MessageRouter`, `SkillRegistry`, `CronScheduler`, `HeartbeatRunner`.
- Depends on: `core`, `shared`, and typed port interfaces (not concrete adapters).
- Used by: `daemon`.
- Purpose: Single-process entry point; wires all adapters into domain services; 5-stage sequential boot chain.
- Location: `packages/daemon/src/daemon.ts`
- Boot stages: `bootFoundation` (secrets, config, event-bus) → `bootAgents` (MCP, tools, executor factory) → `bootChannels` (platform adapters) → `bootGateway` (HTTP, RPC, WebSocket) → `bootShutdown` (health logging, startup banner).
- Depends on: Everything.
- Used by: `node packages/daemon/dist/daemon.js` (production direct) or `pm2` (development).
- Purpose: External-facing surfaces. `gateway` serves HTTP+WS to `cli` and `web`; `cli` sends typed JSON-RPC over WebSocket; `web` is a standalone SPA.
- Location: `packages/gateway/src/`, `packages/cli/src/`, `packages/web/src/`
- Contains: `hono-server.ts`, `rpc-client.ts`, Lit web components, REST/SSE/JSON-RPC API client.
- Depends on: `core` (types), `gateway` depends on `core`; `cli` and `web` are outbound-only.
## Data Flow
### Primary: Inbound Message → LLM Response
### Gateway / CLI / Web RPC Path
### Config Load Path
- Per-request context propagated via `AsyncLocalStorage` (`packages/core/src/context/context.ts`); `runWithContext()` called once per inbound request; `getContext()` / `tryGetContext()` used inside request paths.
- `traceId` auto-injected on all log lines via the Pino mixin bound in `packages/infra/src/logging/logger.ts`.
- Session state persisted to SQLite via `packages/memory/src/session-store.ts` (implements `SessionStorePort`).
- `TypedEventBus` carries state transitions for state-machine consumers.
## Key Abstractions
- Purpose: Single interface every chat platform adapter implements.
- Methods: `start()`, `stop()`, `sendMessage()`, `editMessage()`, `onMessage()`, `getStatus()`, plus optional reactions/threads/attachments.
- Examples: `packages/channels/src/discord/discord-adapter.ts`, `packages/channels/src/telegram/telegram-adapter/index.ts`
- Pattern: `createXxxAdapter(deps)` factory returning `ChannelPort`.
- Purpose: Channel-agnostic message shape; the lingua franca flowing through the system.
- Fields: `id`, `channelId`, `channelType`, `senderId`, `text`, `timestamp`, `attachments[]`, `chatType`, `metadata{}`.
- Every channel adapter converts its native format to this via `message-mapper.ts`.
- Purpose: The dependency container returned by `bootstrap()`; carries `config`, `eventBus`, `secretManager`, `pluginRegistry`, `hookRunner`, `shutdown()`.
- Pattern: Created once; `daemon.ts` threads its fields into every boot stage.
- Purpose: Explicit error handling everywhere; no throw-for-control-flow.
- API: `ok(value)`, `err(error)`, `tryCatch(fn)`, `fromPromise(promise)`.
- Chaining: Early-return pattern `if (!result.ok) return result;` — no `.map`/`.flatMap`.
- Purpose: Strongly-typed publish/subscribe for cross-package state transitions.
- Event domains: `AgentEvents`, `ChannelEvents`, `MessagingEvents`, `InfraEvents` (all in `packages/core/src/event-bus/`).
- Purpose: Interface for a single agent execution turn; returned by `createExecutor(agentId)` in daemon.
- Key method: `execute(message, sessionKey, overrides): Promise<Result<ExecutionResult, Error>>`.
- Implemented by: `PiExecutor` in `packages/agent/src/executor/pi-executor/pi-executor.ts`.
- Purpose: Central secret access; backed by environment snapshot passed at bootstrap time.
- Replaces all `process.env` access after the composition root.
## Entry Points
- Location: `packages/daemon/src/daemon.ts` (compiled to `packages/daemon/dist/daemon.js`)
- Invocation: `COMIS_CONFIG_PATHS="~/.comis/config.yaml" node packages/daemon/dist/daemon.js`
- Responsibilities: Secrets decryption, config load, all adapter wiring, gateway start, graceful shutdown.
- Location: `packages/cli/src/commands/` (compiled to `packages/cli/dist/cli.js`)
- Triggers: `node packages/cli/dist/cli.js <command>` — `config`, `agent`, `channel`, `health`, `doctor`, `sessions`, `memory`, `daemon`, `security`, `init`, `signal-setup`, etc.
- Communicates with daemon via `packages/cli/src/client/rpc-client.ts` over WebSocket JSON-RPC.
- Location: `packages/gateway/src/server/hono-server.ts`
- Serves: WebSocket at `/rpc`, REST at `/api/*`, SSE at `/events`, static SPA assets, `/health`.
- Location: `packages/web/src/` (Lit + Vite; served as static files by gateway or standalone)
- API client: `packages/web/src/api/api-client.ts` (HTTP/SSE), `packages/web/src/api/rpc-client.ts` (JSON-RPC).
## Architectural Constraints
- **Dependency direction:** Strictly inward to `core`. `daemon` → everything; `shared` → nothing. No package may import another package's `src/` internals — only its public `dist/index.js`.
- **Threading:** Single-threaded Node.js event loop. No worker threads in core agent path.
- **Global state:** `process.env` read ONLY in `packages/core/src/bootstrap.ts`, `packages/core/src/runtime/`, `packages/infra/src/runtime/`, daemon composition root, and `packages/web/src/api/`. Enforced by `test/architecture/globals.test.ts`.
- **Circular imports:** Prevented by `pnpm cycles` (madge dist-mode check). `packages/orchestrator` cannot import from itself by name; uses relative imports for internal modules.
- **`ChannelPort` adapters** in `packages/channels/` must never depend on `@comis/infra` or `@comis/orchestrator` directly.
- **`@comis/agent`** must not reference `@comis/infra`; receives logger via `Deps` injection.
- **File size caps:** Production `.ts` files ≤ 800 lines; `agent/executor/` sub-modules have tighter caps. Enforced by `test/architecture/file-size.test.ts`.
- **`throw` is forbidden** outside `security/`, `safety/`, `error-mapper.ts` boundary modules without `// @allow-throw: <reason>`. Enforced by `test/architecture/raw-throw.test.ts`.
## Anti-Patterns
### Cross-package internal imports
### Reading `process.env` in non-sanctioned locations
### `path.join()` for user-controlled path segments
### `try/catch` for control flow in domain code
## Error Handling
- `ERROR` and `WARN` logs require `hint` (operator-actionable next step) and `errorKind` (closed 10-member union: `config | network | auth | validation | precondition | timeout | resource | dependency | internal | platform`).
- `suppressError(promise, reason, logger?)` from `@comis/shared` wraps fire-and-forget async paths instead of empty `.catch(() => {})`.
- `PreconditionError` and `ValidationError` from `packages/daemon/src/api/errors.ts` are typed-class throws inside RPC handlers; caught and classified to `warn`-level by the dispatcher.
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
