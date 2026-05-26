---
phase: 04-mcpx-mcp-transport-resilience
plan: "04"
subsystem: mcp-client / keepalive / reconnect
tags: [mcpx, keepalive, reconnect, tdd-green, cycle-break]
dependency_graph:
  requires: ["04-02", "04-03"]
  provides: ["RED-08-GREEN", "MCPX-02-complete", "MCPX-03-complete"]
  affects: ["mcp-client-keepalive.ts", "mcp-client-reconnect.ts", "mcp-client-connect.ts"]
tech_stack:
  added: []
  patterns:
    - "onFailure callback injection to break keepalive ↔ reconnect source cycle"
    - "optional callback parameter with no-op default for backward-compatible API extension"
key_files:
  created: []
  modified:
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-keepalive.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-reconnect.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-connect.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-reconnect.test.ts
decisions:
  - "Break keepalive ↔ reconnect source cycle via onFailure callback injection rather than dynamic import"
  - "Chose callback injection over state/deps field injection to avoid interface changes in test harness"
metrics:
  duration: "~25 minutes (context-continuation session)"
  completed: "2026-05-26T19:39:58Z"
  tasks_completed: 1
  files_modified: 4
---

# Phase 04 Plan 04: keepalive ticker restart after auto-reconnect (RED-08 GREEN)

## One-liner

Break the keepalive ↔ reconnect source cycle via `onFailure` callback injection, then add `startKeepaliveTicker` call to `reconnectionLoop` success block so RED-08 goes GREEN.

## What Was Built

The `reconnectionLoop` in `mcp-client-reconnect.ts` now calls `startKeepaliveTicker` after a successful auto-reconnect, wiring the transport-aware keepalive ticker (30 000 ms for http/sse, 180 000 ms for stdio) for the new connection. Without this fix, the keepalive ticker was absent after any auto-reconnect — the interval only applied to the initial `connectServer` call. After a reconnect, no pings fired and idle-close could recur silently.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add startKeepaliveTicker call to reconnectionLoop + break source cycle | 6aaf299 | mcp-client-keepalive.ts, mcp-client-reconnect.ts, mcp-client-connect.ts, mcp-client-reconnect.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Dynamic import detected by madge's source-mode check**

- **Found during:** Task 1
- **Issue:** The plan proposed using `await import("./mcp-client-keepalive.js")` (dynamic import) as the cycle-breaking mechanism, citing that "`pnpm cycles` does not detect dynamic imports." Investigation confirmed this was correct for `pnpm cycles` (dist-mode madge), but `test/architecture/no-cycles.test.ts` uses madge in SOURCE mode (`detectiveOptions.ts.mixedImports: true`) which DOES detect dynamic `import()` expressions as dependency edges. Both `void import()` at module init level AND `await import()` inside function bodies are detected as cycle edges in source mode. This caused the architecture test to fail.
- **Fix:** Broke the `keepalive → reconnect` import dependency directly: removed `import { handleDisconnection } from "./mcp-client-reconnect.js"` from `mcp-client-keepalive.ts` and replaced the call with an `onFailure?: (serverName: string) => void` optional callback parameter on both `startKeepaliveTicker` and `maybeEnqueueKeepalivePing`. Call sites (`mcp-client-connect.ts` and `mcp-client-reconnect.ts`) pass `(srvName) => handleDisconnection(state, deps, srvName, "keepalive_failed")`. This is a cleaner architectural fix: `mcp-client-keepalive.ts` now depends on zero mcp-client sibling modules.
- **Files modified:** mcp-client-keepalive.ts, mcp-client-reconnect.ts, mcp-client-connect.ts
- **Commit:** 6aaf299

**2. [Rule 1 - Bug] vi.runAllTimersAsync() caused infinite loop in RED-08 test**

- **Found during:** Task 1 (pre-existing from plan 04-01)
- **Issue:** RED-08 test used `vi.runAllTimersAsync()` to drain fake timers after `handleDisconnection`. Once `startKeepaliveTicker` creates a 30 000 ms `setInterval`, `vi.runAllTimersAsync()` fires it repeatedly until hitting the 10 000-timer loopLimit, causing an "infinite loop" abort.
- **Fix:** Changed `await vi.runAllTimersAsync()` → `await vi.advanceTimersByTimeAsync(100)` in RED-08 test. Advancing 100 ms fires the 1 ms backoff timer (completing reconnectionLoop) but does NOT trigger the 30 000 ms keepalive interval.
- **Files modified:** mcp-client-reconnect.test.ts
- **Commit:** 6aaf299

## Decisions Made

1. **Callback injection over state/deps injection**: Adding `onFailure` as an optional function parameter is backward-compatible (existing 3-arg callers still compile), avoids modifying `McpClientManagerState` or `McpClientManagerDeps` interfaces (which would require updating both test harnesses), and is explicit at the call site about what disconnect semantics are being wired.

2. **Static import in reconnect.ts**: After breaking `keepalive → reconnect`, the reverse `reconnect → keepalive` import creates no cycle. Using a static import is simpler, faster, and more clearly intentional than the originally-planned dynamic import.

## Verification

All verification gates pass:

- RED-08: `state.keepaliveTickers.has("srv")` is true after `await vi.advanceTimersByTimeAsync(100)` — GREEN
- 209 MCP client tests pass (15 test files)
- 1353 test files, 25 011 tests pass (full suite)
- `pnpm cycles`: zero circular dependencies (dist-mode madge)
- `test/architecture/no-cycles.test.ts`: 2 passed (source-mode madge)
- `pnpm validate`: build + test + lint:security + cycles — all green

## Self-Check

Files created/modified:
- `/Users/mosheanconina/Projects/comisai/comis_dev_2/comis/packages/skills/src/skills/integrations/mcp-client/mcp-client-keepalive.ts` — FOUND (modified)
- `/Users/mosheanconina/Projects/comisai/comis_dev_2/comis/packages/skills/src/skills/integrations/mcp-client/mcp-client-reconnect.ts` — FOUND (modified)
- `/Users/mosheanconina/Projects/comisai/comis_dev_2/comis/packages/skills/src/skills/integrations/mcp-client/mcp-client-connect.ts` — FOUND (modified)

Commit 6aaf299: FOUND

## Self-Check: PASSED
