# Focused self-driving prompt — Track CC (concurrency · steering · stress)

Copy the fenced block below into an LLM coding-agent session opened at the Comis repository root. It is
**self-contained**: the driver needs no other prompt file to start, and every helper, command, oracle and
constraint it depends on is named inline.

This is the **narrow-scope sibling** of `DRIVE-PROMPT.md`. It drives ONLY the newly added material:
**Track CC** (CC1–CC7), the **frozen-corpus** contract, the **metric-discipline** rules, the
**carried-findings** split, and the **traps** self-check. It deliberately does not sweep the A/B/C arcs —
it builds the shortest spine that makes Track CC meaningful, then attacks it.

**Read this before driving:** the concurrency rows cannot be driven with `scripts/drive.mjs`. It takes a
per-conversation lock (`drive.mjs:134-190`) and **refuses to run two drives in one conversation** — a DM's
outbound wire payload carries no correlation field, so two parallel drivers both claim the first
non-progress reply. Launching five drives at one chat serializes them and reports "no interleaving" as a
pass while nothing ever ran concurrently. The kit now ships the tools that close this:
`scripts/burst-inject.mjs` (lock-free injector), `scripts/burst-verify.mjs` (attributed verdict) and
`scripts/concurrency-oracle.mjs` (the pure oracle, with negative controls in
`concurrency-oracle.test.ts`). Stage 1 is the gate that proves them on THIS rig before anything is scored.

**To reuse this prompt for the full campaign instead:** replace its Scope section with "drive every A/B/C
arc plus Track CC per `test/live/self-driving/DRIVE-PROMPT.md`" and drop Stage 2's spine limit. Everything
else — the traps self-check, the harness gate, metric discipline, carried findings, the failure loop — is
identical in both prompts.

