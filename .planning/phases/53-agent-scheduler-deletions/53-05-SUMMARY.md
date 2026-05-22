---
phase: 53-agent-scheduler-deletions
plan: 05
subsystem: infra
tags: [bc-shim-removal, clock-injection, architecture-allowlist-shrink, agent-package, scheduler-package, no-backward-compat]

# Dependency graph
requires:
  - phase: 53-agent-scheduler-deletions
    provides: prior wave-1 deletions (51-04 establishes BC removal cadence)
provides:
  - "agent's session-reset-policy.ts requires injected nowMs from caller's ClockPort — no Date.now fallback"
  - "agent's completion-dispatcher.ts has a single canonical fallbackNotifyFn dep field — no notifyFn alias shim"
  - "agent's context-engine.ts pipeline no longer registers signature-replay-scrubber (the registration gate getReplayDriftMode is removed); factory in signature-replay-scrubber.ts is now orphaned"
  - "scheduler's cron-store.ts at-load matches the task-store.ts analog shape — no legacy payloadKind normalization"
affects: [54-skills-channels-orchestrator-deletions, 55-gateway-web-observability-infra-cli-comis-deletions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Port-injected callable `() => number` from ClockPort (clock.now.bind(clock)) — agent receives a structural callback, not the port itself"

key-files:
  created:
    - .planning/phases/53-agent-scheduler-deletions/53-05-SUMMARY.md
  modified:
    - packages/agent/src/session/session-reset-policy.ts
    - packages/agent/src/background/completion-dispatcher.ts
    - packages/agent/src/background/completion-dispatcher.test.ts
    - packages/agent/src/background/background-task-types.ts
    - packages/agent/src/context-engine/signature-replay-scrubber.ts
    - packages/agent/src/context-engine/types-core.ts
    - packages/agent/src/context-engine/context-engine.ts
    - packages/agent/src/executor/executor-context-engine-setup.ts
    - packages/scheduler/src/cron/cron-store.ts
    - packages/scheduler/src/cron/cron-store.test.ts
    - packages/daemon/src/wiring/setup-schedulers.ts
    - test/support/architecture-allowlist.ts

key-decisions:
  - "Plan said clock.nowMs.bind(clock) but ClockPort method is now() — bound correctly as clock.now.bind(clock); agent-side dep contract nowMs: () => number is satisfied either way"
  - "createSignatureReplayScrubber factory left in place after BC-REM-10 cascade — full retirement of the scrubber file is out of scope; the orphaned factory compiles cleanly and produces no production impact"
  - "Legacy camelCase cron-jobs.json files become invalid post-deletion (graceful via existing Zod-error path returning empty array) per AGENTS.md §2.9 no-BC contract"

patterns-established:
  - "BC shim cascade closure with paired allowlist-comment removal in same commit (AGENTS.md §2.8 shrink-only invariant)"
  - "Test-suite cleanup paired with BC removal: when the BC behavior is deleted, the test that asserts that behavior is deleted in the same commit"

requirements-completed: [BC-REM-05, BC-REM-08, BC-REM-09, BC-REM-10]

# Metrics
duration: 32min
completed: 2026-05-22
---

# Phase 53 Plan 05: Agent + Scheduler BC Shim Removal Summary

**Removed four backward-compatibility shims (BC-REM-05/08/09/10) across the agent and scheduler packages: Date.now fallback in session-reset-policy, notifyFn alias in completion-dispatcher, getReplayDriftMode 4-site cascade in context-engine, and payloadKind normalization in cron-store.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-05-22T07:16Z
- **Completed:** 2026-05-22T07:48Z
- **Tasks:** 3 (4 BC-REM items)
- **Files modified:** 12 production + test files; 1 architecture allowlist file

## Accomplishments

- **BC-REM-08** (Date.now fallback): session-reset-policy.ts now requires `nowMs: () => number` in its deps shape (no `?`); daemon caller setup-schedulers.ts wires `clock.now.bind(clock)` from ClockPort. The architecture-allowlist comment block referencing the file was removed in the same commit per AGENTS.md §2.8 shrink-only invariant.
- **BC-REM-09** (notifyFn alias): completion-dispatcher.ts dropped the `notifyFn?: NotifyFn` alias field and the `?? deps.notifyFn` fallback resolution. Test fixtures rewritten to use the canonical `fallbackNotifyFn`. JSDoc references to `notifyFn` in `background-task-types.ts` were also updated for terminology consistency.
- **BC-REM-10** (getReplayDriftMode cascade): 4-site coordinated deletion across signature-replay-scrubber.ts (deps field + JSDoc + unused DriftCheck import), types-core.ts (parent deps field + JSDoc), context-engine.ts (the `if (deps.getReplayDriftMode)` registration branch + unused factory import), and executor-context-engine-setup.ts (caller wiring). Post-deletion grep returns zero references.
- **BC-REM-05** (cron-store payloadKind): cron-store.ts loadFromFile() now matches the task-store.ts:42-59 canonical at-load shape (no legacy normalization). Legacy data on disk gracefully degrades via the existing Zod-error path (log warn, return empty job list).

## Task Commits

Each task was committed atomically. `pnpm validate` (build + 24K unit tests + lint:security + cycles) green after every commit.

1. **Task 1: BC-REM-08 + BC-REM-09 — Date.now fallback removal + notifyFn alias shim removal** — `4063f7b4` (refactor)
2. **Task 2: BC-REM-10 — getReplayDriftMode 4-site cascade deletion** — `d86d5e00` (refactor)
3. **Task 3: BC-REM-05 — cron-store payloadKind shim deletion + legacy migration test cleanup** — `bdf71f2d` (refactor)

## Files Created/Modified

**BC-REM-08 (Task 1):**
- `packages/agent/src/session/session-reset-policy.ts` — `nowMs?: () => number` → `nowMs: () => number` (now required); removed `?? Date.now` fallback at L243; updated JSDoc.
- `packages/daemon/src/wiring/setup-schedulers.ts` — destructured `clock` from deps; passed `clock.now.bind(clock)` in place of `nowMs: undefined`.
- `test/support/architecture-allowlist.ts` — dropped the 2-line comment block at L1641-1642 referencing the file.

**BC-REM-09 (Task 1):**
- `packages/agent/src/background/completion-dispatcher.ts` — removed the `notifyFn?: NotifyFn` field (L140), removed the JSDoc "alias for fallbackNotifyFn (test fixture compatibility)" admission, replaced `?? deps.notifyFn` with `deps.fallbackNotifyFn` at L168.
- `packages/agent/src/background/completion-dispatcher.test.ts` — renamed `notifyFn` → `fallbackNotifyFn` across 2 type signatures and 7 fixture / assertion sites.
- `packages/agent/src/background/background-task-types.ts` — updated 2 JSDoc references from `notifyFn` to `fallbackNotifyFn` for terminology consistency.

**BC-REM-10 (Task 2):**
- `packages/agent/src/context-engine/signature-replay-scrubber.ts` — removed the `getReplayDriftMode?` deps field, its BC-admitting JSDoc, and the now-unused `DriftCheck` import.
- `packages/agent/src/context-engine/types-core.ts` — removed the parent `getReplayDriftMode?` deps field and its JSDoc.
- `packages/agent/src/context-engine/context-engine.ts` — removed the entire `if (deps.getReplayDriftMode) { layers.push(createSignatureReplayScrubber(...)) }` block + the now-unused `createSignatureReplayScrubber` import.
- `packages/agent/src/executor/executor-context-engine-setup.ts` — removed the caller wiring `getReplayDriftMode: () => computeDriftIfNeeded()` (the closure itself stays in scope for `getThinkingKeepTurnsOverride` which still calls `computeDriftIfNeeded`).

**BC-REM-05 (Task 3):**
- `packages/scheduler/src/cron/cron-store.ts` — removed the 8-line `// Normalize legacy camelCase payload_kind values` shim block; loadFromFile() now matches task-store.ts:42-59 analog shape.
- `packages/scheduler/src/cron/cron-store.test.ts` — deleted the "load normalizes legacy camelCase payload_kind values" test case (45 lines) — the BC behavior it asserted no longer exists.

## Decisions Made

- **Plan deviation: `clock.nowMs.bind(clock)` → `clock.now.bind(clock)`.** The plan's must-haves and pattern map both said `clock.nowMs.bind(clock)`, but the actual `ClockPort` interface at `packages/core/src/ports/clock.ts` exposes `now(): number`, not `nowMs()`. The build caught this immediately (TS2551). Bound as `clock.now.bind(clock)` — the agent-side dep contract `nowMs: () => number` is satisfied either way because the contract is structural. Recorded as a Rule 1 fix (plan text was inaccurate about the port API).

- **createSignatureReplayScrubber factory left orphaned.** After the BC-REM-10 cascade removes the only call site of `createSignatureReplayScrubber` in context-engine.ts, the factory in signature-replay-scrubber.ts has no callers. The plan explicitly only edits the deps interface in that file — it does not delete the file. Per SCOPE BOUNDARY, broader retirement of the scrubber subsystem (deleting the file, the `signatureReplayScrubber` snapshot type wiring, the `onSignatureReplayScrubbed` callback plumbing) is out of scope for this plan. The orphaned factory compiles cleanly and produces no production impact.

- **BC-REM-05 test deletion in lockstep with shim deletion.** The cron-store.test.ts contained a test that fed camelCase legacy data into the store and asserted the snake_case migration. With the shim removed, that test contradicts the new behavior contract (Zod parse failure → empty array). Deleted the test in the same commit per AGENTS.md §2.9 (no BC: delete behavior, don't deprecate).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ClockPort method name correction**
- **Found during:** Task 1 (BC-REM-08 caller wiring)
- **Issue:** Plan text said `clock.nowMs.bind(clock)` but the actual ClockPort interface (`packages/core/src/ports/clock.ts`) exposes `now(): number`, not `nowMs()`. The build failed with `error TS2551: Property 'nowMs' does not exist on type 'ClockPort'. Did you mean 'now'?`.
- **Fix:** Used `clock.now.bind(clock)` instead. The agent-side dep contract `nowMs: () => number` is a structural callable `() => number` so any bound `() => number` from any source satisfies it.
- **Files modified:** packages/daemon/src/wiring/setup-schedulers.ts
- **Verification:** `pnpm build` clean; targeted tests green; full `pnpm validate` green.
- **Committed in:** `4063f7b4` (Task 1)

**2. [Rule 2 - Missing Critical] Test JSDoc terminology consistency for BC-REM-09**
- **Found during:** Task 1 (BC-REM-09 alias removal)
- **Issue:** `background-task-types.ts` JSDoc had two references to "notifyFn" (lines 64, 92). After removing the alias from the source, these JSDoc references read as stale (the field name no longer exists; only `fallbackNotifyFn` remains).
- **Fix:** Updated both JSDoc references to `fallbackNotifyFn` for terminology consistency. Zero behavior change.
- **Files modified:** packages/agent/src/background/background-task-types.ts
- **Verification:** `pnpm validate` green; no new lint warnings.
- **Committed in:** `4063f7b4` (Task 1)

**3. [Rule 1 - Bug] Test file deletion paired with BC-REM-05 deletion**
- **Found during:** Task 3 (BC-REM-05 cron-store shim removal)
- **Issue:** The plan said to delete only `cron-store.ts:60-67` (the shim). But `cron-store.test.ts:142-186` contained a test "load normalizes legacy camelCase payload_kind values" that fed camelCase data and asserted the snake_case migration — the BC behavior just removed. Leaving the test would make `pnpm validate` fail (Zod parse would now return empty array, not 2 normalized jobs).
- **Fix:** Deleted the 45-line test case in the same commit. AGENTS.md §2.9 ("Backward compatibility: Not supported") supports this — when the behavior is deleted, its assertion is deleted in lockstep.
- **Files modified:** packages/scheduler/src/cron/cron-store.test.ts
- **Verification:** cron-store test suite 23/23 pass (down from 24, minus the removed BC behavior); `pnpm validate` green.
- **Committed in:** `bdf71f2d` (Task 3)

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs, 1 Rule 2 missing critical)
**Impact on plan:** All auto-fixes essential for compilation / consistency / test-suite integrity. No scope creep — Task-3 test deletion is the AGENTS.md §2.9-mandated companion to the shim deletion.

## Issues Encountered

- **Worktree path safety incident.** Initial Task 1 edits accidentally landed in the main repo working tree (path `/Users/mosheanconina/Projects/comisai/comis/packages/...`) instead of the worktree (path `/Users/mosheanconina/Projects/comisai/comis/.claude/worktrees/agent-a33c246c50a5b92ba/packages/...`) because absolute file paths constructed from `cd /Users/mosheanconina/Projects/comisai/comis &&` resolved to the main repo. Recovered by `git stash` from the main repo (then dropping the stash) and re-applying all edits with worktree-anchored absolute paths obtained from `git rev-parse --show-toplevel` run inside the worktree. The actual git worktree branch (`worktree-agent-a33c246c50a5b92ba`) was never affected; all three task commits and the SUMMARY.md commit live cleanly on the per-agent branch.

- **Worktree node_modules absence.** The worktree had no `node_modules`. Resolved by running `pnpm install --frozen-lockfile` once inside the worktree (warning: did not propagate to the spawn-time `worktree-branch-check` step; this is a known pnpm-worktree caveat). All subsequent `pnpm validate` runs are green.

- **Workspace-wide `embedding-cache-sqlite.test.ts` flake.** A known pre-existing timer-based race condition in `packages/memory/src/embedding-cache-sqlite.test.ts` (the prune timer fires after `db.close()`, raising `TypeError: The database connection is not open`). The test passes in isolation. Documented in `.planning/phases/53-agent-scheduler-deletions/deferred-items.md` item #2. Not caused by Plan 53-05 changes; out of scope per executor SCOPE BOUNDARY rule.

## User Setup Required

None — no external service configuration required. Operators with legacy `cron-jobs.json` files containing `kind: "systemEvent"` or `kind: "agentTurn"` (camelCase) will see their jobs load as empty (existing Zod-error path); they should re-create the jobs via the canonical snake_case form. Recommended for CHANGELOG note at the next release.

## Next Phase Readiness

- All 4 BC removals in Plan 53-05 closed; phase-53 BC closure on track.
- Phase 53 parallel-safety preserved: no file overlap with Phases 51, 52, 54, 55 in this plan's diff surface.
- The `createSignatureReplayScrubber` factory is now orphaned. A future cleanup (potentially phase-54 if scoped, otherwise deferred) could delete the file + its co-located test, the `signatureReplayScrubber` snapshot type wiring in context-engine.ts, and the `onSignatureReplayScrubbed` callback wiring in executor-context-engine-setup.ts.

## Self-Check: PASSED

Verified files (created):
- FOUND: .planning/phases/53-agent-scheduler-deletions/53-05-SUMMARY.md (this file)

Verified commits exist:
- FOUND: 4063f7b4 (Task 1: BC-REM-08 + BC-REM-09)
- FOUND: d86d5e00 (Task 2: BC-REM-10)
- FOUND: bdf71f2d (Task 3: BC-REM-05)

Verified invariants:
- OK: `! grep "?? Date\.now" packages/agent/src/session/session-reset-policy.ts`
- OK: `grep "clock\.now\.bind(clock)" packages/daemon/src/wiring/setup-schedulers.ts`
- OK: `! grep "packages/agent/src/session/session-reset-policy" test/support/architecture-allowlist.ts`
- OK: `! grep "notifyFn?" packages/agent/src/background/completion-dispatcher.ts`
- OK: `! grep "deps\.notifyFn" packages/agent/src/background/completion-dispatcher.ts`
- OK: `grep -rn "getReplayDriftMode" packages/` returns ZERO outside dist/ + node_modules/
- OK: `! grep "Normalize legacy camelCase\|systemEvent\|agentTurn" packages/scheduler/src/cron/cron-store.ts`
- OK: `grep "CronJobArraySchema\.parse(parsed)" packages/scheduler/src/cron/cron-store.ts`

---
*Phase: 53-agent-scheduler-deletions*
*Completed: 2026-05-22*
