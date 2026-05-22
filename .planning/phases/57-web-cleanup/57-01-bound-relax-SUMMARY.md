---
phase: 57-web-cleanup
plan: 01
subsystem: web
type: execute
wave: 1
status: complete
requirements:
  - BOUND-RELAX-01
tags:
  - refactor
  - boundary-test
  - web
dependency-graph:
  requires: []
  provides:
    - "boundary-allowlist:PRE_EXTRACTION_ALLOWLIST=26"
    - "controller-keep-list:6"
  affects: []
tech-stack:
  added: []
  patterns:
    - "Inlined RPC façade — view calls `this.rpcClient!.call(...)` directly instead of delegating through a 1:1 controller wrapper"
key-files:
  created: []
  modified:
    - packages/web/src/__tests__/web-controller-boundary.test.ts
    - packages/web/src/views/dashboard.ts
    - packages/web/src/views/scheduler.ts
    - packages/web/src/views/observe-view.ts
    - packages/web/src/views/memory-inspector.ts
    - packages/web/src/views/chat-console.ts
    - packages/web/src/views/message-center.ts
    - packages/web/src/views/config-editor.ts
    - packages/web/src/views/channel-detail.ts
    - packages/web/src/views/mcp-management.ts
    - packages/web/src/views/models.ts
    - packages/web/src/views/session-detail.ts
    - packages/web/src/views/media-test.ts
    - packages/web/src/views/security.ts
    - packages/web/src/views/agents/agent-list.ts
    - packages/web/src/views/agents/agent-detail.ts
    - packages/web/src/views/agents/agent-editor.ts
    - packages/web/src/views/agents/workspace-manager.ts
    - packages/web/src/views/pipelines/pipeline-list.ts
    - packages/web/src/views/pipelines/pipeline-builder.ts
    - packages/web/src/views/pipelines/pipeline-monitor.ts
    - packages/web/src/components/graph/ic-node-editor.ts
    - test/support/architecture-allowlist.ts
  deleted:
    - packages/web/src/views/dashboard-controller.ts
    - packages/web/src/views/dashboard-controller.test.ts
    - packages/web/src/views/scheduler-controller.ts
    - packages/web/src/views/scheduler-controller.test.ts
    - packages/web/src/views/observe-view-controller.ts
    - packages/web/src/views/observe-view-controller.test.ts
    - packages/web/src/views/memory-inspector-controller.ts
    - packages/web/src/views/memory-inspector-controller.test.ts
    - packages/web/src/views/chat-console-controller.ts
    - packages/web/src/views/chat-console-controller.test.ts
    - packages/web/src/views/message-center-controller.ts
    - packages/web/src/views/message-center-controller.test.ts
    - packages/web/src/views/config-editor-controller.ts
    - packages/web/src/views/config-editor-controller.test.ts
    - packages/web/src/views/channel-detail-controller.ts
    - packages/web/src/views/channel-detail-controller.test.ts
    - packages/web/src/views/mcp-management-controller.ts
    - packages/web/src/views/mcp-management-controller.test.ts
    - packages/web/src/views/models-controller.ts
    - packages/web/src/views/models-controller.test.ts
    - packages/web/src/views/session-detail-controller.ts
    - packages/web/src/views/session-detail-controller.test.ts
    - packages/web/src/views/media-test-controller.ts
    - packages/web/src/views/media-test-controller.test.ts
    - packages/web/src/views/security-controller.ts
    - packages/web/src/views/security-controller.test.ts
    - packages/web/src/views/agents/agent-list-controller.ts
    - packages/web/src/views/agents/agent-list-controller.test.ts
    - packages/web/src/views/agents/agent-detail-controller.ts
    - packages/web/src/views/agents/agent-detail-controller.test.ts
    - packages/web/src/views/agents/agent-editor-controller.ts
    - packages/web/src/views/agents/agent-editor-controller.test.ts
    - packages/web/src/views/agents/workspace-manager-controller.ts
    - packages/web/src/views/agents/workspace-manager-controller.test.ts
    - packages/web/src/views/pipelines/pipeline-list-controller.ts
    - packages/web/src/views/pipelines/pipeline-list-controller.test.ts
    - packages/web/src/views/pipelines/pipeline-builder-controller.ts
    - packages/web/src/views/pipelines/pipeline-builder-controller.test.ts
    - packages/web/src/views/pipelines/pipeline-monitor-controller.ts
    - packages/web/src/views/pipelines/pipeline-monitor-controller.test.ts
    - packages/web/src/components/graph/ic-node-editor-controller.ts
    - packages/web/src/components/graph/ic-node-editor-controller.test.ts
