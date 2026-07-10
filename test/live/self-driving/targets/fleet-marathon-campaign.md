# TARGET — Fleet-management MARATHON campaign: the ENTIRE system, end to end, in Hebrew, over the real ituran-mcp

> A **pinned CAMPAIGN target** — shape 1 (use case), sized for an autonomous run of **hours to days**.
> One agent drives the full `../00-MISSION.md` loop repeatedly over a **researched backlog** of
> real-world fleet-management use cases until every Comis capability domain is proven live or has
> **failed honestly**. Drive surface = the Telegram emulator, **in Hebrew**, like
> `EXAMPLE-nvda-dag.md`; memory/learning/cron predicates use the offline/DB oracles of
> `EXAMPLE-verified-learning.md`. The tool surface is the REAL **ituran-mcp** server
> (credentialed; **no sims**) — the fleet theme exists to make every capability earn its keep
> against a live, stateful, external system.
>
> Rig identity (box alias, access path, the local ituran-mcp checkout) comes from the **kickoff
> paste** + `scripts/.live-env` (untracked) via `scripts/_rig.mjs` — never hard-code it here.

## How to launch

Fill and paste. The chat-only values — box alias/access, the ituran-mcp checkout path, and the
names of the competitor platforms to mine — stay OUT of committed files (AGENTS.md §2.12 for the
competitor names; infra identity stays in `.live-env`):

```
You are a Comis live-test driver on a MARATHON CAMPAIGN. Your target spec is
test/live/self-driving/targets/fleet-marathon-campaign.md — read it, then ../README.md +
../00-MISSION.md, and follow them exactly. Run autonomously for hours or days until the backlog
is exhausted. Do not pause to ask me anything; the spec is the directive. Drive.
  Box: ‹ssh alias + access notes, e.g. "ssh <box>; if ssh drops: <re-auth command>"›
  ituran-mcp checkout: ‹path — default ../../ituran-mcp from the repo root›
  Competitor platforms to mine (Phase 0.2): ‹name them here — chat only, never in files›
  Prior runs to plan beyond: ‹notes, e.g. "see runs/FINDINGS-LEDGER.md"›
```

## Phase 0 — RESEARCH THE BACKLOG BEFORE ANYTHING ELSE (web + repo)

Build a real-world use-case backlog from three sources, then plan from it:

1. **Fleet management (the primary theme).** Search the web (WebSearch/WebFetch) for what real
   fleet managers and telematics operators actually do day to day — daily fleet status briefings,
   driver-safety scoring and coaching, geofence/compliance monitoring, maintenance scheduling by
   mileage/engine-hours, fuel and route efficiency, theft/unauthorized-use response, end-of-month
   compliance and utilization reports, incident investigation. Ground EVERY idea in the real
   ituran-mcp surface: study the checkout's `README.md`, `TOOLS.md`, `docs/` — vehicles, trips,
   alerts, safety, maintenance, drivers, reports + operational reports, places/geofences,
   commands, diagnostics, events, groups, exports.
2. **Competitor real-user mining.** Search the web for what REAL USERS of the operator-named
   competitor platforms (or, if unnamed, the leading open-source chat-first personal-agent
   gateways you identify by search) actually use them for — community showcases, docs,
   forum/Reddit/X posts, blog writeups: morning briefings, inbox/message triage, recurring
   research digests, price/stock watches, reminders and follow-ups, home/ops automations, content
   pipelines, multi-step research. Translate each mined pattern into a **Comis-native scenario**
   — fleet-flavored where natural, generic where not. GUARDRAIL (AGENTS.md §2.12): competitor
   project names NEVER enter committed files — code, tests, docs, comments, runtime strings.
   Everything under `runs/` is gitignored (local-only), so backlog/source notes there may cite
   them freely.
3. **The kit's own catalog.** `../05-CATALOG.md` (capability domains, the 30 UCs, Track K/L/M,
   the HARD security oracles) + prior fleet drives under `runs/` and `runs/FINDINGS-LEDGER.md`
   (local-only, if present) — plan BEYOND what is already proven: deeper compositions,
   edge/failure/abuse variants, not reruns.

Deliverables of Phase 0, written BEFORE any driving, under `runs/<campaign>-<date>/`:

- **`USE-CASE-BACKLOG.md`** — every use case with its source, the capability domains it
  exercises, and a priority order (highest-risk + HARD oracles first).
- **`COVERAGE-MATRIX.md`** — every Comis capability domain (channels/media (image-gen, vision,
  STT/TTS) · memory + recall · verified learning/reflection · cron/scheduled + proactive
  follow-ups · autonomy/durable-resume · orchestrate/DAG/PTC · security (injection, jail,
  secrets, gates, untrusted senders) · admin `*_manage` tools · observability · config
  polarities · cost/budget) mapped to ≥1 backlog UC. An unmapped domain means the backlog is NOT
  done — the campaign tests the ENTIRE system, not a theme.

## Rig

