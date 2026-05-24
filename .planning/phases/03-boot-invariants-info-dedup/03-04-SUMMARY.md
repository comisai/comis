---
phase: 03-boot-invariants-info-dedup
plan: "04"
subsystem: test/integration + orchestrator/inbound
tags: [m1-acceptance-gate, incident-replay, dedup-load-test, tdd, observability]
dependency_graph:
  requires:
    - 03-01 (emitStartupInvariants + getRawHandlerCounts seams)
    - 03-02 (queue:enqueued INFO promotion)
    - 03-03 (createDedupDetector + dedup:duplicate_inbound emit + bridge)
  provides:
    - M1 acceptance gate (design §9.2) — 3-layer incident replay integration test
    - Dedup detector load test (design §8.4) — 10× throughput, bounded memory
  affects:
    - test/integration/incident-replay-2026-05-24.test.ts (new)
    - packages/orchestrator/src/inbound/dedup-detector.perf.test.ts (new)
    - packages/orchestrator/src/index.ts (createDedupDetector export added)
    - packages/daemon/src/index.ts (emitStartupInvariants export added)
    - test/support/public-api-policy.ts (orphan tracking for test-only exports)
tech_stack:
  added: []
  patterns:
    - injectable clock for deterministic perf tests (no real timers)
    - orchestrator-layer replay (no full daemon spin-up)
    - real createCommandQueue + minimal executor stub for Layer 3 queue signals
    - public-api-policy.ts orphan tracking for test-only re-exports
key_files:
  created:
    - test/integration/incident-replay-2026-05-24.test.ts
    - packages/orchestrator/src/inbound/dedup-detector.perf.test.ts
  modified:
    - packages/orchestrator/src/index.ts
    - packages/daemon/src/index.ts
    - test/support/public-api-policy.ts
decisions:
  - "Integration test uses 3 separate describe blocks (one per layer) rather than one monolithic it block — cleaner failure isolation while still satisfying the single-file gate requirement"
  - "Layer 3 uses real createCommandQueue (not stub) so queue:enqueued events are emitted from the real implementation — more faithful to the incident scenario"
  - "createDedupDetector and emitStartupInvariants re-exported from their package indices (@comis/orchestrator and @comis/daemon) and tracked in public-api-policy.ts — avoids internal source path imports from test/"
  - "Layer 2 test uses messageRouter.resolve → undefined to force early exit after the dedup check — clean isolation of the dedup signal without needing a full pipeline execution"
  - "Perf test uses 5 focused assertions instead of one monolithic benchmark: throughput guard, correctness, post-window eviction, LRU cap, synchrony — each independently verifiable"
metrics:
  duration: ~20 minutes
  completed: "2026-05-24"
  tasks: 2
  files_modified: 5
  tests_added: 8
---

# Phase 03 Plan 04: M1 Acceptance Gate + Dedup Load Test — Summary

Single integration test that re-introduces the 2026-05-24 duplicate-adapter wiring and proves the bug is now visible at all three independent layers (boot WARN, dedup event, double queue:enqueued) in one file; plus a deterministic load test confirming the detector handles 10× expected throughput with bounded memory.

## What Was Built

### Task 1 — M1 Acceptance Gate: incident-replay-2026-05-24 (commit 72bc090)

**test/integration/incident-replay-2026-05-24.test.ts** (3 tests):

Construction: orchestrator-layer synthesis (no daemon config revert, no full daemon spin-up). Imports from `@comis/orchestrator`, `@comis/channels`, `@comis/daemon`, `@comis/core`.

**Layer 1 (boot WARN)**
- Creates EchoChannelAdapter with `channelType:"telegram"`, passes it to BOTH `deps.adapters` and `channelRegistry.getChannelPlugins()` — the pre-fix wiring.
- `cm.getRawHandlerCounts().get("telegram") === 2` confirms the BOOT-02 seam captures the regression.
- `emitStartupInvariants(...)` called with a capturing mock logger:
  - INFO record asserted: `handlersPerAdapter: { telegram: 2 }`
  - WARN asserted: `{ channelType:"telegram", errorKind:"config", hint:"Duplicate adapter registration detected; see AGENTS.md §6.1" }`

**Layer 2 (dedup event)**
- Controlled clock (1000 → 1001 ms) via injectable `now`.
- Same messageId injected twice through `processInboundMessage`.
- `dedup:duplicate_inbound` event asserted: `{ messageId, channelType:"telegram", deltaMs:1, source:"pipeline" }`.
- Logger WARN asserted: `{ errorKind:"internal", hint:"Same messageId processed twice..." }`.

**Layer 3 (queue double-enqueue)**
- Real `createCommandQueue` wired to the shared `TypedEventBus`.
- Minimal executor stub returns a valid `ExecutionResult` so Phase 1 succeeds.
- Both messages (unique + duplicate) reach the queue.
- `queue:enqueued` asserted to fire twice with `channelType:"telegram"`.
- Dedup WARN also confirmed present (layers 2+3 share one eventBus).