decisions:
  - "Use `this.rpcClient!.call(...)` (non-null assertion at call sites guarded by an `if (!this.rpcClient) return;` early-return) for the inlined RPC sites. This matches the boundary regex `\\b(this\\.)?rpcClient!?\\.call\\b`, so the boundary check sees the inline call rather than a `const rpc = this.rpcClient; rpc.call(...)` alias (the alias form does not match the regex; not a correctness issue here because all 21 views are in PRE_EXTRACTION_ALLOWLIST, but the explicit form makes intent unambiguous)."
  - "Inlined response-shape interfaces (e.g., `BillingTotalResult`, `BillingHourlyEntry`, `SecurityConfig`, `WorkspaceStatusDto`, etc.) as private types in the view files, rather than relocating to `packages/web/src/api/types/index.js`. The types were single-consumer (only the deleted controller exported them) and the YAGNI rule applies — moving them centrally would add a new public surface for one consumer."
  - "Architecture allowlist (`test/support/architecture-allowlist.ts`) entries retained per the shrink-only ratchet — the 26 web view files still exceed the 800L cap after inlining, so the entries stay. Only the `reason: string` field was updated to cite `Phase 57 BOUND-RELAX-01` and the deleted controller filename."
  - "All 21 view test files (`<name>.test.ts`) survived without modification. The existing tests already mocked `rpcClient` directly via `vi.fn()` and asserted call sites with `expect(rpcClient.call).toHaveBeenCalledWith(...)` — that assertion still resolves because the inlined view code calls `rpcClient.call(...)` at the same sites the controller used to."
  - "Sentinel-based cwd-drift fix applied during the run: an early Edit-tool call went to the main repo (`/Users/.../comis/packages/...`) instead of the worktree, due to the worktree-path-safety concern called out in the executor protocol. Restored the main-repo file via targeted `git checkout -- <file>`, then redid the edit using the full worktree path. Subsequent edits all used the worktree-absolute path."
metrics:
  duration: "47 minutes"
  completed: "2026-05-22"
  tasks: 4
  files_created: 0
  files_modified: 23
  files_deleted: 42
  prod_loc_removed: 2696
  test_loc_removed: 3077
  total_loc_removed: 5773
---

# Phase 57 Plan 01: BOUND-RELAX-01 (Inline 21 RPC façade controllers) Summary

Inlined 21 trivial RPC-façade controllers back into their parent views, deleted ~5,773 LOC across prod + test, and widened the boundary-test allowlist so the architecture check stays green throughout the deletion sequence.

## Outcome

- **6 controllers preserved** (the keep list):
  - `packages/web/src/app-controller.ts` (shell controller, substantive — not in inlining scope)
  - `packages/web/src/state/sse-controller.ts` (state primitive, outside boundary-test walk)
  - `packages/web/src/state/polling-controller.ts` (state primitive, outside boundary-test walk)
  - `packages/web/src/views/skills-controller.ts` (substantive 755L; owns state machine)
  - `packages/web/src/views/setup-wizard-controller.ts` (substantive 791L; owns state machine across 5 wizard steps)
  - `packages/web/src/components/scheduler/ic-cron-editor-controller.ts` (NO-RPC preview-debounce orchestrator)
- **21 controllers deleted** (~2,696 prod LOC), **21 controller test files deleted** (~3,077 test LOC).
- **21 views modified** to call `this.rpcClient!.call(...)` inline at every former delegation site.
- **`PRE_EXTRACTION_ALLOWLIST` widened from 5 → 26 entries** (5 pre-existing baseline + 21 newly inlined).
- **`test/support/architecture-allowlist.ts` reason strings updated** for the 21 inlined views — entry count unchanged.
- **`pnpm validate` fully green** (build + test + lint:security + cycles all pass).

