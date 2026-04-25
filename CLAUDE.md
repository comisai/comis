# CLAUDE.md

Read `AGENTS.md` before any code change — it is the authoritative engineering protocol.

## Project

Comis is a security-first AI agent platform connecting agents to chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). TypeScript monorepo, 13 packages, hexagonal architecture (ports + adapters). Node.js >= 22, Linux-only.

## Build & Test

```bash
pnpm install                    # native deps: better-sqlite3, sharp
pnpm build                      # all packages (tsc + project references)
pnpm test                       # unit tests (Vitest workspace)
pnpm lint:security              # security ESLint rules
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

Primary validation: `pnpm build && pnpm test && pnpm lint:security`.

## Daemon

Data dir: `~/.comis`. The `comis` CLI is **not on PATH** — use `node packages/cli/dist/cli.js`.

### pm2 (recommended)

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

### Direct (alternative)

`COMIS_CONFIG_PATHS` must be set on the same command line — `export` does not propagate to backgrounded processes from tool environments:
```bash
pkill -f 'node.*daemon\.js' 2>/dev/null && sleep 1 && COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" nohup node packages/daemon/dist/daemon.js >/dev/null 2>&1 &
```

## Logging (Pino via `@comis/infra`)

| Level | Use For |
|-------|---------|
| ERROR | Broken functionality. Required: `hint`, `errorKind`. |
| WARN  | Degraded but functional. Required: `hint`, `errorKind`. |
| INFO  | Boundary events only (request arrived, execution complete). 2–5 lines/request. |
| DEBUG | Internal steps, individual tool/LLM calls, intermediate state. |

Once per request → INFO. N times per request → DEBUG (aggregate count in INFO summary).

Object-first syntax only: `logger.info({ agentId, durationMs, toolCalls: 3 }, "Execution complete")`.

Canonical fields: `agentId`, `traceId` (auto-injected via AsyncLocalStorage mixin), `channelType`, `durationMs`, `toolName`, `method`, `err` (**not** `error` — matches Pino serializer), `hint`, `errorKind`, `module` (set via `logLevelManager.getLogger("module")`).

Pino auto-redacts credentials (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`) up to 3 levels deep. Redaction is a safety net — never log secrets, message bodies, or env values at any level.

## Worktree Cleanup

After merging a worktree branch back, remove the worktree and its tracking branch — do not leave stale worktrees:
```bash
git worktree remove .claude/worktrees/<name> --force
git branch -D worktree-<name>
```
