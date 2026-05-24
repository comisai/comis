---
phase: 02-bridge-expansion-payload-bounding
plan: 02
subsystem: observability
tags: [bound-02, bound-03, wr-04, trajectory, file-caps, lru, tdd]
dependency_graph:
  requires:
    - packages/observability/src/trajectory/runtime.ts (emitTruncatedInternal — reused from Phase 1 LIFE-03)
    - packages/observability/src/trajectory/types.ts (TrajectoryRecorderBudgets, TrajectoryRecorder interface)
    - packages/observability/src/shared/queued-file-writer.ts (getQueuedFileWriter — LRU chassis)
  provides:
    - packages/observability/src/trajectory/runtime.ts (TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES, MAX_TRAJECTORY_WRITERS, soft cap in recordEvent, LRU on writerRegistry, droppedEvents() accessor)
  affects:
    - All trajectory JSONL output: recordings now stop inline at 10 MB with trace.truncated sentinel
    - All trajectory writer lifecycle: registry capped at 100 writers with LRU eviction
tech_stack:
  added: []
  patterns:
    - JS Map insertion-order LRU (move-to-end on access, evict-first on overflow)
    - Inline sentinel emission — emitTruncatedInternal called from recordEvent (not only flushAndClose)
    - Per-recorder drop counter exposed as accessor method (WR-04 observable drops)
key_files:
  created: []
  modified:
    - packages/observability/src/trajectory/runtime.ts
    - packages/observability/src/trajectory/runtime.test.ts
    - packages/observability/src/trajectory/types.ts
decisions:
  - "No @comis/infra logger import — observability package does not depend on @comis/infra (not in package.json); droppedEvents() accessor satisfies WR-04 observability without a cross-package import"
  - "flushAndClose skip guard: when soft-cap sets state.closed inline, flushAndClose must still drain+close the writer (drain without re-emitting trace.truncated); solved via alreadyClosed flag"
  - "Fire-and-forget eviction: LRU eviction calls void evicted.flushAndClose() — QueuedFileWriter chassis serialises writes on promise chain so in-flight data is preserved before close"
metrics:
  duration_minutes: 14
  completed_date: "2026-05-24"
  tasks_completed: 3
  files_modified: 3
---

# Phase 2 Plan 2: File Caps (BOUND-02) + Writer LRU (BOUND-03) + WR-04 Drop Signal Summary

**One-liner:** Added 10 MB inline soft cap (`TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES`) in `recordEvent` emitting `trace.truncated` inline via the Phase 1 `emitTruncatedInternal` hook, LRU eviction on `writerRegistry` at `MAX_TRAJECTORY_WRITERS = 100` using JS Map insertion-order semantics, and a `droppedEvents()` accessor on the recorder satisfying WR-04 observable drops.

## What Was Built

### BOUND-02: 10 MB Soft Cap + Hard-Cap Path

**New constant:** `export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024`

**New budget field:** `TrajectoryRecorderBudgets.captureMaxBytes?: number` — per-recorder override for test isolation (defaults to `TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES`).

**New state:** `droppedEventBytes: 0` accumulated alongside `droppedEvents` for accurate sentinel payload.

**Soft-cap check in `recordEvent` (step 4a, before the existing hard-cap check at step 4b):**
```ts
if (state.writtenBytes + bytes > captureMaxBytes) {
  state.droppedEvents += 1;
  state.droppedEventBytes += bytes;
  emitTruncatedInternal({
    reason: "trajectory-runtime-file-size-limit",
    droppedEvents: state.droppedEvents,
    droppedEventBytes: state.droppedEventBytes,
    limitBytes: captureMaxBytes,
  });
  state.closed = true;
  return "dropped";
}
```

**`flushAndClose` fix:** Added `alreadyClosed` flag so the writer is still drained+closed after an inline soft-cap close, but the close-time `trace.truncated` sentinel is NOT re-emitted (it was already written inline). This prevents duplicate sentinels and wrong `droppedEvents` counts.

### BOUND-03: Writer LRU Eviction

**New constant:** `export const MAX_TRAJECTORY_WRITERS = 100`

**`acquireWriter()` helper** implements LRU on the module-level `writerRegistry` Map:
- Move-to-end on re-access (LRU refresh): delete + re-set existing key before registering.
- After `getQueuedFileWriter` registers the new writer, evict oldest entries while `writerRegistry.size > MAX_TRAJECTORY_WRITERS`.
- Eviction: `void evicted.flushAndClose()` (fire-and-forget), then `writerRegistry.delete(oldestKey)`.
- Guard: never evict the `filePath` just acquired (handles size=1 edge case).

