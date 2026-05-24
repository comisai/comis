---
phase: 02-bridge-expansion-payload-bounding
plan: 06
subsystem: observability
tags: [sc3, bound-02, trajectory, hard-cap, warn, tdd, gap-closure]
dependency_graph:
  requires:
    - packages/observability/src/trajectory/runtime.ts (hard-cap branch, step 4b)
    - packages/observability/src/trajectory/types.ts (TrajectoryRecorderInit)
    - packages/core/src/logging/log-fields.ts (ComisLogger structural contract)
  provides:
    - packages/observability/src/trajectory/runtime.ts (hardCapWarnEmitted guard + logger.warn in step 4b)
    - packages/observability/src/trajectory/types.ts (TrajectoryRecorderInit.logger?: ComisLogger)
  affects:
    - All trajectory recorders that pass a logger via init: now emit a single WARN when the 50 MB hard cap fires
tech_stack:
  added: []
  patterns:
    - Injected optional logger (ComisLogger from @comis/core) — matches persist.ts pattern, no new package dep
    - Once-per-recorder WARN guard (hardCapWarnEmitted flag in state)
key_files:
  created: []
  modified:
    - packages/observability/src/trajectory/types.ts
    - packages/observability/src/trajectory/runtime.ts
    - packages/observability/src/trajectory/runtime.test.ts
decisions:
  - "Option B (injected logger) over Option A (@comis/infra dep): observability already uses ComisLogger from @comis/core via optional injection (persist.ts pattern); adding @comis/infra as a declared dep would introduce a new edge in the package graph — not needed since @comis/core already exports the structural ComisLogger contract"
  - "Once-per-recorder guard: hardCapWarnEmitted flag in per-recorder state prevents re-emission on every dropped event after the cap"
  - "limitBytes = usableFileBytes (not maxRuntimeFileBytes): the hard-cap branch guards on usableFileBytes (maxRuntimeFileBytes - sentinelReserveBytes); reporting the actual threshold is more actionable for operators"
metrics:
  duration_minutes: 12
  completed_date: "2026-05-24"
  tasks_completed: 1
  files_modified: 3
---

# Phase 2 Plan 6: SC3 Gap Closure — Hard-Cap 50 MB errorKind:resource WARN Summary

**One-liner:** Added a once-per-recorder `errorKind:"resource"` WARN with `limitBytes` and `observability.logRotation` hint to the 50 MB hard-cap branch in `recordEvent`, injected via an optional `logger?: ComisLogger` on `TrajectoryRecorderInit`, closing the SC3 gap identified in 02-VERIFICATION.md.

## What Was Built

### SC3 / BOUND-02 Hard-Cap WARN

**Gap:** The hard-cap branch (step 4b, `state.writtenBytes + bytes > usableFileBytes`) in `recordEvent` silently incremented `droppedEvents` and returned `"dropped"`. No operator signal was emitted. SC3 and BOUND-02 require a WARN with `errorKind:"resource"` and a `hint` pointing to `observability.logRotation`.

**Fix:** Three-part change:

**1. `TrajectoryRecorderInit.logger?: ComisLogger` (types.ts)**

Added a 12th optional field to `TrajectoryRecorderInit`. Uses `ComisLogger` from `@comis/core` — the same structural contract used by `persist.ts` in the same package. No new package dependency; `@comis/core` was already in `observability`'s `dependencies`. The `model` nested type literal contributes 3 inner optional members that grep overcounts — the interface-level count lands at exactly 12, at the architecture invariant limit.

**2. `hardCapWarnEmitted` guard (runtime.ts state)**

Added to per-recorder `state` object. Prevents repeat emission — without this, every subsequent call to `recordEvent` after the hard cap fires would re-emit the WARN, producing log spam in high-throughput scenarios.

**3. Hard-cap branch WARN emission (runtime.ts recordEvent step 4b)**

```ts
if (logger !== undefined && !state.hardCapWarnEmitted) {
  state.hardCapWarnEmitted = true;
  logger.warn(
    {
      errorKind: "resource" as const,
      limitBytes: usableFileBytes,
      hint: "Trajectory runtime file hit the hard cap; enable observability.logRotation or raise the diagnostics.trajectory.maxFileBytes budget",
    },
    "Trajectory runtime file hit hard cap; writer halted",
  );
}
```

The `hint` value satisfies SC3's requirement to reference `observability.logRotation`.

## TDD Gate Compliance

RED commit precedes GREEN commit:

1. `test(02-06)` commit `1ff4218` — Test 5 added to `runtime.test.ts`; fails RED (warnCalls.length === 0; logger field absent from TrajectoryRecorderInit type)
2. `feat(02-06)` commit `a2a8eff` — types.ts + runtime.ts changes; all 34 tests pass GREEN

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| `1ff4218` | test (RED) | Add failing hard-cap WARN test (SC3/BOUND-02) |
| `a2a8eff` | feat (GREEN) | Emit errorKind:resource WARN once on 50MB hard-cap hit |

## Verification Results

- `pnpm vitest run packages/observability/src/trajectory/runtime.test.ts`: 34/34 pass
- `pnpm vitest run test/architecture/optional-field-bloat.test.ts`: 1/1 pass (TrajectoryRecorderInit at 12 optional fields, within limit)
- `pnpm cycles`: No circular dependency found
- `pnpm build`: all 15 packages compile clean
- `pnpm lint:security`: 0 errors (1616 warnings, pre-existing)
- `pnpm test` full suite: 24129/24129 pass + 13 skip (1 pre-existing worker-crash unrelated to this change)

## Deviations from Plan

None — the fix approach was exactly Option B (injected logger via `TrajectoryRecorderInit`) as specified in the `<fix_approach>` section of the gap closure prompt.

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes. The WARN emission operates within the existing `recordEvent` write path and produces structured log output through the injected logger only.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `types.ts` modified — `logger?: ComisLogger` field added | FOUND |
| `runtime.ts` modified — `hardCapWarnEmitted` guard + WARN emission | FOUND |
| `runtime.test.ts` modified — Test 5 hard-cap WARN test | FOUND |
| RED commit `1ff4218` exists | FOUND |
| GREEN commit `a2a8eff` exists | FOUND |
| `pnpm cycles` clean | CONFIRMED |
| `pnpm build` clean | CONFIRMED |
| architecture optional-field-bloat test passes | CONFIRMED |
| 34/34 runtime tests pass | CONFIRMED |
