# CLAUDE.md

Read `AGENTS.md` before any code change — it is the authoritative engineering protocol.

This file is a Claude-specific operational supplement. If anything here conflicts with `AGENTS.md`, follow `AGENTS.md` and update this file.

## Generic Runtime Check — Before Every Code Change

Preserve Comis as a generic agent runtime on every change. Before editing production code, read `docs/developer-guide/generic-agent-architecture.md` and decide whether the requested behavior is a universal runtime mechanism or application-specific expertise.

- Runtime code may provide reusable mechanisms for orchestration, models, tools, memory, channels, scheduling, approvals, delivery, observability, security, typed prompts, locale policy, and immutable workspace policy.
- Do not add an industry, persona, business workflow, fixed human language, response script, domain vocabulary, or task-specific tool instructions to the engine prompt, workspace starters, default config, `packages/core`, or `packages/agent`.
- Put deployment-specific policy and persona in operator workspace files. Put reusable procedures, examples, domain knowledge, and tool-selection guidance in an opt-in prompt skill. When it should ship with Comis, build a repository-shipped skill at `skills/<name>/SKILL.md` instead of specializing runtime code.
- Put external API capabilities behind MCP or a typed adapter. Keep their instructions bounded and attributed, preserve side-effect/approval metadata, and never let integration or skill prose grant capabilities or override engine/operator policy.
- Promote behavior into the runtime only when an unrelated deployment can use it without inheriting the requester's assumptions. Do not accept a temporary hard-coded special case.

During final diff review, ask: **would a completely unrelated agent inherit any domain assumption from this change?** If yes, move that behavior to workspace policy, a skill, MCP, or an adapter before calling the change complete. Run `pnpm vitest run test/architecture/generic-runtime-boundary.test.ts` for every change touching runtime prompts, workspace policy, locale behavior, integrations, health surfaces, or specialization boundaries; extend that gate when the new regression class is not already covered.

## Tests-First

Every fix and every feature in `packages/*/src/**` starts with a failing test that fails on the pre-patch code, then a production patch that flips it to green. Commit the test first when practical so the failing state is reproducible from that commit alone. Exempt only: pure docs, comments, formatting, and build-tooling/CI/config edits — when in doubt, write the test.

## Docs-Current

Keep `docs/**/*.mdx` up to date in the **same change** that alters anything they describe — user-facing behavior, config keys/defaults, CLI commands/flags, file paths and the `~/.comis` data-dir layout (`docs/operations/data-directory.mdx`), env vars (`docs/reference/environment-variables.mdx`), logging, and install/release steps. A patch that leaves the docs describing the old behavior is incomplete. Run `pnpm docs:check` (cheap, no build needed; also part of `validate`) to catch MDX errors. The docs sit **outside** the build/lint/coverage gates, so drift fails silently rather than breaking a gate: e.g. `COMIS_LOG_PATH`'s documented default was wrong (`~/.comis/logs/daemon.log`) for ages because nothing checked it. When you rename or move a path/flag/key, `grep -rn '<old-name>' docs/` and fix every hit.

## Root-Cause Before Patching

