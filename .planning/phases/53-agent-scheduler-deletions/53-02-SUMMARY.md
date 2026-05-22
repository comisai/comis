---
phase: 53-agent-scheduler-deletions
plan: 02
subsystem: dead-code-deletion

tags:
  - dead-module-deletion
  - barrel-first-ordering
  - scheduler-package
  - daemon-monitoring
  - heartbeat-ok-token-consolidation
  - canonical-home-discipline
  - public-api-policy-shrink

requires:
  - phase: roadmap-traceability
    provides: DEAD-MOD-14 requirement ID
  - phase: 53-01
    provides: barrel-first deletion ordering pattern (validated against agent package); per-commit shrink-only discipline for public-api-policy

provides:
  - "Pattern 1 barrel-first deletion ordering re-validated across scheduler package (2 barrels: heartbeat/index.ts + scheduler/index.ts)"
  - "HEARTBEAT_OK_TOKEN canonical-home discipline established: @comis/shared/src/silent-tokens.ts:19 is now the SOLE export const declaration site (verified via grep -rn '^export const HEARTBEAT_OK_TOKEN' packages/*/src/ → 1 hit)"
  - "Scheduler barrel role of HEARTBEAT_OK_TOKEN intermediation removed (no longer a token broker); daemon monitoring consumers and scheduler-internal consumers all import directly from @comis/shared"
  - "public-api-policy.ts orphan baseline shrunk by 3 names (buildCronEventPrompt, buildExecEventPrompt, shouldSkipHeartbeatOnlyDelivery)"

affects:
  - 53-03 (scheduler tasks/ + setupTaskExtraction plumbing teardown — reuses the same barrel-first + per-commit-validate discipline)
  - 53-04 (event-bus deletions — reuses the public-api-policy-shrink discipline)
  - Any future phase touching packages/scheduler/src/heartbeat/ — relevance-filter.ts is now a clean primitive (consumes HEARTBEAT_OK_TOKEN from shared, exports classifyHeartbeatResult + shouldNotify + DEFAULT_VISIBILITY + NotificationLevel + NotificationVisibility)
  - Any future phase touching daemon monitoring sources — the @comis/shared import pattern is now the convention for HEARTBEAT_OK_TOKEN (6 daemon files use it consistently)

tech-stack:
  added: []
  patterns:
    - "canonical-home discipline for cross-package constants (delete duplicate declarations; route ALL consumers to the canonical home; break intermediating barrels)"
    - "Rule 3 deviation: when removing a re-exported symbol breaks internal scheduler-test imports, retarget those tests in the same commit (3 scheduler tests + 1 internal scheduler module retargeted to @comis/shared)"
    - "Rule 2 deviation: when the plan enumerates 5 consumer files but RESEARCH grep reveals 6 (security-update-source.ts inadvertently omitted), retarget all 6 in the same commit (the 6th file is also a monitoring HeartbeatSourcePort consumer; identical retarget pattern)"

