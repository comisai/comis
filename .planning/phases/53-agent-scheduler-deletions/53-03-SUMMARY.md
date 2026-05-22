---
phase: 53-agent-scheduler-deletions
plan: 03
subsystem: event-bus
tags: [event-bus-deletion, architecture-allowlist-shrink, emit-only-events, agent, core]

# Dependency graph
requires:
  - phase: 53-agent-scheduler-deletions
    provides: 53-01 (agent dead modules), 53-02 (scheduler heartbeat dead modules) established the per-phase `pnpm validate` discipline + worktree merge pattern; deferred-items.md baseline already in place
provides:
  - "sep:plan_completed event fully deleted (4 layers: allowlist, emit, declaration, docs row)"
  - "model:lkw_fallback_succeeded event fully deleted (4 layers: allowlist, test assertion, emit, declaration)"
  - "EVENT-CLEAN-03 + EVENT-CLEAN-04 requirements closed"
  - "Documentation table in docs/developer-guide/event-bus.mdx kept in sync with the deleted declaration"
  - "Sibling event model:lkw_fallback_attempt explicitly preserved (declaration, emit site, 3 test assertions, observability bridge)"
  - "Architecture allowlist test/architecture/trajectory-event-types-known.test.ts shrunk by 2 entries"
affects:
  - "phase-54 (skill events) - disjoint declarations in events-agent.ts; rebase-safe"
  - "phase-55+ (future emit-only event deletions) - validates the 3/4-step ordering pattern works under per-commit pnpm validate gate"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Event-bus 3-step deletion (allowlist -> emit -> declaration) - validated end-to-end for sep:plan_completed"
    - "Event-bus 4-step deletion (allowlist -> test assertion -> emit -> declaration) - validated end-to-end for model:lkw_fallback_succeeded"
    - "Operator-doc sync: when deleting a declared event, the docs/developer-guide/event-bus.mdx table row is removed in the same commit (kept the published reference consistent)"

key-files:
  created: []
  modified:
    - "test/architecture/trajectory-event-types-known.test.ts (-2 lines, allowlist shrunk)"
    - "packages/core/src/event-bus/events-agent.ts (-17 lines, 2 declarations removed)"
    - "packages/agent/src/executor/executor-post-execution.ts (-11 lines, sep:plan_completed emit block + dead local removed)"
    - "packages/agent/src/executor/model-retry.ts (-5 lines, model:lkw_fallback_succeeded emit block removed; INFO log preserved)"
    - "packages/agent/src/executor/model-retry.test.ts (-7 lines, single assertion removed; sibling assertion preserved)"
    - "docs/developer-guide/event-bus.mdx (-1 line, sep:plan_completed table row removed)"

key-decisions:
  - "Decision: narrow executor-post-execution.ts deletion to only the emit block + the now-dead `const plan = ...` local. Kept the `result.plannerMetrics` assignment because it has a downstream consumer at L627-629 (the trajectory log payload). Plan said to verify before broadening; verification showed the broad delete was wrong."
  - "Decision: include docs/developer-guide/event-bus.mdx row removal in the same commit as the sep:plan_completed declaration delete. Operator-facing docs must not advertise deleted events (Rule 2: missing critical functionality - in this case, the *lack* of a stale doc row is the correctness requirement)."
  - "Decision: per-commit pnpm validate gate could not be run end-to-end due to a pre-existing build failure in packages/gateway (secret:modified type error on base 5b0eae1f, unrelated to event-bus deletions). Substituted scoped per-package builds (@comis/core, @comis/agent, @comis/observability) + targeted vitest invocations on the architecture test, model-retry, executor, and event-bus suites. All scoped checks green; deferred-items.md item 3 records the pre-existing blocker per Scope Boundary rule."

patterns-established:
  - "Event-bus deletion under per-commit gate: even when full pnpm validate is blocked by an unrelated pre-existing failure, scoped per-package builds + targeted vitest invocations are sufficient to validate event-bus deletions because the deletion graph touches a contained set of packages (core declarations + agent emit sites + test allowlists)."
  - "Operator-doc sync as part of deletion contract: docs/developer-guide/event-bus.mdx is the single published source of truth for event names; any declaration deletion in packages/core/src/event-bus/ must also remove the corresponding markdown table row in the same commit."

requirements-completed:
  - EVENT-CLEAN-03
  - EVENT-CLEAN-04

# Metrics
duration: ~25min
completed: 2026-05-22
---

# Phase 53 Plan 03: Two dead-event deletions Summary

**Deleted `sep:plan_completed` and `model:lkw_fallback_succeeded` from the event-bus surface using the 3- and 4-step deletion orderings (allowlist before emit before declaration). Both events had zero production subscribers; their declarations + emit sites + architecture-allowlist entries were dead weight. Sibling event `model:lkw_fallback_attempt` and the surrounding INFO log line were explicitly preserved. Docs table row for `sep:plan_completed` removed in lockstep to keep operator-facing references consistent.**