## Tasks completed

| # | Task | Commit | LOC change |
|---|------|--------|------------|
| 1 | Widen PRE_EXTRACTION_ALLOWLIST first (boundary-test-green throughout) | `f282d2d4` | +34 / -8 |
| 2 | Inline 21 controllers — delete controller files + test files; edit each view | `a87f2cf1` | +485 / -6624 |
| 3 | Update reason strings in test/support/architecture-allowlist.ts | `68f6ce19` | +21 / -21 |
| 4 | Drop unreachable raw throw introduced during message-center inlining (validate gate) | `c6f4418b` | +1 / -3 |

Net diff (Task 1 + 2 + 3 + 4): **+541 / -6656 lines** (−6115 net).

## Plan-vs-reality LOC delta

| Quantity | Plan estimate | Actual |
|----------|---------------|--------|
| Prod LOC removed (21 controllers) | ~2,696 | matches |
| Test LOC removed (21 controller tests) | ~3,077 | matches |
| Inline LOC delta per view | "0–50 LOC depending on method count" | confirmed — each view grew by ~10-30 LOC (the inlined RPC call signatures + inlined response-type interfaces) but lost the ~20-25 LOC of `_controller`, `_capturedRpcClient`, `_ensureController()` plumbing |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unreachable raw throw added during message-center inlining**

- **Found during:** Final `pnpm validate` gate (Task 4)
- **Issue:** While inlining message-center.ts `_loadData()`, I added a defensive `if (!this.rpcClient) throw new Error("RPC client not available")` inside the `try { ... }` block — but the outer `if (!this.rpcClient || !channel) return;` at the function entry already guards against this. The architecture rule `rawThrowAllowlist` rejected the raw throw because it lives outside `security/` / `safety/` / `error-mapper.ts` and lacks an `@allow-throw:` annotation.
- **Fix:** Removed the unreachable inner throw and the redundant null check; the outer guard at L400 is sufficient. Added a code-comment noting that `rpcClient` is guarded above.
- **Files modified:** `packages/web/src/views/message-center.ts`
- **Commit:** `c6f4418b`

**2. [Path-safety drift, recovered] Initial Edit landed in main repo, not worktree**

- **Found during:** Task 1 verification (after first Edit)
- **Issue:** The first Edit call used the absolute path `/Users/.../comis/packages/web/src/__tests__/web-controller-boundary.test.ts` (no `.claude/worktrees/agent-.../` prefix). The Edit tool resolved that to the **main repo**, not the worktree at `/Users/.../comis/.claude/worktrees/agent-a922031126a549911/`. The worktree file remained unchanged.
- **Detection:** I noticed git status was empty in the worktree but the main repo had `M  packages/web/src/__tests__/web-controller-boundary.test.ts`. This is the cwd-drift / absolute-path safety failure mode called out in the executor protocol's `<absolute_path_safety>` block.
- **Fix:** Restored the main-repo file via targeted `git checkout -- packages/web/src/__tests__/web-controller-boundary.test.ts` (NOT a blanket reset), then redid the Edit using the full worktree absolute path `/Users/.../comis/.claude/worktrees/agent-a922031126a549911/packages/web/src/...`. All subsequent edits used the worktree-prefixed path.
- **Files modified:** None permanently in the main repo; the restoration left the main repo clean.
- **Commit:** N/A (no commit on the main repo); the Task 1 commit `f282d2d4` lives only on the worktree branch.

### No other deviations

All 4 tasks executed as written in the PLAN.md. No checkpoint hits. No auth gates.

## Plan-execution feedback

