# 00 — MISSION: the self-driving live-test loop

> You have been pointed at this folder **with a target** (a use case, a milestone, or a design-document
> path). Your mission: **comprehensively live-test that target on the VPS through the Telegram emulator,
> end to end, fixing every issue test-first under the fix-verify discipline, until it works or fails
> honestly.** This file is the orchestration loop. It cites the other kit docs — read each when it says to.
> Do not pause to ask the user what to do; the target IS the directive. Drive.

## Non-negotiables (carry these through every step — full text in `02-DISCIPLINE.md`)
1. **A false success is the worst outcome.** Make the system tell the truth about failure *before* you optimize for success.
2. **Ground truth, not the reply.** The agent's chat reply is the *least* trustworthy oracle. Read the daemon log / trajectory / `explain` / the dual oracle (`03-OBSERVABILITY.md`).
3. **One issue fully closed before the next.** Stop at the first failure; fix it; reproduce on a clean slate; confirm; then continue. Don't pivot away from an open issue.
4. **Every test = works OR fails-honestly.** Security/honesty oracles are **binary HARD**. Classify with the 3-way engine (`02-DISCIPLINE.md` §scoring) — only **COMIS-FAIL** stops the loop.
5. **Self-improve UNPROMPTED — the observability, the emulator, AND this framework.** Every friction is itself an issue you OWN: a diagnosis that needed a raw-log grep or a hand-join; an error whose `hint` named the wrong knob; a kit script that drifted, errored, or that you hand-wrote a one-off for; a missing/awkward oracle; a stale rig assumption (e.g. a global CLI masking the deployed build). Close it the **moment you realise it (on the fly)**, or in the STEP 6 finalize sweep — **without being asked**: test-first for product code, edit-in-place for kit docs/scripts. The **default is IMPLEMENT**; "document as a finding" is the narrow exception (structural / security-sensitive / the-HARD-oracle-already-passed, per `02-DISCIPLINE.md`). The three loops — observability · emulator · framework — are in `03-OBSERVABILITY.md`. **Litmus: a second run of this exact target must hit measurably LESS friction than this one** (and never re-discover a friction you already hit).
6. **Fix EVERY system issue you trip over — even ones unrelated to the target.** A live run exercises the whole daemon, not just the target's surface. Any unexplained ERROR/FATAL, broken agent tool, mis-gated RPC, degraded provider, silent substitution, or obs gap you observe **is in scope** — diagnose it, and fix it test-first under the same loop, target-related or not. The target is the *vehicle*; a healthy, correct system is the *goal*. (This run found+fixed `memory.store` deny-by-origin while testing verified-learning — a bug in a different subsystem entirely. That is the expected pattern, not a digression.) Run the **system-health sweep** (STEP 4.5) deliberately, don't just wait to stumble on issues.
7. **Plan comprehensively BEFORE you drive — never test ad-hoc.** The very first deliverable, before a single inject, is a written `TEST-PLAN.md` that covers the **whole scenario**: **real-world use cases** (how a user actually exercises it end-to-end, multi-turn, in context — not just one happy call), **edge cases** (empty / huge / malformed / boundary / quota / concurrency / failure-injection), and both axes — **deep** (every requirement + its negative/abuse/security variant + the config-combination polarities) and **broad** (the cross-cutting system flows + the surface sweep). This holds for **any** target shape — a spec, a milestone, a user story, or a bare prompt with test instructions. A thin or improvised plan misses exactly the cases that break in production; STEP 2 is a **gate** — you do not enter STEP 4 (drive) until that comprehensive plan exists.

---

## STEP 1 — Understand the target → a requirement list

Classify the target and extract a flat list of **testable requirements** (each becomes ≥1 test). Method + worked examples in **`04-DERIVE-TESTS.md`**; in short:

- **Use case** ("test the DAG pipeline") → enumerate the capabilities it exercises + the happy path + edge + abuse variants. Cross-reference `05-CATALOG.md` to find the matching domain UCs.
- **Milestone** ("test v2.29 M1") → find its roadmap/plan under `.planning/design/` or `.planning/phases/` (grep the version); extract every **requirement + success-criterion**; map to phases.
- **Design document / spec** (a path) → read it fully; extract every **implementation, success-criterion, security invariant, and config knob**; each is a requirement.
- **User story** ("As a trader, I want four analysts to debate NVDA so I get a grounded call") → treat each acceptance criterion as a requirement; enumerate the acceptance path **plus** the alternate/error paths and the edge cases the story implies (an unstated "so that …" is a requirement too).
- **A bare prompt with test instructions** (the user hands you the scenario + what to check) → the prompt is the **seed, not the whole plan**: expand it into the full real-world + edge + deep + broad matrix for the scenario it implies. Test what the prompt *means* end-to-end, not just its literal words.

Write the requirement list into a fresh **`runs/<target>-<YYYYMMDD>/TEST-PLAN.md`** (copy `templates/TEST-PLAN.template.md`). For each requirement record: `id · what it claims · the test that proves it`. **This requirement list must already aim at WHOLE-scenario coverage** (real-world + edge + deep + broad) — STEP 2 turns it into the test matrix, but the comprehensiveness ambition starts here.

