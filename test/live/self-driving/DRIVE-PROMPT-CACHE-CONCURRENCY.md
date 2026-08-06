# Remote self-driving prompt — real-user cache-and-concurrency campaign

Copy the fenced block below into an LLM coding-agent session opened at the Comis repository root.

The behavior under test is a real person's complete Telegram usage, replayed verbatim and then attacked
three ways: in parallel, with mid-request steering, and under burst stress. The transport is the loopback
Telegram emulator wired onto the **production VPS** — the real Telegram block is preserved and restored at
the end. The subject under test is Anthropic prompt-cache management: whether the cached prefix survives
concurrency, steering and bursts, and what still breaks it.

Read `01-SETUP.md` §remote before running anything: this drive mutates a production box.

```text
You are the primary Comis self-driving live-test driver. Work autonomously in this repository
until the real-user cache-and-concurrency campaign is genuinely complete or every unresolved
limitation is reported honestly. This is an execution task: write the plan to disk, then continue
into setup, driving, diagnosis, fixes, verification and reporting without waiting for approval
between stages. Pause only when an action needs authority the user has not granted or a secret
that cannot be obtained safely.

## Mission

Reproduce a real person's full Telegram usage against a live Comis install, then attack it:
in parallel, with mid-request steering, and under burst stress. Prove the Anthropic prompt-cache
management is sound under all three, and fix what is not.

The campaign succeeds only when every planned row either works — proven against ground truth —
or fails honestly with the real reason and the exact missing capability or config knob.
A plausible reply is not proof. A false success is the worst outcome.

## Authority and read order

1. `AGENTS.md`
2. `test/live/self-driving/README.md`
3. `test/live/self-driving/00-MISSION.md`
4. `test/live/self-driving/01-SETUP.md` (the remote-mode section)
5. `test/live/self-driving/02-DISCIPLINE.md`
6. `test/live/self-driving/03-OBSERVABILITY.md`
7. `test/live/self-driving/04-DERIVE-TESTS.md`
8. `test/live/self-driving/05-CATALOG.md`
9. `test/live/self-driving/scripts/README.md`
10. `test/live/self-driving/runs/real-user-haiku45-20260806/TEST-PLAN.md` and its
    `ACTIVITY-MATRIX.md` — the planned rows this campaign must account for.

Source is implementation truth. If prose and source disagree, the drift is a framework finding:
fix the kit in the same change-set, not just the product.

Before changing any production source, read `docs/developer-guide/generic-agent-architecture.md`.
Persona and corpus content belong in this campaign's isolated workspace policy or an opt-in skill,
never in the generic runtime.

## Rig

Remote rig = the production VPS (`comis-moshe`). Model under test: `claude-haiku-4-5-20251001`
(≈5x cheaper than Opus 5: $1 base / $1.25 5m-write / $2 1h-write / $0.10 read / $5 output).
Do the final regression pass on `claude-opus-5`.

    cd test/live/self-driving/scripts
    RIG_MODE=remote VPS=<host> DATA=/home/comis/.comis SERVICE=comis CHATID=<chatid> \
      bash deploy-scripts.sh
    ssh <host> 'command -v tsx || sudo npm i -g tsx'
    RIG_MODE=remote VPS=<host> DATA=/home/comis/.comis SERVICE=comis CHATID=<chatid> \
      WIRE=1 bash deploy-emu.sh

Back up `config.yaml` BEFORE switching the model. `wire-emu.mjs` preserves the real Telegram block
at `$DATA/config.pre-emu.yaml`; restoring it plus `systemctl restart comis` returns the box to real
Telegram.

Deploy the build under test with `deploy-dist.sh`, which overlays all 16 `packages/*/dist` onto the
installed npm-global package. Then PROVE the box is running it — a deploy you did not verify did not
happen:

    ./verify-build.sh <symbol-only-in-your-diff> [pkg]

That checks provenance (`/root/comis-deployed-build` matches local HEAD), process (the daemon started
AFTER the deploy — a deploy without a restart leaves the old in-memory dist serving), and a symbol
grep against the deployed dist. Never trust mtimes across two hosts. For a byte-level second opinion,
a checksummed dry-run (`rsync -rn -c -i`) over the same trees must report ZERO diffs.

## The corpus

    comis messages --since 90d --limit 5000 --format jsonl

on the box yields the real inbound messages (`--limit` caps at 10000; `m|h|d` are the relative units).
Internal cron and sub-agent dispatch is excluded and counted separately unless you pass
`--include-internal`.

Drive them VERBATIM, in timestamp order — do not paraphrase, do not translate, do not skip the ones
that look redundant. The repeated greetings and the status polls are load-bearing: they are session
restarts and cheap turns, which is exactly where cache behaviour shows.

## Tracks (each needs a ground-truth predicate, not a reply that "looks right")

| ID | Track          | Drive                                       | Passes only if |
|----|----------------|---------------------------------------------|----------------|
| A  | Sequential     | all activities, in order                    | every turn produces outbound; none silently dropped |
| P1 | Parallel       | 5 concurrent, same chat                     | no lost or interleaved reply; no session-lock deadlock |
| P2 | Parallel heavy | 3 concurrent report/chart/scan asks         | all settle; background tasks not cross-attributed |
| S1 | Steering       | inject a follow-up 10-15s into a long turn  | steer honored or queued — NEVER silently dropped |
| S2 | Steering       | contradicting steer ("stop, do X instead")  | superseded goal abandoned; no double delivery |
| X1 | Stress         | 10-message burst, no quiesce                | no crash, no FATAL, breaker not tripped |
| X2 | Stress         | burst + session-restart greetings           | cache prefix survives; breaks stay at ZERO |
| H1 | Health         | after all tracks                            | active, NRestarts=0, 0 FATAL, degraded rate reported |

P1/P2 drive the SAME chat, so `parallel-chat.mjs` (independent session keys, gateway `/api/chat`) is
the wrong instrument for them — use concurrent emulator sends. Reserve `parallel-chat.mjs` for the
independent-conversation control.

## Cache oracles (the point of the campaign)

- `comis cache stats --since 1h` — hit rate, `cacheCreationTokens`, and the per-TTL split
  (`cacheWrite1hTokens` / `cacheWrite5mTokens`; also `--agent` / `--provider`). The split is an
  ESTIMATE normalized to sum exactly to the write total; expect ~0.15% attribution error against the
  provider console.
- `Cache break detected` in `~/.comis/logs/daemon.*.log` — window it by timestamp and count by
  `reason` (the closed `CacheBreakReason` set in
  `packages/agent/src/executor/cache-detection/cache-state-types.ts`).
  **Break count is the signal; hit rate is NOT.** Hit rate tracks workload shape, so a prefix-building
  arc scores lower than a steady conversation on identical code. Never present a hit-rate delta across
  different workloads as a before/after — that is a workload artifact, and presenting one as a
  regression or a win is the mistake this campaign exists to avoid repeating.
- `comis system-health --since N` — `health_signal:cache_prefix_churn`, `announcement_quarantine`,
  degraded-by-cause.
- `~/.comis/logs/cache-trace.jsonl` — `stage:"stream:context"` carries `toolCount`, `toolsDigest`,
  `systemDigest`, `messagesDigest`, `assembledShape` and the depth-wise `messagePrefixHashes` ladder.
  Comparing consecutive calls localises a break to tools vs system vs messages in one pass; the depth
  hashes PROVE whether the message prefix actually diverged. `model:before` is emitted immediately
  before it with the same digests.
- Reconcile against the provider console. Reads and total writes must match to the token.

## Already fixed — re-verify, do not re-diagnose

- `tools_changed`: the sub-agent announcement relay shipped `tools: []`, emptying the head of the
  cache key and re-writing a byte-identical ~200k prefix in AND out. Now expressed as
  `toolChoice: "none"`, enforced by the provider where one enforces it and by shipping no tools
  everywhere else (fail-closed, direct-Anthropic only — NOT the family check).
- `retention_changed`: the retention ladder was rebuilt per EXECUTION and always started cold, so
  an established session re-wrote its prefix at 5m then again at 1h, every execution. Warm sessions
  now resume warm.
- Per-TTL write split recorded on `obs_token_usage` and reported by `cache stats`.
- Uncached input no longer swallowed (Anthropic bills `input_tokens` as the uncached portion, so
  `prompt - read - write` underflowed to 0).

## Open — this is the work

- Tool failures on heavy report/chart requests (`read`, `exec`, `write`, `web_fetch`, `message`);
  sessions end `completed_with_tool_errors` and still deliver a degraded reply. Establish per-tool
  which failure is real and which is a path/contract mismatch before patching anything.
- `cache_prefix_churn` with reasons `content-cleared`, `block-count-changed`, `structural-shift`.
  Localise each against the `messagePrefixHashes` ladder — the depth at which the hashes diverge names
  the layer, and a break at idx 0 means the WHOLE prefix went.
- `announcement_quarantine` — completed sub-agent work parked and invisible to the parent.
- `comis explain` returned no `likelyRootCause` for the worst degraded session. The tool built to
  answer this in one call went quiet; that is itself a finding, and closing it is in scope.
- Output under-reported ~5.6% vs the provider console.

Every one of these must end the campaign either fixed with a test that was RED pre-patch, or reported
with the exact reason it was not.

## Traps that will cost you hours

Each of these was paid for in real time already.

- `drive.mjs` must run ON the box; run locally it resolves the VPS package path and dies.
- `pgrep -f vitest` (or any pattern) MATCHES YOUR OWN ssh command — an idle box reads as busy.
  Verify liveness by log growth plus load average.
- `ssh host 'nohup bash -s ... </dev/null' < script.sh` — the `</dev/null` replaces the script on
  stdin; bash reads EOF and exits with a 0-byte log. Write the script to the box first, then run it.
- A `scripts/.rig-env` pinning `RIG_MODE=local` silently makes remote scripts run on YOUR machine.
- `sudo -u comis` from another shell expands globs in the CALLER's shell against a 0700 home —
  use `sudo -u comis -i bash -s`. A symbol grep run as root against that home is a FALSE NEGATIVE.
- Never rebuild `dist/` while integration or E2E is running; they import from it.
- Never run vitest concurrently with `pnpm validate` — deadline-sensitive tests fail on CPU
  starvation and look exactly like regressions.
- `errorKind:"precondition"` is dominated by a repeating skill-metadata advisory. Count by `hint`,
  not by `errorKind`, or you will chase thousands of non-failures.
- The window row is validated by a `z.strictObject` that DEGRADES TO ALL-ZERO on failure. Add a
  SELECT column without extending the schema and every field silently returns 0 — an all-zero cache
  window is a schema bug before it is a workload observation.
- `announceToParent` being capability-free is DELIBERATE containment (it relays a completion and must
  not act on the evidence grounding it). Do not "fix" it by handing it tools.
- `diagnostics.cacheTrace` is ON by default but capped at `maxFileBytes` (50 MB). Past the cap,
  appends are REJECTED and you get only a `cache_trace.write_failures` sentinel — on a burst campaign,
  check for that sentinel before concluding "no breaks were traced".
- `cacheTrace.includeMessages` / `includeSystem` default OFF, and that is sufficient: digests plus the
  prefix-hash ladder localise every break. Do not switch on raw message or system capture (identity,
  memory and message bodies) to answer a question the digests already answer.

## Discipline

Test-first for every production change; prove RED on pre-patch code before GREEN. Run
`pnpm validate` before claiming green. Fix at the authoritative layer, never a guard at a
convenient one. When source contradicts your hypothesis, the hypothesis is wrong — three plausible
theories were falsified by evidence in the prior campaign. Report corrections plainly and move on.

Record every finding in `test/live/self-driving/runs/<target>-<date>/`, and close the observability
loop: any point where you hand-joined logs, or an error told you WHAT but not WHICH KNOB, becomes a
change in the same change-set or an immediate follow-up — never a silent drop.

## Stop condition

Every planned row accounted for; every executed behaviour works against ground truth or fails
honestly; the security and honesty oracles are binary HARD. Restore the box to real Telegram and the
production model when done, verify the daemon is active with NRestarts=0, and say explicitly what you
did NOT prove.
```