- **Box:** from the kickoff paste / `scripts/.live-env` (`_rig.mjs` resolution). Production
  layout: systemd `comis.service` + npm-global install — NOT pm2. Access drops are EXPECTED over
  a days-long run (SSO/SSM token expiry): re-auth with the kickoff-supplied command and
  reconnect; a dropped ssh is not a failure.
- **Real-channel guard:** if the box is wired to REAL Telegram, FIRST snapshot its config, then
  wire the emulator (`scripts/wire-emu.mjs`). When the whole campaign is done, RESTORE the
  real-Telegram wiring and verify the daemon is healthy on it.
- **Credentials:** ituran-mcp is a credentialed MCP (env `ITURAN_*`) — confirm the daemon's MCP
  config resolves the credentials; never print or log them.
- **Spend watch:** the campaign makes real LLM + real ituran calls for days. Check cost per
  window in `comis fleet` at every phase boundary; runaway or unknown-priced spend
  (`pricing_gap`) is itself a finding to investigate.

## The discipline (pins `../02-DISCIPLINE.md` for this campaign)

**THE PER-ISSUE CONTRACT (memorize; it overrides everything else):** run forward → stop at the
FIRST failure → fix it test-first → wipe logs + memory + test sessions → rebuild + clean-restart
→ reproduce on the clean slate → confirm it works → only then continue. **One issue fully closed
before the next.** Never batch findings, never keep driving past a failure, never verify a fix
against dirty state.

Non-negotiables:

1. **CLEAN THE RIG FIRST:** `scripts/clean-restart.sh` (wipe logs + memory + test sessions), then
   a green baseline = `phase0-check.sh` + `rig-doctor.sh` + `verify-build.sh` all pass. Driving a
   stale build is a FALSE RESULT — confirm the box serves the build you think it does.
2. **PLAN BEFORE DRIVING** (the `../04-DERIVE-TESTS.md` §D gate): from the backlog, write
   `runs/<campaign>-<date>/TEST-PLAN.md` covering all four axes — real-world end-to-end ·
   edge/boundary/failure · deep (every requirement + its negative/abuse/security variant, config
   both polarities) · broad (cross-cutting flows) — ordered highest-risk-first.
3. **DRIVE** each use case through the Telegram emulator **in Hebrew**, SERIALLY (never parallel
   drives). Verify every predicate in GROUND TRUTH, never the surface reply: trajectory
   (`*.jsonl.trajectory.jsonl` via its `.trajectory-path.json` pointer) + `_session-metadata.json`
   → `comis explain "<sessionKey|traceId>"` → `comis fleet --since N` → `~/.comis/memory.db`
   (`scripts/db.mjs`) → only then a raw `daemon.log` grep. (On the box the npm-global `comis`
   serves the CLI; from a source checkout it is `node packages/cli/dist/cli.js`.) A false success
   is the worst outcome.
4. **AUDIT THE OBSERVABILITY EVERY CYCLE** — pass or fail, no exceptions. After EVERY use-case
   drive, turn the lenses on themselves: run `comis explain` on the session and `comis fleet`
   over the window, and GRADE them against the ground truth you just read. Does `explain` name
   the actual root cause (or a wrong/`unknown` verdict)? Does `fleet` surface the signal you
   found by hand? Is every load-bearing fact visible at default log level (INFO completion +
   `durationMs`, ERROR/WARN carrying `hint` + `errorKind` naming the exact config knob and
   values, step-tagged stages, event-bus events on state transitions)? Do the trajectory records
   carry what the incident needs? Any divergence — a grep you needed, a hand-join, a wrong-way or
   missing hint, DEBUG-only evidence, a field meaning two things, a double-counting lens, a
   signal `fleet` missed — is a DEFECT in the observability layer: fix it test-first IN THE SAME
   CYCLE, then re-run the lens to prove the gap is closed. Litmus before closing any cycle:
   "next time, `comis explain <ref>` answers this in one call." If not, the cycle is not done.
5. **AUDIT MEMORY RECALL + LEARNING AFTER EVERY USE CASE** — pass or fail, BEFORE any wipe.
   Three checks, all in ground truth:
   a. **Persistence:** in `~/.comis/memory.db` (`scripts/db.mjs`) confirm the UC's
      facts/preferences/procedures actually persisted — right content, right scope (agent- vs
      user-), embeddings present with the correct dimension, `outcome_events` carrying the UC's
      outcomes.
   b. **Recall probe:** reset the conversation (or open a fresh session) so the context window
      CANNOT answer, then send a Hebrew follow-up answerable only from the UC's stored memories.
      Verify in the trajectory `memory.*` records that recall ran and the RIGHT memory ranked
      into the set with the right scope — a plausible reply without the recall record is a FALSE
      SUCCESS. Wrong memory, no memory, or dead recall = defect.
   c. **Learning:** exercise the reflection path (`scripts/reflect-run.mjs` when waiting for the
      scheduled cycle is impractical) and confirm outcomes were admitted per the corroboration
      mode, mental models were written, and — in a later related UC — the learned procedure is
      actually REUSED/transferred. Learning that stays inert across related UCs = defect.
   If a fix-verify cycle wiped state before this audit completed, re-drive the UC on the clean
   slate and re-audit. Every divergence enters the per-issue contract AND the step-4 obs grading
   (can the recall/learning lenses show what was recalled/learned and why?).
