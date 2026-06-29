# Live-test helper scripts — VPS + Telegram emulator

Ready-to-run versions of every helper used in the v2.29 M1 Codex+Anthropic live-test.
Read **`../01-SETUP.md`** for the full setup playbook and **`../03-OBSERVABILITY.md`** for the traps —
this folder is the copy-paste toolkit those docs refer to. (Driven by `../00-MISSION.md`.)

## Config (env vars — defaults target the v2.29 rig; override inline)

| Var | Default | Meaning |
|---|---|---|
| `VPS` | _(set in `.live-env`)_ | ssh target `user@host` — **auto-sourced** from `.live-env` by the local scripts; ssh KEY lives in your `~/.ssh` |
| `SRC` | `/root/comis-src` | the daemon's source tree on the VPS (dist is overlaid here) |
| `DATA` | `/home/comis/.comis` | the daemon data dir (config, secrets, sessions) |
| `GWTOKEN` | _(per box — set in `.live-env` / `~/.comis/.env`; not committed)_ | LITERAL ≥32-char gateway token — must match `config.yaml`'s `gateway.tokens[].secret` |
| `CHATID` | `678314278` | the emulator chat/sender id to drive |
| `MODELS`/`PRIMARY` | — | the model list + restore-target for `models-sweep.sh` |

## Run order

```bash
# 0. Push the WHOLE kit to the VPS (re-run every session — the framework is gitignored, so scripts on
#    the box DRIFT from this local kit; this keeps /root + /home/comis in sync, no archaeology):
bash test/live/self-driving/scripts/deploy-scripts.sh   # VPS=root@1.2.3.4 to override

# 1. ONCE per box — make the rig comis-runnable + open perms/chown:
ssh root@<vps> 'bash /root/setup-vps.sh'

# 2. After each local `pnpm build` — overlay your dist onto the VPS:
./.planning/live-tests/scripts/deploy-dist.sh        # run from the repo root

# 3. Clean-slate + (re)launch the daemon (run on the VPS as root):
ssh root@<vps> 'bash /root/lt-scripts/clean-restart.sh'

# 4. Drive:
ssh root@<vps> 'node /root/drive.mjs 678314278 "reply with PONG42"'
ssh root@<vps> 'export COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml; export COMIS_GATEWAY_TOKEN=<GWTOKEN>; node /root/revoke.mjs capabilities.introspect'
ssh root@<vps> 'MODELS="claude-sonnet-4-6 claude-opus-4-8" PRIMARY=claude-sonnet-4-6 nohup bash /root/lt-scripts/models-sweep.sh >/root/sweep.out 2>&1 &'
```

