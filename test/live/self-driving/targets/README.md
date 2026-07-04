# targets/ — how to specify WHAT to test

Point an agent at `self-driving/` with **one** of these as the target. The agent reads `../00-MISSION.md`
+ `../04-DERIVE-TESTS.md` and drives the whole loop from there.

## The target shapes (any one)

> **Whatever the shape, the agent first plans a comprehensive test — real-world use cases + edge cases + deep + broad, covering the WHOLE scenario — BEFORE driving** (`../00-MISSION.md` non-negotiable #7 + `../04-DERIVE-TESTS.md §D`). The shape only changes how requirements are *extracted*; the comprehensiveness bar is the same.

1. **A use case** — a sentence. *"Test the orchestrate/DAG pipeline."* · *"Test memory recall across sessions."* · *"Test STT/TTS round-trip."* · *"Test the security gauntlet."*
   For anything non-trivial, drop a `<name>.md` here (copy `EXAMPLE-nvda-dag.md`) so the scenario + must-pass predicates are pinned.

2. **A milestone** — a named release milestone. The agent locates its roadmap/plan and tests every requirement + success-criterion.

3. **A spec / design document** — a path to a design or spec document. The agent reads it and tests every implementation, success-criterion, security invariant, and config knob (verifying each claim at HEAD first).

4. **A user story** — *"As a trader, I want four analysts to debate NVDA so I get a grounded call."* The agent treats each acceptance criterion as a requirement and tests the acceptance path **plus** the alternate/error paths + edge cases the story implies (`../04-DERIVE-TESTS.md §A4`).

5. **A bare prompt with test instructions** — the user hands you the scenario + what to check. The prompt is the **seed, not the plan**: the agent expands it into the full real-world + edge + deep + broad matrix for the scenario it implies, testing what the prompt *means* end-to-end, not just its literal words (`../04-DERIVE-TESTS.md §A5`).

## How the agent uses a target

```
target ─▶ 00-MISSION STEP 1 (extract requirements, per 04-DERIVE-TESTS §A)
       ─▶ STEP 2 (deep + broad test matrix → runs/<target>-<date>/TEST-PLAN.md, from templates/)
       ─▶ STEP 3 (rig + green baseline, per 01-SETUP)
       ─▶ STEP 4 (drive + fix-verify per issue, per 02-DISCIPLINE + 03-OBSERVABILITY)
       ─▶ STEP 5 (sweep K/L/M, per 05-CATALOG)
       ─▶ STEP 6 (stop-condition audit → RESULTS-LOG → fixes → memory)
```

## Writing a target spec (recommended for complex use cases)
Copy a worked example and fill: **Scenario** (the exact drive), **Capabilities→requirements**, **Must-pass predicates** (with their ground-truth oracle), **Provider/model + Stage**, and **Scope** (which broad sweeps + config postures apply). A good spec is the difference between a thin smoke test and a comprehensive one — but the agent can also derive it all from a bare sentence. Two patterns:
- **`EXAMPLE-nvda-dag.md`** — a **channel/orchestrate** target (drive via the emulator, oracle = daemon log + outbound + `explain`).
- **`EXAMPLE-verified-learning.md`** — an **offline / DB / event-resident** target (drive via tool turns + crons, oracle = `db.mjs` + `comis memory learning` + the `learning:*` events). Use this shape for memory/learning/cron/queue capabilities that aren't a chat round-trip. It also models the **verify-impl-state-at-HEAD** discipline (a stale spec marked things "dormant" that were live + default-ON).
- **`EXAMPLE-cron-wake-gate.md`** — a **cron / scheduler-gate + jail** target (author a gate → fire via `cron.run` → oracle = the `cron.runs` skip lens + `scheduler:wake_gate` events + fleet `cron_wake_gate_efficiency` + `security audit-log`, driven with `scripts/wg.mjs`). Use this shape for a scheduler pre-payload capability that runs in a bwrap jail (Linux-only — run the `.linux` gate via `scripts/run-linux-tests.sh`); it combines the offline discipline (verified-learning) with the jail-probe discipline (nvda-dag).

## Convention
- Keep per-run output under `runs/<target>-<YYYYMMDD>/` (TEST-PLAN.md, RESULTS-LOG.md, FIX-VERIFY-LOG.md from `../templates/`).
- A run is "done" only when the `RESULTS-LOG` stop-condition checklist is all-checked or honest-deferred.