A bug is usually a **layer mismatch** — two parts of the system disagreeing — not a defect at the site that throws. Before fixing: read the docs/design for the *intended* behavior (you may be about to contradict it), trace the mechanism **end-to-end across every layer** (don't stop at the first file that throws), and fix the **authoritative** layer — never a parallel guard/allowlist/special-case at a convenient layer that hides the symptom and leaves the architecture inconsistent. Prove it against **ground truth** — the real artifact (trajectory, `~/.comis` db, `comis explain`) or a live drive — never a green mock that passes while the real wiring is broken. When the right fix is a genuine design/product tradeoff, settle it with the user first. (AGENTS.md §2.11.) This cost a wrong-fix-then-revert here: a denylist that *hid* the dead admin `*_manage` tools instead of reconciling the deny-by-origin/trust layers; and a mock-store test that went green while compact failed against the real empty store.

## No Pre-History in Comments/Docs/Strings

The public repo shows no build pre-history. Never add (AGENTS.md §2.12): process/traceability IDs (`WR-01`, `Phase 193`, `.planning/…`, `design §…`), Comis version pre-history (`v2.31`, "added in vX", migration framing), milestone codenames ("Glass Box"), or reference-project names (Hermes, OpenClaw/clawdbot, Deer-Flow). State the constraint, not its origin. **Runtime strings — log messages, `hint`s, tool/CLI output — carry ZERO of these; cleaning one is a behavior change, so update its asserting test in the same commit.** Keep third-party/standards versions, GitHub `#refs`, real code identifiers (`SEC-GW-003` codes, live-test scenario IDs, `architecture-allowlist` phase types), and license attributions in `NOTICE`.

## Project

Comis is a security-first AI agent platform connecting agents to chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). TypeScript monorepo, 16 packages, hexagonal architecture (ports + adapters). Node.js >= 22, Linux-only.

## Build & Test

