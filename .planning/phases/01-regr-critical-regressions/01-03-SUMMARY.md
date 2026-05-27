---
phase: 01-regr-critical-regressions
plan: "03"
subsystem: agent
tags: [context-engine, signed-thinking, anthropic-400, pipeline, layers, tdd]

# Dependency graph
requires:
  - phase: 01-regr-critical-regressions/01-01
    provides: Secret-prefix vocabulary R0 (prerequisite for this phase)
provides:
  - "createSignatureReplayScrubber wired always-on into context-engine pipeline (between thinkingCleaner and signatureSurrogateGuard)"
  - "R5-a/R5-b layer-membership+ordering durability test (catches future accidental unwiring)"
  - "R5-c continuation-history functional test (no signed thinking block survives transformContext)"
affects: [context-engine, executor, continuation, anthropic-api]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Always-on layer push outside model.reasoning guard (signature-replay-scrubber)"
    - "layerNames array in startup log for test introspection"
    - "Startup log layer inspection approach for ordering assertions (no test accessor required)"

key-files:
  created: []
  modified:
    - packages/agent/src/context-engine/context-engine.ts
    - packages/agent/src/context-engine/context-engine.test.ts

key-decisions:
  - "Layer inspection via startup log layerNames field (added to log payload) — avoids adding test accessor to ContextEngine interface"
  - "Test uses thinkingSignature (not signature) for R5-c — matches actual scrubber logic at signature-replay-scrubber.ts:167"
  - "All layerCount assertions updated +1 in GREEN commit (scrubber always-on adds one layer to every config)"
  - "setup-shutdown.test.ts timeout during full suite run confirmed pre-existing flaky test (passes in isolation)"

requirements-completed:
  - R5

# Metrics
duration: 15min
completed: 2026-05-27
---

# Phase 01 Plan 03: Re-wire createSignatureReplayScrubber Summary

**Always-on signed-thinking scrubber re-wired into context-engine pipeline (import + layers.push between thinkingCleaner and signatureSurrogateGuard), with R5-a/R5-b/R5-c TDD durability tests**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-27T14:30:00Z
- **Completed:** 2026-05-27T14:39:10Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 2

## Accomplishments

- Re-wired `createSignatureReplayScrubber` as always-on layer between `thinkingCleaner` and `signatureSurrogateGuard`, fixing the Anthropic 400 "thinking blocks cannot be modified" regression from commit `3ee4397`
- Added `layerNames` to startup log for test introspection without modifying the `ContextEngine` interface
- Wrote 3 durability tests (R5-a membership, R5-b ordering, R5-c continuation scrub) that will catch any future accidental unwiring
- Updated all 13 existing `layerCount` assertions (+1 for always-on scrubber) and the per-layer index assertions in test `q)`

## Task Commits

1. **Task 1 (RED): Failing R5 tests** - `7944310` (test)
2. **Task 2 (GREEN): Re-wire createSignatureReplayScrubber** - `50a4984` (feat)

## Files Created/Modified

- `packages/agent/src/context-engine/context-engine.ts` — Added import + layers.push(createSignatureReplayScrubber) + layerNames to startup log
- `packages/agent/src/context-engine/context-engine.test.ts` — Added R5-a/b/c tests; updated layerCount assertions; updated layer name indices in test q)

## Decisions Made

- **Layer inspection approach:** Added `layerNames: layers.map((l) => l.name)` to the startup log payload. This avoids adding a `getLayerNames()` method to the `ContextEngine` interface (which would be test-only surface on a production type). The startup log approach follows the existing pattern used for `layerCount`.
- **R5-c uses `thinkingSignature` not `signature`:** The scrubber strips blocks where `b.thinkingSignature` is a non-empty string (line 167 of `signature-replay-scrubber.ts`), not blocks with a `signature` field. The test was written to match the actual scrubber behavior so it fails pre-patch for the right reason (scrubber absent) and passes post-patch.
- **No test accessor added to ContextEngine:** Kept the interface clean. Log-based inspection is sufficient for durability testing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test `f)` exact-match broken by layerNames log addition**

- **Found during:** Task 1 (RED)
- **Issue:** Test `f)` asserts an exact object match on the startup log payload. Adding `layerNames` to the log broke it since the exact object no longer matched.
- **Fix:** Updated test `f)` to include `layerNames: expect.any(Array)` in the expected object, keeping the exact match pattern but tolerating the new field.
- **Files modified:** `context-engine.test.ts`
- **Committed in:** `7944310` (part of RED commit — minimal change to restore passing state)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug caused by new log field)
**Impact on plan:** Minimal — one test assertion updated to include the new `layerNames` field. No scope creep.

## Issues Encountered

- `setup-shutdown.test.ts` timed out during full `pnpm test` run (5000ms timeout under load). Confirmed pre-existing flaky test: passes when run in isolation (`pnpm vitest run packages/daemon/src/wiring/setup-shutdown.test.ts`). Not related to R5. Logged as deferred (out-of-scope per scope boundary rule).

## Next Phase Readiness

- R5 complete: signed-thinking scrubber always-on in pipeline; continuation-after-requiresConfirmation/error no longer produces Anthropic 400
- `pnpm validate` green: build + agent tests (222/222) + lint:security (0 errors) + cycles (no circular deps)
- Phase 01 requirements R0 (01-01), R1 (01-02), R5 (01-03) all complete

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The scrubber is a pure in-memory content transformation layer — no new trust boundaries.

---
*Phase: 01-regr-critical-regressions*
*Completed: 2026-05-27*