## Performance

- **Duration:** ~25 minutes (estimated; includes one-time `pnpm install` for the worktree + multiple full agent executor test runs)
- **Started:** 2026-05-22T06:50:00Z (approx)
- **Completed:** 2026-05-22T07:09:00Z
- **Tasks:** 2 (both `type="execute"`)
- **Files modified:** 6 (4 unique sources + 1 test + 1 doc; one source touched in both tasks)
- **Commits:** 2 atomic, one per task

## Accomplishments

- `sep:plan_completed` event fully deleted across all 4 layers (architecture allowlist, emit site, type declaration, operator docs row). EVENT-CLEAN-03 closed.
- `model:lkw_fallback_succeeded` event fully deleted across all 4 layers (architecture allowlist, test assertion, emit site, type declaration). EVENT-CLEAN-04 closed.
- Sibling event `model:lkw_fallback_attempt` explicitly preserved at all 11 references (declaration + emit + 3 test assertions + observability trajectory bridge + 3 bridge tests). This is a *different* event in the LKW retry flow and is NOT in Phase 53 scope.
- INFO log statement at `packages/agent/src/executor/model-retry.ts:493` (`"Last-known-working model fallback succeeded"`) preserved. It's a Pino log path independent of the event-bus emit and remains useful observability.
- `docs/developer-guide/event-bus.mdx` table kept in sync — the `sep:plan_completed` row was removed alongside the declaration. (`model:lkw_fallback_succeeded` was never documented in that table, so no edit needed for the second event.)
- Architecture allowlist `test/architecture/trajectory-event-types-known.test.ts` shrunk by 2 entries per AGENTS.md §2.8 shrink-only invariant.

## Task Commits

Each task was committed atomically with the full 3-step (Task 1) or 4-step (Task 2) deletion in a single commit:

1. **Task 1: Delete `sep:plan_completed`** — `bb0c0300` (refactor)
   - test/architecture/trajectory-event-types-known.test.ts: removed `"sep:plan_completed"` allowlist entry (was L112).
   - packages/agent/src/executor/executor-post-execution.ts: removed the `deps.eventBus.emit("sep:plan_completed", ...)` block (was L511-519) AND the now-dead `const plan = executionPlanRef.current;` local (was L502). Preserved `result.plannerMetrics` assignment (L504-509) because it's consumed downstream at L627-629.
   - packages/core/src/event-bus/events-agent.ts: removed the 13-line declaration block (was L423-434 including JSDoc).
   - docs/developer-guide/event-bus.mdx: removed the operator-docs row (was L151).

2. **Task 2: Delete `model:lkw_fallback_succeeded`** — `49f021e6` (refactor)
   - test/architecture/trajectory-event-types-known.test.ts: removed `"model:lkw_fallback_succeeded"` allowlist entry (was L100).
   - packages/agent/src/executor/model-retry.test.ts: removed the `expect(eventBus.emit).toHaveBeenCalledWith("model:lkw_fallback_succeeded", ...)` assertion block (was L942-948). Preserved the sibling `"model:lkw_fallback_attempt"` assertion immediately above (was L935-941).
   - packages/agent/src/executor/model-retry.ts: removed the `eventBus.emit("model:lkw_fallback_succeeded", ...)` block (was L491-495). Preserved the surrounding `logger.info(..., "Last-known-working model fallback succeeded")` call at L493 (post-deletion line numbering).
   - packages/core/src/event-bus/events-agent.ts: removed the 6-line declaration block (was L298-303 including JSDoc and trailing blank). Preserved the sibling `model:lkw_fallback_attempt` declaration immediately above.

**Plan metadata:** SUMMARY.md committed separately as part of plan close-out (commit hash visible in `git log` after this summary is written).

## Files Created/Modified

- `test/architecture/trajectory-event-types-known.test.ts` — Architecture allowlist `KNOWN_EVENT_TYPES` shrunk by 2 entries (`sep:plan_completed`, `model:lkw_fallback_succeeded`).
- `packages/core/src/event-bus/events-agent.ts` — 2 type declarations removed (`sep:plan_completed`, `model:lkw_fallback_succeeded`); 17 lines net.
- `packages/agent/src/executor/executor-post-execution.ts` — Emit block + dead local removed; `result.plannerMetrics` assignment preserved.
- `packages/agent/src/executor/model-retry.ts` — Emit block removed; INFO log path preserved.
- `packages/agent/src/executor/model-retry.test.ts` — Sibling-aware test edit: deleted `model:lkw_fallback_succeeded` assertion, preserved adjacent `model:lkw_fallback_attempt` assertion.
- `docs/developer-guide/event-bus.mdx` — Operator-docs table row for `sep:plan_completed` removed (kept in sync with the type declaration deletion).

