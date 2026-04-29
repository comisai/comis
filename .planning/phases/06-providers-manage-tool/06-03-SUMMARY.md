---
phase: 06-providers-manage-tool
plan: 03
subsystem: skills
tags: [typebox, admin-manage-factory, rpc, provider-management, approval-gate]

# Dependency graph
requires:
  - phase: 06-providers-manage-tool (plan 01)
    provides: admin-manage-factory pattern used by createProvidersManageTool
provides:
  - createProvidersManageTool factory function with TypeBox schema
  - ProvidersManageToolParams exported schema type
  - 25-test comprehensive test suite for provider management tool
affects: [06-providers-manage-tool plans 04-06 (wiring, registration, tool descriptions)]

# Tech tracking
tech-stack:
  added: []
  patterns: [createAdminManageTool descriptor pattern for provider CRUD, coerceConfig JSON string-to-object coercion]

key-files:
  created:
    - packages/skills/src/builtin/platform/providers-manage-tool.ts
    - packages/skills/src/builtin/platform/providers-manage-tool.test.ts
  modified: []

key-decisions:
  - "No ComisLogger parameter -- providers tool has no custom contract text emission unlike agents-manage"
  - "All 7 actions use actionOverrides for explicit RPC method routing and parameter extraction"
  - "enable/disable include mutation fence callbacks (onMutationStart/onMutationEnd) since they trigger persist/restart"
  - "Intentionally omitted capabilities, cost, comisCompat, sdkCompat from TypeBox schema per CONTEXT.md decisions"

patterns-established:
  - "Provider tool follows exact createAdminManageTool descriptor pattern with simpler factory signature (no logger, no onAgentCreated)"
  - "coerceConfig helper copied verbatim from agents-manage-tool -- same JSON string-to-object coercion for LLM double-encoding"

requirements-completed: [PROVIDER-01, PROVIDER-02]

# Metrics
duration: 4min
completed: 2026-04-29
---

# Phase 6 Plan 3: Providers Manage Tool Summary

**LLM-facing providers_manage tool with 7-action TypeBox schema, createAdminManageTool factory delegation, approval gates on create/delete, and 25-test verification suite**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-29T11:21:11Z
- **Completed:** 2026-04-29T11:25:16Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- Created providers-manage-tool.ts with complete TypeBox schema covering 7 actions (list, get, create, update, delete, enable, disable), config union type (structured object + JSON string fallback), and provider model definitions
- Implemented createProvidersManageTool factory using createAdminManageTool with correct descriptor including gatedActions (create, delete), mutation fence callbacks, and all 7 action overrides with RPC delegation
- Created comprehensive test suite (25 tests) covering metadata, trust guard, action delegation, approval gate, config coercion, mutation callbacks, error handling, and schema validation

## Task Commits

Each task was committed atomically:

1. **Task 1: Create providers-manage-tool.ts with TypeBox schema and factory** - `1c02dab` (feat)
2. **Task 2: Create providers-manage-tool.test.ts** - `3467507` (test)

## Files Created/Modified
- `packages/skills/src/builtin/platform/providers-manage-tool.ts` - LLM-facing tool definition with TypeBox schema (7 actions, config object/string union), coerceConfig helper, and createProvidersManageTool factory
- `packages/skills/src/builtin/platform/providers-manage-tool.test.ts` - 25 tests covering metadata, trust guard (guest/user rejected, admin allowed), all 7 action RPC delegations, approval gate behavior, config coercion, mutation callbacks, error handling, and schema validation

## Decisions Made
- No ComisLogger parameter in factory signature -- providers tool has no custom contract text emission (unlike agents-manage which logs create-contract). Simplifies the public API.
- All 7 actions implemented as actionOverrides (not relying on default factory dispatch) for explicit parameter extraction and mutation fence placement.
- enable/disable actions include mutation fence callbacks (try/finally pattern) since they trigger config persistence and daemon restart.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- providers-manage-tool.ts and test file are complete and tested
- Ready for plan 04+ to wire into barrel exports, setup-tools.ts registration, and rpc-dispatch.ts
- Factory function signature is final: `createProvidersManageTool(rpcCall, approvalGate?, callbacks?)`

## Self-Check: PASSED

- [x] providers-manage-tool.ts exists
- [x] providers-manage-tool.test.ts exists
- [x] 06-03-SUMMARY.md exists
- [x] Commit 1c02dab (Task 1) found
- [x] Commit 3467507 (Task 2) found
- [x] All 25 tests pass

---
*Phase: 06-providers-manage-tool*
*Completed: 2026-04-29*