key-files:
  created: []
  modified:
    - packages/scheduler/src/heartbeat/index.ts (barrel prune: drop 5 lines — L9 HEARTBEAT_OK_TOKEN re-export + L51, 54, 61, 62 dead-module re-exports)
    - packages/scheduler/src/index.ts (top-level barrel prune: drop L73 + L76 dead-module re-exports + split L27 to drop HEARTBEAT_OK_TOKEN keeping createHeartbeatRunner; added explanatory comment about the canonical-home move)
    - packages/scheduler/src/heartbeat/relevance-filter.ts (BREAK the duplicate const declaration at L28; import HEARTBEAT_OK_TOKEN from @comis/shared; classifyHeartbeatResult internal use unchanged)
    - packages/scheduler/src/heartbeat/response-processor.ts (internal scheduler module retarget: import HEARTBEAT_OK_TOKEN from @comis/shared instead of "./relevance-filter.js"; Rule 3 deviation — same-pattern blocker fix)
    - packages/scheduler/src/heartbeat/relevance-filter.test.ts (Rule 3 deviation: blocker fix — test now imports HEARTBEAT_OK_TOKEN from @comis/shared; classifyHeartbeatResult test cases unchanged)
    - packages/scheduler/src/heartbeat/heartbeat-runner.test.ts (Rule 3 deviation: blocker fix — test now imports HEARTBEAT_OK_TOKEN from @comis/shared)
    - packages/scheduler/src/heartbeat/sched-wake.test.ts (Rule 3 deviation: blocker fix — test now imports HEARTBEAT_OK_TOKEN from @comis/shared)
    - packages/daemon/src/monitoring/disk-space-source.ts (retarget: @comis/scheduler → @comis/shared)
    - packages/daemon/src/monitoring/system-resources-source.ts (retarget: @comis/scheduler → @comis/shared)
    - packages/daemon/src/monitoring/systemd-service-source.ts (retarget: @comis/scheduler → @comis/shared)
    - packages/daemon/src/monitoring/git-watcher-source.ts (retarget: @comis/scheduler → @comis/shared)
    - packages/daemon/src/monitoring/security-update-source.ts (Rule 2 deviation: retarget — file is a 6th HeartbeatSourcePort consumer not enumerated in plan)
    - packages/daemon/src/monitoring/monitoring-sources.test.ts (retarget: @comis/scheduler → @comis/shared)
    - test/support/public-api-policy.ts (orphan baseline shrunk by 3 names: buildCronEventPrompt, buildExecEventPrompt, shouldSkipHeartbeatOnlyDelivery)
  deleted:
    - packages/scheduler/src/heartbeat/response-cache.ts (95 LOC — createHeartbeatResponseCache + hashHeartbeatPrompt + HeartbeatResponseCache; DEAD-MOD-14)
    - packages/scheduler/src/heartbeat/response-cache.test.ts (131 LOC — co-located test suite)
    - packages/scheduler/src/heartbeat/cron-event-prompt.ts (36 LOC — buildCronEventPrompt + buildExecEventPrompt; DEAD-MOD-14)
    - packages/scheduler/src/heartbeat/cron-event-prompt.test.ts (62 LOC — co-located test suite)
    - packages/scheduler/src/heartbeat/cron-delivery-policy.ts (39 LOC — shouldSkipHeartbeatOnlyDelivery; DEAD-MOD-14)
    - packages/scheduler/src/heartbeat/cron-delivery-policy.test.ts (41 LOC — co-located test suite)

key-decisions:
  - "Barrel-first ordering: pruned scheduler heartbeat/index.ts + scheduler/index.ts barrels in Task 1 BEFORE deleting source files in Task 2. The 3 dead source files (response-cache, cron-event-prompt, cron-delivery-policy) were orphaned-but-compiled at the Task 1 commit boundary; pnpm build + scheduler tests + daemon tests + cycles all green. Source rm landed in Task 2 atomically with the HEARTBEAT_OK_TOKEN consolidation."
  - "BREAK the scheduler barrel of HEARTBEAT_OK_TOKEN per RESEARCH Sub-area 8 recommendation. Daemon monitoring consumers no longer go via @comis/scheduler — they import directly from @comis/shared. Removes scheduler's role as a token broker and eliminates any future cycle risk at the scheduler↔shared boundary. Scheduler.relevance-filter.ts itself also imports HEARTBEAT_OK_TOKEN from @comis/shared now (consumes its own former export from the canonical home)."
  - "Rule 2 deviation — retarget 6 daemon files, not 5 as plan enumerated. RESEARCH Sub-area 8 lists 4 source + 1 test (disk-space, system-resources, systemd-service, git-watcher, monitoring-sources.test.ts). Grep in this worktree found a 6th file: packages/daemon/src/monitoring/security-update-source.ts:12 (a HeartbeatSourcePort for security updates). Same import shape (`import { HEARTBEAT_OK_TOKEN } from \"@comis/scheduler\"`). Retargeted in the same commit per Rule 2 — without the retarget, the must_have invariant 'No stale scheduler-source imports for HEARTBEAT_OK_TOKEN' would fail."
  - "Rule 3 deviation — retarget 3 scheduler-internal test files (relevance-filter.test.ts, heartbeat-runner.test.ts, sched-wake.test.ts) + 1 scheduler-internal source file (response-processor.ts:17). These all imported HEARTBEAT_OK_TOKEN from `./relevance-filter.js` (the local module that previously declared the const). After Task 2 removed the const declaration from relevance-filter.ts:28, those imports became broken; retargeted to `@comis/shared` in the same commit. Plan did NOT enumerate these — they were a downstream blocker discovered by `pnpm test` after the edit. Auto-fixed per Rule 3."
  - "Skipped workspace-wide `pnpm validate` exit-0 contract per Plan 53-01 precedent: documented in 53-01 deferred-items.md and 53-01 SUMMARY that lint:security has 1 pre-existing baseline error (packages/core/src/hooks/plugin-registry.ts:38 empty-interface from Phase 52 EVENT-CLEAN-07) and the workspace-wide vitest run has macOS timing/concurrency flakes. Verified that Plan 53-02 introduces ZERO new lint:security errors (count unchanged: 1631 problems, 1 error, 1630 warnings before and after) and runs scheduler-package tests + daemon-package tests + architecture tests + cycles all GREEN."

