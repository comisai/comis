# CLAUDE.md

Read `AGENTS.md` before any code change — it is the authoritative engineering protocol.

This file is a Claude-specific operational supplement. If anything here conflicts with `AGENTS.md`, follow `AGENTS.md` and update this file.

## Tests-First

Every fix and every feature in `packages/*/src/**` starts with a failing test that fails on the pre-patch code, then a production patch that flips it to green. Commit the test first when practical so the failing state is reproducible from that commit alone. Exempt only: pure docs, comments, formatting, and build-tooling/CI/config edits — when in doubt, write the test.

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

**Clean the pm2 cache before every start — do not rely on `pm2 restart`.** `pm2 restart` re-execs the **cached exec path** stored in the running process (and in `~/.pm2/dump.pm2`); it does **not** re-read `ecosystem.config.js`. So once the daemon has been started from any checkout, every later `restart` stays pinned to that path — your `pnpm build` in *this* checkout then has zero effect on the live process, and the symptom is silent (daemon looks healthy, runs stale code from another directory). The saved `dump.pm2` / `dump.pm2.bak` persist those stale paths across reboots via `pm2 resurrect`, and have been observed pointing at long-dead sibling checkouts (`clawdbot/…`, a second `comisai/comis`, etc.).

Canonical start/restart — force pm2 to re-read the config and refresh its saved state:
```bash
node packages/cli/dist/cli.js pm2 setup        # regenerate ecosystem.config.js for THIS checkout's cwd
pm2 delete comis 2>/dev/null                    # drop the cached process def (next start re-reads the config)
rm -f ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak        # purge stale saved exec paths (may point at old checkouts)
pnpm build && pm2 flush                          # rebuild this checkout + clear logs
node packages/cli/dist/cli.js pm2 start          # starts from the freshly-written ecosystem.config.js
pm2 save --force                                 # rewrite dump.pm2 to the current, correct state
```
After starting, **verify pm2 is actually running this checkout** (not a cached path):
```bash
pm2 jlist | node -e 'const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="comis");console.log(p.pm2_env.pm_exec_path)'
```
It must print `…/<this checkout>/packages/daemon/dist/daemon.js`. If it points elsewhere, the cache wasn't cleared — repeat the block above.

Always `pm2 flush` before start/restart to keep logs clean. Verify startup (use `run_in_background: true`):
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
