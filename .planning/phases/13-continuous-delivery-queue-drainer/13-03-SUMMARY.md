---
phase: 13-continuous-delivery-queue-drainer
plan: 03
subsystem: delivery-queue
tags: [delivery-queue, channel-side, in-flight-insert, redundant-emit-removal, race-safety, hexagonal]

# Dependency graph
requires:
  - phase: 13-continuous-delivery-queue-drainer
    provides: SPEC.md (R2 race safety, R5 universal observability), CONTEXT.md (D-04 adapter emit, D-05 channel-side in_flight insert, D-06 in_flight semantics), PATTERNS.md (call-site rewire pattern)
  - plan: 13-02
    provides: DeliveryQueuePort.enqueueInFlight (status='in_flight' insert), DeliveryQueuePort.recoverInFlight, SqliteDeliveryQueueAdapter eventBus-injected emit (single source of truth)
provides:
  - "Channel-side synchronous-send path inserts with status='in_flight' (race-safe vs recurring drainer's WHERE status='pending' filter; SPEC-R2)"
  - "Single delivery:enqueued event per channel-side send -- adapter is sole emit source (SPEC-R5 universal observability)"
  - "Test mocks across all four createMock*Queue factories type-check against the extended DeliveryQueuePort interface from Plan 13-02"