**Export additions to support the test**:
- `createDedupDetector` + types re-exported from `@comis/orchestrator`
- `emitStartupInvariants` + types re-exported from `@comis/daemon`
- Both tracked in `test/support/public-api-policy.ts` under their respective package orphan lists.

### Task 2 — Dedup Detector Load Test (commit 48cfb71)

**packages/orchestrator/src/inbound/dedup-detector.perf.test.ts** (5 tests):

All deterministic — injectable `now` clock, no real timers.

1. **Throughput guard**: 3000 message checks (300 msg/s × 10s synthetic) complete in <100ms wall-clock.
2. **Duplicate correctness**: 200 unique IDs at 300 msg/s pace, then 50 re-injected within the window → all 50 detected as `isDuplicate:true`.
3. **Post-window eviction**: ID inserted at t=0, checked at t=10001ms → `isDuplicate:false` (memory bounded).
4. **LRU cap**: Insert MAX_ENTRIES+50 unique IDs → first 50 evicted → return `isDuplicate:false` on re-check. Last inserted ID returns `isDuplicate:true`.
5. **Synchrony**: `check()` result is a plain object, never a Promise; `isDuplicate` is immediately available.

## 3-Layer Replay Result

All three layers proven programmatically in `test/integration/incident-replay-2026-05-24.test.ts`:

| Layer | Signal | Proven | Method |
|-------|--------|--------|--------|
| 1 (boot) | WARN `errorKind:"config"` + `handlersPerAdapter:{telegram:2}` | Programmatically | emitStartupInvariants + mock logger assertion |
| 2 (first message) | `dedup:duplicate_inbound` `deltaMs:1` + WARN `errorKind:"internal"` | Programmatically | processInboundMessage with injectable clock |
| 3 (queue) | `queue:enqueued` fires twice with same channelType | Programmatically | real createCommandQueue on shared TypedEventBus |

No layer requires live-daemon manual verification. M1 is closeable.

## Deviations from Plan

### Auto-added exports (Rule 2 — missing critical functionality)

**createDedupDetector not exported from @comis/orchestrator**
- **Found during:** Task 1 implementation
- **Issue:** The integration test (in `test/`) must import from dist aliases; `createDedupDetector` was internal to `packages/orchestrator/src/inbound/dedup-detector.ts` with no public re-export.
- **Fix:** Added `export { createDedupDetector }` + type exports to `packages/orchestrator/src/index.ts`; tracked in `public-api-policy.ts` under `@comis/orchestrator`.
- **Commit:** 72bc090

**emitStartupInvariants not exported from @comis/daemon**
- **Found during:** Task 1 implementation
- **Issue:** Same issue — `emitStartupInvariants` was not accessible from `@comis/daemon` dist.
- **Fix:** Added `export { emitStartupInvariants }` + type exports to `packages/daemon/src/index.ts`; tracked in `public-api-policy.ts` under `@comis/daemon`.
- **Commit:** 72bc090

### Approach deviation (Layer 2 test construction)

The plan suggested wiring Layer 2 through the channel-manager `onMessage` path. Instead, `processInboundMessage` is called directly with `messageRouter.resolve → undefined` to force early exit after the dedup check fires — cleaner isolation of the Layer 2 signal without needing the full resolution/execution pipeline. The plan explicitly allows either construction ("either via the channel-manager onMessage … OR via processInboundMessage directly").

## Verification

- `pnpm build`: clean (all 15 packages)
- `pnpm test`: 1300/1301 test files pass; 1 pre-existing flaky failure in `@comis/skills/src/tools/builtin/exec-tool.test.ts` (unrelated to this plan — `TypeError: URL is not a constructor` environment issue)
- `pnpm lint:security`: 0 errors, 1616 warnings (all pre-existing)
- `pnpm cycles`: No circular dependency found
- Integration test: all 3 layers GREEN via `pnpm vitest run --config test/vitest.config.ts test/integration/incident-replay-2026-05-24.test.ts`
- Perf test: all 5 assertions GREEN via `pnpm vitest run packages/orchestrator/src/inbound/dedup-detector.perf.test.ts`

## Known Stubs

None. All assertions test real implementations from 03-01/02/03.

## Self-Check: PASSED

### Created files exist:
- [x] `test/integration/incident-replay-2026-05-24.test.ts`
- [x] `packages/orchestrator/src/inbound/dedup-detector.perf.test.ts`
- [x] `.planning/phases/03-boot-invariants-info-dedup/03-04-SUMMARY.md`

### Commits exist:
- [x] 72bc090 (Task 1: M1 acceptance gate + exports)
- [x] 48cfb71 (Task 2: dedup detector load test)
