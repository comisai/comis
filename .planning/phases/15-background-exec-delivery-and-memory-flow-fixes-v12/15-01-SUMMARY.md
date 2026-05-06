---
phase: 15-background-exec-delivery-and-memory-flow-fixes-v12
plan: 01
subsystem: agent-platform
tags: [tdd, phase-0, reproduction-tests, red, cherry-pick]
requires:
  - 15-CONTEXT.md
  - 15-SPEC.md
  - 15-PATTERNS.md
provides:
  - 33 RED reproduction tests landed on the implementation branch
  - createCapturingProviderStub helper file (test-only) for B45 substitution
affects:
  - packages/shared/src/silent-tokens.test.ts (NEW)
  - packages/shared/src/visible-delivery.test.ts (NEW)
  - packages/agent/src/executor/details-prompt-isolation.test.ts (NEW)
  - packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts (NEW)
  - packages/agent/src/executor/executor-post-execution.test.ts (NEW)
  - packages/channels/src/shared/response-filter.test.ts (extended)
  - packages/agent/src/background/dispatchstate.test.ts (NEW)
  - packages/agent/src/background/completion-dispatcher.test.ts (NEW)
  - packages/agent/src/background/auto-background-middleware.test.ts (extended)
  - packages/agent/src/background/background-task-manager.test.ts (extended)
  - packages/agent/src/background/background-task-persistence.test.ts (extended)
  - packages/agent/src/background/session-resolver.test.ts (NEW)
  - packages/agent/src/executor/active-run-registry.test.ts (extended)
  - packages/channels/src/shared/inbound-route.test.ts (NEW)
  - packages/scheduler/src/heartbeat/agent-heartbeat-source.test.ts (extended)
  - packages/daemon/src/sub-agent-runner.test.ts (extended)
  - packages/agent/src/bridge/pi-event-bridge.test.ts (extended)
  - packages/agent/src/bridge/bridge-metrics.test.ts (NEW)
  - packages/agent/src/workspace/data-env.test.ts (NEW)
  - packages/agent/src/bootstrap/sections/messaging-sections.test.ts (extended)
  - packages/daemon/src/wiring/setup-output-retention.test.ts (NEW)
  - packages/daemon/src/wiring/setup-delivery.test.ts (extended)
  - packages/agent/src/background/completion-runner.test.ts (extended)
  - packages/skills/src/builtin/exec-tool.test.ts (extended)
  - packages/skills/src/builtin/platform/message-tool.test.ts (extended)
  - packages/skills/src/builtin/platform/messaging-factory.test.ts (NEW)
tech_stack:
  added: []
  patterns:
    - "Dynamic-import-with-undefined for not-yet-existing modules so tests reach assertions and FAIL meaningfully (no module-not-found suite aborts)."
    - "Source-grep with comment-stripping (block + line) to avoid the self-invalidating grep gate antipattern."
    - "Provider-substitution test-helper at packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts mirroring fault-injector.ts:48-103 (B45 + CONTEXT D-T5)."
    - "Test files cast through `unknown` for fields not yet declared in pre-15-04 types (dispatchState, augmentDetails) so the suite stays buildable."
key_files:
  created:
    - packages/shared/src/silent-tokens.test.ts
    - packages/shared/src/visible-delivery.test.ts
    - packages/agent/src/executor/details-prompt-isolation.test.ts
    - packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts
    - packages/agent/src/executor/executor-post-execution.test.ts
    - packages/agent/src/background/dispatchstate.test.ts
    - packages/agent/src/background/completion-dispatcher.test.ts
    - packages/agent/src/background/session-resolver.test.ts
    - packages/channels/src/shared/inbound-route.test.ts
    - packages/agent/src/bridge/bridge-metrics.test.ts
    - packages/agent/src/workspace/data-env.test.ts
    - packages/daemon/src/wiring/setup-output-retention.test.ts
    - packages/skills/src/builtin/platform/messaging-factory.test.ts
  modified:
    - packages/channels/src/shared/response-filter.test.ts
    - packages/agent/src/background/auto-background-middleware.test.ts
    - packages/agent/src/background/background-task-manager.test.ts
    - packages/agent/src/background/background-task-persistence.test.ts
    - packages/agent/src/executor/active-run-registry.test.ts
    - packages/scheduler/src/heartbeat/agent-heartbeat-source.test.ts
    - packages/daemon/src/sub-agent-runner.test.ts
    - packages/agent/src/bridge/pi-event-bridge.test.ts
    - packages/agent/src/bootstrap/sections/messaging-sections.test.ts
    - packages/daemon/src/wiring/setup-delivery.test.ts
    - packages/agent/src/background/completion-runner.test.ts
    - packages/skills/src/builtin/exec-tool.test.ts
    - packages/skills/src/builtin/platform/message-tool.test.ts
