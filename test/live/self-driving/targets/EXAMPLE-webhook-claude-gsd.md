# TARGET (worked example) — a webhook-driven `claude` terminal drive that ships a GSD milestone

> An **unattended coding-CLI drive** target: an inbound HTTP webhook (no human in the loop) hands a
> `claude` terminal drive a task, and the drive autonomously builds a working artifact (here: an
> HTML5-Canvas Snake game) through a GSD milestone — the build must **compile AND run**, not just
> "the agent said it's done." This is the hardest reliability shape in the platform: a long,
> multi-phase, backgrounded drive that no human will nudge, gated by a jail, and provable only in
> ground truth (the built files + the browser), never the chat reply.
>
> Born the `webhook-claude-gsd-snake-20260702` run. Its findings hardened the kit + the obs — this
> doc is the reusable recipe so a second run hits measurably less friction (mission non-negotiable #5).

## Scenario (the exact drive)

1. **Preflight** (`phase0-check.sh`) — daemon up, gateway bound, **webhook route mounted + HMAC active**
   (unsigned POST → 401), terminal `worker` block complete, jail deps present. Fail here = don't drive.
2. **Inject** a signed webhook (`webhook-drive.mjs <path> @/unique/per-run/body.json`) whose mapping
   renders a prompt telling the agent to open a `claude` drive and drive a GSD milestone to build the app.
3. The agent clears the terminal launch/trust gate, `terminal_session_create`s the `claude` drive,
   **delivers the full task** (`terminal_session_send_text`), and the durable terminal backgrounds it.
4. The backgrounded drive autonomously runs the GSD phases (plan → build → verify), committing code.
5. **Oracle the artifact**, not the reply: the project dir has commits + code files; the built game
   compiles (`browser-oracle.mjs`) and RUNS (chrome-devtools MCP — real render + arrow-key interaction).

## Capabilities exercised → requirements

- **Webhook inbound** — HMAC-before-turn (401 on missing/bad/stale sig); JSON→prompt mapping; the turn
  fires ASYNC past the 200 (the DAG-async contract).
- **Terminal-driver drive** — bwrap jail (daemon secrets absent from `/proc/<jailed>/environ`); tmux
  durable session; the launch/trust gate; `create` → `send_text` (task delivery) → background.
- **Unattended-drive endurance** — a PRODUCING drive is NOT idle-reaped (PRODUCING-01); a never-tasked
  drive IS honest-failed (`reapNeverTaskedDrives` → `webhook_delivered:false`); an idle/lifetime reap of
  a real drive is DIAGNOSABLE (EVICT-01 `terminal_drive_evicted` verdict).
- **GSD milestone execution** — the drive produces a modular, test-covered build (real files + commits).
- **Browser "it runs" oracle** — the artifact compiles, renders, and responds to input with zero console errors.

## Must-pass predicates (with the ground-truth oracle)

| # | Predicate (the works-bar) | Ground-truth oracle | HARD? |
|---|---|---|---|
| 1 | Unsigned/bad/stale webhook is 401'd BEFORE any turn | `phase0-check.sh` (unsigned→401); `webhook-drive.mjs --no-sign/--bad-sign` | **HARD** (auth-before-turn) |
| 2 | The jailed `claude` holds ZERO daemon secrets | `terminal-drive-observe.mjs secrets` (`/proc/<pid>/environ`, expect 0) | **HARD** (jail) |
| 3 | The drive delivers the task, then builds (not "opened, never tasked") | `terminal-drive-observe.mjs lifecycle` (create→send_text→promote); a no-task drive → `explain` `terminal_drive_opened_without_task` | — |
| 4 | The GSD milestone produces real code (not a chat claim) | `terminal-drive-observe.mjs progress <project>` (git commits + code files + ROADMAP `[x]`) | — |
| 5 | The built app COMPILES and RUNS | `browser-oracle.mjs <dir>` (compile+serve) → chrome-devtools MCP (render + `press_key` + 0 console errors) | — |
| 6 | A PRODUCING drive is NOT idle-reaped mid-work | `explain` shows NO `terminal_drive_evicted` while producing; if it fires with `wasProducing:true` → PRODUCING-01 regression | **HARD** (idle-reap polarity) |
| 7 | A real reap (idle/wall-clock) is diagnosable in one call | `comis explain <sessionKey>` → `likelyRootCause.code === "terminal_drive_evicted"` (EVICT-01) | — |

## Provider/model + Stage

**Stage C (keyed)** — the drive runs a real `claude` CLI, so it needs a live key in the jail's kept env.
The webhook auth + mapping + honest-fail floor (predicates 1–3) are provable at **Stage B (keyless)**.

## Scope (broad sweeps)

Webhook subsystem (`packages/gateway/src/webhook/`) · terminal-driver (`packages/skills/.../terminal-driver/`
+ `packages/daemon/src/wiring/terminal-*`) · the wake-FSM/backstop · the obs pipeline (event → bridge →
IncidentReport → `explain` verdict). Config postures to sweep: `worker.idleTtlMs` short-vs-long,
`webhooks` on/off, terminal cap allowed/denied for the webhook origin.

## Known traps for this target (don't re-discover)

- **Classifier mis-reads a working drive as `awaiting-input`.** `claude` parks its cursor at the `❯`
  composer WHILE autonomously working — the classifier calls it `awaiting-input`. Freezing the idle
  clock unconditionally then let the reaper evict a still-producing drive (PRODUCING-01, now fixed:
  `checkLiveness` freezes ONLY when the screen digest is unchanged across probes).
- **Browser measurement-timing false-defect.** An auto-running game that dies into a wall in ~1.25s
  reads as a "static canvas" if you screenshot AFTER a reload→evaluate latency. Inject an `initScript`
  trail-recorder BEFORE the game starts and assert MOTION/state, not one late pixel-grab. (`browser-oracle.mjs`
  prints this recipe.) Nearly logged a false COMIS-FAIL twice — corroborate against ground truth.
- **Stale/missing `@file` webhook body.** An unset `$ID` → `wh-undefined.json`, or a reused `/tmp` body a
  prior run left comis-owned, silently sends the WRONG bytes (a phantom turn). `webhook-drive.mjs` now
  HARD-FAILS on a missing file and on a >120s-old body (`--allow-stale` to override). Write a UNIQUE
  per-run path and `&&`-gate the write before the POST.
- **FATAL boot on an incomplete terminal config.** The terminal schema requires a COMPLETE `worker`
  block (`maxSessions/idleTtlMs/ringBytes/stuckMs/maxConcurrentAttentionTurns`) + `defaults`
  (`cols/rows/scrollback`) — they are NOT optional. `phase0-check.sh` catches this before you drive.
- **The turn is ASYNC past the 200.** The `claude` build takes minutes; the webhook 200 returns
  immediately. Read completion from the trajectory / `terminal-drive-observe`, never the POST response.
- **pm2 runs stale code.** `pm2 restart` re-execs the CACHED exec path — a `pnpm build` in this checkout
  has zero effect on a process pinned to another dir. Use the canonical clean-start block (CLAUDE.md).

## Observability this target's run added (and the deferred follow-ups)

**Shipped (test-first, live-verifiable):**
- **EVICT-01** — `terminal:session_evicted` is now bridged to the trajectory (`terminal.session_evicted`)
  and folds into `IncidentSignals.terminalDriveEvicted{reason,idleMs,wasProducing}`; a new
  `terminal_drive_evicted` `explain` verdict names a reaper-killed drive (fires on `idle`/`wall_clock`,
  the cut-short caps — NOT the benign `max_sessions` LRU or the deliberate `max_interactions` budget).
  `wasProducing` is DERIVED (zero new events) from a preceding `producing` `drive_promoted` — the acute
  PRODUCING-01 regression canary. This is the obs completion of the PRODUCING-01 keep-alive fix: a reap
  that used to be a daemon WARN only is now a one-call diagnosis.

**Deferred — STRUCTURAL, root-cause already covered (dated TODO, `webhook-claude-gsd-snake-20260702`):**
- **`drive_progress` as a first-class event (obs #2).** There is no `terminal:drive_progress` emit in the
  codebase; a true progress signal would need net-new terminal-driver instrumentation. Its *intent*
  (was the drive producing?) is already captured by EVICT-01's derived `wasProducing`, so this is a
  low-value net-new-event and is deferred, not built.
- **`webhook_delivered:false` → session `explain` (obs #4/#5).** `diagnostic:webhook_delivered`
  (`events-infra.ts`) carries NO `sessionKey`/`traceId`, so it can't join to a session trajectory; it
  lands only in the daemon-wide diagnostic ring. Threading it onto `explain` needs NEW correlation (add
  `sessionKey` to the payload at both `setup-gateway-routes.ts` emit sites + bridge a `diagnostic:*`
  event — a new precedent — + fold + verdict). **Deferred because the dominant webhook-failure cause is
  ALREADY diagnosed** by the sibling `terminal_drive_opened_without_task` verdict (a never-tasked drive
  is exactly what flips `webhook_delivered:false`). The never-tasked honest-fail reap is correct and
  already isolated to the webhook layer — no "benign marker" is needed on `explain` until #4 lands.
