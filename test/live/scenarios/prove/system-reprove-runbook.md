# System health verification runbook

The **system verification** is the reason-to-exist proof: the manual cross-session
triage the by-hand review ran on `daemon.log` (a severity histogram + a
group-by-message + a pm2 native model scrape) is replaced by **one
`obs.system.health` call, zero log-greps**. This runbook documents the operator's
**live costed RUN** — the half the always-on scenario cannot do in CI.

> **KEYLESS.** The system proof is a
> count/structure reproduction — there is **no model, no judge, no API key, no
> live-gate env flag, and no new environment variable of any kind**. The live RUN
> only boots the (already-built) daemon and reads its output. If you came here
> looking for a judge-env block (the live-gate apparatus), there isn't one —
> that is by design.

---

## Two tiers (the Stage-A/B-vs-Stage-C discipline, keyless)

- **The always-on scenario** (`system-reprove.test.ts`, **keyless, in `pnpm
  test:live prove`**) proves the deterministic STRUCTURE: a single
  `assembleSystemHealthReport` call over a **seeded** store reproduces the corpus's
  signal classes — both flagship health signals (`health_signal:lcd_divergence` +
  `health_signal:mcp_reconnect_failed`), `model_health` + `config_posture`
  (I-track), and the A-track rates (`degradedRate` / `topErrorKinds` /
  `breakerTripTotal` / `cost.costUsd`) — in **1 call, 0 log-greps**. No daemon, no
  key, no env read. It writes only to a `mkdtempSync` tmp dataDir.

- **The operator's live RUN** (this runbook, **NOT in CI**) proves the
  **end-to-end loop** against REAL, freshly-written rows: the new instrumented
  daemon writes real `health_signal` / `model_health` / `config_posture` rows, and
  one `node packages/cli/dist/cli.js system` call surfaces them.

### Why the live RUN exists — the LOAD-BEARING scope reality

The in-context scenario **SEEDS** the I-track because **the current real `~/.comis`
was produced by an earlier daemon build**. It has the A-track (`session_summary`) rows the earlier
daemon already wrote, but **NO `health_signal` / `model_health` / `config_posture`
rows** — those are written **only when the new instrumented daemon RUNS**. So the
deterministic scenario proves the assembler surfaces those rows *when present*
(seeded); the live RUN is what actually produces them against real data. This is
the single most load-bearing fact about the proof's split.

---

## NO hard-coded target

The contrast against `test/live/fixtures/system-triage/manual-cost-to-beat.json` is
**narrative / qualitative**, never a numeric delta in any `pnpm validate`-tier
check. The manual cost the lens replaces is:

- a **severity histogram** over `daemon.log` (the WARN/INFO/ERROR tally) →
  reproduced by the report's `findings` + `topErrorKinds`,
- a **group-by-message** over the recurring WARNs (LCD divergence ×N, config
  posture ×N, MCP reconnect ×N) → reproduced by the report's `findings` grouped by
  the closed `signal` label, and
- a **pm2 native-stdout model scrape** (the `node-llama-cpp` tokenizer line that is
  invisible to Pino) → reproduced by the report's `model_health` finding.

The proof is **STRUCTURE** (those classes appear in one report), not "the lens
saved K tokens / M minutes". There is no number to maintain.

---

## The operator RUN — boot the new daemon, then ONE call

The Comis CLI is **NOT on PATH** — invoke it as `node packages/cli/dist/cli.js …`
(never a bare `comis …`).

### 1. Boot the new instrumented daemon (the canonical pm2 clean-start)

`pm2 restart` re-execs the **cached** exec path — it does NOT re-read the config or
pick up your `pnpm build`. Use the canonical clean-start block from `CLAUDE.md` so
the live process runs **this checkout's** `dist`:

```bash
node packages/cli/dist/cli.js pm2 setup        # regenerate ecosystem.config.js for THIS checkout
pm2 delete comis 2>/dev/null                    # drop the cached process def
rm -f ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak        # purge stale saved exec paths
rm -f ~/.pm2/logs/comis-*.log                    # purge stale logs (pm2 flush is blind to a deleted app)
pnpm build && pm2 flush                          # rebuild this checkout + clear remaining logs
node packages/cli/dist/cli.js pm2 start          # start from the freshly-written config
pm2 save --force                                 # rewrite dump.pm2 to the correct state
```

Verify the live exec path points at **this** checkout (replace `<this-checkout>`
with your repo path — do not paste a home/hostname into a committed file):

```bash
pm2 jlist | node -e 'const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="comis");console.log(p.pm2_env.pm_exec_path)'
# expect: <this-checkout>/packages/daemon/dist/daemon.js
```

### 2. Exercise it so the REAL I-track rows get written

Run real sessions and, where you can, drive the flagship signals so the new
diagnostic rows are produced:

- **LCD divergence** → a live/store divergence that fail-closed-rolls over
  (`health_signal:lcd_divergence`).
- **MCP churn** → a reconnecting / failing MCP server (`health_signal:mcp_reconnect_failed`).
- **A degraded session** → any session that trips a breaker or accrues errorKinds
  (feeds the A-track `degradedRate` / `topErrorKinds` / `breakerTripTotal`).
- **Provider/model degradation** → if reproducible, exercises `model_health`.

The more of the corpus's flagship classes you can trigger, the more of the manual
triage the single call reproduces against real data.

### 3. Surface the system in ONE call (0 log-greps)

```bash
node packages/cli/dist/cli.js system --since 24
# JSON for transcription / tooling:
node packages/cli/dist/cli.js system --since 24 --format json
```

Confirm, in that **single** call, that the report's `findings` now include the
**now-real** I-track signals (`health_signal:lcd_divergence` /
`health_signal:mcp_reconnect_failed` / `model_health` / `config_posture`) plus the
A-track rates — with **ZERO `daemon.log` reads**. The 0-grep property is
architectural: the assembler reads sqlite (`memory.db`) + the session-index
`.jsonl` day-files only; it never opens `daemon.log`. You should not need to grep a
log to answer "what's wrong across the system right now" — that is the whole point.

---

## Skip ≠ fail + NO new env var

- The always-on `system-reprove.test.ts` stays **GREEN with no operator action** —
  it is keyless and seeds its own store. There is no `it.skip` judged tier and no
  env gate; nothing about the live RUN can turn `pnpm validate` / `pnpm test:live`
  red.
- The live RUN is **operator-gated** (it needs a box with a real `~/.comis` and a
  running daemon — neither exists on CI). Not running it is **not a failure**.
- **No new environment variable.** The system proof introduces none — no live-gate
  flag, no judge-env block, nothing. The live RUN is just "boot the daemon,
  exercise it, call the system health view".

This is the live costed run. The in-context proof does
**not** require a running daemon.

---

## Recording table (transcribe per run)

`Surfaced` = yes / no / `NOT-RUN`. Fill one row per live RUN. The expectation: every
flagship class you exercised appears in the findings of the **one**
`node packages/cli/dist/cli.js system --since 24` call, the A-track rates are
populated, and you read **zero** log lines to get there.

| Date | LCD divergence | MCP reconnect | model_health | config_posture | degradedRate | topErrorKinds | breakerTripTotal | costUsd | 1 call / 0 grep | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |
| | | | | | | | | | | |

`1 call / 0 grep` = confirm the whole system picture came from a single
`node packages/cli/dist/cli.js system --since 24` invocation with no `daemon.log`
grep — the milestone's thesis, proven against real data.