patterns-established:
  - "Pattern 1 (PATTERNS.md): Barrel-first deletion ordering re-validated for scheduler package — Task 1 prunes both barrels; Task 2 deletes source. Build green at every intermediate commit."
  - "Canonical-home discipline: when consolidating a cross-package constant, (a) delete the duplicate, (b) retarget ALL consumers (both external-via-public-API and internal-via-local-module), (c) break the intermediating barrel to prevent re-introduction. After Plan 53-02, HEARTBEAT_OK_TOKEN has exactly ONE `export const` declaration site in the entire repo (packages/shared/src/silent-tokens.ts:19), enforced by grep verification."
  - "Per-commit shrink-only invariant: public-api-policy.ts orphan baseline shrunk by 3 names in Task 1 commit (the same commit that orphaned the symbols from public exports). No allowlist drift introduced."

requirements-completed:
  - DEAD-MOD-14

# Metrics
duration: ~33min
completed: 2026-05-22
---

# Phase 53 Plan 02: scheduler heartbeat dead modules + HEARTBEAT_OK_TOKEN canonical-home consolidation Summary

**Three scheduler heartbeat dead modules deleted (response-cache, cron-event-prompt, cron-delivery-policy — 404 LOC across 6 files including co-located tests) with strict barrel-first ordering, and the HEARTBEAT_OK_TOKEN double-define collapsed — canonical home is now @comis/shared/src/silent-tokens.ts:19 as the SOLE declaration site; 6 daemon monitoring sources + 1 scheduler-internal source + 3 scheduler-internal tests retargeted to @comis/shared; 5 scheduler-barrel re-exports pruned; public-api-policy orphan baseline shrunk by 3 names**

## Performance

- **Duration:** ~33 min
- **Started:** 2026-05-22T09:20Z (worktree spawn — first read of plan files)
- **Completed:** 2026-05-22T09:52Z (Task 2 commit)
- **Tasks:** 2
- **Files modified:** 13 (incl. 5 deviation files: 1 Rule 2 + 4 Rule 3)
- **Files deleted:** 6

## Accomplishments

- Reclaimed 404 LOC across 6 files (response-cache.ts/test.ts, cron-event-prompt.ts/test.ts, cron-delivery-policy.ts/test.ts).
- Collapsed the `HEARTBEAT_OK_TOKEN` double-define: removed the duplicate at `packages/scheduler/src/heartbeat/relevance-filter.ts:28`; canonical home `@comis/shared/src/silent-tokens.ts:19` is now the SOLE declaration site (verified `grep -rn "^export const HEARTBEAT_OK_TOKEN" packages/*/src/` returns 1 hit).
- Retargeted 6 daemon monitoring consumers to `@comis/shared` (4 enumerated in plan + 1 not-enumerated `security-update-source.ts` discovered by grep + 1 test). All daemon HeartbeatSourcePort implementations now consume the token via the canonical home.
- Retargeted 1 scheduler-internal source (`response-processor.ts:17`) and 3 scheduler-internal tests (`relevance-filter.test.ts`, `heartbeat-runner.test.ts`, `sched-wake.test.ts`) to `@comis/shared` — auto-fixed blockers discovered after the relevance-filter.ts declaration removal.
- Pruned 5 barrel re-export lines in `packages/scheduler/src/heartbeat/index.ts` (response-cache×2 + cron-event-prompt + cron-delivery-policy + HEARTBEAT_OK_TOKEN broker re-export) and 3 in `packages/scheduler/src/index.ts` (cron-event-prompt + cron-delivery-policy + HEARTBEAT_OK_TOKEN split).
- Shrunk `test/support/public-api-policy.ts` orphan baseline by 3 names (`buildCronEventPrompt`, `buildExecEventPrompt`, `shouldSkipHeartbeatOnlyDelivery`).
- Held `pnpm build`, scheduler-package tests, daemon-package tests, `pnpm test:architecture`, `pnpm cycles`, and the 2 scheduler integration tests GREEN at every commit boundary.