> **Verify before trusting the doc.** Design docs drift from code. For each claimed mechanism/anchor, confirm it exists at HEAD (`grep -rn`, read the file). A claim the code doesn't back is itself a finding (doc-vs-code, like the `verify/` audit) — note it, test the *actual* behavior.

## STEP 2 — Derive the deep + broad test matrix

Turn the requirements into tests. **Deep** (every requirement, plus its edge/abuse/negative variants and its config-combination axis) **and broad** (the system-level use cases + the surface sweep). For each test fix, **before driving it**, write: **Drive** (how) · **Predicate** (the works-bar, asserted on structure/state not model wording) · **Ground-truth oracle** (where the real artifact lives) · **HARD oracle** (if security/honesty) · **Stage** (B keyless / C keyed). Full derivation rules in `04-DERIVE-TESTS.md`; the reusable inventory (domains, P-phases, the 30 UCs, the HARD oracles, the config classes) in `05-CATALOG.md`.

> **GATE — the plan must be comprehensive before STEP 3 (non-negotiable #7).** The matrix is drive-ready only when, for the **whole scenario**, it holds: the **real-world end-to-end** use cases (multi-turn, in context), the **edge/boundary/failure** cases (empty/huge/malformed/quota/concurrency/failure-injection), every requirement's **deep** variants (negative/abuse/security + config both-polarities), and the **broad** cross-cutting flows + surface sweep. Run it against `04-DERIVE-TESTS.md §D` (the comprehensiveness checklist) first. **A plan that only lists the happy path is not done — do not start driving.**

Order within the plan: **harness/baseline → cheap channel round-trips → runtime/tools → memory/context → research/orchestration → media → interactivity/groups → multi-agent/API → scheduling → MCP → security gauntlet → platform/resilience/failure-injection (LAST)**, then the broad sweeps (K/L/M). Mutating/destructive tests come **last in their phase**.

## STEP 3 — Stand up the rig + baseline (Phase 0)

Follow **`01-SETUP.md`**: deploy the build under test to the VPS, run the daemon **as `comis`** (not root), wire the emulator, set the literal gateway token + the target provider/model, clean-slate, and prove a **green baseline** (one text round-trip + a smoke turn) so a healthy rig never looks broken. Record baselines (memory.db counts, fleet, log offsets) so you can tell *your* incidents from pre-existing ones. **Exit Phase 0** only when one round-trip is green through the real adapter, every observability lens is readable, the model serves, and keys are inventoried.

## STEP 4 — Drive forward, **fix-verify per issue** (the inner loop)

> ⛔ **THE #1 DEVIATION — do NOT do this:** run the whole plan, collect a pile of failures, and fix them all
> at the end. That **defeats the framework** — every later test then runs on a still-buggy system, no fix is
> reproduced on a clean slate, and you can't tell a real pass from one masked by an unfixed earlier bug.
> **The rule is structural: at most ONE open COMIS-FAIL at a time.** The instant a test is a COMIS-FAIL you
> must, *before driving the next test*, either **(a) CLOSE it** — fix test-first → clean-slate → reproduce →
> confirm — or **(b) DOCUMENT it as a finding** (only if it's nuanced/security-sensitive/the-HARD-oracle-
> already-passed, per `02-DISCIPLINE.md`). Carrying a backlog of unfixed COMIS-FAILs forward is itself a
> stop-the-run failure. "I'll fix them at the end" is never allowed.

Run the plan in order. Per test:
1. **Drive** it (one clean inject per turn; `scripts/drive.mjs`). Don't batch overlapping injects (they pollute the queue).
2. **Score** against the predicate, read from **ground truth** (`03-OBSERVABILITY.md` read-order). Classify OK / NO-ACCESS / COMIS-FAIL.
3. **OK / NO-ACCESS** → record + continue. **COMIS-FAIL** (or a HARD oracle trips, or a false success) → **STOP** and run the fix-verify loop (`02-DISCIPLINE.md`):
   > diagnose from evidence (one root cause) → **RED test** in `packages/*/src/**` reproducing the live shape → patch to GREEN → review (does it make the failure *impossible*?) → **clean slate** (wipe logs + memory.db + the test session) → **rebuild + clean-restart**, prove you're on the new code → **reproduce** the same test from zero → **confirm** it now holds in ground truth, and a forced failure still degrades honestly → **close the observability gap** if diagnosing needed a raw-log grep → re-run anything the fix could regress → resume.
4. **One issue fully closed before the next** — *closed* = fixed test-first + reproduced-on-clean-slate + confirmed in ground truth, OR deliberately documented-as-finding. Never carry an open COMIS-FAIL forward to "fix later." A chain of causes is normal — each fix unblocks the next, and you re-enter the loop on the same test until it's green-or-honest.

## STEP 4.5 — System-health sweep (the broad-issue mandate — do it deliberately)

The target is the vehicle; while the rig is hot, **actively hunt system-wide issues** (non-negotiable #6), not just the target's. This is where you catch the bugs the target's tests never would. Method + the precise filters in `03-OBSERVABILITY.md §system-health-sweep`:
- **`fleet --since N`** → degraded rate, top errorKinds, breaker trips, the `config_posture`/`model_health`/`health_signal` findings. Triage each: real bug vs. expected-for-the-rig (TLS-off on loopback, no canary) vs. advisory.
- **Daemon-log scan with PRECISE filters** (read structured fields, not raw word-grep — `grep "degraded"` matches the `"Daemon health"` report lines, a false positive). Look for `"level":50/60` (ERROR/FATAL), unexplained `errorKind`, tool-failure records (`"success":false` / `failedTools`), `not reachable` / `Capability denied` / `EACCES`/`EPERM`.
- **Drive a basic agent tool turn** (memory_store, web_search, a file write) even if the target doesn't use it — a broken core tool (like the MD-02 `memory_store` deny-by-origin) only shows under a real agent turn, never in a handler unit test.
- Each real issue → the same fix-verify loop (STEP 4.3). Each one that's nuanced/security-sensitive/out-of-budget → a **documented finding** with the verdict + evidence + fix direction (never silently dropped) + a recommended focused follow-up.

## STEP 5 — Sweep broad (after the deep UCs)

- **Track K — providers × models:** sweep every configured provider × every catalog model, one per restart (`scripts/models-sweep.sh`). Classify each OK/NO-ACCESS/COMIS-FAIL; confirm the actual `modelId` == config (no silent substitution / chimeric pairing). `05-CATALOG.md §Track-K` has the per-provider gotchas.
- **Track L — surface completeness:** every RPC method, agent tool, CLI command, HTTP endpoint, channel, media provider, content gate — smoke-called or cited-by-a-UC + classified; admin-gated methods reject non-admin. (`05-CATALOG.md §Track-L`.)
- **Track M — config combinations:** every behavior-changing toggle on **both** polarities (POS + NEG/MODE/INVARIANT); every always-on guard driven; a relaxed security default must *surface* the relaxation. (`05-CATALOG.md §Track-M`.)

Scale these to the target: a single use-case target may need only the K/L/M slices it touches; a milestone/design-doc target wants the full sweep of the surfaces it ships.

## STEP 6 — Audit, report, finalize

- **Stop condition** (`02-DISCIPLINE.md §stop`): every deep test works-or-fails-honestly, **zero false successes**, all HARD oracles green; K matrix complete (0 COMIS-FAIL open); L walked; dual-oracle clean; logs clean (no unexplained ERROR/FATAL, no secret residency); `pnpm validate` green on the fix branch; test-only config mutations restored; the obs + emulator + framework loops closed; the daemon left healthy on the fixed build.
- **Self-improvement sweep (non-negotiable #5 — UNPROMPTED):** before declaring done, implement every observability / emulator / framework improvement the run surfaced that you didn't already close on the fly — the missing oracle, the kit-script drift, the misleading `hint`, the diagnosis that needed a raw grep, the rig gotcha. Implement them (test-first for product code, edit-in-place for kit docs/scripts); only the structural/security-sensitive ones become a documented finding. **Do NOT wait for the user to ask** — and consider whether the live-test instructions (`00-MISSION`/`02`/`03`/`05`/`scripts/`) themselves need a sharpening so the next run avoids the friction you just hit.
- **Results log:** fill `runs/<target>-<date>/RESULTS-LOG.md` (copy `templates/RESULTS-LOG.template.md`) — per test: works / fails-honestly / COMIS-FAIL + fix commit; the provider matrix; the obs-gap ledger; the open findings (documented, never silently dropped).
- **Fixes:** branch-first, test-first, `pnpm validate` green; **commit/push only when the user asks** (per `CLAUDE.md`). Each fix gets a `FIX-VERIFY-LOG.md` entry.
- **Memory:** record the milestone outcome + any new recurring-defect or obs-gap lesson (so the next run starts ahead).

---

## The loop, in one diagram

```
 target ──▶ [1] requirements ──▶ [2] deep+broad test matrix ──▶ [3] rig + green baseline
                                                                       │
                          ┌────────────────────────────────────────────┘
                          ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  [4] for each test, in order:                                  │
        │      drive → read GROUND TRUTH → classify                      │
        │        OK / NO-ACCESS → record, continue                       │
        │        COMIS-FAIL / HARD-trip / false-success →                │
        │           STOP → RED test → GREEN → clean-slate →              │
        │           rebuild+restart → reproduce → confirm →              │
        │           close obs gap → resume   (one issue fully closed)    │
        └───────────────────────────────────────────────────────────────┘
                          │
                          ▼
   [5] sweep K (providers×models) · L (surfaces) · M (config combos)
                          │
                          ▼
   [6] stop-condition audit → results log → fixes (test-first) → memory
```

**Scale to the ask.** "Test use case X" → STEP 1 yields a few requirements; run the relevant deep UCs +
the K/L/M slices they touch. "Test milestone Y / design doc Z" → STEP 1 yields the full requirement set;
run the whole matrix + the full sweeps. When unsure, lean **comprehensive** (the user asked for deep + broad).
