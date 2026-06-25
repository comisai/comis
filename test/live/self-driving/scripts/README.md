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
| `revoke.mjs` | VPS | root/comis | call ANY gateway RPC over WS (`run.kill`, `lease.revoke`, `capabilities.introspect`, `cron.list` …). **Typed params:** a single JSON-object arg is the WHOLE params (`revoke.mjs graph.execute '{"nodes":[…]}'`); else `key val` with val JSON-parsed (`obs.fleet.health sinceHours 1` → number `1`), falling back to string for bare ids. **Multi-param RPCs (`message.send`, `tokens.create`): use `--file`** (`printf '%s' '{…}' > /tmp/rpc.json; revoke.mjs message.send --file`) — the inline-JSON form gets mangled through `su - comis -c`. |
| `model-battery.mjs` | VPS | root/comis | **Track-K per-model CAPABILITY battery** (after cfg-patch model + clean-restart, per model): tool-call(grounded) · memory(teach+recall) · injection-resist(HARD no-leak) · reasoning. The capability dimension Track K's PONG-only sweep misses. Pairs with `models-sweep.sh` (liveness+modelId). `GWTOKEN` env for the leak check. |
| `gate-probe.mjs` | VPS | root/comis | **DETERMINISTIC security-gate / jail oracle prover** — calls the DEPLOYED guard off `dist/` directly: `floor` (`validateExecCommand` destructive denylist), `ssrf` (`validateUrl` — ASYNC `Result{ok}`), `invisible` (`stripInvisible` zero-click). `gate-probe.mjs [floor\|ssrf\|invisible\|all]`, `SRC=` overridable, exit 0/1. **The PRIMARY method for the prove-once gate/jail/exfil oracles** — a cautious frontier model refuses every adversarial-framed probe (so you get no gate stdout); this proves the actual deployed code-path instead. (bwrap egress is a kernel test — run the `bwrap --unshare-net` one-liner in `03-OBSERVABILITY.md` separately.) |
| `cfg-patch.mjs` | VPS | **comis** | the **Track-M workhorse** — deep-merge a JSON patch into `config.yaml` (preserves secrets, backs up). Reads `/tmp/patch.json` (write it first — `su - comis -c` drops env/quotes). Set a value, or pass `"__DELETE__"` to remove a key. Echoes the touched sections. |
| `logscan.mjs` | VPS | root/comis | **precise structured-field daemon-log scan** (replaces hand-written `grep \| node -e` projectors; immune to the `grep "degraded"`/`"transient"` false-positive class). `--level 50,60 [--uniq]`, `--kind <k>`, `--msg <substr>`, `--method <m>`, `--fields a,b,c`, `--last N`, `--raw`. |
| `db.mjs` | VPS | **comis** (so `HOME=/home/comis`) | read-only DB oracle for `memory.db` (no `sqlite3` on the box). Canned: `tables`, `schema <t>`, `cols <t>`, `count <t>`, `rows <t> [n]`, `pick <t> <c1,c2> [n]`, `sql <raw>`. The primary oracle for offline/learning/memory tests (`outcome_events`, `learned_skills`, `tuned_alpha`, `memory_usefulness`, `memories`) + DB-resident HARD invariants (`schema learned_skills` → the `trust_level CHECK`). |
| `models-sweep.sh` | VPS | root | sweep a model list: swap config → restart → PONG → check actual `modelId` |
| `config.example.yaml` | — | — | reference config (literal token, nested budget, emulator apiRoot) |

## Notes
- The **emulator** itself is launched from the repo's existing tooling: `tsx test/live/bin/vps-emu.ts`
  (deploy `test/live/` per runbook §0). It writes `/tmp/comis-emu.json` (`{apiRoot, port, botToken}`) which
  `drive.mjs` reads. It binds a **kernel-allocated loopback port** — re-patch `config.yaml`'s `apiRoot` if you
  restart it.
- `GWTOKEN` is NOT committed — set it per box in `scripts/.live-env` (gitignored) or the VPS `~/.comis/.env`, matching `config.yaml`'s `gateway.tokens[].secret`. Start from `.live-env.example`.
- All defaults are overridable: `VPS=root@1.2.3.4 SRC=/opt/comis ./deploy-dist.sh`.
