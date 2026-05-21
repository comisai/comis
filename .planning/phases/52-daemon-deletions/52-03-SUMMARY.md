---
phase: 52-daemon-deletions
plan: 03
subsystem: infra
tags: [daemon, shutdown, signal-handlers, refactor, behavior-preserving-inline, tdd]

# Dependency graph
requires:
  - phase: 50-infra-core-orchestrator-daemon-critical-fixes
    provides: "Phase 50 Plan 01 daemon-shutdown.test.ts + daemon-shutdown-teardown.test.ts integration tests (11 assertions) — the GREEN gate that validated the inlining as behavior-preserving"
  - phase: 52-daemon-deletions
    provides: "Plan 52-01 (Wave 1) finalized device/watchdog field removal on daemon-types.ts and daemon.ts; this plan (Wave 2) edits disjoint lines on the same files"
provides:
  - "wiring/setup-shutdown.ts is the sole owner of the daemon shutdown chain (signal-handler registration + ordered teardown + timeout machinery + dispose)"
  - "process/graceful-shutdown.ts removed (175 LOC) along with graceful-shutdown.test.ts (264 LOC)"
  - "DaemonOverrides.registerGracefulShutdown factory seam removed; daemon.ts no longer threads a factory through composition root"
  - "ShutdownHandle public type now exported from wiring/setup-shutdown.ts (was process/graceful-shutdown.ts)"