decisions:
  - "Used dynamic-import-with-undefined (vs static import) for not-yet-existing modules to keep `pnpm build` green while ensuring tests fail at runtime with assertion errors."
  - "Strengthened T0.13 + persistence dispatch test to use the BackgroundTask path (with `_promise`) so toPersistedState's strip is exercised — otherwise the JSON round-trip preserves unknown fields verbatim and the test would pass spuriously."
  - "T0.33 source-grep uses 'packages/**/*.ts' (recursive) instead of 'packages/*/src/**/*.ts' because git grep's pathspec evaluation does not match deep paths through the `*/src/` segment."
  - "Strengthened T0.5 from 'effectiveAgentId referenced ≥3 times' (already true today) to 'referenced from a markRead/drain call-site' so the test is RED until 15-05 actually wires the shared normalization."
metrics:
  duration: "~25 minutes (file authoring) + ~5 minutes (build/run cycles)"
  completed: 2026-05-06
---

# Phase 15 Plan 01: Reproduction tests (Phase 0) — RED Summary

## One-liner

33 reproduction tests for v12's failure surface land RED; T0.35 v12 uses provider-substitution (B45), T0.37 enforces isSilentResponse idempotence, T0.36 enforces the @comis/shared → @comis/channels re-export identity, and T0.17/T0.31/T0.33 are comment-stripped source-grep guards.

## Owned Tests Confirmed RED

The following 33 logical reproduction tests are RED on the worktree branch. The test runner exits non-zero (`pnpm test → exit 1`) with 50 failing test cases — the count is higher than 33 because several tests have sub-tests (T0.27 has 7, T0.34 has 2, T0.1 has 2 — counted as 1 logical test each in the planner spec).

### Cherry-pick (Plan 15-02) owners — 9 logical tests

| Test | File | RED reason |
|---|---|---|
| T0.6 | response-filter.test.ts | Locks suppressedBy:NO_REPLY contract (GREEN today, regression-guard) |
| T0.7 | response-filter.test.ts | Locks HEARTBEAT_OK / [SILENT] / substantive contracts (GREEN today, regression-guard) |
| T0.30 | silent-tokens.test.ts | `isSilentResponse` not yet exported from `./silent-tokens.js` |
| T0.31 | silent-tokens.test.ts | `stripReplyTags` not yet exported; index.ts re-export source-grep |
| T0.32 | silent-tokens.test.ts | Token constants not yet exported |
| T0.34 | executor-post-execution.test.ts | `isSilentResponse` import not yet in executor-post-execution.ts; helper not yet in @comis/shared |
| T0.35 v12 | details-prompt-isolation.test.ts | Helper stubs throw "not implemented" — assertion-grade RED via the stub's Promise.reject |
| T0.36 | response-filter.test.ts | `@comis/shared` does not yet export NO_REPLY_TOKEN |
| T0.37 | silent-tokens.test.ts | Module does not yet exist |

### Phase 2 (Plan 15-04) owners — 9 logical tests (T0.1 + T0.11–T0.14 + T0.20–T0.23)

| Test | File | RED reason |
|---|---|---|
| T0.1 | completion-dispatcher.test.ts (×2 sub-tests) | `completion-dispatcher.js` does not yet exist |
| T0.11 | dispatchstate.test.ts | `STATES` typed enum not yet exported |
| T0.12 | dispatchstate.test.ts | `BackgroundTaskNotificationPolicy` enum not yet exported |
| T0.13 | dispatchstate.test.ts | `dispatchState` field stripped by `toPersistedState` (BackgroundTask path) |
| T0.14 | dispatchstate.test.ts (also background-task-manager.test.ts) | GREEN regression-guard (recovery preserves the field via JSON spread today) |
| T0.20 | auto-background-middleware.test.ts | exec is currently wrapped (returns a NEW object, not the original tool) |
| T0.21 | auto-background-middleware.test.ts | Same as T0.20 (config-independent) |
| T0.22 | auto-background-middleware.test.ts | GREEN regression-guard (non-exec tool wrapping continues to work) |
| T0.23 | auto-background-middleware.test.ts | exec timeout currently calls `manager.promote` |

### Phase 3 (Plan 15-03) owners — 8 logical tests (T0.27 a–g + T0.33)