affects: [13-04-PLAN integration test (depends on race-safe channel-side insert)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Method swap on existing port call site (enqueue -> enqueueInFlight) -- payload byte-identical, only status semantics change"
    - "Removal of caller-side event emit when adapter takes ownership of emission (SPEC-R5 single-source-of-truth refactor)"
    - "Process-local lease semantics: 'in_flight' rows are owned by the in-process send; ack/nack/fail release the lease via status-agnostic UPDATE-by-id"

key-files:
  created: []
  modified:
    - "packages/channels/src/shared/deliver-to-channel.ts -- line 447 method swap (enqueue -> enqueueInFlight); deleted the eventBus?.emit('delivery:enqueued', ...) block at lines 466-472 (7 lines deleted, 3-line comment retained explaining the move)"
    - "packages/channels/src/shared/deliver-to-channel.test.ts -- ALL FOUR createMock*Queue factories extended with enqueueInFlight + recoverInFlight (plan anticipated 2; found 4); existing test 'calls enqueue before send' renamed to 'calls enqueueInFlight before send', assertions updated; existing test 'continues delivery when enqueue fails' renamed to enqueueInFlight; existing test 'emits delivery:enqueued and delivery:acked events' inverted to assert ZERO delivery:enqueued events (mock adapter doesn't emit); 4 new Phase 13 tests added in describe('delivery-queue integration (Phase 13)')"

key-decisions:
  - "Updated all four createMock*Queue factories, not just the two anticipated by the plan (the plan said 'fail-loud rather than skip' if a third was found; we found two more: createMockQueue at line 1084 used by delivery-strategy tests, and createMockQueueForInFlight at line 1242 used by inFlightSends tracking tests; both are consumed by tests that exercise the channel-side path through deliverToChannel, so without the new method the awaited call would explode at runtime)"
  - "Retained the 3-line explanatory comment at the deleted-emit site (per Step 2a of plan -- the AC's grep target is the QUOTED string literal, not the bare token; the comment helps future readers understand the move to adapter-side emission)"
  - "Inverted (rather than deleted) the existing test 'emits delivery:enqueued and delivery:acked events when queue is active' -- the test still verifies delivery:acked AND now asserts delivery:enqueued count is 0 from this file's perspective (the mocked adapter doesn't emit; the real adapter would, but it's mocked in this unit-tier test)"

requirements-completed: [SPEC-R2, SPEC-R5]

# Metrics
duration: 6min
completed: 2026-05-05
---

# Phase 13 Plan 03: Channel-side in_flight insert + redundant emit removal Summary

**Switched the channel-side synchronous-send path to insert delivery-queue rows with `status='in_flight'` (via Plan 13-02's `enqueueInFlight`) and removed the now-redundant `delivery:enqueued` event emit from `deliver-to-channel.ts`. The recurring drainer's `WHERE status='pending'` filter cannot race-pick rows whose `adapter.sendMessage` is in progress (SPEC-R2), and there is exactly one source of truth for `delivery:enqueued` -- the adapter (SPEC-R5).**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-05T13:17:00Z
- **Completed:** 2026-05-05T13:22:44Z
- **Tasks:** 1 / 1
- **Files modified:** 2

## Accomplishments

- `deliver-to-channel.ts:447` swapped from `deps.deliveryQueue.enqueue(...)` to `deps.deliveryQueue.enqueueInFlight(...)`. Payload object is byte-identical (per the plan's instruction: only the method name changes). Channel-side rows now persist as `'in_flight'` instead of `'pending'`.
- `deliver-to-channel.ts:466-472` -- the `deps.eventBus?.emit("delivery:enqueued", ...)` block (7 lines) was deleted. SqliteDeliveryQueueAdapter (Plan 13-02) is now the sole emit source for `delivery:enqueued` -- universal observability with one event per persisted row.
- Comment retained at the former emit site (3 lines, bare-token references only -- no quoted string literal). The comment is explicitly permitted by the AC (grep counts only quoted occurrences `"delivery:enqueued"`).
- `entryId` capture for downstream ack/nack/fail still works -- only the method name and the inner emit call were changed; `entryId = enqueueResult.value` remains.
- `ack`, `nack`, and `fail` blocks at lines 519-588 are UNCHANGED -- the existing UPDATE-by-id statements are status-agnostic and transition `'in_flight' -> 'delivered' / 'pending' / 'failed'` cleanly without any SQL modification.
- ALL FOUR `createMock*Queue` factories in `deliver-to-channel.test.ts` extended with `enqueueInFlight` and `recoverInFlight` (plus `statusCounts` in the two factories whose type intersection lacked it). The plan anticipated 2 factories; we found 4 and applied the same extension to all of them.
- 4 new Phase 13 unit tests added in `describe("delivery-queue integration (Phase 13)", ...)` exercising the new behavior contract directly.
- 65 / 65 tests pass in `deliver-to-channel.test.ts` (61 existing + 4 new). Full monorepo `pnpm build` exits 0.

## Task Commits

1. **Task 1: Switch channel-side path to enqueueInFlight + remove redundant emit + update both mock factories** -- `e49490d` (feat)

## Files Created/Modified

- `packages/channels/src/shared/deliver-to-channel.ts` -- 1 method-swap edit at line 447 (`deliveryQueue.enqueue` -> `deliveryQueue.enqueueInFlight`); 1 deletion of the 7-line `deps.eventBus?.emit("delivery:enqueued", ...)` block at original lines 466-472, replaced with a 3-line bare-token explanatory comment; 6-line block comment added above the if-block explaining the in_flight lease semantics. Net: +14 / -8 lines (per `git diff --shortstat HEAD~1 HEAD -- packages/channels/src/shared/deliver-to-channel.ts`).
- `packages/channels/src/shared/deliver-to-channel.test.ts` -- 4 mock factory extensions, 3 existing test updates (1 rename, 1 graceful-degradation rename, 1 assertion inversion), 4 new Phase 13 tests in a nested describe block. Net: +114 / -18 lines.

## Output Spec Confirmation

Per the plan's `<output>` block:

- **Exact line range of the deleted emit block (post-edit):** Original lines 466-472 (7 lines, the `deps.eventBus?.emit("delivery:enqueued", { ... });` call including its argument literal). Replaced by a 3-line bare-token comment that does NOT contain the quoted string `"delivery:enqueued"`. AC `grep -c '"delivery:enqueued"' packages/channels/src/shared/deliver-to-channel.ts` returns `0`.
- **Confirmation that `deps.deliveryQueue.enqueueInFlight` replaces `deps.deliveryQueue.enqueue` at the prior line 447:** Yes -- `grep -c "deps.deliveryQueue.enqueueInFlight" packages/channels/src/shared/deliver-to-channel.ts` returns `1`; `grep -c "deps.deliveryQueue.enqueue(" packages/channels/src/shared/deliver-to-channel.ts` returns `0`.
- **Whether the explanatory comment in Step 2 was kept or omitted:** Kept. The 3-line bare-token comment ("delivery:enqueued is now emitted by the adapter ...") plus a 6-line preamble block comment above the if-block explaining the in_flight lease semantics. Both contain bare-token references to `delivery:enqueued` (NOT quoted), so the AC pattern (which matches only `"delivery:enqueued"`) returns 0 -- comment policy from Step 2a satisfied.
- **Confirmation that BOTH `createMockDeliveryQueue` factories were updated:** Yes, plus TWO MORE that the plan didn't anticipate. ALL FOUR `createMock*Queue` factories in the file were extended with `enqueueInFlight: vi.fn()` and `recoverInFlight: vi.fn()`. The two `createMockDeliveryQueue` factories (lines 634, 926 post-edit -- shifted from 634, 848 pre-edit due to the inserted Phase 13 describe block) and the two additional factories `createMockQueue` (line 1093 post-edit) and `createMockQueueForInFlight` (line 1252 post-edit) all received the same extension. The two `createMockDeliveryQueue` factories also received `statusCounts` in their type intersections; the other two factories' type intersections had a narrower shape and were extended only with `enqueueInFlight` / `recoverInFlight` matching their existing pattern.

  Verification:
  - `grep -c "function createMockDeliveryQueue" packages/channels/src/shared/deliver-to-channel.test.ts` returns `2` (unchanged -- the two `createMockDeliveryQueue` factories are preserved).
  - `grep -c "enqueueInFlight: vi.fn" packages/channels/src/shared/deliver-to-channel.test.ts` returns `4` (one per factory; `>= 2` is the AC).
  - `grep -c "recoverInFlight: vi.fn" packages/channels/src/shared/deliver-to-channel.test.ts` returns `4` (one per factory; `>= 2` is the AC).

- **Names of the 4 new tests in `deliver-to-channel.test.ts`** (in `describe("delivery-queue integration (Phase 13)", ...)`):
  1. `"calls enqueueInFlight (not enqueue) for channel-side sends"`
  2. `"does NOT emit delivery:enqueued from the channel-side path (adapter is sole source)"`
  3. `"captures entryId from enqueueInFlight for downstream ack"`
  4. `"send proceeds even when enqueueInFlight fails (queue failure must not block delivery)"`

  Plus one renamed/inverted existing test `"does not emit delivery:enqueued from this file (adapter is sole source) but still emits delivery:acked"` (was: `"emits delivery:enqueued and delivery:acked events when queue is active"`), bringing the file's net new behavior coverage to 5 tests.

- **Confirmation that `cd packages/channels && pnpm vitest run src/shared/deliver-to-channel.test.ts` exits 0 with all existing + new tests passing:** Yes -- 65 / 65 tests pass (Test Files 1 passed, Tests 65 passed; duration 424ms).
- **Confirmation that `pnpm build` from repo root exits 0:** Yes. With Plans 13-01 (in parallel worktree) and 13-02 (already landed) both contributing, the full monorepo build closes the chain end-to-end. All 13 packages plus `web` SPA build cleanly.

## Decisions Made

1. **Updated all four `createMock*Queue` factories in lockstep** -- the plan anticipated 2, found 4 (`createMockDeliveryQueue` x2 + `createMockQueue` + `createMockQueueForInFlight`). Per the plan's "fail-loud rather than skip" guidance for additional factories, the same extension (`enqueueInFlight: vi.fn().mockResolvedValue(ok(...))` + `recoverInFlight: vi.fn().mockResolvedValue(ok(0))`) was applied to all four. The two extra factories were necessary because their consumer tests call `deliverToChannel`, which after this plan's source change calls `enqueueInFlight` -- without the method on the mock, the await would resolve `undefined(...)` and throw a TypeError.
2. **Retained the explanatory bare-token comment at the deleted-emit site** -- per Step 2a of the plan, the comment is permitted by the AC (which matches only the QUOTED string `"delivery:enqueued"`, not bare-token references). The comment preserves design intent for future readers.
3. **Inverted (not deleted) the test `"emits delivery:enqueued and delivery:acked events when queue is active"`** -- renamed to `"does not emit delivery:enqueued from this file (adapter is sole source) but still emits delivery:acked"`. The inversion is more informative than deletion: it documents the new contract that THIS FILE no longer emits `delivery:enqueued` (the adapter does), while preserving the verification that the `delivery:acked` event STILL fires from this file (which is correct: ack-on-success is unchanged).

## Deviations from Plan

**[Rule 3 - Blocking issue, scope expansion within file] Updated TWO additional mock factories beyond the two anticipated by the plan.**

- **Found during:** Task 1 Step 7 (test run after Steps 1-6).
- **Issue:** After updating `createMockDeliveryQueue` factories at lines 634 and 848 (the two the plan anticipated), three tests failed:
  1. `delivery strategy > best-effort: failed chunks use queue.fail not nack` -- uses `createMockQueue` at line 1084.
  2. `inFlightSends tracking > adds sendPromise to inFlightSends Set before await...` -- uses `createMockQueueForInFlight` at line 1242.
  3. `inFlightSends tracking > removes sendPromise via finally even when sendMessage rejects...` -- same factory.
- **Root cause:** Both `createMockQueue` and `createMockQueueForInFlight` lack `enqueueInFlight`. After the source switch to `deps.deliveryQueue.enqueueInFlight(...)`, calling `await undefined(...)` threw a TypeError, blowing up `deliverToChannel` before it could reach `sendMessage`. The factories were not in the plan's scope because the plan's grep scan focused on `function createMockDeliveryQueue` (the exact name); two other factories with similar shape but different names slipped through.
- **Fix:** Extended both factories with `enqueueInFlight: vi.fn(...)` and `recoverInFlight: vi.fn(...)`. `createMockQueue` is in the `delivery strategy` describe block; `createMockQueueForInFlight` is in the `inFlightSends tracking` describe block. Both extensions are minimal and consistent with the plan's pattern.
- **Files modified:** `packages/channels/src/shared/deliver-to-channel.test.ts` (same file the plan was already modifying).
- **Commit:** `e49490d` (same atomic commit as the rest of Task 1 -- the four factory updates ship together because the type-checker / runtime require all of them to type-check).

## Threat Model Compliance

The plan's `<threat_model>` defined five threats (T-13-03-01 through T-13-03-05):

- **T-13-03-01 (Tampering, mitigate):** Dual-send race between drainer tick and channel-side send is now closed -- channel-side inserts `'in_flight'`, drainer's `pendingStmt` filters `WHERE status='pending'` (existing line 128 of delivery-queue-adapter.ts unchanged). The unit-tier proof of the row-selection invariant lives in Plan 13-01's drainer tests; this plan's tests exercise the channel-side half (4 new tests + 1 inverted test). **Mitigation in place.**
- **T-13-03-02 (Repudiation, mitigate):** The redundant emit at lines 466-472 has been REMOVED. Adapter is now sole emit source. SPEC AC-5 ("exactly one delivery:enqueued event") tested by `does NOT emit delivery:enqueued from the channel-side path` (asserts 0 emits from this file) and `does not emit delivery:enqueued from this file (adapter is sole source) but still emits delivery:acked` (verifies the inverted assertion alongside the still-firing delivery:acked). **Mitigation in place.**
- **T-13-03-03 (DoS, mitigate):** Existing fallback at line 477 ("If enqueue fails, log and continue -- queue failure should not block delivery") preserved -- the `if (enqueueResult.ok) { entryId = ... }` branch only sets entryId on success; on failure, entryId stays null and the send proceeds. Tested by `send proceeds even when enqueueInFlight fails (queue failure must not block delivery)` -- asserts adapter.sendMessage was called and ack was NOT (because entryId is null). **Mitigation in place.**
- **T-13-03-04 (Tampering, accept):** Existing `nackStmt` at line 110 of delivery-queue-adapter.ts SETS `status = 'pending'` unconditionally. So an `'in_flight' -> nack -> 'pending'` flip happens automatically; the drainer can then pick the row up on its next tick. No code change needed -- verified by reading the prepared statement. **Accepted.**
- **T-13-03-05 (Information Disclosure, accept):** `'in_flight'` rows are visible in `statusCounts` debug output to operators. `statusCounts` already breaks down by status (existing `statusCountsStmt`); no new operator-facing data, just a populated existing bucket. **Accepted.**

All threats classified `mitigate` or `accept`; none `high`. Blocking gate cleared.

## Validation Performed

- `cd packages/channels && pnpm vitest run src/shared/deliver-to-channel.test.ts` -- 65 / 65 tests pass (Test Files 1 passed; duration 424ms; 61 existing + 4 new Phase 13).
- `pnpm build` from repo root -- exits 0. All packages (core, memory, channels, daemon, gateway, agent, skills, scheduler, infra, cli, comis, shared, web) build cleanly. Note: an initial run reported a transient TS2554 error in `setup-delivery.ts` line 119; this was an incremental-build artifact from `composite: true` references not picking up the channels rebuild on the first pass. A second build attempt closed the chain. Daemon package builds clean with Plan 13-01's setup-delivery.ts changes (in another worktree, but applied on this branch via the `a62793c` commit).
- AC grep checks (all 8 verified):
  - `grep -c "deps.deliveryQueue.enqueueInFlight" packages/channels/src/shared/deliver-to-channel.ts` -> `1`  PASS
  - `grep -c "deps.deliveryQueue.enqueue(" packages/channels/src/shared/deliver-to-channel.ts` -> `0`  PASS
  - `grep -c '"delivery:enqueued"' packages/channels/src/shared/deliver-to-channel.ts` -> `0`  PASS
  - `grep -c "delivery:acked\|delivery:nacked\|delivery:failed\|delivery:chunk_sent" packages/channels/src/shared/deliver-to-channel.ts` -> `7` (>= 4)  PASS
  - `grep -c "function createMockDeliveryQueue" packages/channels/src/shared/deliver-to-channel.test.ts` -> `2`  PASS
  - `grep -c "enqueueInFlight: vi.fn" packages/channels/src/shared/deliver-to-channel.test.ts` -> `4` (>= 2)  PASS
  - `grep -c "recoverInFlight: vi.fn" packages/channels/src/shared/deliver-to-channel.test.ts` -> `4` (>= 2)  PASS
- `pnpm lint:security` -- baseline unchanged. Pre-edit (with my changes stashed): 66 errors, 4555 warnings. Post-edit: 66 errors, 4555 warnings. My modified files contribute zero new violations. The pre-existing warnings at `packages/channels/src/shared/deliver-to-channel.ts:96` and `:408` are outside my edit window (lines 444-475) and are pre-existing.

## TDD Gate Compliance

This plan's task is `type="auto" tdd="true"`. The plan-level `type` is `execute` (not `tdd`), so the plan-level RED/GREEN gate sequence does not apply -- only the per-task TDD discipline applies.

For Task 1, the source-and-test changes are mutually load-bearing -- you cannot land the source change without the matching mock-factory extensions because the test file would fail to type-check (the post-13-02 `DeliveryQueuePort` interface requires both `enqueueInFlight` and `recoverInFlight`). Conversely, the new Phase 13 tests require the source change to pass (e.g., `expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1)` would fail if the source still called `enqueue`). The two halves were therefore committed atomically in `e49490d`.

Per-task TDD intent was honored: the new tests directly exercise the four behaviors specified in `<behavior>` of the plan's task, plus the inverted existing test verifies the no-emit invariant from a different angle.

## Self-Check: PASSED

Verified:
- `packages/channels/src/shared/deliver-to-channel.ts` exists and contains the method swap + comment-retained emit deletion.
- `packages/channels/src/shared/deliver-to-channel.test.ts` exists with all four mock factories extended and the four new Phase 13 tests.
- Commit `e49490d` (Task 1) is in `git log` -- `git log --oneline | grep e49490d` -> 1 match.
- All 8 grep-based acceptance criteria return the expected counts.
- 65 / 65 tests pass in `deliver-to-channel.test.ts`.
- `pnpm build` from repo root exits 0.
- `pnpm lint:security` baseline preserved (zero new violations from my files).
