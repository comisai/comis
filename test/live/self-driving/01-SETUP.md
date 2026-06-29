# 01 — SETUP: stand up the rig (VPS + emulator + build under test)

> Goal of this step: a **green baseline** — the build under test running on the VPS as the `comis` user,
> driven through the loopback Telegram emulator, with every observability lens readable. All commands have
> a ready-to-run script in `scripts/` (see `scripts/README.md`). Env defaults below target the v2.29 rig;
> override `VPS`/`SRC`/`DATA`/`GWTOKEN`/`CHATID` as needed.

## 0. Rig topology

| Thing | Path / value | Notes |
|---|---|---|
| ssh target | `$VPS` — set `user@host` in `scripts/.live-env` (see `.live-env.example`; auto-sourced by the local scripts) | you are root; the daemon runs as `comis`. ssh key lives in your `~/.ssh` |
| daemon source tree | `/root/comis-src` (`SRC`) | rsync'd tree (NOT git); `0700` → `chmod o+rX` so comis can read it |
| data dir | `/home/comis/.comis` (`DATA`) | config, secrets.db, sessions, workspace — owned by `comis` |
| master key | `$DATA/.env` → `SECRETS_MASTER_KEY` | the daemon loads `<dataDir>/.env` at boot; source it into the launch env |
| secrets | encrypted `secrets.db` | `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, the `openai-codex` OAuth profile, gateway token — `comis secrets list` |
| emulator | `tsx test/live/bin/vps-emu.ts` on a **kernel-allocated** loopback port | wiring in `/tmp/comis-emu.json` `{apiRoot, port, botToken:"1234567:emulator-fake-token"}` |
| drive id | sender/chat `678314278` (`CHATID`), `senderTrustMap: admin` | drive as this user (admin-trust) |

The daemon is launched **directly** (`node --permission … daemon.js`), not via systemd (`comis.service` is inactive on this box). The emulator binds **loopback only** → it must run **on the VPS** (same host as the daemon).

## 1. THE #1 lesson — run the daemon as **`comis`**, not root

As root, `os.homedir()`=`/root` → anything that writes to a homedir-derived path hits `/root`, blocked by `--permission` → cryptic `FATAL: Access to this API has been restricted` (no path in the message). Root-owned leftovers in `~comis/.comis` then EACCES a comis daemon. **Once per box** (`scripts/setup-vps.sh`):
```bash
chmod o+x /root && chmod -R o+rX /root/comis-src      # comis can read the code
chown -R comis:comis /home/comis/.comis                # clear root-owned leftovers
```
Launch via `su - comis -c 'bash /home/comis/restart-m1.sh'` (`scripts/restart-m1.sh` — sources `.env`, sets the env, `setsid node --permission … daemon.js`, survives the ssh close). Don't fight the permission model as root — switch users.

## 2. Deploy the build under test (overlay dist; no rebuild on the box)

Local, after `pnpm build`: `scripts/deploy-dist.sh` = `tar czf - packages/*/dist | ssh $VPS 'tar xzf - -C $SRC'`.
- The macOS `tar` xattr warnings are harmless noise.
- M1 added no new third-party deps, so the VPS `node_modules` is fine — dist overlay is enough.
- **Verify recursively** — top-level globs lie. orchestrate lives in `packages/skills/dist/tools/builtin/orchestrate/`, the cap wiring in `packages/daemon/dist/wiring/`. The script checks the key symbols landed.
- **Prove you're on the new code via a HEAD-only SYMBOL GREP, not the dist mtime.** A live daemon holds its `dist/` in memory; `pnpm build` alone does not hot-reload it — so after deploy + restart, confirm a symbol that exists ONLY in your HEAD is in the deployed dist: `ssh $VPS 'grep -c "<new-symbol>" $SRC/packages/<pkg>/dist/.../<file>.js'` (e.g. a brand-new function/finding name from your diff). This is **definitive + timezone-immune**. ⚠ **Do NOT use the dist FILE MTIME** as the proof — the box clock is often a different TZ than your laptop (reflect-obs-20260627: box UTC vs local IDT+0300), so a freshly-deployed `10:10` build shows as `07:10` and *looks* stale when it isn't. To confirm the running PROCESS picked it up: `ps -o lstart,etimes -p $(pgrep -f "^node .*daemon\.js")` (started AFTER your clean-restart) + the symbol grep on the deployed dist — never the mtime.
- **HEAD can move under you (a sibling auto-commit process).** This checkout has a concurrent process that stacks commits + renames branches mid-run (it bumped HEAD 4× — `12ce96→89a5a8→2b0e32→643aac99` — in one session, and renamed the branch I was committing on). Consequences for the rig: (a) **pin the SHA you deployed** (`git rev-parse --short HEAD` at deploy time) and treat *that* as the build under test — don't assume `main` still equals what you built; a result is only valid against the deployed SHA. (b) When you land a fix, **`git fetch` + re-check `origin/main` and rebase onto it before pushing** (`--force-with-lease` only if you must force); a normal-looking local branch may already be behind the sibling's commits, and a blind push is a non-fast-forward reject (or worse, a clobber). A "wrong-build" false result is the cost of skipping (a).

## 3. Config (the load-bearing edits — `scripts/config.example.yaml` is a template)

- **Gateway token: a LITERAL ≥32 chars in `config.yaml`** — `${COMIS_GATEWAY_TOKEN}` does NOT resolve. Use that same literal for every `revoke.mjs`/CLI/RPC call (`GWTOKEN`). **It is NOT committed** — keep it per-box in `scripts/.live-env` (gitignored; `source` it before the local scripts) AND in the VPS `~/.comis/.env` as `GWTOKEN=…` (which `restart-m1.sh` sources). Copy `scripts/.live-env.example` to start; the daemon's `config.yaml` `gateway.tokens[].secret` must equal it.
- **Provider/model:** `provider:` + `model:` on the agent's line (the `integrations.media` block also has `provider:` — sed only the agent's). The model must be a **valid catalog model** for the provider (enumerate via `node -e 'import("@earendil-works/pi-ai").then(m=>console.log(m.getModels("<provider>").map(x=>x.id)))'`).
- **Budget — the per-root meter has THREE limbs; know all of them + the one gotcha (codex-30uc run 2026-06-25 burned cycles here):** the per-root `BoundedAutonomy` meter (`schema-agent-autonomy-bounds.ts`) bounds the whole spawn tree on `agents.<id>.autonomy.budget.{ aggregateUsd, tokens, wallClockMs }` — raise **all three** for heavy/long turns, not just `aggregateUsd`:
  - `aggregateUsd` (default **$2** — the flat `aggregateBudgetUsd` alias is shadowed by the profile; the standard profile resolves higher) — the priced $-limb.
  - `tokens` (default **2,000,000**) — bites even on a $0/subscription model (BUDGET-02). **Counts cache-read tokens**, so a multi-tool turn on a cache-heavy provider (Codex/OpenAI, 30–50K cacheRead/call) hits 2M fast at trivial actual $. Raise to e.g. `50000000` for heavy agentic/coding turns.
  - `wallClockMs` (default **1,800,000** = 30 min) — backstop on a stuck tree; raise for a long marathon.
  A heavy DAG/build wants e.g. `{ aggregateUsd: 30, tokens: 50000000, wallClockMs: 7200000 }`.
  - ⚠ **DO NOT add `observability.spend.perTurnMax` to "raise a cap" — it BACKFIRES.** That value is the per-CALL $-reservation the per-root meter holds against `aggregateUsd` (`pi-event-bridge.ts` ~:2076); a *bigger* perTurnMax aborts a multi-turn session *sooner* (`spend_exceeded`, honest-degraded). Leave `observability.spend` **unset** (its ceilings default `null`/off, `action:warn`); the per-root limbs above are the knobs that matter. A spend abort whose hint says "raise `observability.spend.*`" is usually really the `autonomy.budget.*` limbs (SPEND-ABORT-OBS — the hint names the wrong knob).
  - Mitigation when a long session starts aborting `spend_exceeded` with no limb actually near its cap: the per-root meter is **in-memory + accumulates per-root (rootRunId = per session/sender) across ALL that session's turns** — and **`session.reset_conversation` does NOT reset it** (it clears the LCD only); only a **daemon restart** does (a plain `restart-m1.sh` suffices — no memory.db wipe needed). For a **multi-workload / many-turn run that reuses the same few senders, `restart-m1` between workloads** (memory-learning-stress-catalog-20260629: reusing sender 279 across 7 turns incl. one 73-tool-call loop tripped its meter → spurious feeder aborts on later cheap turns; a restart-m1 fixed it cleanly). ⚠ **Finding WHICH limb is currently hard (BUDGET-LIMB-OBS):** limbs 1/2 log `"Per-root wall-clock|token budget exceeded"` (with numbers) in `per-root-budget.ts`, but **limb 3 ($) logs NO such line**, and the user-facing bridge abort (`"Per-root autonomy budget exceeded, aborting execution"`) is content-free; the limb+numbers are carried on the in-process `execution:aborted.perRootBudget` event (OBS-3) but are **not yet trajectory-bridged**, so `explain` can't name them either. Until that's threaded, if no limb line appears the trip is the $ limb — and the fix is a restart, not a grep.
- **Web search:** ensure `TAVILY_API_KEY` is set (`comis secrets set TAVILY_API_KEY --value tvly-…`). Keyless DuckDuckGo returns **empty** from the datacenter IP, so `web_search` looks broken without Tavily.
- **Inbound trust (`allowFrom` + `elevatedReply.senderTrustMap`) — the axis for the trust-tiered deny-by-origin (AGENTS.md §6.6).** Two knobs gate the emulator sender's per-message trust:
  - `channels.telegram.allowFrom: ["<senderId>"]` — ONLY listed senders reach the agent; an un-listed sender is dropped at ingress (no turn at all).
  - `agents.<id>.elevatedReply: { enabled: true, senderTrustMap: { "<senderId>": admin } }` — resolves that sender's per-message trust (default `user` when unmapped/disabled). An **admin**-trust turn's agent **inherits admin** → it CAN use the admin `*_manage` tools + the control plane; a **user/guest** (or unmapped) turn is **denied at deny-by-origin** (`non_admin_agent_origin`).

  Example (emulator sender `678314278`):
  ```yaml
  agents:
    default:
      elevatedReply:
        enabled: true
        senderTrustMap:
          "678314278": admin     # this sender's AGENT inherits admin
  channels:
    telegram:
      enabled: true
      botToken: ${TELEGRAM_BOT_TOKEN}   # rig uses the literal "1234567:emulator-fake-token"
      allowFrom:
        - "678314278"
  ```

  **Test BOTH sides (Track-M — a toggle is "covered" only when both are green); flip with `cfg-patch.mjs`, clean-restart between:**
  - **admin (WITH `senderTrustMap: admin`):** an admin op succeeds — `drive.mjs 678314278 "use agents_manage to list the agents"` → ground truth `success:true`, **no** `capability_denied`. Patch: `{"agents":{"default":{"elevatedReply":{"enabled":true,"senderTrustMap":{"678314278":"admin"}}}}}`.
  - **non-admin (`user`/`guest`, or delete `elevatedReply`):** the SAME op must be **DENIED** (`non_admin_agent_origin`, the confused-deputy floor) — the agent gets an honest "operator-only", the turn does not escalate. Patch: `{"agents":{"default":{"elevatedReply":{"senderTrustMap":{"678314278":"user"}}}}}` or `{"agents":{"default":{"elevatedReply":"__DELETE__"}}}`.
  - **not-allowed (drop from `allowFrom`):** an un-listed sender gets **no turn** — `drive.mjs` returns the honest empty (no outbound). Patch: `{"channels":{"telegram":{"allowFrom":["999999999"]}}}` then drive as `678314278`.
- Keep `security.storage: encrypted`. Never downgrade to `file`.

## 4. The emulator (drive the real channel adapter)

The daemon's real grammy Telegram adapter takes `channels.telegram.apiRoot`; point it at the emulator and the adapter long-polls the mock (`getMe`/`deleteWebhook`/`getUpdates`) and `sendMessage`s replies there. Deploy `test/live/` to the box (`rsync --exclude=node_modules test/live/ root@$VPS:/root/comis-emu/test/live/` + `printf '{"type":"module"}' > /root/comis-emu/package.json` so `tsx` picks ESM) and launch `tsx test/live/bin/vps-emu.ts` — it prints `EMU_UP {…}` and writes `/tmp/comis-emu.json`. Set `config.yaml` `botToken: "1234567:emulator-fake-token"` (== the emulator's fake token) + `apiRoot:` from the json. **Kernel-allocated port:** restarting the emulator changes the port → re-patch `apiRoot` + restart the daemon.

**Control API** (the driver hits these; `scripts/drive.mjs` wraps inject+poll):
- `POST /control/chats/:id/messages {fromUserId, text} → {messageId}`
- `GET /control/chats/:id/outbound?afterMessageId=&waitMs= → RecordedOutbound[]` (long-poll; `[]` on timeout = honest no-reply)
- `POST /control/chats/:id/reactions {fromUserId, botMessageId, emoji}` (WS1 learning signal)
- also `/media`, `/location`, `/callbacks`, `/edits`, `/faults` (see `05-CATALOG.md §emulator` + `.planning/live-tests/telegram-emulator-harness-design.md` for the full surface + fault matrix).

## 5. Clean-slate (between reproductions / before a fresh test)

`scripts/clean-restart.sh` (as root): preserves `config.yaml`, `secrets.db`, the master key; wipes the test session + LCD + logs; relaunches as comis.
- **The session dir is `workspace/sessions/default/<chatId>/` — NOT `default/telegram/`.** A clean-slate of the wrong path is a no-op.
- **Replace `memory.db`** (`mv memory.db{,.bak}; rm -f memory.db-wal memory.db-shm`) — the conversation/LCD lives in `lcd_*` tables; `sessions reset` queries an empty `sessions` table and does NOT clear it. The daemon recreates `memory.db` fresh (and re-seeds bundled skills).
- LCD contamination is the #1 "still broken after the fix" trap: prior turns persist in the session JSONL + `memory.db` and replay into a new turn.

## 6. Phase 0 baseline (exit gate)

Do not start the real test plan until ALL hold:
1. One **text round-trip** is green through the real adapter (`drive.mjs … "reply with PONG42"` → `PONG42` on the wire) and both oracles agree.
2. **Every observability lens is readable** on that trivial turn — daemon log, trajectory, `revoke.mjs capabilities.introspect`/`explain` (prove you can read each before you need it).
3. The **model serves** (the configured provider/model completes; `modelId`==config; no degraded-provider, no viable-floor WARN you didn't expect).
4. **Keys inventoried** (`secrets list`, `models.list`) — decides which capabilities run keyed vs honest-keyless.
5. **Baselines recorded** — `memory.db` counts, `fleet`, log offsets — so you can tell *your* incidents from pre-existing ones.
6. **CLI = the DEPLOYED build, not a stale global.** The `comis` on the comis user's PATH may be a long-ago `npm i -g comisai` (openclaw-usecases 2026-06-25 found **v1.0.42** on PATH while the deployed SHA was ~2.30). A stale global validates config with an OLD schema → it falsely flagged a valid `agents.default.autonomy` as "Unrecognized key" + cascade-skipped the gateway/channel doctor checks, and reported "No OAuth profiles stored" for an active profile — all phantom. **Check once:** `sudo -u comis bash -lc 'comis --version'` vs your deployed `git rev-parse --short HEAD`; if it's not your build, run every pure-CLI oracle (`security audit`, `doctor`, `explain`, `fleet`) via the deployed dist — `node /root/comis-src/packages/cli/dist/cli.js …` — NOT the PATH `comis`. (RPC-based lenses via `revoke.mjs` already hit the daemon, so they're unaffected.)

> A harness with a silent gotcha (a too-short token that 401s, a stale `dist/`, a wrong env var, the wrong session path) makes a healthy daemon look broken and burns a whole cycle. Phase 0 is where you make the rig tell the truth.

## Traps that cost cycles (the short list — full set in `scripts/README.md` + `03-OBSERVABILITY.md`)
- **`pkill -f "daemon.js"` self-matches your ssh shell** (its argv contains the pattern) → kills the shell → ssh exit 255. Always anchor: `pkill -9 -f "^node .*daemon\.js"`. **Same trap for the emulator:** `pkill -f "vps-emu"` self-kills the ssh shell running it (argv has "vps-emu.ts") — anchor `pkill -9 -f "^node .*vps-emu"`. And a backgrounded `nohup/setsid … &` emulator dies on ssh close → launch it in **tmux**. Both are baked into **`scripts/restart-emu.sh`** (use it; the port is kernel-allocated, so re-patch `channels.telegram.apiRoot` + restart the daemon after).
- **Severing the LCD needs the FORMATTED session key, not the trajectory-filename form.** `session.reset_conversation {session_key}` wants `default:<chatId>:<chatId>:peer:<chatId>` (read it from `db.mjs sql "SELECT DISTINCT session_key FROM lcd_messages"`), NOT the `~`-separated trajectory filename (`<chatId>~peer~<chatId>`). On a key-format mismatch it returns `lcdRowsDeleted:0` **silently** (no error) → the LCD is NOT cleared and a "cross-session" recall test is invalid. Verify `lcdRowsDeleted>0` after a sever.
- **Media OUTPUT delivery (image-gen/TTS/video-gen) is observable on the channel oracle as of 2026-06-25** — the emulator now records `sendPhoto`/`sendAudio`/`sendVideo` (with `mediaKind`), not just `sendVoice`/`sendDocument`. A media-only turn delivers no text, so `drive.mjs` prints `[NO SUBSTANTIVE ANSWER]` — read the outbound (`…/outbound` shows the `sendAudio`/`sendPhoto`) not the drive's text verdict.
- **SSH drops on long sleeps** → add `-o ServerAliveInterval=5`. macOS has no `timeout`.
- **`pgrep -f daemon.js` false-matches** your `bash -lc`/`sudo` wrappers → filter `grep -vE "bash|sudo|grep"`.
- **Don't chase an `effectiveWindow:8192` viable-floor WARN** — for a catalog-unknown model it's usually an invalid/mistyped model, not a window bug. Pick a valid model.
- **rootRunId has two formats:** orchestrate=`root-default-<id>`; graph/spawn=`root-session-<sessionKey>`.