affects: ["future shutdown work", "Phase 53 (if any further consolidation of process/* lands)", "Phase 50 integration test contract (now validates the inlined body verbatim)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-file owner of orchestration chain (signal handlers + ordered teardown + timeout machinery all live in wiring/setup-shutdown.ts) — eliminates indirection layers in tear-down logic"
    - "Behavior-preserving inline via integration-test GREEN gate — when an existing integration test exercises the integrated flow under real signals, that test IS the RED-to-GREEN contract for a refactor; no new unit test needed at the RED gate"

key-files:
  created: []
  modified:
    - packages/daemon/src/wiring/setup-shutdown.ts (absorbed graceful-shutdown.ts body; 691 → 797 LOC, under the 800-line cap)
    - packages/daemon/src/wiring/setup-shutdown.test.ts (reworked 22 tests to drive shutdown via result.shutdownHandle.trigger("SIGTERM") instead of capturing onShutdown through the dead factory seam)
    - packages/daemon/src/daemon.ts (removed registerGracefulShutdown import + _registerGracefulShutdown resolution at lines 1117-1121)
    - packages/daemon/src/daemon-types.ts (removed DaemonOverrides.registerGracefulShutdown field + retargeted ShutdownHandle import to wiring/setup-shutdown.js)
    - packages/daemon/src/daemon.test.ts (removed registerGracefulShutdown vi.fn override + 4 toHaveBeenCalledWith assertions whose coverage migrated to setup-shutdown.test.ts and integration tests; retargeted ShutdownHandle import)
    - packages/daemon/src/process/index.ts (dropped graceful-shutdown re-export — barrel exports only process-monitor now)
    - packages/daemon/src/wiring/daemon-context.ts (retargeted ShutdownHandle import)
  deleted:
    - packages/daemon/src/process/graceful-shutdown.ts (175 LOC)
    - packages/daemon/src/process/graceful-shutdown.test.ts (264 LOC of unit tests subsumed by Phase 50 integration tests and the reworked setup-shutdown unit tests)

key-decisions:
  - "Used Approach A (direct trigger invocation) for the test rework rather than Approach B (extracted private helper); test files import the public ShutdownHandle.trigger via result.shutdownHandle.trigger(\"SIGTERM\") with no new @ts-expect-error or re-exports. AGENTS.md §2.9 + no-BC policy preferred Approach A."
  - "process.on(\"exit\", ...) safety-net listener preserved verbatim per Phase 52 RESEARCH Open Question #4. Phase 50 daemon-shutdown.test.ts asserts no error-level logs at shutdown — covering this code path. Fallback to per-handle listener was not needed."
  - "dispose() removes only SIGTERM/SIGINT listeners — parity with original graceful-shutdown.ts. The exit listener stays because the process is exiting and Phase 50 tests depend on this behavior."
  - "Dropped 4 toHaveBeenCalledWith assertions in daemon.test.ts that asserted the factory was called with specific args (onShutdown/container/processMonitor/exit). Coverage migrated to: (a) setup-shutdown.test.ts (per-component teardown invocation via direct trigger), and (b) test/integration/daemon-shutdown*.test.ts (real-signal end-to-end). The factory seam was the only place these wirings could be observed before inlining; after inlining, there is no factory to spy on."
  - "Logger.flush narrowed via local shape (`logger as unknown as { flush?: (cb?: () => void) => void }`) because ComisLogger in core/src/logging/log-fields.ts does not include flush — `flush` is a pino runtime feature. Matches the original graceful-shutdown.ts pattern where the factory accepted a logger with optional flush."

patterns-established:
  - "Behavior-preserving inline via integration-test GREEN gate — applicable to any future refactor where the existing test contract already covers the integrated flow; no new RED-phase unit test is required"
  - "Single-file orchestration owner — signal-handler registration + ordered teardown + timeout machinery + dispose all in one file"

requirements-completed: [DUP-CONS-03]

# Metrics
duration: ~30min
completed: 2026-05-21
---

# Phase 52 Plan 03: graceful-shutdown.ts inlining (DUP-CONS-03) Summary

**Folded 175 LOC of process/graceful-shutdown.ts (signal handlers + outer shutdown chrome) into wiring/setup-shutdown.ts so the entire teardown chain is legible in a single 797-line file; Phase 50's 11-assertion integration test contract stays green verbatim**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-05-21T22:54Z (approx, RED-phase baseline run)
- **Completed:** 2026-05-21T23:36Z
- **Tasks:** 3 (RED baseline / GREEN inline / REFACTOR compaction absorbed into GREEN)
- **Files modified:** 7
- **Files deleted:** 2

## Accomplishments

- `wiring/setup-shutdown.ts` absorbs the body of `registerGracefulShutdown` — SIGTERM/SIGINT/SIGUSR2 handler registration, `shuttingDown` re-entrancy guard, 30s hard timeout (`hardTimeoutMs`), per-step 5s timeout (`STEP_TIMEOUT_MS`), logger.flush before exit, exit-code dispatch (SIGUSR2 ⇒ 42, SIGTERM/SIGINT ⇒ 0, error ⇒ 1), and the `process.on("exit", ...)` safety-net log.
- `process/graceful-shutdown.ts` (175 LOC) and `process/graceful-shutdown.test.ts` (264 LOC) deleted.
- `DaemonOverrides.registerGracefulShutdown?` factory seam removed; daemon composition root no longer plumbs a factory through ShutdownDeps.
- `ShutdownHandle` type now exported from `wiring/setup-shutdown.ts`; 3 import sites retargeted (`daemon-types.ts`, `daemon-context.ts`, `daemon.test.ts`).
- `process/index.ts` barrel: dropped the graceful-shutdown re-export — now exports only ProcessMonitor surfaces.
- 22 setup-shutdown unit tests reworked to call `result.shutdownHandle.trigger("SIGTERM")` directly (Approach A per RESEARCH §"Track 4"), eliminating the dead `capturedOnShutdown` capture mechanism.
- `setup-shutdown.ts` final LOC: 797 — under the project-wide 800-line cap; no `fileSizeAllowlist` entry needed.
- `pnpm cycles` still passes (0 new circular dependencies).

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Baseline verification** — no commit (verification only; the 11 Phase 50 integration assertions ran green at HEAD `0c90cc8e` confirming the GREEN contract was established).
2. **Task 2 (GREEN): Inline graceful-shutdown.ts body into setup-shutdown.ts + delete the factory seam + rework unit tests** — `93d77feb` (refactor)
3. **Task 3 (REFACTOR): Compact docstrings to land setup-shutdown.ts under the 800-line cap** — absorbed into the GREEN commit (`93d77feb`) rather than splitting into a separate commit. The compaction was inline with the GREEN inlining because the initial inline at 859 LOC violated the file-size invariant. Trimming verbose Phase-52 doc blocks brought the file to 797 LOC. Per AGENTS.md §5, splitting GREEN and REFACTOR into separate commits is the textbook flow; here the REFACTOR was load-bearing (file-size gate enforcement) so combining was the pragmatic choice. The remaining REFACTOR work (no extra helpers needed; structure was already clean post-inline) yielded zero additional changes.

**Plan metadata commit:** (this SUMMARY.md commit — to be made after writing this file)

## Files Created/Modified

- `packages/daemon/src/wiring/setup-shutdown.ts` (797 LOC, +106 from 691) — absorbed the graceful-shutdown body; sole owner of shutdown chain.
- `packages/daemon/src/wiring/setup-shutdown.test.ts` — 22 tests reworked to drive shutdown via `result.shutdownHandle.trigger("SIGTERM")` after the factory seam was removed.
- `packages/daemon/src/daemon.ts` — removed `import { registerGracefulShutdown } ...` (line 79) and the `_registerGracefulShutdown` resolution at lines 1117-1121.
- `packages/daemon/src/daemon-types.ts` — removed `registerGracefulShutdown?: typeof registerGracefulShutdown` field from `DaemonOverrides` (and its `import type { registerGracefulShutdown }`); retargeted `ShutdownHandle` import to `./wiring/setup-shutdown.js`.
- `packages/daemon/src/daemon.test.ts` — removed `registerGracefulShutdown: vi.fn().mockImplementation(...)` override and the call-order assertions + 4 `toHaveBeenCalledWith` assertions. Retargeted ShutdownHandle import.
- `packages/daemon/src/process/index.ts` — barrel now exports only process-monitor surfaces.
- `packages/daemon/src/wiring/daemon-context.ts` — retargeted `ShutdownHandle` import to `./setup-shutdown.js`.
- `packages/daemon/src/process/graceful-shutdown.ts` — DELETED.
- `packages/daemon/src/process/graceful-shutdown.test.ts` — DELETED.

## 8-Element Behavior-Preservation Contract

| # | Element | Preserved | Mechanism |
|---|---------|-----------|-----------|
| 1 | SIGTERM/SIGINT registered exactly once | YES | `process.on("SIGTERM", sigterm)` + `process.on("SIGINT", sigint)` registered once at the bottom of `setupShutdown(deps)`; tests assert via `processOnSpy.mock.calls.find(...)`. |
| 2 | Double-signal guard via `shuttingDown` flag | YES | `if (shuttingDown) return;` at top of `shutdown(signal)`; `daemon-shutdown-teardown.test.ts` "Double-shutdown is idempotent" passes verbatim. |
| 3 | 30s hard timeout → `process.exit(1)` if cleanup hangs | YES | `systemSetTimeout(() => { ... exitFnLocal(1); }, hardTimeoutMs)` with `timer.unref()`; `hardTimeoutMs = deps.timeoutMs ?? 30_000`. |
| 4 | Per-step 5s timeout (`STEP_TIMEOUT_MS`) | YES | Unchanged at line 156: `export const STEP_TIMEOUT_MS = 5_000;` consumed by `withStepTimeout`. |
| 5 | Logger flush before exit | YES | `flushable.flush!(() => resolve())` with 2s safety timeout; logger narrowed via local shape because `ComisLogger` type does not expose `flush`. |
| 6 | Exit-code dispatch (SIGUSR2 ⇒ 42, SIGTERM/SIGINT ⇒ 0, error ⇒ 1) | YES | `const isRestartSignal = signal === "SIGUSR2"; exitFnLocal(isRestartSignal ? 42 : 0);` Error path: `catch (error) { ... exitFnLocal(1); return; }`. |
| 7 | `process.on("exit", ...)` safety-net log | YES | `process.on("exit", onExit)` where `onExit` checks `if (!shuttingDown)` and logs "Daemon process exiting unexpectedly". Preserved verbatim per RESEARCH OQ#4. |
| 8 | `dispose()` removes SIGTERM/SIGINT listeners (test-only) | YES | `dispose(): void { process.off("SIGTERM", sigterm); process.off("SIGINT", sigint); }`. The `exit` listener intentionally stays (parity with original). |

## Integration Test Result (GREEN Gate)

```
 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  02:36:41
   Duration  17.23s
```

Test files exercised (Phase 50 deliverables):
- `test/integration/daemon-shutdown.test.ts` — 8 `it()` blocks: pre-shutdown sanity (cron / gateway), DMN-02 (WS 1001 close on SIGTERM), DMN-01 (sub-agent runner drain), DMN-03 (cron stop without orphan), DMN-04 (ordered teardown sequence), DMN-04 (no error logs), timer cleanup contract.
- `test/integration/daemon-shutdown-teardown.test.ts` — 3 `it()` blocks: SIGTERM invokes 8 always-wired teardowns exactly once, SIGUSR2 same, double-shutdown idempotent.

These tests exercise the inlined body verbatim — they do not mock `_registerGracefulShutdown`; they spawn a real daemon and signal it.

## Per-commit Gate Status

- `pnpm build` → exit 0 ✓
- `pnpm vitest run --config test/vitest.config.ts test/integration/daemon-shutdown.test.ts test/integration/daemon-shutdown-teardown.test.ts --retry=0` → 11 PASS / 0 FAIL ✓
- `pnpm test` (per-package unit tests) → daemon 2536/2536 pass ✓
- `pnpm cycles` → exit 0 ✓
- `test/architecture/file-size.test.ts` → setup-shutdown.ts at 797 LOC, under 800-line cap ✓
- `test/architecture/optional-field-bloat.test.ts` → ShutdownDeps still in optionalFieldAllowlist (file::typeName key unchanged) ✓
- `test/architecture/allowlist-shrink.test.ts` → all 8 allowlists shrink-only ✓
- `pnpm lint:security` → 1 pre-existing error in `packages/core/src/hooks/plugin-registry.ts:38` (empty PluginRegistryOptions interface) — see "Issues Encountered" below ✓ (not caused by 52-03)

## Decisions Made

1. **Approach A (direct trigger invocation) for unit-test rework, not Approach B (extracted private helper).**
   - RESEARCH §Track 4 lines 250-254 listed both approaches. Approach B would require `setup-shutdown.ts` to expose a `runShutdown` symbol via a test-only re-export or `(setupShutdownModule as any).runShutdown(...)`. AGENTS.md §2.9 + no-BC policy preferred Approach A. The reworked tests call `await result.shutdownHandle.trigger("SIGTERM")` — a public API — with no `as any` casts or `// @ts-expect-error` directives.
2. **`process.on("exit", ...)` listener preserved verbatim per RESEARCH Open Question #4.**
   - The listener was kept inside `setupShutdown(deps)` rather than disposed via `shutdownHandle.dispose()`. Phase 50 integration tests passed without changes, so the fallback (per-handle listener) was not needed.
3. **Dropped 4 daemon.test.ts assertions whose coverage migrated to setup-shutdown.test.ts + integration tests.**
   - The four `expect(overrides.registerGracefulShutdown).toHaveBeenCalledWith(expect.objectContaining({ onShutdown / container / processMonitor / exit }))` assertions verified the factory was called with specific args. After inlining, there is no factory; the wiring is exercised by (a) setup-shutdown.test.ts "executes ordered teardown in correct sequence" + "returns a shutdownHandle..." + "registers SIGUSR2 handler that triggers shutdown" and (b) integration tests under real signals. Removing these 4 daemon.test.ts assertions shrank the test surface without losing coverage.
4. **Combined GREEN + REFACTOR into a single commit.**
   - The 859 → 797 LOC compaction was load-bearing (file-size gate enforcement at 800 LOC); splitting into two commits would have left an intermediate commit failing `pnpm validate`. Combined into `93d77feb` (refactor commit) with the trim work as part of the inlining.
5. **Logger `flush` narrowed via local shape rather than added to ComisLogger.**
   - The original `graceful-shutdown.ts` accepted a logger with `flush?: (cb?: () => void) => void`. ComisLogger (core/src/logging/log-fields.ts:105) does not expose flush — it's a pino runtime feature. Cast via `logger as unknown as { flush?: ... }` matches the original's structural narrowing without adding `flush` to the canonical type (which would force every ComisLogger consumer to handle the optional method).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree absolute-path safety — initial edits landed in the main repo, not the worktree**

- **Found during:** Task 2 (GREEN inline)
- **Issue:** During the initial inlining phase, I used absolute paths of the form `/Users/mosheanconina/Projects/comisai/comis/packages/daemon/src/...` for the Edit tool. These resolved to the MAIN REPO (cwd-drift parent) rather than the worktree at `.claude/worktrees/agent-a332a2a5a30e55771/packages/daemon/src/...`. Six modified files (daemon-types.ts, daemon.test.ts, daemon.ts, process/index.ts, daemon-context.ts, setup-shutdown.ts) ended up in the main repo's working tree, not the worktree.
- **Fix:** Captured the main-repo diff to `/tmp/52-03-changes.patch`, ran `git checkout -- packages/` in the main repo to revert, then `git apply /tmp/52-03-changes.patch` in the worktree to land the same edits at the correct path. All subsequent edits used the explicit worktree absolute path `/Users/mosheanconina/Projects/comisai/comis/.claude/worktrees/agent-a332a2a5a30e55771/...`.
- **Files modified:** All 7 (worktree-side) — content unchanged from the patched diff.
- **Verification:** `git status` in main repo is clean; `git status` in worktree shows all 7 modifications. `cmp` between main repo and worktree files confirms the worktree has the inlined content while the main repo is at HEAD.
- **Committed in:** `93d77feb` (Task 2 GREEN commit)

**2. [Rule 3 - Blocking] setup-shutdown.ts exceeded the 800-line file-size cap after initial inline**

- **Found during:** Task 2 (GREEN inline)
- **Issue:** The initial inline of the 175-LOC graceful-shutdown body into setup-shutdown.ts plus the new ShutdownHandle interface and documentation comments brought the file to 859 LOC — above the project-wide 800-line cap enforced by `test/architecture/file-size.test.ts`. Adding a `fileSizeAllowlist` entry was not viable because `test/architecture/allowlist-shrink.test.ts` rejects newly-added allowlist keys.
- **Fix:** Compacted verbose Phase-52 doc blocks (`<14-line @module doc → 9 lines`, `<19-line ShutdownHandle JSDoc → 5 lines`, `<14-line "Inlined graceful-shutdown body" comment → 3 lines`, `<15-line "shutdown(signal)" header → 4 lines`, `<8-line "Exit code encodes intent" comment → 3 lines`, `<7-line "process.on exit safety net" comment → 2 lines`, `<14-line "Defense-in-depth flush" comment → 2 lines`, plus inlined the SIGTERM/SIGINT handler bodies onto single-line arrow expressions). File now sits at 797 LOC. Verbiage went, the contract didn't.
- **Files modified:** `packages/daemon/src/wiring/setup-shutdown.ts`
- **Verification:** `wc -l packages/daemon/src/wiring/setup-shutdown.ts` → 797; `pnpm vitest run --no-coverage test/architecture/file-size.test.ts` → all 51 tests pass.
- **Committed in:** `93d77feb` (combined with GREEN)

---

**Total deviations:** 2 auto-fixed (1 worktree-path-safety blocker, 1 file-size invariant blocker)
**Impact on plan:** Both auto-fixes were path-safety / invariant-enforcement steps. Plan executed substantively as written — RED gate confirmed baseline, GREEN inlining preserved all 11 integration assertions, REFACTOR absorbed into GREEN per behavior-preservation discipline. No scope creep.

## Cross-Phase Coordination

**Plan 52-01 (Wave 1) coordination:** Plan 52-01 (executed before this plan in Wave 1 of Phase 52) had already touched `daemon-types.ts` and `daemon.ts` to remove device/watchdog fields. This plan (Wave 2) edits DIFFERENT lines in those files:
- `daemon-types.ts`: 52-01 removed device/watchdog fields; 52-03 removed `DaemonOverrides.registerGracefulShutdown?` + retargeted the `ShutdownHandle` import. Disjoint line ranges per PATTERNS.md §"Wiring-touch coordination" line 164.
- `daemon.ts`: 52-01 removed device/watchdog wiring; 52-03 removed `import { registerGracefulShutdown }` (line 79) + the `_registerGracefulShutdown` resolution (lines 1117-1121). Disjoint line ranges.

No conflicts were observed; the patch applied cleanly to the post-52-01 state.

## Issues Encountered

- **Pre-existing lint:security error in `packages/core/src/hooks/plugin-registry.ts:38` (empty PluginRegistryOptions interface).** Verified at base ref `0c90cc8e` before this plan ran (`git checkout 0c90cc8e -- packages/ && pnpm lint:security` reports the same 1 error). Not introduced by 52-03. Scope-boundary rule applies — out of scope; documented in `.planning/phases/52-daemon-deletions/deferred-items.md` as pre-existing baseline. The 23+ pre-existing integration test failures inherited from earlier phases (daemon-spawn timing flakes, Phase 54-03 PriorityScheduler regression in concurrency-cap.test.ts) also persist post-52-03 and were not triggered by the inlining.
- **Read tool cache divergence during the worktree-path-safety incident.** While the absolute-path issue was being diagnosed, the `Read` tool's file-state cache appeared to show post-edit content even though `cat`/`awk`/`git status` confirmed the file on disk was unmodified. This happens when an Edit operation writes to a parent-tree path (main repo) and the Read tool's cache reflects that write but the worktree on-disk state is unchanged. Resolved by capturing the main-repo diff to `/tmp/52-03-changes.patch`, reverting the main repo, and applying the patch to the worktree.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 52-03 closes the DUP-CONS-03 requirement. `process/graceful-shutdown.ts` is gone; the shutdown chain is legible in a single file.
- Plan 52-04 (the remaining incomplete plan in Phase 52) can run in parallel with no dependency on this plan's changes.
- Phase 53 (if any future shutdown consolidation lands) can build on the now-single-owner `setupShutdown(deps)` entry point.

---
*Phase: 52-daemon-deletions*
*Plan: 03*
*Completed: 2026-05-21*

## Self-Check: PASSED

Verified items:
- File created: `.planning/phases/52-daemon-deletions/52-03-SUMMARY.md` ✓
- Commit `93d77feb` exists in git log ✓
- `packages/daemon/src/process/graceful-shutdown.ts` absent on disk ✓
- `packages/daemon/src/process/graceful-shutdown.test.ts` absent on disk ✓
- `packages/daemon/src/wiring/setup-shutdown.ts` exists at 797 LOC ✓
- No code references to `registerGracefulShutdown` / `_registerGracefulShutdown` (only descriptive comments) ✓
- Phase 50 integration tests (11 assertions) green post-inline ✓
- `pnpm cycles` exit 0 ✓
- `test/architecture/file-size.test.ts` green ✓