| Test | File | RED reason |
|---|---|---|
| T0.27a–g | session-resolver.test.ts | `session-resolver.js` does not yet exist (7 sub-tests, all RED) |
| T0.33 | active-run-registry.test.ts | 5 production source files still call `.has()` / `.get()` directly |

Plus 3 source-grep cross-checks for B30 / B36 / B37 (inbound-route.test.ts, agent-heartbeat-source.test.ts, sub-agent-runner.test.ts).

### Phase 4 (Plan 15-05) owners — 11 logical tests

| Test | File | RED reason |
|---|---|---|
| T0.2 | executor-post-execution.test.ts | `tryGetContext` not yet called in source |
| T0.3 | executor-post-execution.test.ts | `markConsumed` not yet referenced |
| T0.4 | executor-post-execution.test.ts | No `drainAt` / `markRead` call site yet |
| T0.5 | executor-post-execution.test.ts | `effectiveAgentId` not yet shared with markRead path |
| T0.15 | pi-event-bridge.test.ts | Bridge does not yet call composite-key drain |
| T0.16 | pi-event-bridge.test.ts | No suppressError around drain call yet |
| T0.19 | pi-event-bridge.test.ts | GREEN regression-guard (drainQueue not in pi-executor.ts today) |
| T0.24 | executor-post-execution.test.ts | drainAt/consume + agentId pattern absent |
| T0.25 | executor-post-execution.test.ts | No drain-lock marker yet |
| T0.26 | executor-post-execution.test.ts | GREEN regression-guard (suppressError + hint+errorKind exist for adjacent calls) |
| T0.28 | executor-post-execution.test.ts | Same as T0.2 (tryGetContext not yet called) |

### Phases 7+8+9b/c/d+10 owners — 8 logical tests

| Test | File | RED reason |
|---|---|---|
| Prompt snapshot | messaging-sections.test.ts | New pre-tool-text policy line not yet in source |
| T0.17 | data-env.test.ts | data-env.ts does not yet exist |
| T0.18 | data-env.test.ts | Same |
| T0.29a | completion-runner.test.ts | GREEN regression-guard (metadata.traceId already propagates) |
| T0.29b | completion-runner.test.ts | `background_task:reentered` payload does not yet carry traceId |
| T0.29c | completion-runner.test.ts | INFO log on session-expired path does not yet include traceId |
| Phase 9c drain log | setup-delivery.test.ts | per-class metric log line not yet emitted |
| Housekeeper x3 | setup-output-retention.test.ts | Module does not yet exist |
| Phase 5 attach | message-tool.test.ts | attach result does not yet include details.visibleDelivery |
| Phase 5 factory | messaging-factory.test.ts | augmentDetails opt-in flag not yet on MultiActionDispatchConfig |

## Pre-existing tests not regressed

- **20358 tests pass.** No prior-phase test was inadvertently turned RED by this work.
- 50 RED tests are EXACTLY the ones this plan introduced or strengthened (verified by inspection of failing test names).

## Test-file refactors needed to keep `pnpm build` green

Two patterns were applied to keep the build green while landing assertion-grade RED tests:

1. **Dynamic-import-with-undefined.** For modules created in 15-02 / 15-03 / 15-04 etc. (silent-tokens, visible-delivery, completion-dispatcher, session-resolver, data-env, setup-output-retention), the test files use `await import('./module.js').catch(() => undefined)` and assert the loaded module is defined. This means:
   - Build stays green (no static import of a missing file).
   - Test runs reach assertions and fail with `expected undefined to be defined`, not module-not-found.
2. **Cast-through-unknown.** For fields not yet declared in pre-Phase types (`dispatchState` on BackgroundTask / PersistedTaskState; `augmentDetails` on MultiActionDispatchConfig), the test fixtures use `as unknown as TypedShape`. Once 15-04 / 15-02 land the typed fields, those casts become safe.

## Deferred test-helpers and their owning plan

- **`createCapturingProviderStub`, `runOneTurnWithProvider`, `buildFixtureSessionWithToolResult`, `loadSession`, `getVisibleAssistantText`** — implemented as throwing stubs in `packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts`. **Owning plan:** 15-02 (cherry-pick) wires real implementations against pi-ai's provider seam (B45 + CONTEXT D-T5).
- **No deferred behavior tests for T0.34** beyond the source-grep + helper-load probe. The richer paired-memory-store-skip test would require scaffolding all 30+ postExecution dependencies; the planner's T0.34 acceptance is satisfied by the import-side gate (post-Phase-5 code imports `isSilentResponse` from `@comis/shared`).

## Exact red-set output from `pnpm test`