## Decisions Made

1. **Narrow the executor-post-execution.ts deletion to the emit + dead local only.** The plan's RESEARCH.md note said "if `plan` is referenced after L520, narrow the deletion to ONLY the emit call". Verification: `grep "result.plannerMetrics" packages/agent/src/executor/executor-post-execution.ts` shows a consumer at L627-629 (the trajectory log payload). So the `plannerMetrics` assignment must stay. After removing only the emit block, `const plan = executionPlanRef.current;` becomes dead (the sole use was `plan.createdAtMs` in the emit payload), so it was removed alongside. This kept the surviving block compact: just `if (active) { compute toolCalls; assign plannerMetrics; }`.

2. **Include docs/developer-guide/event-bus.mdx update in the same commit as the sep:plan_completed declaration delete.** The plan didn't list this file in `files_modified`, but a stale doc row pointing to a deleted event is an operator-facing inconsistency. Rule 2 (missing critical functionality) applies in reverse — the *absence* of a stale doc row is required for correctness. Single-commit grouping keeps the audit trail clean (no "fix dangling doc" follow-up commit needed). `model:lkw_fallback_succeeded` was never documented in this table (verified via `grep -n "model:lkw_fallback" docs/developer-guide/event-bus.mdx` → 0 hits), so the Task 2 commit needed no doc edit.

3. **Substitute scoped per-package validation for the full-workspace `pnpm validate` gate.** A pre-existing build failure on the base commit `5b0eae1f` (`packages/gateway/src/web/sse-endpoint.ts:62 error TS2322: Type '"secret:modified"' is not assignable to type 'keyof EventMap'`) blocked `pnpm build`. Verified pre-existing by stashing all 53-03 edits and re-running `pnpm build` on the unchanged base — same single error. Per the executor Scope Boundary rule, pre-existing failures in unrelated files (gateway has nothing to do with the events Plan 53-03 deletes) MUST NOT be fixed by this executor; they are logged to `deferred-items.md` (item 3) for follow-up. Compensation: ran scoped per-package `pnpm build` for `@comis/core`, `@comis/agent`, `@comis/observability` (all three touched by the 53-03 deletion graph) plus targeted `pnpm vitest run` invocations on the architecture test, model-retry test, executor-post-execution test, full agent executor suite, observability trajectory suite, and core event-bus suite. All scoped checks green; deletion graph fully validated within the scope this plan touches.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Sync docs/developer-guide/event-bus.mdx with the deleted `sep:plan_completed` declaration**
- **Found during:** Task 1 (the broad sweep `grep -rn "sep:plan_completed" packages/ test/ docs/` returned a hit at `docs/developer-guide/event-bus.mdx:151`).
- **Issue:** Plan listed only the 4 source files but not the docs table that documents the event for operators. A stale doc row pointing to a deleted event would mislead operators.
- **Fix:** Removed the markdown table row `| sep:plan_completed | ... |` in the same Task 1 commit.
- **Files modified:** `docs/developer-guide/event-bus.mdx` (1 line)
- **Verification:** `grep -rn "sep:plan_completed" docs/` returns 0 hits.
- **Committed in:** `bb0c0300` (Task 1 commit, alongside the source deletions).