### WR-04: Drop Signal Observable

**New `droppedEvents()` accessor** on the `TrajectoryRecorder` interface and implementation:
```ts
droppedEvents(): number {
  return state.droppedEvents;
}
```
Callers at lifecycle-envelope emit sites can now read this to detect and log silent drops.

## TDD Gate Compliance

RED commit precedes GREEN commits:

1. `test(02-02)` commit `8c240cf` — 4 BOUND-02/03 tests failing on pre-patch code
2. `feat(02-02)` commit `2e0d218` — soft cap + WR-04 GREEN (tests 1, 2, 4 pass)
3. `feat(02-02)` commit `8b6502a` — LRU GREEN (test 3 passes)

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| `8c240cf` | test (RED) | Add failing BOUND-02/03 file-cap + LRU tests |
| `2e0d218` | feat (GREEN) | Add 10MB soft cap + WR-04 drop handling (BOUND-02) |
| `8b6502a` | feat (GREEN) | Add writer-registry LRU eviction at MAX_TRAJECTORY_WRITERS (BOUND-03) |

## Verification Results

- `cd packages/observability && pnpm vitest run src/trajectory/runtime.test.ts`: 33/33 pass
- `grep -n "captureMaxBytes" packages/observability/src/trajectory/runtime.ts`: confirms check at recordEvent line ~468 (inside recordEvent, not flushAndClose)
- `pnpm build`: all 15 packages compile cleanly
- `pnpm lint:security`: 0 errors
- `pnpm cycles`: No circular dependency found
- `pnpm test` (full suite): 574/574 observability tests pass; 1 pre-existing worker-crash failure in unrelated package (confirmed pre-existing before this plan's changes)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed flushAndClose to drain writer after inline soft-cap close**
- **Found during:** Task 2 (GREEN) — soft-cap test showed 0 lines written
- **Issue:** When soft-cap fires and sets `state.closed = true`, the existing `if (state.closed) return;` guard in `flushAndClose` caused early exit BEFORE calling `await writer.flushAndClose()`. The writer's promise chain (queued writes including the inline trace.truncated sentinel) was never drained, so no data landed on disk.
- **Fix:** Added `alreadyClosed` flag before the guard. If already closed, skip state mutation and the droppedEvents close-time sentinel emission, but still call `writer.flush()` + `writer.flushAndClose()` to drain the queue and close the file handle.
- **Files modified:** `packages/observability/src/trajectory/runtime.ts`
- **Commit:** `2e0d218`

**2. [Rule 2 - Missing functionality] @comis/infra import omitted — WR-04 satisfied via accessor**
- **Found during:** Task 2 planning — plan suggested `getLogger("trajectory-runtime").debug(...)` for WR-04
- **Issue:** `packages/observability/package.json` does not list `@comis/infra` as a dependency. Adding a logger import would create a new cross-package dependency requiring package.json changes (architectural scope).
- **Fix:** Per plan's explicit fallback ("Prefer a per-recorder counter for WR-04 if adding a logger import would breach a module boundary"), implemented WR-04 purely via the `droppedEvents(): number` accessor. The counter is observable by callers at lifecycle-envelope emit sites without requiring a logger in this package.
- **Files modified:** None beyond the plan (no new dependency needed)

## Known Stubs

None. All three capabilities (soft cap, LRU, drop accessor) are fully functional with no placeholders.

## Threat Flags

No new network endpoints, auth paths, or schema changes. The soft cap and LRU eviction operate entirely within the existing trajectory write path and module-level registry.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `runtime.ts` modified | FOUND |
| `types.ts` modified | FOUND |
| `runtime.test.ts` modified | FOUND |
| RED commit `8c240cf` exists | FOUND |
| GREEN commit `2e0d218` exists | FOUND |
| GREEN commit `8b6502a` exists | FOUND |
| `TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES` exported | FOUND (line 93) |
| `MAX_TRAJECTORY_WRITERS` exported | FOUND (line 116) |
| `captureMaxBytes` check in recordEvent (not flushAndClose) | FOUND (line ~468) |
| `droppedEvents()` on TrajectoryRecorder interface | FOUND |
| All 33 runtime tests pass | CONFIRMED |
| pnpm build clean | CONFIRMED |