| Script | Runs on | As | Purpose |
|---|---|---|---|
| `deploy-dist.sh` | local checkout | you | overlay `packages/*/dist` onto the VPS (no rebuild on the box) |
| `deploy-scripts.sh` | local checkout | you | **push the WHOLE scripts/ kit to the VPS** (re-run per session — gitignored kit drifts from the box; syncs /root + chowns the comis-side launcher/supervisor) |
| `setup-vps.sh` | VPS | **root** | one-time: open `/root/comis-src` perms + chown `~/.comis` + install helpers |
| `restart-m1.sh` | VPS | **comis** (via `su - comis -c`) | kill + (re)launch the daemon with `--permission` |
| `clean-restart.sh` | VPS | root | clean-slate (wipe session/LCD/logs) + restart |
| `restart-emu.sh` | VPS | root | **robustly (re)launch the Telegram emulator** — survives ssh close (tmux) + anchored `pkill -9 -f "^node .*vps-emu"` (avoids the self-match that kills your ssh shell). Prints the new kernel-allocated port → re-patch `channels.telegram.apiRoot` + restart the daemon. Born openclaw-usecases 2026-06-25 (the emulator media-send fix needed an emu redeploy; bare `nohup … &` kept dying + `pkill -f vps-emu` self-killed the session). |
| `drive.mjs` | VPS | root/comis | inject a turn, wait for the **TURN to END** (trajectory `session.summary`/`execution.aborted`), capture the last substantive reply. **v2** (codex-30uc 2026-06-25): keys off the trajectory turn-end, not wire-silence, so async research/build/sub-agent turns don't quiesce on the agent's planning-checklist/"running it now" announcement; filters `[ ]`/`(step N of M)` as progress. Optional `DATA=` (5th arg/env) for the watch; falls back to wire quiescence if absent. **DAG caveat:** a graph turn ends at the agent's launch-announcement — poll `graph.status` for the graph itself. **First-turn cold-start** (hermes 2026-06-25): `resolveTraj()` runs BEFORE the inject, so the FIRST turn right after a clean-slate (session dir not yet created) prints `trajectory=NONE (wire-only)` and falls back to wire quiescence — harmless (the PONG still verifies); every subsequent turn watches the trajectory. |
| `media-drive.mjs` | VPS | root/comis | the **media analog of `drive.mjs`** — inject a photo/voice/audio/document via `/control/.../media` + poll outbound. `media-drive.mjs <chatId> <file-or-base64> <kind> ["caption"]`. **`<file-or-base64>` is AUTO-DETECTED** (existing path → read+encode; else inline base64) — fixes the old box one-off's `ENAMETOOLONG`-on-inline-base64 trap. Media INPUT is fetched by the daemon from the (allowlisted) emulator apiRoot; transcription/vision ACCURACY needs real media that survives the ffmpeg/decode pipeline (a synthetic blob fails-honestly = coverage-gap, not a bug). |
| `revoke.mjs` | VPS | root/comis | call ANY gateway RPC over WS (`run.kill`, `lease.revoke`, `capabilities.introspect`, `cron.list` …). **Typed params:** a single JSON-object arg is the WHOLE params (`revoke.mjs graph.execute '{"nodes":[…]}'`); else `key val` with val JSON-parsed (`obs.fleet.health sinceHours 1` → number `1`), falling back to string for bare ids. **Multi-param RPCs (`message.send`, `tokens.create`): use `--file`** (`printf '%s' '{…}' > /tmp/rpc.json; revoke.mjs message.send --file`) — the inline-JSON form gets mangled through `su - comis -c`. **`--pick <dotpath>`** prints ONLY that field of the result (`revoke.mjs obs.fleet.health sinceHours 24 --pick report.findings.0.code`) so you stop hand-writing `node -e 'JSON.parse(...)'` extractors. |
| `model-battery.mjs` | VPS | root/comis | **Track-K per-model CAPABILITY battery** (after cfg-patch model + clean-restart, per model): tool-call(grounded) · memory(teach+recall) · injection-resist(HARD no-leak) · reasoning. The capability dimension Track K's PONG-only sweep misses. Pairs with `models-sweep.sh` (liveness+modelId). `GWTOKEN` env for the leak check. |
| `gate-probe.mjs` | VPS | root/comis | **DETERMINISTIC security-gate / jail oracle prover** — calls the DEPLOYED guard off `dist/` directly: `floor` (`validateExecCommand` destructive denylist), `ssrf` (`validateUrl` — ASYNC `Result{ok}`), `invisible` (`stripInvisible` zero-click). `gate-probe.mjs [floor\|ssrf\|invisible\|all]`, `SRC=` overridable, exit 0/1. **The PRIMARY method for the prove-once gate/jail/exfil oracles** — a cautious frontier model refuses every adversarial-framed probe (so you get no gate stdout); this proves the actual deployed code-path instead. (bwrap egress is a kernel test — run the `bwrap --unshare-net` one-liner in `03-OBSERVABILITY.md` separately.) |
| `cfg-patch.mjs` | VPS | **comis** | the **Track-M workhorse** — deep-merge a JSON patch into `config.yaml` (preserves secrets, backs up). Reads `/tmp/patch.json` (write it first — `su - comis -c` drops env/quotes). Set a value, or pass `"__DELETE__"` to remove a key. Echoes the touched sections. |
| `logscan.mjs` | VPS | root/comis | **precise structured-field daemon-log scan** (replaces hand-written `grep \| node -e` projectors; immune to the `grep "degraded"`/`"transient"` false-positive class). `--level 50,60 [--uniq]`, `--kind <k>`, `--msg <substr>`, `--method <m>`, `--fields a,b,c`, `--last N`, `--raw`. |
| `db.mjs` | VPS | **comis** (so `HOME=/home/comis`) — but now **ROOT-HOME-guarded** (run as root → it resolves `/home/comis/.comis` + warns, instead of throwing on `/root/.comis`; `COMIS_DATA_DIR` overrides) | read-only DB oracle for `memory.db` (no `sqlite3` on the box). Canned: `tables`, `schema <t>`, `cols <t>`, `count <t>`, `rows <t> [n]`, `pick <t> <c1,c2> [n]`, `pickw <t> <cols> <col> <val>`, `sql <raw>`. The primary oracle for offline/learning/memory tests (`outcome_events`, `mental_models`, `memory_usefulness`, `memories`) + DB-resident HARD invariants (`schema mental_models` → the `trust_level CHECK`, no `scripts` col). |
| `reflect-run.mjs` | VPS | root/comis | **trigger a fire-and-forget learning cron AND wait for its REAL completion**, then print the content-free funnel. `reflect-run.mjs [jobName="Reflection"] [maxWaitS=120] [agentId]`. Polls the EXACT `"Reflection complete (all kinds)"` marker — NEVER the ~1s `"Job dispatched (fire-and-forget)"` dispatch line (a fixed-sleep there reads a false `count:0`; the reflection LLM call lands ~20s later). Born reflect-obs-20260627. Needs the `revoke.mjs` env (`COMIS_CONFIG_PATHS` + `COMIS_GATEWAY_TOKEN`) + `DATA` for the log dir. |
| `seed.mjs` | VPS | **comis** (read-WRITE `memory.db`) | the **read-WRITE companion to `db.mjs`** for the offline oracles that REQUIRE a seed (the live synthesis/failure-accrual chains are LLM-fragile): `seed.mjs skill <kebab-name> [proof=2] [kind]` mints a grounded read-only `mental_models` doc (candidate, trust=learned — surfaces + is reusable; default proof=2 so one reuse promotes at promoteAtProofCount=3); `seed.mjs failure <memId> <count> [content] [--proof=N] [--pinned]` seeds `memory_usefulness.failure_count` (+ the `memories` row) for the eviction/INV-4 gate. Never seeds a `scripts` column (none exists — advisory docs only, INV-3). Born reflect-obs-20260627. |
| `drive-sim-workload.sh` | VPS | **root** | **the per-workload ACC→REFLECT composition** for the memory/learning sim catalog (born memory-learning-stress-catalog-20260629 — RUN1+RUN2 each hand-orchestrated this loop ~14×). `drive-sim-workload.sh <workload> [variant=A] [feeder1=…279] [feeder2=…280]`: restart-m1 (fresh per-root meter — the RUN1 spurious-abort lesson) → disconnect every sim server + connect THIS workload's (one at a time, no tool confusion) → reset the 2 feeder sessions → **2 BYTE-IDENTICAL feeders** using the embedded canonical prompt per workload (the #5 prompt-table) → `reflect-run` → read GROUND TRUTH (mental_models delta + newest skill row + a grounding grep). Needs `COMIS_GATEWAY_TOKEN`+`COMIS_CONFIG_PATHS`. Wrap with `bg.sh` for the flaky link. **`drive-sim-workload.sh --check`** is an offline wiring-guard — asserts the embedded SERVER+PROMPT maps cover every sim workload dir (a `tools.json`), so a workload added to `sim/` but not registered here FAILS loudly (exit 1) instead of being silently un-drivable. |
| `explain.mjs` | VPS | root/comis | **offline IncidentReport oracle for ONE session** — runs `assembleIncidentReportFromSources` off the deployed dist + prints the diagnostic set: `failures[]` (w/ `classifiedFailureBy`+`matchedRule`+`transportOk`), `perRootBudget`, `likelyRootCause`, the learning block. `explain.mjs <sessionKey> [summary\|full] [--json\|--learning\|--failures\|--budget]`. Replaces hand-written `node -e 'assembleIncidentReportFromSources…'` one-liners + the **3 traps** that cost cycles: `.mjs`-vs-`.cjs` (dist is CJS), `ssh→su→node` quote-escaping, and **run-as-root → wrong HOME → 0 records → false "explain blind"** (ROOT-HOME-guarded). Sets `NODE_ENV=production` so it always returns the report (skips the dev-only strict parse). Born memory-learning-stress-catalog-20260629. |
| `bg.sh` | VPS | root/comis | **run a long box command DETACHED + pollable** — the flaky-VPS-link prescription as a helper (RUN1's W-10 dropped a 300s foreground drive; RUN2 hand-rolled nohup+poll 3×). `bg.sh <tag> '<command string>'` launches detached (setsid+nohup → `/tmp/bg-<tag>.out` + `.done` carrying the exit code); `bg.sh --poll <tag> [maxSec]` waits + tails; `bg.sh --tail <tag> [n]`. **Pass the whole command as ONE quoted arg.** Wrap `drive-sim-workload.sh` with it so an ssh drop never loses a run. Born memory-learning-stress-catalog-20260629. |
| `models-sweep.sh` | VPS | root | sweep a model list: swap config → restart → PONG → check actual `modelId` |
| `config.example.yaml` | — | — | reference config (literal token, nested budget, emulator apiRoot) |

## Gotchas (hindsight-verified-learning 2026-06-25 — don't re-discover)
- **`db.mjs count vec_memories` / `vec_learned_skills` fails `no such module: vec0`** — `db.mjs`'s plain better-sqlite3 handle doesn't load the sqlite-vec extension, so the `vec0` virtual tables are unreadable. To check the **vector+FTS reconcile** on a forget/delete (REC-3), count the plain **shadow** table `vec_memories_rowids` (and `memory_fts`) instead — they drop in lockstep with `memories`. (A kit improvement would be to load the vec extension in `db.mjs`, or add a `veccount <t>` that reads the `_rowids` shadow.)
- **`db.mjs sql "… WHERE x='lit'"` dies `unrecognized token: "\"`** — single-quoted SQL string literals don't survive the `ssh → su - comis -c "…" → node` quoting layers (the `\x27`/`'…'` escapes mangle). Prefer **`db.mjs pick <t> <cols> [n]`** (no literals) and filter/grep the JSON locally, or write the query to a `/tmp/q.sql` file and have `db.mjs` read it. Numeric/no-literal `sql` (e.g. `SELECT DISTINCT session_id FROM outcome_events`) is fine.
- **`logscan --msg <substr> --fields a,b` often prints `{}`** — `--msg` matches by substring so it catches the WRONG lines (`--msg completed` matches "Request completed"/"RPC call completed"; `--msg outcome`/`recall`/`memory_store` matched lines without those fields), and the `--fields` projection only reads TOP-LEVEL keys, returning `{}` when the field is nested or absent. When it returns `{}`, fall back to a **traceId-anchored raw grep** + `node -e` JSON.parse to read the real `err`/`hint`/`errorText` (the tool-failure errorText lives on a `level:40/50` `module:agent` "Tool execution failed" line, NOT on the `module:skills` audit line). A kit improvement: make `--fields` walk nested paths + tighten `--msg` to anchored/exact.
- **Skill-synthesis `admitted:0` is NOT "needs more corroboration" at HEAD — it's SYNTH-EMBED-DEAD** (embeddings never injected → all singletons). See `targets/EXAMPLE-verified-learning.md` + `runs/FINDINGS-LEDGER.md`. Don't re-investigate.

## Notes
- The **emulator** itself is launched from the repo's existing tooling: `tsx test/live/bin/vps-emu.ts`
  (deploy `test/live/` per runbook §0). It writes `/tmp/comis-emu.json` (`{apiRoot, port, botToken}`) which
  `drive.mjs` reads. It binds a **kernel-allocated loopback port** — re-patch `config.yaml`'s `apiRoot` if you
  restart it.
- `GWTOKEN` is NOT committed — set it per box in `scripts/.live-env` (gitignored) or the VPS `~/.comis/.env`, matching `config.yaml`'s `gateway.tokens[].secret`. Start from `.live-env.example`.
- All defaults are overridable: `VPS=root@1.2.3.4 SRC=/opt/comis ./deploy-dist.sh`.