## Task Commits

Each task was committed atomically:

1. **Task 1: Barrel-first prune of scheduler barrels + public-api-policy shrink** — `f7c8f747` (refactor)
   - 4 line-touches in `packages/scheduler/src/heartbeat/index.ts` (drop 4 re-exports for response-cache×2 + cron-event-prompt + cron-delivery-policy)
   - 2 line-touches in `packages/scheduler/src/index.ts` (drop cron-event-prompt + cron-delivery-policy re-exports at L73, L76)
   - 3 line-touches in `test/support/public-api-policy.ts` (drop `buildCronEventPrompt`, `buildExecEventPrompt`, `shouldSkipHeartbeatOnlyDelivery` from orphan baseline)
   - `pnpm build` green; `cd packages/scheduler && pnpm test` 33 files / 552 tests green; `pnpm cycles` green; source files still on disk (orphaned barrel exports gone; zero internal callers verified per RESEARCH Sub-area 3)
   - **Defers** HEARTBEAT_OK_TOKEN consolidation to Task 2 (atomic with source deletion to keep `pnpm validate` green at the commit boundary)

2. **Task 2: Delete 3 heartbeat dead source files + co-located tests + retarget HEARTBEAT_OK_TOKEN consumers + scheduler integration tests** — `1db495aa` (refactor)
   - `rm` 6 files (response-cache.ts/test.ts, cron-event-prompt.ts/test.ts, cron-delivery-policy.ts/test.ts)
   - Edit `packages/scheduler/src/heartbeat/relevance-filter.ts`: drop L28 const declaration; add `import { HEARTBEAT_OK_TOKEN } from "@comis/shared"` at the top of the file
   - Edit `packages/scheduler/src/heartbeat/index.ts`: drop L9 HEARTBEAT_OK_TOKEN re-export from local relevance-filter.js (heartbeat sub-barrel no longer mediates the token)
   - Edit `packages/scheduler/src/index.ts`: split L27 `export { HEARTBEAT_OK_TOKEN, createHeartbeatRunner }` into a comment + `export { createHeartbeatRunner }` only (top-level barrel no longer mediates the token; canonical-home comment added)
   - Edit `packages/scheduler/src/heartbeat/response-processor.ts:17`: retarget internal import from "./relevance-filter.js" to "@comis/shared"
   - Edit 6 daemon monitoring consumers + 1 daemon test: retarget HEARTBEAT_OK_TOKEN import from "@comis/scheduler" to "@comis/shared" (4 plan-enumerated + 1 Rule 2 deviation + 1 test)
   - Edit 3 scheduler-internal tests (Rule 3 deviation): retarget HEARTBEAT_OK_TOKEN import from "./relevance-filter.js" to "@comis/shared"
   - `pnpm build` green; `cd packages/scheduler && pnpm test` 30 files / 526 tests green; `cd packages/daemon && pnpm test` 128 files / 2524 tests green; `pnpm test:architecture` 45 files / 278 tests green; `pnpm cycles` green; `pnpm vitest run --config test/vitest.config.ts test/integration/scheduler-cron-integration.test.ts test/integration/scheduler-crud.test.ts` 2 files / 13 tests green (ROADMAP success criterion 7 verified)

## Files Created/Modified

(see frontmatter `key-files` for the full enumeration with per-file rationale)

## Decisions Made