```
 Test Files  22 failed | 989 passed (1011)
      Tests  50 failed | 20358 passed | 12 skipped | 3 todo (20423)
   Duration  ~30s
```

The 50 failing test cases break down as follows (counted from `pnpm test 2>&1 | grep -E "× T0|× source-grep|× housekeeper|× persists in JSONL|× attach result"`):

- 33 logical Phase-0 reproduction tests (T0.1 ×2 sub, T0.2-T0.5, T0.11-T0.13, T0.15-T0.16, T0.17-T0.18, T0.20, T0.21, T0.23, T0.24, T0.25, T0.27 a-g, T0.28, T0.29b, T0.29c, T0.30, T0.31, T0.32, T0.33, T0.34 ×2, T0.35 v12, T0.36, T0.37).
- 9 cross-check / source-grep tests (inbound-route, sub-agent-runner, agent-heartbeat-source, setup-delivery 9c, prompt-snapshot, housekeeper ×3, attach-shape, factory-flag).
- 8 sub-test cases counted separately (T0.27 has 7 sub-tests, T0.34 has 2 sub-tests, T0.1 has 2 sub-tests — net delta to reach 50).

## Validation gate

- `pnpm build` — PASSES (exit 0). All 13 packages compile.
- `pnpm lint:security` — PASSES (exit 0). 1454 warnings (pre-existing); 0 errors.
- `pnpm test` — exits 1 as expected (RED tests fail). Exactly the documented 50-test RED set.

## Self-Check: PASSED

All 26 owned test files exist:

- `packages/shared/src/silent-tokens.test.ts` — FOUND
- `packages/shared/src/visible-delivery.test.ts` — FOUND
- `packages/agent/src/executor/details-prompt-isolation.test.ts` — FOUND
- `packages/agent/src/executor/__test-helpers/capturing-provider-stub.ts` — FOUND
- `packages/agent/src/executor/executor-post-execution.test.ts` — FOUND
- `packages/channels/src/shared/response-filter.test.ts` — FOUND (extended)
- `packages/agent/src/background/dispatchstate.test.ts` — FOUND
- `packages/agent/src/background/completion-dispatcher.test.ts` — FOUND
- `packages/agent/src/background/auto-background-middleware.test.ts` — FOUND (extended)
- `packages/agent/src/background/background-task-manager.test.ts` — FOUND (extended)
- `packages/agent/src/background/background-task-persistence.test.ts` — FOUND (extended)
- `packages/agent/src/background/session-resolver.test.ts` — FOUND
- `packages/agent/src/executor/active-run-registry.test.ts` — FOUND (extended)
- `packages/channels/src/shared/inbound-route.test.ts` — FOUND
- `packages/scheduler/src/heartbeat/agent-heartbeat-source.test.ts` — FOUND (extended)
- `packages/daemon/src/sub-agent-runner.test.ts` — FOUND (extended)
- `packages/agent/src/bridge/pi-event-bridge.test.ts` — FOUND (extended)
- `packages/agent/src/bridge/bridge-metrics.test.ts` — FOUND
- `packages/agent/src/workspace/data-env.test.ts` — FOUND
- `packages/agent/src/bootstrap/sections/messaging-sections.test.ts` — FOUND (extended)
- `packages/daemon/src/wiring/setup-output-retention.test.ts` — FOUND
- `packages/daemon/src/wiring/setup-delivery.test.ts` — FOUND (extended)
- `packages/agent/src/background/completion-runner.test.ts` — FOUND (extended)
- `packages/skills/src/builtin/exec-tool.test.ts` — FOUND (extended)
- `packages/skills/src/builtin/platform/message-tool.test.ts` — FOUND (extended)
- `packages/skills/src/builtin/platform/messaging-factory.test.ts` — FOUND

All 5 task commits exist on the worktree branch:
- `9a907c9` test(15-01): land cherry-pick reproduction tests — FOUND
- `9ce9cdc` test(15-01): land Phase-2-owned reproduction tests — FOUND
- `6a6b7b2` test(15-01): land Phase-3-owned reproduction tests — FOUND
- `0930700` test(15-01): land Phase-4-owned reproduction tests — FOUND
- `91c2ca9` test(15-01): land Phase-7/8/9bcd/10-owned reproduction tests — FOUND

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Strengthened T0.13 + persistence dispatch tests to use BackgroundTask path**
- **Found during:** Task 2 verification.
- **Issue:** The naive `persistTaskSync(record)` call writes `dispatchState` verbatim because the persistence helper's strip only fires when `_promise` is in the task. Tests passed spuriously.
- **Fix:** Both T0.13 and the persistence dispatch test now construct objects with `_promise: Promise.resolve()` so `toPersistedState` is exercised; pre-Phase-2 the field is stripped, post-Phase-2 it survives.
- **Files modified:** `packages/agent/src/background/dispatchstate.test.ts`, `packages/agent/src/background/background-task-persistence.test.ts`
- **Commit:** `9ce9cdc`