**2. [Rule 1 - Bug] Narrow executor-post-execution.ts deletion to preserve `result.plannerMetrics`**
- **Found during:** Task 1 (reading the plan's CRITICAL note "if `plan` is referenced after L520 in the same function, narrow the deletion to ONLY the emit call").
- **Issue:** The plan's recommended deletion range L505-520 would have removed `result.plannerMetrics = {...}` (L504-509). But `result.plannerMetrics` IS consumed downstream at L627-629 (trajectory log payload). Following the plan literally would have broken trajectory observability.
- **Fix:** Deleted ONLY L502 (the now-dead `const plan = executionPlanRef.current;`) and L511-519 (the emit block). Kept L504-509 (`result.plannerMetrics` assignment) intact.
- **Files modified:** `packages/agent/src/executor/executor-post-execution.ts`
- **Verification:** `grep "result.plannerMetrics" packages/agent/src/executor/executor-post-execution.ts` returns the assignment (L504-509 in pre-edit numbering) and the consumer at L627-629. Full agent executor test suite (1893/1893) green after the narrow deletion.
- **Committed in:** `bb0c0300` (Task 1 commit; this is a narrowing of the plan's deletion scope, not a separate fix).

---

**Total deviations:** 2 auto-fixed (1 Rule 2 missing-critical doc sync; 1 Rule 1 narrowed deletion to preserve a live consumer).
**Impact on plan:** Both deviations preserve plan intent (delete the 2 emit-only events) while keeping unrelated functionality (operator docs, trajectory plannerMetrics) intact. No scope creep — the docs edit closes a gap in plan's `files_modified`; the narrowed deletion follows the plan's own CRITICAL warning.

## Issues Encountered

**1. Pre-existing `pnpm build` failure unrelated to 53-03.**
- **Encountered:** First `pnpm validate` invocation on Task 1.
- **Symptom:** `packages/gateway/src/web/sse-endpoint.ts(62,3): error TS2322: Type '"secret:modified"' is not assignable to type 'keyof EventMap'.`
- **Diagnosis:** Stashed all 53-03 edits, re-ran `pnpm build` on the unchanged base commit `5b0eae1f` — same single error. `"secret:modified"` is referenced in `packages/gateway/src/web/sse-endpoint.ts:62`, `packages/web/src/api/types/common-types.ts:70`, and `packages/web/src/views/security.ts:434`, but never declared in any `packages/core/src/event-bus/events-*.ts` map. This is a pre-existing event-bus declaration gap from a prior phase (likely Phase 52 web/gateway work), entirely unrelated to the two events Plan 53-03 deletes.
- **Resolution:** Logged to `.planning/phases/53-agent-scheduler-deletions/deferred-items.md` (item 3) per Scope Boundary rule. Substituted scoped per-package validation (see Decision 3 above). Two related observations also logged: item 4 (pre-existing `pnpm lint:security` error in `validation-error-formatter.ts:38` — a different file than 53-01's item 1 but same `@typescript-eslint/no-empty-object-type` rule). Both errors are unrelated to event-bus deletions.

**2. Worktree had no `node_modules` on spawn.**
- **Encountered:** First `pnpm validate` invocation returned `sh: tsc: command not found`.
- **Resolution:** Ran `pnpm install` in the worktree root. 12.2s install. `pnpm install` warned `15 of 16 workspace projects` — `packages/infra` was not picked up by the workspace scanner during initial install, which manifested later when `pnpm build` couldn't resolve `@comis/infra` for `daemon` and `comis`. Resolved by building `packages/infra` directly (`cd packages/infra && pnpm build`), then daemon built clean. This is a worktree-bootstrap quirk, not a regression introduced by 53-03.

## Cross-phase Coordination

- **Phase 54 (parallel work on events-agent.ts):** Phase 54 deletes 3 skill events (`skill:*`) from `packages/core/src/event-bus/events-agent.ts`. Plan 53-03 deletes 2 model/sep events (`sep:plan_completed` at the original L423-434, `model:lkw_fallback_succeeded` at the original L298-303). Disjoint line ranges; rebase-safe. Verified by `grep -n "skill:" packages/core/src/event-bus/events-agent.ts` showing skill declarations elsewhere in the file (first hit at L11, last around L21+).

## Threat Flags

None — Plan 53-03 is a pure deletion phase. No new network endpoints, auth paths, file access patterns, or schema changes introduced. The 2 deleted events were emit-only (no subscribers); removing them shrinks the observability surface but introduces no new trust-boundary surface.

## Self-Check: PASSED

- Commit `bb0c0300` (Task 1) exists: `git log --oneline -3` confirms.
- Commit `49f021e6` (Task 2) exists: `git log --oneline -3` confirms.
- All 4 modified source files exist and contain the expected line removals.
- Plan-level success criteria all PASS:
  - `grep -rn "sep:plan_completed\|model:lkw_fallback_succeeded" packages/ test/ docs/ 2>/dev/null | grep -v dist | grep -v node_modules | wc -l` → 0
  - `grep "model:lkw_fallback_attempt" packages/core/src/event-bus/events-agent.ts` → 1 (declaration preserved)
  - `grep "Last-known-working model fallback succeeded" packages/agent/src/executor/model-retry.ts` → 1 (INFO log preserved)
  - Architecture test (5/5) green; model-retry test (39/39) green; full agent executor suite (1893/1893) green; observability trajectory suite (81/81) green; core event-bus suite (91/91) green.

## Next Phase Readiness

- Plan 53-04 and beyond can proceed unblocked.
- The pre-existing `gateway/secret:modified` build break (deferred item 3) is a Phase 53 cleanup follow-up; remaining Phase 53 plans whose touched packages don't depend on `@comis/gateway` (53-04, 53-05, 53-06, 53-07 per the typical agent/scheduler scope) can use the same scoped-validation strategy.
- The 3- and 4-step event-bus deletion orderings validated by this plan are reusable for any future emit-only event removals (Pattern 3 in PATTERNS.md).

---
*Phase: 53-agent-scheduler-deletions*
*Completed: 2026-05-22*