6. **On the FIRST failure: STOP driving** (the per-issue contract starts here). Root-cause
   end-to-end across layers (never the first file that throws; fix the authoritative layer, no
   symptom-hiding guards), then fix TEST-FIRST: a RED unit test in `packages/*/src/**`
   reproducing the live shape, then the patch to GREEN. `pnpm validate` before any deploy.
7. **THEN CLOSE THE CONTRACT:** wipe logs + memory + test sessions (`clean-restart.sh`), rebuild
   + redeploy to the box (`install-vps.sh` / `deploy-dist.sh` + `restart-daemon.sh`) and CONFIRM
   the box actually serves the new build — installer upgrades do NOT restart the daemon, the
   global CLI can be stale, and tarball installs hit bundledDeps-prune (repair with
   `npm install --no-save`). REPRODUCE the original scenario on the clean slate, CONFIRM it works
   in ground truth — only then continue driving. One issue fully closed before the next.
8. **REPEAT** until the current use case works or fails honestly (truthful, reason-coded, names
   the missing knob) — only then move to the next use case. No silently deferred defects: if you
   must defer, leave a dated TODO naming the incident. If the SAME issue survives 3 full
   fix-verify attempts, record it as an honest fail with everything you learned and move on — do
   not spin.
9. **IMPROVE THE OBS LAYER AND THE KIT CONSTANTLY, unprompted** — a standing deliverable of every
   cycle, not a wrap-up chore. Every friction from steps 4–5 ships as its own test-first
   improvement (trajectory event → bridge mapping → translator → IncidentReport /
   FleetHealthReport section → heuristic verdict, per the repo's obs feedback loop). Same for the
   kit — if the emulator or a `scripts/` helper drifted, errored, or misled you, fix it in the
   same run. Leave the observability, the logging, and the emulator measurably better after
   EVERY cycle.

## Marathon operations — how to survive hours/days

- **DURABLE STATE, NOT CONVERSATION MEMORY:** your context WILL compact. Everything needed to
  resume must live on disk in `runs/<campaign>-<date>/CAMPAIGN-STATE.md`: the backlog with
  per-UC status (pending / driving / fixing:`<issue>` / closed:works / closed:honest-fail), the
  current step within the per-issue contract, the deployed build's commit, open TODOs, and the
  next action. Update it at EVERY state change, BEFORE starting the action. On any fresh start:
  read CAMPAIGN-STATE.md first and resume exactly where it points — never restart the campaign,
  never re-drive closed UCs.
- **TIME-GATED SCENARIOS ARE FIRST-CLASS:** cron fires, proactive follow-ups, reflection cycles,
  and durable-resume tests need real elapsed time. Schedule them, record the expected fire
  window in CAMPAIGN-STATE.md, keep driving other UCs meanwhile — but plan so nothing else is
  mid-flight in the same agent/session when a scheduled event fires (the serial rule extends to
  wake windows). Verify each firing in ground truth after the window passes.
- **PHASE CADENCE:** at every phase boundary (and at least every few hours of driving) run
  `comis fleet --since N` as a campaign heartbeat — degraded rate, error kinds, breaker trips,
  cost — and append a dated snapshot to RESULTS-LOG.md. A drifting baseline (rising degraded
  rate, a new errorKind, climbing cost) is a finding: stop and investigate before driving on.
- **KEEP GOING:** after each closed UC, pick the next backlog item and continue without asking.
  The campaign ends only when the backlog is exhausted, the coverage matrix has no unmapped
  domain, and the box is restored to its real channel — or the operator interrupts.

## Git

Branch-first off the currently deployed branch — never commit to `main`; commit as you close
each issue so a crash never loses a closed fix; do not push unless the operator asks.

## Deliverables — all under `runs/<campaign>-<date>/`

- `USE-CASE-BACKLOG.md` + `COVERAGE-MATRIX.md` (Phase 0, with sources).
- `CAMPAIGN-STATE.md` — always current, the resume point.
- `TEST-PLAN.md` · `RESULTS-LOG.md` (per-UC: the verdict works / fails honestly with
  ground-truth evidence pointers, PLUS the step-5 memory/recall/learning audit result — a UC
  without a memory-audit entry is NOT closed — plus periodic fleet-health snapshots) ·
  `FIX-VERIFY-LOG.md` (issue → RED test → fix → wipe → rebuild → clean-slate reproduction →
  confirmation; one entry per issue, closed in order) · `OBS-AUDIT-LOG.md` (per-cycle: what each
  lens got right/wrong vs ground truth, and the improvement shipped for every gap — an empty
  cycle entry means the audit was skipped, not that the obs is perfect).
- A branch with all fixes + their tests, `pnpm validate` green.
- A final campaign report: use cases driven per domain, issues found and fixed, honest fails
  with reasons, obs/logging/emulator improvements shipped, total cost, and the box restored to
  its real channel and verified healthy.