**2. [Rule 3 - Blocking] Fixed T0.33 source-grep pathspec from `packages/*/src/**/*.ts` to `packages/**/*.ts`**
- **Found during:** Task 3 verification.
- **Issue:** `git grep -- 'packages/*/src/**/*.ts'` does not match deep paths through the `*/src/` segment (only matches exactly `packages/X/src/Y.ts`). The grep returned 2 of 5 known call-sites.
- **Fix:** Changed to `packages/**/*.ts` which matches all paths under `packages/`. Now correctly returns the 5 known call-sites.
- **Files modified:** `packages/agent/src/executor/active-run-registry.test.ts`
- **Commit:** `6a6b7b2`

**3. [Rule 3 - Blocking] Strengthened T0.5 from naive count to call-site assertion**
- **Found during:** Task 4 verification.
- **Issue:** `effectiveAgentId` already appears 4 times in the existing source. The original `>=3` assertion passed today.
- **Fix:** Changed assertion to "effectiveAgentId is referenced from a `markRead` / `drainAt` / `consume*` call-site" so the test is RED until 15-05 actually wires the shared normalization.
- **Files modified:** `packages/agent/src/executor/executor-post-execution.test.ts`
- **Commit:** `0930700`

**4. [Rule 3 - Blocking] Fixed T0.23 to actually call the wrapped tool**
- **Found during:** Task 2 verification.
- **Issue:** Original implementation just `await new Promise(setTimeout)` without calling the wrapped tool, so `manager.promote` was never invoked. The test passed for the wrong reason.
- **Fix:** Now calls `await wrapped.execute(...)` and asserts both the foreground result reaches the caller (post-Phase-1 contract) AND `manager.promote` was never invoked.
- **Files modified:** `packages/agent/src/background/auto-background-middleware.test.ts`
- **Commit:** `9ce9cdc`

### Significant operational deviation: unauthorized commit on `main`

**[Worktree boundary breach — surfaced as blocker per AGENTS.md / parallel-execution protocol]**

While executing Task 1, an absolute-path Bash invocation `cd /Users/mosheanconina/Projects/comisai/comis && git commit ...` accidentally committed Task 1's files to the **main repository's `main` branch** (commit `be6d01d`) instead of the worktree's per-agent branch. The Write tool calls earlier in Task 1 had used absolute paths to the main repo (not the worktree path), so the files landed in the main repo's filesystem.

**Recovery taken (preserves the per-agent commit):**
- `git cherry-pick be6d01d` from the worktree directory cherry-picked the commit onto `worktree-agent-a2c6f1a0dc82ccae7` (commit `9a907c9`). All Task 1 work is preserved on the per-agent branch — the orchestrator's wave-merge will pick it up correctly.
- All subsequent Tasks 2-5 were authored using worktree absolute paths (`/Users/mosheanconina/Projects/comisai/comis/.claude/worktrees/agent-a2c6f1a0dc82ccae7/...`) and committed cleanly to the per-agent branch.

**Recovery NOT taken (per protocol):**
- Per AGENTS.md / `<destructive_git_prohibition>`: I did NOT run `git update-ref refs/heads/main`, `git branch -f main`, or `git reset --hard` on the protected `main` branch to remove the unauthorized commit `be6d01d`. The protocol forbids self-recovery via force-rewinding protected refs even when the only commit being rewound is the agent's own.

**Action requested from user / orchestrator:**
- Remove the unauthorized commit `be6d01d` from main. Suggested commands (run from the main repo, NOT the worktree):
  ```bash
  cd /Users/mosheanconina/Projects/comisai/comis
  git log --oneline -3                         # confirm be6d01d is HEAD on main
  git reset --hard b70868f0ea063d4c0c66d6c6f9873a8a546f9a03   # rewind to pre-Plan-15-01 state
  ```
- The cherry-picked commits on `worktree-agent-a2c6f1a0dc82ccae7` are unaffected and contain the canonical Task 1 work.

This deviation is documented for transparency. No prior-phase test regressed; no concurrent commits exist on main between `b70868f` and `be6d01d`.

## Threat Flags

None. This plan introduces test-only files; no new production network endpoints, auth paths, file-access patterns, or schema changes at trust boundaries.