(see frontmatter `key-decisions`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Retarget `packages/daemon/src/monitoring/security-update-source.ts:12` to `@comis/shared`**

- **Found during:** Task 2 (pre-edit grep `grep -rn "from \"@comis/scheduler\"" packages/daemon/src/ | grep "HEARTBEAT_OK_TOKEN"` returned 6 hits, not the 5 plan enumerated)
- **Issue:** The plan's `<read_first>` block + the must_haves enumerate 5 daemon files (`disk-space-source.ts`, `system-resources-source.ts`, `systemd-service-source.ts`, `git-watcher-source.ts`, `monitoring-sources.test.ts`). My grep revealed a 6th consumer at `packages/daemon/src/monitoring/security-update-source.ts:12` — a `HeartbeatSourcePort` implementation that monitors pending security updates (apt-get/dnf/yum). Same import shape, same retarget pattern. The must_have invariant "No stale scheduler-source imports for HEARTBEAT_OK_TOKEN" (verified by `grep -rn 'from "@comis/scheduler".*HEARTBEAT_OK_TOKEN\|HEARTBEAT_OK_TOKEN.*@comis/scheduler' packages/daemon/src/ packages/scheduler/src/`) would have FAILED without including this 6th file.
- **Fix:** One-line edit: `import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler"` → `import { HEARTBEAT_OK_TOKEN } from "@comis/shared"`.
- **Files modified:** `packages/daemon/src/monitoring/security-update-source.ts`
- **Verification:** `grep -q 'HEARTBEAT_OK_TOKEN.*@comis/shared' packages/daemon/src/monitoring/security-update-source.ts` returns 1 hit; `cd packages/daemon && pnpm test` 128 files / 2524 tests green.
- **Committed in:** `1db495aa` (Task 2 commit)

**2. [Rule 3 - Blocking Issue] Retarget `packages/scheduler/src/heartbeat/response-processor.ts:17` to `@comis/shared`**

- **Found during:** Task 2 — after editing relevance-filter.ts to drop the L28 const declaration, internal scheduler grep showed `response-processor.ts:17` imports `HEARTBEAT_OK_TOKEN` from `./relevance-filter.js`. Without retarget, `tsc --build` fails: "Module './relevance-filter.js' has no exported member 'HEARTBEAT_OK_TOKEN'".
- **Issue:** Internal scheduler module had its own dependency on the (now-removed) local export. The plan's edit guidance focused on the relevance-filter.ts surgical edit + 5 daemon retargets — it did not enumerate the scheduler-internal `response-processor.ts` consumer.
- **Fix:** Retarget the import to `@comis/shared` (the canonical home). One-line edit.
- **Files modified:** `packages/scheduler/src/heartbeat/response-processor.ts`
- **Verification:** `pnpm build` green (no TS errors); scheduler tests green (response-processor.test.ts also passes since it doesn't import the token directly).
- **Committed in:** `1db495aa` (Task 2 commit)

**3. [Rule 3 - Blocking Issue] Retarget 3 scheduler-internal test files for HEARTBEAT_OK_TOKEN import**

- **Found during:** Task 2 — `cd packages/scheduler && pnpm test` after the relevance-filter.ts edit revealed 6 test failures in 3 files. Failed tests: `relevance-filter.test.ts > classifyHeartbeatResult` (2 cases), `heartbeat-runner.test.ts > HeartbeatRunner` (3 cases), `sched-wake.test.ts > runOnce()` (1 case). Root cause: all 3 files import `HEARTBEAT_OK_TOKEN` from `./relevance-filter.js` — the now-removed local export.
- **Issue:** Plan's `files_modified` enumerates `relevance-filter.ts` (singular) and the 5 daemon files. The 3 scheduler-internal test files were not enumerated. After Task 2's relevance-filter.ts edit, the 3 test imports broke at module-evaluation time.
- **Fix:** For each of the 3 test files, retarget the import: `import { HEARTBEAT_OK_TOKEN } from "./relevance-filter.js"` → `import { HEARTBEAT_OK_TOKEN } from "@comis/shared"`. `heartbeat-runner.test.ts` could fold this into an existing `import { ok } from "@comis/shared"` line (`import { ok, HEARTBEAT_OK_TOKEN } from "@comis/shared"`).
- **Files modified:** `packages/scheduler/src/heartbeat/relevance-filter.test.ts`, `packages/scheduler/src/heartbeat/heartbeat-runner.test.ts`, `packages/scheduler/src/heartbeat/sched-wake.test.ts`
- **Verification:** `cd packages/scheduler && pnpm test` returns to green: 30 files / 526 tests passing. (Pre-Task-2 was 33 files / 552 — 3 test files removed by the dead-module deletion, 26 tests fewer.)
- **Committed in:** `1db495aa` (Task 2 commit)

**4. [Rule 3 - Blocking Issue] Sequencing decision: defer HEARTBEAT_OK_TOKEN barrel-line removal from Task 1 to Task 2**

- **Found during:** Task 1 planning — the plan's `<action>` Step 2 says "Also DELETE line 27 (if present) — the export { HEARTBEAT_OK_TOKEN } from './heartbeat/index.js' re-export" inside the Task 1 commit boundary, with the parenthetical "If line 27 does NOT match this pattern (verify with Read first), skip that deletion".
- **Issue:** The actual L27 of `packages/scheduler/src/index.ts` is `export { HEARTBEAT_OK_TOKEN, createHeartbeatRunner } from "./heartbeat/index.js"` — a combined re-export, NOT a sole HEARTBEAT_OK_TOKEN line. Removing only the token portion in Task 1 would have broken all 6 daemon consumers + the 3 scheduler test consumers, because Task 1 does not retarget them. Per the plan's barrel-first ordering principle ("source files orphaned-but-compiled at each intermediate commit"), the HEARTBEAT_OK_TOKEN barrel removal MUST happen in the SAME commit as the consumer retargets — that's Task 2.
- **Fix:** Task 1 only removes the 4+2+3 = 9 cleanly-citable barrel/policy lines for the 3 dead modules. Task 2 atomically (a) retargets all 6 daemon consumers, (b) retargets all 4 scheduler-internal consumers (response-processor.ts + 3 tests), (c) edits relevance-filter.ts to drop the duplicate const + import from shared, (d) drops the HEARTBEAT_OK_TOKEN portion of `scheduler/index.ts:27` and the entire `heartbeat/index.ts:9` re-export, (e) deletes the 6 source files.
- **Files modified:** Same as Task 2 file list above.
- **Verification:** Task 1 commit has `pnpm build` green + scheduler/daemon tests green (no HEARTBEAT_OK_TOKEN consumer broken). Task 2 commit has `pnpm build` green + scheduler/daemon/architecture tests green + `pnpm cycles` green + scheduler integration tests green.
- **Committed in:** Approach decision — affects ordering of `f7c8f747` (Task 1) + `1db495aa` (Task 2).

---

**Total deviations:** 4 auto-fixed (1 Rule 2 — missing critical retarget; 3 Rule 3 — blocking issues from removing the local const declaration).
**Impact on plan:** All 4 auto-fixes were essential to keep the plan's must_have invariants green. None introduce scope creep — each touches files/symbols that are direct downstream consumers of the canonical-home consolidation. The plan's `success_criteria` are all satisfied; no acceptance criterion relaxed.

## Issues Encountered

- **Workspace-wide `pnpm test` has 1 worker-exit flake** on macOS during the very first run; rerunning `pnpm test` returns green: 1308 files / 24253 tests + 12 skipped. This matches the pre-existing pattern Plan 53-01 documented in `deferred-items.md` — timing/concurrency flakes (timer-mock contention, sqlite WAL, IMAP mock cleanup) under concurrent vitest projects on macOS. Confirmed unrelated: all scheduler-affecting tests run individually green at every commit.

- **Workspace-wide `pnpm test:integration` has 16+ pre-existing failures** in unrelated CLI/RPC/auth/env-vars/config/trajectory tests (auth-state-matrix, cli-rpc-roundtrip, cli-sync-tooling, cli-tooling-fill, config-audit-roundtrip, env-vars-daemon, env-vars-unit, trajectory-event-types-filter, dynamic-rpc-scope-batch). Verified that NONE of these tests reference any symbol this plan deletes (`HEARTBEAT_OK_TOKEN`, `createHeartbeatResponseCache`, `hashHeartbeatPrompt`, `HeartbeatResponseCache`, `buildCronEventPrompt`, `buildExecEventPrompt`, `shouldSkipHeartbeatOnlyDelivery`) via `grep -l <symbols> test/integration/<failing tests>` returning zero hits. The 2 SCHEDULER-SPECIFIC integration tests (`test/integration/scheduler-cron-integration.test.ts` + `test/integration/scheduler-crud.test.ts`) PASS — 2 files / 13 tests green — satisfying the plan's ROADMAP success criterion 7 ("pnpm test:integration passes for scheduler heartbeat/cron paths"). Sample failure (env-vars-unit.test.ts:362): assertion expects error message containing "ECONNREFUSED" or "19999" — pure CLI-RPC network-error format check, pre-existing daemon-startup timing flake. Documented as out-of-scope per Plan 53-01 precedent.

- **Pre-existing `pnpm lint:security` error** at `packages/core/src/hooks/plugin-registry.ts:38` (`@typescript-eslint/no-empty-object-type`) — confirmed pre-existing from Phase 52's EVENT-CLEAN-07 plan. Error count unchanged before and after Plan 53-02: 1631 problems, 1 error, 1630 warnings. Plan 53-02 introduces ZERO new lint:security errors or warnings. Documented in `deferred-items.md` from Plan 53-01.

## Cross-Phase Coordination

- **Phase 50 already complete.** Phase 50-03 edited `packages/daemon/src/wiring/setup-channels/setup-channels-runtime.ts:554` (different file/path from this plan's daemon edits). No conflict.
- **Phase 52 already complete.** Phase 52 may have edited daemon monitoring per RESEARCH note; verified all 6 daemon monitoring sources in this plan still import `HEARTBEAT_OK_TOKEN` from `@comis/scheduler` at the worktree base commit (bd68a86f). No Phase 52 retarget interfered.
- **Phase 53-01 already complete** (just merged before this worktree spawn). Phase 53-01 edited `packages/agent/src/index.ts` + `packages/agent/src/rag/*` + `test/support/public-api-policy.ts`. Plan 53-02's only overlap with Plan 53-01 is `test/support/public-api-policy.ts` — different lines (53-01 dropped 6 names at L91-92/L167-170; 53-02 drops 3 names at L1641-1643). Disjoint line ranges; rebase-safe.
- **Phase 53 sibling plans (53-03 through 53-07) parallel-safe.** None touches `packages/scheduler/src/heartbeat/` modules, `packages/daemon/src/monitoring/*`, or the lines this plan modifies in `test/support/public-api-policy.ts`. Verified by inspecting their `files_modified` frontmatter.

## User Setup Required

None — pure deletion + consolidation phase. No external services, no env vars, no schemas, no operator-facing config touched.

## Next Phase Readiness

- The 3 deleted scheduler heartbeat dead modules are reclaimed prod LOC; `pnpm build` + scheduler/daemon/architecture tests + `pnpm cycles` + scheduler integration tests are green.
- The pattern of "Task 1 barrel-first prune → Task 2 source-rm + canonical-home consolidation" is now demonstrated working across the scheduler package. Sibling plans 53-03 (scheduler `tasks/` subdir + `setupTaskExtraction` plumbing teardown) and 53-04 (event-bus declarations) can reuse the same per-commit-shrink-only discipline.
- `HEARTBEAT_OK_TOKEN` has exactly ONE declaration site (the canonical home `@comis/shared/src/silent-tokens.ts:19`). All consumers — 6 daemon monitoring sources + 4 scheduler-internal sites (relevance-filter + response-processor + 3 tests) — go through `@comis/shared`. The scheduler package no longer brokers the token at any barrel.
- `relevance-filter.ts` is now a clean primitive: consumes `HEARTBEAT_OK_TOKEN` from shared; exports `classifyHeartbeatResult` + `shouldNotify` + `DEFAULT_VISIBILITY` + `NotificationLevel` + `NotificationVisibility` + `NotificationVisibility` + `ShouldNotifyOptions`. No dual-purpose constant declaration.

## Self-Check: PASSED

**1. Files created/modified/deleted check** (verified via test/grep on disk):

```bash
# Deleted source + test files (6 files)
test ! -f packages/scheduler/src/heartbeat/response-cache.ts                       # PASS
test ! -f packages/scheduler/src/heartbeat/response-cache.test.ts                  # PASS
test ! -f packages/scheduler/src/heartbeat/cron-event-prompt.ts                    # PASS
test ! -f packages/scheduler/src/heartbeat/cron-event-prompt.test.ts               # PASS
test ! -f packages/scheduler/src/heartbeat/cron-delivery-policy.ts                 # PASS
test ! -f packages/scheduler/src/heartbeat/cron-delivery-policy.test.ts            # PASS

# Surgical edit (file survives)
test -f packages/scheduler/src/heartbeat/relevance-filter.ts                       # PASS
test -f packages/scheduler/src/heartbeat/response-processor.ts                     # PASS
test -f packages/scheduler/src/heartbeat/index.ts                                  # PASS
test -f packages/scheduler/src/index.ts                                            # PASS

# Symbol-presence checks
! grep -q "^export const HEARTBEAT_OK_TOKEN" packages/scheduler/src/heartbeat/relevance-filter.ts   # PASS (duplicate gone)
grep -q 'HEARTBEAT_OK_TOKEN.*@comis/shared' packages/scheduler/src/heartbeat/relevance-filter.ts    # PASS (imports from shared)
grep -q 'HEARTBEAT_OK_TOKEN.*@comis/shared' packages/scheduler/src/heartbeat/response-processor.ts  # PASS
# 6 daemon files (4 plan + 1 deviation + 1 test) all import from @comis/shared
for f in disk-space-source.ts system-resources-source.ts systemd-service-source.ts git-watcher-source.ts security-update-source.ts monitoring-sources.test.ts; do
  grep -q 'HEARTBEAT_OK_TOKEN.*@comis/shared' packages/daemon/src/monitoring/$f                     # all PASS
done

# Sole declaration site
[ "$(grep -rn '^export const HEARTBEAT_OK_TOKEN' packages/*/src/ | wc -l | tr -d ' ')" = "1" ]      # PASS
grep -q "HEARTBEAT_OK_TOKEN" packages/shared/src/silent-tokens.ts                                   # PASS

# No stale @comis/scheduler imports anywhere
! grep -rn 'from "@comis/scheduler".*HEARTBEAT_OK_TOKEN\|HEARTBEAT_OK_TOKEN.*@comis/scheduler' \
    packages/daemon/src/ packages/scheduler/src/                                                    # PASS (0 hits)

# Barrels pruned
! grep -q "createHeartbeatResponseCache\|hashHeartbeatPrompt\|HeartbeatResponseCache" \
    packages/scheduler/src/heartbeat/index.ts                                                       # PASS
! grep -q "buildCronEventPrompt\|buildExecEventPrompt\|shouldSkipHeartbeatOnlyDelivery" \
    packages/scheduler/src/heartbeat/index.ts packages/scheduler/src/index.ts                       # PASS

# public-api-policy shrink
! grep -q "buildCronEventPrompt\|buildExecEventPrompt\|shouldSkipHeartbeatOnlyDelivery" \
    test/support/public-api-policy.ts                                                               # PASS

# Symbols deleted from production source
[ "$(grep -rn 'createHeartbeatResponseCache\|hashHeartbeatPrompt\|HeartbeatResponseCache\|buildCronEventPrompt\|buildExecEventPrompt\|shouldSkipHeartbeatOnlyDelivery' packages/*/src/ 2>/dev/null | wc -l | tr -d ' ')" = "0" ]   # PASS
```

**2. Commit existence check:**

```bash
git log --oneline --all | grep -q "f7c8f747" && echo "FOUND: f7c8f747 (Task 1)"   # PASS
git log --oneline --all | grep -q "1db495aa" && echo "FOUND: 1db495aa (Task 2)"   # PASS
```

**3. Full-pipeline validation** (per-commit GREEN):

```bash
pnpm build                                                                          # PASS
cd packages/scheduler && pnpm test                                                  # PASS: 30 files / 526 tests
cd packages/daemon && pnpm test                                                     # PASS: 128 files / 2524 tests
pnpm test:architecture                                                              # PASS: 45 files / 278 tests
pnpm cycles                                                                         # PASS: no circular dep
pnpm vitest run --config test/vitest.config.ts \
    test/integration/scheduler-cron-integration.test.ts \
    test/integration/scheduler-crud.test.ts                                         # PASS: 2 files / 13 tests
```

---
*Phase: 53-agent-scheduler-deletions*
*Plan: 02*
*Completed: 2026-05-22*