- **Plan was clear and correct.** The 21 view+controller pairs table, the keep list (6 controllers), and the 26-entry final allowlist were precise. The plan's gotchas (especially "observe-view.ts has TWO `createObserveViewController()` call sites" and "scheduler-controller does parameter normalization") matched reality and saved time during the per-view edits.
- **Per-view test files all survived without modification.** The plan flagged this as "most tests already mock rpcClient directly" — confirmed for 100% of the 21 views. Zero view-test files needed updates. No unique branch coverage was ported from a deleted controller test to a view test (each controller test asserted only that the controller method invokes `rpcClient.call(...)` with specific args — the view tests assert the same thing at the inline site).
- **Boundary regex behavior matters.** The boundary test's regex `\b(this\.)?rpcClient!?\.call\b` matches `this.rpcClient.call(...)` and `rpcClient!.call(...)` but NOT `const rpc = this.rpcClient; rpc.call(...)`. Several views (notably `dashboard.ts:_loadRpcData`) already use the local-alias pattern and the boundary test passes only because they're in the allowlist. My inlined RPC sites use the explicit `this.rpcClient!.call(...)` form where practical, but for parallel-fetch blocks (e.g., `Promise.allSettled([...])`) the local-alias is used for readability — the boundary test sees zero violations either way because all 21 views are in `PRE_EXTRACTION_ALLOWLIST`.

## Verification (phase-level checks)

All 6 checks from the plan's `<verification>` section pass:

1. **Controller inventory:** `find packages/web/src -name "*-controller.ts" -not -name "*.test.ts" | wc -l` → **6** (keep list).
2. **Allowlist count:** `grep -c '"packages/web/src/' packages/web/src/__tests__/web-controller-boundary.test.ts` → **26**.
3. **No stale imports:** `grep -rn "from \"./.*-controller\"" packages/web/src/views/` → **0 lines** (no view imports a deleted controller).
4. **Boundary test green:** `cd packages/web && pnpm vitest run src/__tests__/web-controller-boundary.test.ts` → **4 tests pass**.
5. **Allowlist text:** `grep -c 'Phase 57 BOUND-RELAX-01' test/support/architecture-allowlist.ts` → **21**.
6. **Full validate gate:** `pnpm validate` → **0 errors** (build / test / lint:security / cycles all green).

## Coverage assessment

Per `<plan>` Pitfall 4 ("Coverage floor risk assessment"): the inlined-back-into-view code retains coverage because the view's own test file already mocks `rpcClient` and asserts call-sites by method name + args. Each former controller method's coverage moves from `<name>-controller.ts` (deleted, contributes nothing) to `<name>.ts` (the view, where the test mock now sees the call directly).

No coverage regressions detected. `pnpm test` reports 2,192 passing tests in `packages/web` (117 test files).

## Stub tracking

None. The plan removed code rather than added it; no stubs introduced.

## Self-Check: PASSED

All commits exist and the files claimed in `key-files.modified` and `key-files.deleted` are in the worktree at the expected paths.

```
git log --oneline | head -5
c6f4418b fix(57-01): drop unreachable raw throw introduced during message-center inlining
68f6ce19 docs(57-01): update fileSizeAllowlist reason strings for inlined views
a87f2cf1 refactor(57-01): inline 21 trivial RPC-façade controllers into views
f282d2d4 test(57-01): widen PRE_EXTRACTION_ALLOWLIST for 21 inlined views
53d0e920 fix(53-review): WR-04 refresh AUDIT.md line numbers after onTaskExtraction removal (base)
```

File-presence spot-check (sample):
- `packages/web/src/views/dashboard-controller.ts` → **GONE** (deleted in commit a87f2cf1)
- `packages/web/src/views/observe-view-controller.ts` → **GONE** (deleted in commit a87f2cf1)
- `packages/web/src/components/graph/ic-node-editor-controller.ts` → **GONE** (deleted in commit a87f2cf1)
- `packages/web/src/views/skills-controller.ts` → **EXISTS** (preserved per keep list)
- `packages/web/src/views/setup-wizard-controller.ts` → **EXISTS** (preserved per keep list)
- `packages/web/src/app-controller.ts` → **EXISTS** (preserved per keep list)
- `packages/web/src/views/dashboard.ts` → **EXISTS** with 3 inlined `this.rpcClient!.call(...)` sites
- `packages/web/src/__tests__/web-controller-boundary.test.ts` → **EXISTS** with 26 allowlist entries + Phase 57 BOUND-RELAX-01 comment block
- `test/support/architecture-allowlist.ts` → **EXISTS** with 21 entries citing Phase 57 BOUND-RELAX-01

All claims verified.