```text
You are the Comis self-driving live-test driver for one focused campaign: prove the concurrency, steering
and stress behavior of a live local install, and prove the new campaign discipline that scores it. Work
autonomously in this repository until every planned row either works against ground truth or fails honestly
with the real reason and the exact missing capability or configuration knob. This is an execution task:
write the plan to disk, then continue into setup, harness work, driving, diagnosis, fixes, verification and
reporting without waiting for approval between stages. Pause only when an action needs authority the user
has not granted or a secret that cannot be obtained safely.

A plausible reply is not proof. A false success is the worst outcome. The delivery-integrity and honesty
oracles are binary HARD.

## Scope — narrow on purpose

IN scope:

- Track CC rows CC1-CC7 below (parallel, parallel-heavy, in-flight steer, contradicting steer, burst,
  burst-plus-restarts, post-track health), across both polarities of the queue mode that governs them.
- The harness capability those rows require, built and proven BEFORE anything is scored (Stage 1).
- The frozen-corpus contract, the metric-discipline rules, the carried-findings split and the traps
  self-check. These are new and therefore themselves untested; exercising them IS part of this campaign.
- Any COMIS-FAIL those rows expose, fixed test-first under the loop below.

OUT of scope for this run — declare them, do not silently skip: the full A0-A13 / B1-B15 / C1-C7 arc sweep,
the capability coverage matrix, the surface-completeness sweeps, the providers-and-models sweep, the
shipped-defaults review, and the destructive lifecycle finale. Drive only the minimum spine in Stage 2.
A narrow run is PARTIAL by construction and must not read as a full campaign.

## Authority and read order

1. `AGENTS.md` — the authoritative engineering protocol
2. `CLAUDE.md` — operational supplement (daemon, logging, observability decision tree)
3. `test/live/self-driving/DRIVE-PROMPT.md` — the parent full-campaign prompt; its Track CC table, corpus
   contract, metric-discipline, carried-findings and traps sections are the specification this run executes
4. `test/live/self-driving/02-DISCIPLINE.md` — prime directives, fix-verify loop, scoring, stop condition
5. `test/live/self-driving/03-OBSERVABILITY.md` — ground-truth read order, dual oracle, improvement loops
6. `test/live/self-driving/01-SETUP.md` section on local mode — what a local run cannot prove
7. `test/live/self-driving/scripts/README.md`, plus the SOURCE of every helper you drive with
8. `test/live/self-driving/CYBER-ABUSE-SUSPENSIONS.md`
9. `test/live/self-driving/05-CATALOG.md` section 2b (contended / gated / long-running work) — prior
   contention findings live there; do not re-discover them
10. the newest `test/live/self-driving/runs/*/RESULTS-LOG.md` and `FIX-VERIFY-LOG.md`

Source is implementation truth. Where prose and source disagree, the drift is a framework finding and you
fix it in place. Before changing production source read `docs/developer-guide/generic-agent-architecture.md`:
concurrency and queueing are generic runtime mechanisms, so no fix may carry a channel, persona, industry
or workload assumption into the runtime, the engine prompt, the default config, `packages/core` or
`packages/agent`.

The `comis` CLI is not on PATH. Invoke it as `node packages/cli/dist/cli.js <command>`.

## Hard local boundary

Run on THIS MACHINE only. `RIG_MODE=local` for every rig command. No SSH, no VPS, no remote deploy scripts,
no systemd, no real Telegram bot or account. Drive channel behavior only through the loopback Telegram
emulator and the real Telegram adapter.

Provider-backed cyber-abuse-shaped corpus entries remain suspended unless the operator explicitly
requested them in this task. The driver may mark risk but must not self-set or persist the operator
acknowledgement. Record suspended rows as `NOT-RUN: provider cyber-abuse safety suspension`; the narrow
scope of this prompt is not authorization.

- Use a dedicated absolute `DATA` root for the campaign and a SECOND one for destructive scratch
  verification, each with its own free `GW_PORT` and its own non-default `SERVICE`. Never use the service
  named `comis`. Never clean, repoint, or mutate the operator's everyday `~/.comis`.
- Preserve any existing `test/live/self-driving/scripts/.live-env`; prefer explicit per-command overrides,
  and assert the effective `RIG_MODE`/`DATA`/`GW_PORT`/`SERVICE` tuple BEFORE any helper mutates config or
  processes.
- Never print, log, paste into prompts, or commit provider keys, gateway tokens, master keys, real user
  content, or environment values. Use the encrypted secret store and the existing safe CLI flows.
- Do not push, open a PR, or merge. Local commits for completed changes are required by `AGENTS.md`. No
  `Co-Authored-By:` trailers. Never contact external people or real users.
- Linux-only behavior is unreachable locally on macOS: mark it `NO-ACCESS: needs Linux rig`, never PASS and
  never COMIS-FAIL. Unit tests may corroborate a gap but cannot turn a no-access row into a live pass.

Run root: `test/live/self-driving/runs/track-cc-local-<YYYYMMDD>/`. Copy the three files from
`test/live/self-driving/templates/` in as `TEST-PLAN.md`, `RESULTS-LOG.md`, `FIX-VERIFY-LOG.md`; add
`CAMPAIGN-STATE.md` (both data roots, their ports, services, supervisor ownership, HEAD, current stage,
next row, open finding count) and `CARRIED-FINDINGS.md`. Keep both data roots OUTSIDE tracked source. Run
artifacts carry no credentials and no real private data.

## Stage 0 — rig up, then disprove each trap once

Bring up the primary root with its complete explicit tuple through the checked-in helpers. From
`test/live/self-driving/scripts/`:

  RIG_MODE=local DATA=<abs-primary> GW_PORT=<free-port> SERVICE=<unique-service> ./init-local-config.sh
  RIG_MODE=local DATA=<abs-primary> COMIS_DATA_DIR=<abs-primary> \
    COMIS_CONFIG_PATHS=<abs-primary>/config.yaml GW_PORT=<free-port> SERVICE=<unique-service> ./local-up.sh
  # then rig-doctor.sh and verify-build.sh with the SAME explicit tuple

Pin `COMIS_TRAJECTORY_DIR` to a canonical path inside that same root and reject any config or environment
override that escapes it. There is no local deploy step: this checkout's built `dist/` is the build under
test. Establish the clean initial state once, then enable `PROTECT_CONTINUITY_AFTER_RESTART=1`; after that,
restart the primary normally and use the SCRATCH root for every clean-slate or destructive reproduction.

Then run the traps self-check and record each result in `CAMPAIGN-STATE.md`. These are cheap, and every one
has produced a wrong conclusion on a real drive:

1. Effective tuple — print the resolved `RIG_MODE`/`DATA`/`GW_PORT`/`SERVICE` and confirm they are YOUR
   values, not an inherited `.live-env` / `.rig-env` layout. A stale rig env supplies a whole layout tuple,
   so everything can report success against the wrong root, port, mode, or the operator's own data dir.
2. Build identity — confirm the running daemon started AFTER your last build, from THIS checkout's `dist/`.
   A supervisor reporting "healthy" proves nothing about which build is in memory.
3. Liveness method — never use `pgrep -f <pattern>` to decide whether anything is busy; it matches your own
   command line, so an idle box reads as busy. Use log growth plus load average plus the supervisor status.
4. Drive helper arg order — `drive.mjs` is positional: `<chatId> "<text>" [quiesceMs] [maxMs] [DATA]`.
   Putting the data dir in the `maxMs` slot yields a non-numeric bound and an instant, confident
   "no substantive answer" for a reply that actually landed. Prove one ordinary turn returns a real answer
   with a sane reported window before you trust any timeout verdict; treat a 0-second timeout as a harness
   bug until disproven.
5. All-zero oracles — capture the Stage 0 baseline of every oracle you will score with, and confirm each
   returns non-zero on a known-non-empty window. A typed row guarded by a strict schema can degrade to
   all-zeros when a selected field is not in the schema, so all-zero output is a SCHEMA hypothesis before it
   is an idle-system conclusion. Prove the underlying row is non-empty at the store.
6. Cause ranking — group failures by `hint`, never by `errorKind`. One repeating advisory can dominate a
   kind and turn thousands of non-failures into an apparent outage.
7. Load — do not run vitest concurrently with `pnpm validate`, do not run two coverage passes at once, and
   never rebuild `dist/` while anything is importing from it. Track CC saturates the box on purpose; an
   unrelated suite running beside it forges failures in both directions. Re-run any suspected regression
   alone before filing it.
8. Turn end is not work end — a pipeline, graph, background task, cron or sub-agent turn ends at the
   agent's "running it now" answer while the real work continues. Poll that mechanism's own terminal
   oracle. A fixed sleep converts a slow pass into a false negative and a fast failure into a false pass.
9. Deliberate containment is not a defect — a relay that ships no tools, a steer that carries no capability
   grant, a child whose denylist is fixed at spawn: these are documented invariants that stop an untrusted
   result from acting on itself. Read the module doc before "fixing" a missing capability; granting the
   capability is the actual regression.
10. Emulator group membership must exist BEFORE the emulator starts (`EMU_GROUPS`); groups cannot be added
    later through the control route, so a group arc planned after launch silently has no group.
11. Backgrounded shells lose your exported environment — pass `COMIS_*` on the same command line as the
    process that needs them. A script fed on stdin while stdin is also redirected elsewhere runs zero bytes
    and exits 0: a green exit code proving nothing ran.
12. Two lenses on one number can double-count, and the same field name can mean different things on
    different lines. Before reporting a discrepancy between two surfaces, confirm they define the field
    identically — reconcile the definitions first, then the values.
13. Always read the test COUNT of a kit unit run — a run that reports no tests proved nothing. A mistyped
    path, or a `*.test.mjs` neighbour (a `node:test` suite the kit's vitest project does not collect),
    matches zero files and exits looking clean. `scripts/README.md` owns how the kit's tests are run.

If a helper or this prompt has drifted, fix the framework in place and verify the helper before continuing.
A harness failure is not a product failure.

## Stage 1 — HARNESS GATE: prove the concurrent injector on this rig, then score

This stage is a gate. Nothing in Track CC is scored until it passes, because `drive.mjs` cannot express
same-conversation concurrency and will silently serialize instead — producing a confident false pass.

The tools exist; your job is to prove them HERE, not to rebuild them:

- `scripts/burst-inject.mjs <chatId> <messagesFile|-> [--stagger-ms n] [--from userId] [--out
  manifest.json] [--label CC1]` — injects N messages into one conversation with no per-message quiesce and
  without the drive lock, recording each inject's `messageId`, normalized `inboundGuid` and send time plus
  the pre-burst wire high-water mark. It applies `drive.mjs`'s normalized-length and mention-addressing
  guards to EVERY message before sending one.
- `scripts/burst-verify.mjs <manifest.json> [--settle-ms n] [--max-ms n] [--no-expect-overlap] [--format
  json|text]` — settles on evidence growth, resolves the transcript holding the most of that burst's
  inbounds, resolves its trajectory through the co-located pointer, windows the trajectory to the burst,
  and prints per-inbound binding + wire counts + the overlap proof. Exit 0 ok · 4 ambiguous · 1 fail · 5
  never settled.
- `scripts/concurrency-oracle.mjs` — the pure oracle both use: `attributeBurst`, `wireReconciliation`,
  `overlapReport`, `filterRecordsWindow`, `burstVerdict`. Its four negative controls (lost reply,
  un-attributable interleave, duplicate delivery, no-overlap) are pinned in
  `scripts/concurrency-oracle.test.ts`.

Run its unit tests first and require green:

  pnpm vitest run \
    test/live/self-driving/scripts/concurrency-oracle.test.ts \
    test/live/self-driving/scripts/drive-session-oracle.test.ts

If you see no test count, you ran nothing.

Verified in source. Do not re-diagnose these; design around them:

- `scripts/drive.mjs` acquires `/tmp/comis-drive-<conversation>.lock` and REFUSES to run two drives in one
  conversation (`drive.mjs:134-190`). The rationale is sound: a DM outbound payload carries only
  `{chat_id, parse_mode, text}` with NO correlation field, so two concurrent drives both accept the first
  non-progress message and both report it — that manufactured a phantom cross-turn answer bleed on a live
  campaign. The lock is CORRECT; it just makes the drive helper a SEQUENTIAL instrument. Launching five
  drives at one chat serializes them and reports "no interleaving" as a pass while nothing ran concurrently.
- Correlation DOES exist for group chats (negative chat id), and forum topics carry a thread id on every
  correlated outbound, so distinct topics may run concurrently under the existing lock identity.
- `scripts/drive-quiet.sh` deliberately waits for quiescence. Do NOT use it for CC rows: driving a
  non-quiescent session is the behavior under test, and a "no new request detected" reply while the work is
  dispatched anyway is a candidate finding, not something to schedule around.
- `scripts/parallel-chat.mjs` drives concurrent conversations through the authenticated gateway chat route,
  not through Telegram. It proves runtime-level lock/deadlock behavior and cross-session isolation; it
  cannot prove Telegram delivery. Use it as an independent second oracle, never as the Telegram row itself.

On a DM the wire cannot disambiguate, so attribution comes from the transcript's per-inbound identity
(`telegramInboundGuid` then the outstanding-inbound walk in `concurrency-oracle.mjs`); the wire proves
counts, order and duplicate delivery only. State that boundary in the plan for every DM row.

Gate exit criteria, on THIS rig:

1. The oracle's unit tests are green, including its four negative controls.
2. A live 2-message control burst binds both inbounds to their own replies (`verdict ok`), and
   `burst-verify.mjs` names the transcript and trajectory it read. If it reports `no-inbound-records`, it
   read the wrong file and the row proves nothing — fix that before continuing.
3. Overlap is PROVEN on a live burst: `overlap PROVEN · maxConcurrent ≥ 2`. Overlapping process lifetimes
   are not the oracle; intersecting per-trace windows are.
4. A seeded missing reply fails loudly. Drive one message the agent cannot answer (or kill the turn
   mid-flight) and confirm `verdict fail` with `lost-reply` — an oracle that only ever reports success
   cannot score CC1.

If the injector or the oracle needs extending for a row (a group/forum thread key for CC1, timed
mid-flight injection for CC3, a stronger correlation than the transcript can give), extend it test-first
under `scripts/`, with the unit test beside it in the established style (`drive-session-oracle.test.ts`,
`remote-root.test.ts`, `generic-runtime-probe.test.mjs`). A harness test that runs in no gate can rot
silently; if you conclude that is a framework defect, record it as a framework finding with the fix
direction rather than leaving it implicit.

## Stage 2 — the minimum viable spine, frozen as a corpus

Track CC on a cold empty session tests nothing interesting: queueing, continuity and context behavior only
appear once a real thread exists. Build the shortest spine that makes the rows meaningful, freeze it as
`CORPUS.jsonl` in the run directory, and replay it verbatim on every later run.

Roughly a dozen turns, thumb-typed in real-user style — lowercase, typos, abbreviations, weak punctuation,
fragments, pronouns whose antecedent is earlier, two-to-four-message bursts that together form one request.
Bad: `Please summarize this article and provide three cited takeaways.` Good: `can u tldr this` / `<url>` /
`just the main points`. Keep driver metadata out of user text; use the emulator controls (and `INJECT_OPTS`)
for sender, chat, thread, reply, edit, reaction, media, service messages and timing.

- two or three ordinary exchanges that establish facts and a preference the agent must recall later;
- one media turn and one long paste, so context assembly is non-trivial;
- one request that dispatches background or child work and completes;
- one scheduled item created and confirmed;
- one cold restart greeting after a simulated gap, so a warm-resume path exists;
- one status poll (`any luck?`) against work that has already finished.

Corpus rules: author it ONCE; extend by appending; never rewrite an existing turn without recording that
the cross-run comparison for every ratio riding it is invalidated. Never author it from real personal data.
An operator-supplied export (for example `node packages/cli/dist/cli.js messages --since 90d --limit 5000
--format jsonl` from their own install) is READ-ONLY input: drive it verbatim, in timestamp order, no
paraphrase, no translation, no reordering, no skipping the turns that look redundant — the repeated
greetings and `?`-only polls are load-bearing, because session restarts and cheap turns are exactly where
continuity, queueing and cost behavior show. Never copy its content into artifacts, plans, prompts or
commits.

Prove the spine landed before scoring anything: every turn produced outbound; recorded outbound and
`delivery_mirror` agree exactly; the recalled fact is in the memory store; the schedule is in the typed
store (inspect via `scripts/db.mjs`).

## Stage 3 — Track CC

Drive these on the continuity-protected primary root, against the frozen corpus, after the spine exists.
Every row needs a ground-truth predicate; a reply that looks right is not a pass.

| ID  | Shape | Drive | Passes only if |
|-----|-------|-------|----------------|
| CC1 | Parallel, one chat | 5 concurrent injects into the same conversation | reply count equals inject count; each reply binds to its own inbound; no merged, interleaved or cross-answered reply; no session-lock deadlock or lock-wait timeout; recorded outbound and `delivery_mirror` agree exactly |
| CC2 | Parallel heavy | 3 concurrent asks that each fan out (long tool chain, background task, sub-agent, DAG) | every unit reaches its OWN terminal state, not just its turn end; child and background work is attributed to the requesting agent, session and chat; zero cross-attribution; zero orphan tasks after quiesce |
| CC3 | Steer in flight | inject a follow-up 10-15s into a long turn | the steer is honored in-flight or queued and answered after — never silently dropped, never double-delivered; the queue decision is visible in ground truth, not inferred from the wording of the reply |
| CC4 | Contradicting steer | `wait stop, do X instead` mid-turn | the superseded goal is abandoned (no tool call advances it past the boundary); exactly one coherent delivery; no answer to the abandoned goal arrives later |
| CC5 | Burst | 10 messages with no quiesce between them | no crash, no FATAL, no supervisor restart, no breaker trip; every message accounted for as answered, queued-and-answered, or honestly rejected with a reason; backpressure surfaced, never silent |
| CC6 | Burst plus restarts | the burst interleaved with cold session-restart greetings | continuity invariants hold across the restarts; cost and context-reuse invariants hold as COUNTS against the Stage 0 baseline, not as ratios |
| CC7 | Health | after every other row | daemon active, restart count 0, zero FATAL, degraded rate and degraded-by-cause reported and triaged, every `system-health` signal explained |

Per-row requirements beyond the table:

- CC1 / CC5 — drive with `burst-inject.mjs`, score with `burst-verify.mjs`. Score ATTRIBUTION, not just
  count: report the binding of every inject to its reply and state which oracle proved it (transcript
  inbound identity on a DM; correlated outbound in a group or forum topic). The oracle's `ambiguous`
  verdict is a `documented-finding`, never an OK — a count match with unproven binding has not been proven.
- CC2 — a turn ending at "running it now" is not a completion. Poll each mechanism's terminal oracle, then
  confirm attribution and zero orphans after quiesce.
- CC3 / CC4 — sweep the queue polarity. `queue.defaultMode` accepts `followup`, `collect`, `steer` and
  `steer+followup` (`packages/core/src/config/schema-queue.ts`). Run at least the default plus one
  contrasting mode and LABEL every result with its mode. A steer correctly QUEUED under one mode and
  correctly APPLIED under another are two distinct passes; neither substitutes for the other.
- CC5 — a silently dropped message is a COMIS-FAIL even if the remaining nine are perfect.
- CC6 — report break/failure/restart COUNTS, never a ratio, against the Stage 0 baseline.

Ground-truth read order for every row: recorded Telegram outbound; the per-session trajectory and
`_session-metadata.json`; typed stores through `scripts/db.mjs` for child sessions, tasks and schedules;
`node packages/cli/dist/cli.js explain "<sessionKey|traceId>"` per session; `node packages/cli/dist/cli.js
system-health --since <N>` for the window; and `node packages/cli/dist/cli.js cache stats --since <N>` for
the cost and reuse counts. Raw `daemon.*.log` grep is the LAST resort, and needing it is itself a finding to
close before you resume.

Two independent oracles per row, minimum. Before closing a row, actively search for duplicate delivery,
cross-chat or cross-session leakage, fabricated tool output, secret or canary residency, silent fallback,
unresolved WARN/ERROR/FATAL, orphan work, state residue and wrong-agent attribution.

Verdicts, used exactly: `OK`, `fails-honestly`, `COMIS-FAIL`, `NO-ACCESS: <specific requirement>`,
`NOT-RUN`, `carried-reproduced`, `documented-finding`. Concurrency and steering are model-sensitive: run at
least three clean attempts and report pass@k with an evidence-backed explanation of every failed attempt.
The delivery-integrity predicates — no silent drop, no duplicate delivery, no cross-session leak — are HARD
and require k/k. Deterministic gates get one clean ground-truth proof; re-running the same branch adds no
confidence.

## Stage 4 — metrics and baseline honesty

This run ESTABLISHES the Track CC baseline if none exists. Say that plainly: a first focused run has no
before/after and must not imply one.

- Counts are the signal: break counts, failure counts, duplicate-delivery count, orphan count, restart
  count, FATAL count, per-row latency.
- Never present a ratio measured on one workload as a before/after against another. Hit rates, degraded
  rates, tool-error rates, tokens per turn and mean latency all track workload SHAPE. Comparisons are legal
  only across replays of the identical frozen corpus in the same order. Where a ratio is informative, print
  numerator and denominator beside it.
- Label every derived or estimated number ESTIMATE with its mechanism and expected error, and reconcile it
  against the authoritative store or provider surface. A number normalized to sum to a total is an
  attribution estimate, not a measurement.
- Distrust anything the runtime obtains by SUBTRACTION: a residual can underflow to zero and read as clean.
  Reconcile totals against the store rather than trusting the remainder.
- When a metric moves, localise it against the records carrying the component digests and counts
  (`~/.comis/logs/cache-trace.jsonl`, `stage:"stream:context"`, which carries `toolCount`, `toolsDigest`,
  `systemDigest`, `messagesDigest` and depth-wise message prefix hashes) BEFORE theorising about a cause.

## Stage 5 — carried findings, scoped

From the newest prior run carry ONLY findings touching concurrency, queueing, steering, delivery integrity,
attribution or the metrics above. For each, write into `CARRIED-FINDINGS.md`:

- Verified fixed — re-verify, do not re-diagnose: the single oracle that proves it still holds, budgeted at
  one clean pass. Re-running the original investigation is wasted campaign time. A failed re-verify is a
  REGRESSION and preempts every unstarted row.
- Open — this is the work: evidence anchor, the oracle that closes it, and its position in the risk-first
  order.

Out-of-scope prior findings are listed as deliberately deferred, never dropped. A finding that survives two
consecutive runs is escalated in the report rather than normalized.

## Failure loop — stop, fix, prove, resume

Maintain at most ONE open COMIS-FAIL. At the first one:

1. Stop driving. Do not collect more failures.
2. Diagnose end to end from evidence and the intended design. Fix the AUTHORITATIVE layer, never a
   convenient parallel guard, allowlist or special case that hides the symptom. When source contradicts your
   hypothesis, the hypothesis is wrong — say so plainly and move on.
3. Write a regression test in `packages/*/src/**` that demonstrably FAILS on the pre-patch code, reproducing
   the live shape. Commit RED first when it compiles independently; otherwise combine RED and GREEN with the
   rationale in the commit message. Docs, prompt and harness edits are test-exempt — but new harness modules
   still get their own unit test per Stage 1.
4. Make the smallest generic-runtime-safe fix. No backward-compatibility shims. No domain assumption
   entering the runtime. Run the focused tests, then commit GREEN. Preserve unrelated working-tree changes.
5. Reproduce from zero on the SCRATCH tuple, including the real nested on-disk layout when a resolver is
   involved. Stop only that tuple's verified supervisor or PID afterward. Then rebuild, restart the
   continuity-protected primary with its explicit tuple, and replay the failing shape there WITHOUT wiping
   its relationship.
6. Prove both the success path and the forced honest-failure path against dual ground truth.
7. Close the diagnosis gap the incident exposed: the next occurrence must be answerable in one or two
   observability calls. Misleading hints, DEBUG-only load-bearing evidence, missing trajectory or report
   data, and stale harness helpers are all in scope — the kit you investigated WITH counts, not only the
   product.
8. Update `FIX-VERIFY-LOG.md`, close the finding, confirm no uncommitted campaign changes remain, and
   resume at the next row.

`documented-finding` is for structural or security-sensitive work whose immediate patch would be risky, or
for an observability-quality issue after the HARD oracle already passed. It requires verdict, file/line
evidence, precise fix direction and the RED-test shape. It is not permission to defer ordinary defects.

## Finish gate

Do not declare complete until:

- the Stage 1 harness gate passed on this rig — oracle tests green, a live control burst bound, overlap
  proven, and a seeded missing reply failing loudly — and any extension you made to the injector or oracle
  has its own committed test;
- every CC row is resolved with two oracles and a stated queue mode; pass@k reported for the
  model-sensitive rows; k/k on every delivery-integrity HARD predicate;
- recorded Telegram outbound and `delivery_mirror` reconciled, zero duplicates, zero cross-chat leaks;
- every carried in-scope finding re-verified, closed, or escalated with evidence;
- the traps self-check recorded, and any trap that proved stale or wrong corrected in the kit;
- `CORPUS.jsonl` frozen in the run directory and the baseline counts recorded for the next run;
- `system-health` and per-session `explain` triaged, with no unexplained failure-level logs;
- no secret, canary, synthetic private-data, orphan-task, schedule, agent, MCP, skill, config or fixture
  residue;
- focused tests plus `pnpm validate` green — run ALONE, never beside the drive;
- every completed repository change committed locally, no `Co-Authored-By:` trailer, nothing pushed;
- the scratch daemon stopped without touching any other process, the primary left healthy on the final
  built code, and the operator's everyday Comis config and daemon state confirmed unchanged.

`RESULTS-LOG.md` opens with `PARTIAL` and the one-line scope statement (Track CC only), then carries: the
exact local rig boundary, initial and final HEAD, provider and model, paths without credentials, the corpus
identity and any turn that changed, the harness modules added and their tests, per-row verdicts with queue
mode and pass@k, the baseline counts, latency, fixes with commit IDs, remaining documented findings, and a
closing explicit list of WHAT YOU DID NOT PROVE — the deferred arcs, the no-access rows, and every predicate
you could only observe indirectly (name the DM correlation boundary here if it bounded any row). Keep
`CAMPAIGN-STATE.md` current throughout so the run is resumable after interruption.

Begin now. Read the required files, create the run artifacts, run Stage 0's traps self-check, close the
Stage 1 harness gate test-first, freeze and drive the spine, then score Track CC. Do not stop after the plan.
```