```bash
pnpm install                    # native deps: better-sqlite3, sharp
pnpm build                      # all packages (tsc + project references) — incremental
pnpm clean                      # rm packages/*/dist + *.tsbuildinfo (force a clean-room build)
pnpm build:clean                # clean && build — matches a fresh CI checkout
pnpm test                       # unit tests (Vitest workspace) — watch mode (CI=true → run-once)
pnpm test:coverage              # vitest run --coverage; floors are PER-PACKAGE (see vitest.config.ts)
pnpm lint:security              # security ESLint rules
pnpm docs:check                 # compile docs/**/*.mdx — catches MDX syntax errors the Mintlify deploy would reject
pnpm cycles                     # madge dist-mode .d.ts circular-dep check
pnpm cycles:refs                # tsc -b --dry packages/comis — project-reference cycle (TS6202) check
pnpm validate                   # FULL local mirror of CI's deterministic gates (see below)
pnpm validate:full              # validate + integration coverage + tarball smoke (needs Linux + ffmpeg/bubblewrap)
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

Primary validation: **`pnpm validate`** = `docs:check && build:clean && cycles && cycles:refs && lint:security && test:coverage`. This is the local mirror of CI's deterministic, cross-platform gates — run it before pushing. It deliberately uses **`build:clean`** (not incremental `build`) and **`test:coverage`** (not bare `test`) because those are exactly the gaps that let the #133 build-cycle + coverage cascade reach `main`: a stale `dist/` hides a workspace-dependency cycle, and the per-package coverage floors are CI-only unless coverage actually runs. **`docs:check`** runs first (cheap, no build needed) and compiles every `docs/**/*.mdx` through the MDX compiler — the docs are otherwise outside every gate (build/cycles/lint/coverage all scope to `packages/*`), so a bare `<`/`{` in prose used to fail only server-side at the Mintlify deploy. It also runs as its own `ci.yml` step since the pre-push hook can be skipped with `--no-verify` (which the hook itself suggests for docs-only pushes).

A **pre-push git hook** (`.githooks/pre-push`, auto-installed by the `prepare` script via `git config core.hooksPath .githooks`) runs `pnpm validate` and blocks the push on failure. Bypass a single push with `git push --no-verify`. The integration/E2E/tarball/audit tiers are NOT in the hook (they need Linux + ffmpeg/bubblewrap) — run `pnpm validate:full` on Linux or rely on CI.

**`pnpm validate` green on macOS ≠ CI green** — it is the cross-platform *floor*, not the full surface. Three CI classes it cannot run on a Mac (all hid behind a chronically-red CI once, 2026-06-21): (1) the **Docker image build** — `validate`'s `pnpm build` uses the fully-installed local workspace, but the image has a *selective* `COPY packages/<n>/package.json` + frozen-install layer, so a package missing from that hand-maintained COPY list (`@comis/observability-otel` → `@opentelemetry/*` TS2307) fails ONLY in `docker-release.yml`. That drift class is now caught locally by `test/architecture/dockerfile-workspace-packages.test.ts` (runs in `validate` via the architecture project) — but the Docker *build itself* still isn't run pre-push. (2) **`*.linux.test.ts`** tests **skip on macOS** (real-`bwrap` gated). (3) **integration tests** (`test/integration/**`) run via a SEPARATE config and are in `validate:full`, NOT `validate`. So before merging anything that touches sandboxing (bwrap), packaging (Docker/tarball), or daemon behavior, run `pnpm validate:full` + a Docker build on **Linux — the VPS is that box** (`/tmp/vps.sh`); reproducing there caught the bwrap + audit-schema regressions in one shot. And keep CI green: a red baseline makes the unit step fail first, so the integration step never runs and its regressions pile up invisibly.

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

**Clean the pm2 cache before every start — do not rely on `pm2 restart`.** `pm2 restart` re-execs the **cached exec path** stored in the running process (and in `~/.pm2/dump.pm2`); it does **not** re-read `ecosystem.config.js`. So once the daemon has been started from any checkout, every later `restart` stays pinned to that path — your `pnpm build` in *this* checkout then has zero effect on the live process, and the symptom is silent (daemon looks healthy, runs stale code from another directory). The saved `dump.pm2` / `dump.pm2.bak` persist those stale paths across reboots via `pm2 resurrect`, and have been observed pointing at long-dead sibling checkouts.

Canonical start/restart — force pm2 to re-read the config and refresh its saved state:
```bash
node packages/cli/dist/cli.js pm2 setup        # regenerate ecosystem.config.js for THIS checkout's cwd
pm2 delete comis 2>/dev/null                    # drop the cached process def (next start re-reads the config)
rm -f ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak        # purge stale saved exec paths (may point at old checkouts)
rm -f ~/.pm2/logs/comis-*.log                    # purge stale logs — `pm2 flush` below is BLIND to comis (flush only truncates MANAGED apps, and comis was just deleted)
pnpm build && pm2 flush                          # rebuild this checkout + clear any remaining logs
node packages/cli/dist/cli.js pm2 start          # starts from the freshly-written ecosystem.config.js
pm2 save --force                                 # rewrite dump.pm2 to the current, correct state
```
After starting, **verify pm2 is actually running this checkout** (not a cached path):
```bash
pm2 jlist | node -e 'const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="comis");console.log(p.pm2_env.pm_exec_path)'
```
It must print `…/<this checkout>/packages/daemon/dist/daemon.js`. If it points elsewhere, the cache wasn't cleared — repeat the block above.

**Clear the stale pm2 log files before every start — `pm2 flush` alone is NOT enough.** `pm2 flush` only truncates logs for *currently-managed* apps, and the canonical block runs it *after* `pm2 delete comis`, so `comis-out.log` / `comis-error.log` are left untouched with prior-session content. This bites hard: a *previous* failed boot's `FATAL: Bootstrap failed` lines survive into a healthy run's error log (the live process appends to the un-truncated file), making a working daemon look broken — observed 2026-06-06, where 6 stale `Missing env var COMIS_GATEWAY_TOKEN` FATALs masked a clean start (gateway listening on 4766, 0 restarts, `Comis daemon started` in the structured log). Always `rm -f ~/.pm2/logs/comis-*.log` (as in the block above) so the logs you read after start belong only to this boot. The authoritative startup record is the structured Pino log at `~/.comis/logs/daemon.*.log` (look for `"Comis daemon started"`), not the pm2 stdout/stderr capture. Verify startup (use `run_in_background: true`):
```bash
sleep 5 && pm2 logs comis --lines 10 --nostream
```
Look for `"Comis daemon started"`. On `FATAL: Bootstrap failed`, restore last-known-good:
```bash
cp ~/.comis/config.last-good.yaml ~/.comis/config.yaml && pm2 restart comis
```

### Direct (production)

How VPS deployments and the published `comisai` package run the daemon — Node directly with `--permission` flags. Do not assume pm2 is present when debugging a production install; expect a bare `node …/daemon.js` process.

`COMIS_CONFIG_PATHS` must be set on the same command line — `export` does not propagate to backgrounded processes from tool environments:
```bash
pkill -f 'node.*daemon\.js' 2>/dev/null && sleep 1 && COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" nohup node packages/daemon/dist/daemon.js >/dev/null 2>&1 &
```

## Logging (Pino via `@comis/infra`)

Levels, syntax, event-bus rules: see AGENTS.md.

Canonical fields: `agentId`, `traceId` (auto-injected via AsyncLocalStorage mixin), `channelType`, `durationMs`, `toolName`, `method`, `err` (**not** `error` — matches Pino serializer), `hint`, `errorKind`, `module` (bound once via `getLogger("…")`), `submodule` (call-site scope; reuse via `deps.logger.child({ submodule: "completion-runner" })`), `step` (pipeline-stage tag).

Pino auto-redacts credentials (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`) up to 3 levels deep. Redaction is a safety net — never log secrets, message bodies, or env values at any level.

**Instrument for troubleshooting (full observability).** Treat every new boundary crossing — channel inbound, RPC, tool call, external API, queue hop — as something an operator must be able to reconstruct from logs + events alone, with no debugger and no live repro. Per the §2.7 logging matrix in AGENTS.md, that means: an INFO completion line with `durationMs`, an ERROR/WARN carrying `hint` + `errorKind` on every failure branch, a `step:`-tagged DEBUG per intermediate stage, and an `eventBus` event for each state transition / health signal. Let `traceId` ride the AsyncLocalStorage context so one request stitches together across packages — don't open a fresh context mid-flow and orphan it. Litmus test before you call a path done: can you explain exactly how its next production failure would be diagnosed from the logs it emits? If not, add the missing instrumentation now, not after the incident.

## Diagnosing a degraded session — or the whole daemon (system health view)

**Production-troubleshooting decision tree (Claude Code: run these, in this order, before any `daemon.log` grep).** The CLI is not on PATH — prefix every command with `node packages/cli/dist/cli.js`.

| Symptom / question | First command | What it answers |
|---|---|---|
| "Review the production logs" / daemon-wide health | `system --since <N>` | degraded rate, top errorKinds, breaker trips, cost, + the `health_signal`/`model_health`/`config_posture` findings (the worst session to drill into) |
| One bad/degraded session (you have a sessionKey or traceId) | `explain "<sessionKey\|traceId>"` | deterministic `likelyRootCause` + outcome/cost/failures(+provenance)/breaker timeline/contextBudget/offloads |
| "Which model/provider actually ran?" / a phantom capability profile | `system` → look for `config_posture:chimeric_model` | a NATIVE provider (anthropic/openai/google) paired with a foreign model family — named in one look |
| A **non-default** agent's cron/conversation (multi-agent daemon) | pass an explicit `agentId` (below) | which agent the op acted on (never a silent default) |
| Recall surfaced the wrong/no memory, or "is this agent- or user-scoped recall?" | trajectory `memory.*` records + `~/.comis/memory.db` (the recall lens is the obs-excellence roadmap — see `.planning/design/observability-excellence.md`) | the ranked set / scope used |
| Who accessed a secret / what command was blocked / an injection-detection (the security audit) | `security audit-log` | the durable, scrubbed `obs_audit_events` trail — filter by kind/agent/tenant/outcome; also `obs_query {action:"audit"}` + the optional `audit?` IncidentReport section |
| A spend ceiling tripped / a session killed for cost | `explain "<sessionKey\|traceId>"` | the `spend_exceeded` `likelyRootCause` verdict + the `spend?` section; `system` surfaces `config_posture:pricing_gap` (unknown-priced spend) |
| "Pull up the messages users sent" (per channel / chat / date window) | `messages --channel telegram --date <YYYY-MM-DD>` (offline; `--format text\|jsonl` for full bodies) | the inbound messages users typed, parsed from the raw session jsonl for you — never hand-grep `workspace/sessions` for this again; internal cron/sub-agent dispatch excluded + counted |

**Ground-truth read-order (never trust a surface reply alone):** surface reply → the session **trajectory** (`*.jsonl.trajectory.jsonl`, resolved via the `.trajectory-path.json` pointer) + `_session-metadata.json` rollup → offline `obs.explain` (`assembleIncidentReportFromSources`) → `comis system-health` → only then a raw `daemon.log` grep. A false success is the worst outcome — corroborate every claim against the db/trajectory.

**Multi-agent targeting.** `cron.run` / `cron.list` / `cron.runs` / `cron.status` / `session.reset_conversation` take an optional `agentId` — pass it to act on a NON-default agent (the default agent is otherwise resolved from the connection, silently). `cron.list` with `agentId: "*"` returns EVERY agent's jobs. Every response states the `resolvedAgentId` it acted on; a 0-row reset reports the scope rather than failing silently. (Without this, a cron triggered for `mldag` ran on `default`, and a reset returned `lcdRowsDeleted:0` — both diagnosed the hard way.)

**Start with `obs.explain` — do NOT hand-join the logs.** It exists so an agent (or you) root-causes a bad session in one call instead of grepping four files. The CLI is not on PATH:

```bash
node packages/cli/dist/cli.js explain "<sessionKey|traceId>" [--depth summary|full] [--format json]
```

It returns a bounded, digest-only `IncidentReport` (outcome, cost, per-tool `{ok,failed}`, normalized failures with `classifiedFailureBy`/`transportOk`, breaker timeline, large-result offload pointers, and a deterministic `likelyRootCause` — no LLM, same input → same verdict). Same report via the `obs_query` agent `explain`/`session_report` actions and the permission-gated `obs_explain` MCP tool. Docs: `docs/reference/cli.mdx` (`comis explain`) + `docs/reference/json-rpc.mdx` (`obs.explain`).

**For daemon-wide / cross-session triage — when asked to "review the production logs" — start with `comis system-health`, NOT a `daemon.log` grep.** `obs.explain` sees ONE session; `obs.system.health` sees the **whole daemon over the last N hours** — the automated version of a by-hand log sweep. CLI is not on PATH:

```bash
node packages/cli/dist/cli.js system --since 24 [--format table|json]    # default window 24h
```

Returns a bounded, admin-gated, deterministic `SystemHealthReport` — **counts + hints only, never raw WARN bodies or secrets** (so it is safe to paste into a review): cross-session degraded rate, top errorKinds, breaker trips, cost, plus the signals that used to be log-file-only — `health_signal` (LCD-divergence + MCP churn/reconnect/budget), `model_health` (embedding-provider / GGUF load / reranker presence at boot), `config_posture` (TLS-off / stranded-secret-**count** / canary-fallback / `served_below_configured` / `chimeric_model` — a native-provider+foreign-model mismatch). Same report via the `obs_query` `system_health` action + the permission-gated `obs_system_health` MCP tool + the `obs.system.health` RPC. Docs: `docs/reference/cli.mdx` (`comis system-health`) + `docs/reference/json-rpc.mdx` (`obs.system.health`).

**Two-tier workflow for "troubleshoot the logs":** `comis system-health --since N` to surface the daemon-wide pattern (which signal recurs, how degraded, at what cost) → then `comis explain <sessionKey|traceId>` on the worst session it points at to root-cause that one. Only fall through to a raw `daemon.log` grep if the system health view itself looks wrong. **Data caveat:** the ingested `health_signal`/`model_health`/`config_posture` rows only populate once a daemon running the **current build** has been up — on a daemon running a stale `dist/` you still get the session-rollup half (degraded/errors/breaker/cost) but the log-only half will be sparse; restart on the fresh `dist/` first (see the restart note below).

Only drop to the raw data when you're debugging the **observability layer itself** (it's what `obs.explain` / `obs.system.health` read). Layout is in `docs/operations/data-directory.mdx`; the load-bearing files:
- `~/.comis/workspace/sessions/<tenant>/<channel>/<file>.jsonl.trajectory.jsonl` — the trajectory (tool.result with provenance, `tool.result_offloaded` with `diskPathRel`, `session.summary`, `model.completed`). Resolve its path via the co-located `<file>.jsonl.trajectory-path.json` pointer (`runtimeFile`), **not** a hand-built `<dataDir>/sessions/<id>` guess — that path does not exist (it's the bug class §2.10 calls out).
- `…/<file>_session-metadata.json` — the flight-recorder `sessionEnd` rollup (`degraded`/`costUsd`/`toolStats`/`breakerTripCount`/`topErrorKinds`).
- `~/.comis/logs/{daemon.*.log, cache-trace.jsonl, session-index.<date>.jsonl}` and `~/.comis/memory.db` → `obs_diagnostics` (`category='session_summary'`).

**Restart the daemon before checking a code change against live `~/.comis`.** The running process holds its `dist/daemon.js` in memory (`pm2 jlist` → `pm_uptime`/`pm_exec_path`); a `pnpm build` does NOT hot-reload it. Use the canonical pm2 clean-start block above, or to test a fix without disturbing a live daemon, call the assembler directly off the fresh dist:
```bash
node -e 'const{assembleIncidentReportFromSources,makeRealReader}=require("./packages/daemon/dist/index.js");assembleIncidentReportFromSources(makeRealReader(process.env.HOME+"/.comis"),process.env.HOME+"/.comis",{sessionKey:"<key>",depth:"summary"}).then(r=>console.log(JSON.stringify(r,null,1)))'
```

## Troubleshooting Feedback Loop (mandatory after every investigation)

**Every troubleshooting session ends with an observability retro, and every friction found becomes an improvement — UNPROMPTED.** An investigation is not done when the root cause is found — it is done when the NEXT occurrence of that incident class is diagnosable in one or two obs calls. Do this **without being asked** (on the fly when you realise the gap, or at the end); having the user ask you to implement an improvement you already identified is a process failure. The loop's scope includes the **tooling you investigated *with*** — when a live-test harness/script (e.g. `test/live/self-driving/`) drifted, errored, or pointed you the wrong way, fix the kit too, not just the product. After any debugging/triage work (yours or a user-reported incident), replay your own diagnostic path and convert each point of friction into a change, test-first like any other fix, citing the live incident in the test/commit:

- **You grepped raw logs or hand-joined files** because `obs.explain`/`obs.system.health` lacked the data → thread that data into the trajectory (event-bus event → `TRAJECTORY_BRIDGE_MAPPING` → translator) and onto the `IncidentReport`/`SystemHealthReport`, then make the heuristic verdict consume it. (Precedent: the budget equation lived only on DEBUG lines; now `context.budget` → `IncidentReport.contextBudget` → a numbers-backed `context_exhausted` verdict.)
- **An error/hint told you WHAT but not WHICH KNOB** → make the message name the exact config key and the actual values that conflicted. (Precedent: "effective window 32000" vs configured 131072 — the error now names `contextEngine.budget.effectiveContextCapSmall` and both numbers.)
- **A message pointed you the WRONG way** → branch it by failure class so each class gets the hint that fits. (Precedents: "daemon not running" on an auth-rejected WS — close code 4001 now maps to a token-naming error and counts as liveness proof; "start Ollama" on an HTTP 400 from a running Ollama.)
- **Load-bearing evidence was DEBUG-only** (invisible at the default level) → promote a once-per-operation summary to INFO, or flight-record it on the degraded path. Diagnosability must not depend on `logLevel: debug` having been set before the incident.
- **The same field name meant different things on different lines** (e.g. four `activeToolCount` universes) or **two lenses double-counted** (e.g. cache-trace `tool:after` re-counting tool results) → rename/dedupe so the numbers reconcile.
- **A tool you needed was unreachable in the failure mode it exists to diagnose** (daemon down, token broken) → give it an offline/local path with honest `coverage` degradation, never a silent empty.
- **The verdict ranked chronic noise over the acute event**, or routine events inflated warning counts → fix the heuristic ordering / severity classification (`BENIGN_DAG_DEGRADED_REASONS` precedent).

Scope guard: do these in the same change-set when small (string/hint/severity fixes), or as an immediate follow-up branch when structural (new trajectory events, report sections) — but never silently drop them. If you genuinely must defer, leave a dated TODO naming the incident. The §2.7 litmus test extends to incidents: if you cannot say "next time, `comis explain <ref>` answers this in one call," the loop is not closed.

## Git & Branching

**Branch-first — never commit directly to the default branch (`main`).** Before the first change, cut a working branch off `main` (`feature/<desc>`, `fix/<desc>`, `docs/<desc>` — see AGENTS.md §9) and land the work through a PR. Commit or push only when the user asks: approval to *make* a change is not approval to push it, and approval in one turn doesn't carry to the next. If you discover you're already on `main` with uncommitted work, branch before committing — don't add to `main`'s history.

## Worktree Cleanup

After merging a worktree branch back, remove the worktree and its tracking branch — do not leave stale worktrees:
```bash
git worktree remove .claude/worktrees/<name> --force
git branch -D worktree-<name>
```

## Releases

Steps to ship `vX.Y.Z`:

1. **Bump all 16 `packages/*/package.json` to `X.Y.Z`** — they must move together. The umbrella `comisai` package (in `packages/comis/`) bundles the others, so version drift between them surfaces at publish time, not in local builds.

2. **Sweep for version pins.** The docs no longer pin release versions (de-pinned in the accuracy-first docs rewrite), so as of v1.0.54 this sweep should hit only the 16 `packages/*/package.json` — but run it every bump as the guard against a pin creeping back:
   ```bash
   grep -rn '<old-version>' --include='*.json' --include='*.mdx' --include='*.md' . \
     | grep -v node_modules | grep -v 'dist/' | grep -v package-lock | grep -v CHANGELOG
   ```
   `docs/operations/docker.mdx` mentions a version illustratively (`pushing vX.Y.Z produces …`) and is **not** bumped per release.

3. **Validate:** `pnpm validate` — clean build, cycles (madge + project-reference), lint:security, and coverage must all pass before the bump commit. (Skipping the cycles step once let a release ship with a missing `@comis/core` dep in `packages/web/package.json` and a latent 17-cycle backlog go unnoticed for days.) For the release, also run `pnpm validate:full` on Linux to exercise the integration + tarball tiers.

4. **Commit, push, tag:**
   ```bash
   git commit -m "chore(release): X.Y.Z"
   git push origin main
   gh release create vX.Y.Z --title vX.Y.Z --notes "<notes>"
   ```
   The `vX.Y.Z` tag triggers three workflows in `.github/workflows/` (there is no separate release-artifacts workflow — `gh release create` itself publishes the release):
   - `npm-publish.yml` — `pnpm publish -r --provenance` (sigstore attestation via GitHub OIDC). Runs `packages/comis/scripts/prepack.js`, which bundles `@comis/*` into `node_modules/@comis/` for inclusion in the tarball.
   - `docker-release.yml`, `dockerhub-release.yml` — multi-arch images (`linux/amd64` + `linux/arm64`), both `default` and `slim` variants. arm64 builds on a native runner (not QEMU).

   After the runs complete, verify the publish actually landed: `npm view comisai dist-tags` must show the new version (the npm job has silently drifted before).

### Supply-chain invariants (do not regress)

These are load-bearing for `npm install -g comisai`:

- **All `dependencies` / `devDependencies` are exact-pinned** (no `^` / `~`) across every `packages/*/package.json` and `website/package.json`. `workspace:*` is the only allowed non-numeric specifier — `prepack.js` rewrites it to literal versions for the published tarball.
- **`@comis/*` workspace packages are `"private": true` and bundled** via `bundledDependencies`. Never publish them to the npm registry.
