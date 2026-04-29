---
phase: "06-providers-manage-tool"
plan: "04"
subsystem: "daemon"
tags: [rpc-dispatch, tool-registration, denylist, model-failover, wiring]
dependency_graph:
  requires:
    - "06-01 (barrel exports for createProvidersManageTool)"
    - "06-02 (provider-handlers.ts with createProviderHandlers)"
    - "06-03 (providers-manage-tool.ts with createProvidersManageTool)"
  provides:
    - "Provider RPC routing via rpc-dispatch.ts"
    - "providers_manage tool available in agentPlatformTools"
    - "Sub-agent denylist enforcement for providers_manage"
    - "modelFailover shallow merge in agents.update"
  affects:
    - "packages/daemon/src/rpc/rpc-dispatch.ts"
    - "packages/daemon/src/wiring/setup-tools.ts"
    - "packages/daemon/src/wiring/setup-cross-session.ts"
    - "packages/daemon/src/rpc/agent-handlers.ts"
tech_stack:
  added: []
  patterns:
    - "Handler spread wiring (createProviderHandlers into handlers object)"
    - "Live config reference passing (not spread copy)"
    - "Mutation fence callbacks (enterConfigMutationFence/leaveConfigMutationFence)"
    - "Shallow merge for partial nested config updates"
key_files:
  created: []
  modified:
    - "packages/daemon/src/rpc/rpc-dispatch.ts"
    - "packages/daemon/src/wiring/setup-tools.ts"
    - "packages/daemon/src/wiring/setup-tools.test.ts"
    - "packages/daemon/src/wiring/setup-cross-session.ts"
    - "packages/daemon/src/wiring/setup-cross-session.test.ts"
    - "packages/daemon/src/rpc/agent-handlers.ts"
    - "packages/daemon/src/rpc/agent-handlers.test.ts"
decisions:
  - "Used live config reference (deps.container.config.providers.entries) not spread copy for provider handler wiring"
  - "Placed providers_manage after models_manage in both tool registration and denylist for alphabetical consistency"
  - "modelFailover merge is shallow (not deep) because all nested fields are scalars or arrays, no nested objects"
metrics:
  duration_seconds: 561
  completed: "2026-04-29T11:58:00Z"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 7
  files_created: 0
---

# Phase 06 Plan 04: Daemon Wiring and ModelFailover Fix Summary

Provider handlers wired into RPC dispatch with live config reference, providers_manage registered in platform tools with mutation fence, sub-agent denylist extended to 10 entries, and modelFailover shallow merge prevents scalar cooldown field loss during partial updates.

## Task Summary

| Task | Name | Commit(s) | Status |
|------|------|-----------|--------|
| 1 | Wire provider handlers + register tool + denylist | 5fd7eae | Done |
| 2 | ModelFailover shallow merge (TDD) | 28b9234, d42e5fc | Done |

## Changes Made

### Task 1: Wire provider handlers + register tool + denylist

**rpc-dispatch.ts** -- Added `import { createProviderHandlers }` and spread `...createProviderHandlers({...})` into the handlers object after `createAgentHandlers`. Uses live `deps.container.config.providers.entries` reference (not a spread copy) per CONTEXT.md locked decision. Passes `agents`, `secretManager`, and full `persistDeps` for config persistence.

**setup-tools.ts** -- Added `createProvidersManageTool` to the `@comis/skills` import block and registered it in `agentPlatformTools` after `createModelsManageTool` with `approvalGate` and mutation fence callbacks (`enterConfigMutationFence`/`leaveConfigMutationFence`).

**setup-cross-session.ts** -- Added `"providers_manage"` to `SUB_AGENT_TOOL_DENYLIST` after `"models_manage"`, bringing the set from 9 to 10 entries. This prevents sub-agents from triggering provider CRUD which causes SIGUSR2 restarts.

**setup-tools.test.ts** -- Added hoisted mock `mockCreateProvidersManageTool`, wired it into the `vi.mock("@comis/skills")` block, and added `expect(toolNames).toContain("providers_manage")` assertion in the base tools test.

**setup-cross-session.test.ts** -- Updated count assertion from 9 to 10 and added `expect(SUB_AGENT_TOOL_DENYLIST.has("providers_manage")).toBe(true)` assertion.

### Task 2: ModelFailover shallow merge (TDD)

**agent-handlers.ts** -- Added shallow merge clause for `config.modelFailover` between the `scheduler.heartbeat` merge and `const merged = { ...existing, ...config }`. When both `config.modelFailover` and `existing.modelFailover` are present, existing scalar fields (cooldownInitialMs, cooldownMultiplier, cooldownCapMs, maxAttempts) are preserved while user-supplied fields override. Arrays (fallbackModels, authProfiles, allowedModels) are replaced wholesale by spread.

**agent-handlers.test.ts** -- Added test "preserves scalar modelFailover fields when patching only fallbackModels" that verifies: (1) in-memory result has `cooldownInitialMs: 30_000` and `cooldownMultiplier: 3` preserved after patching only `fallbackModels`, and (2) persisted patch does NOT contain `cooldownInitialMs` (only user's partial input is persisted, not the merged form).

## TDD Gate Compliance

- RED gate: test(06-04) commit 28b9234 -- failing test for modelFailover shallow merge
- GREEN gate: feat(06-04) commit d42e5fc -- implementation that passes the test
- REFACTOR gate: not needed (implementation is minimal, no cleanup required)

## Deviations from Plan

None -- plan executed exactly as written.

## Threat Mitigations Applied

| Threat ID | Component | Mitigation |
|-----------|-----------|------------|
| T-6-14 | setup-cross-session.ts | `providers_manage` added to SUB_AGENT_TOOL_DENYLIST -- sub-agents cannot trigger provider CRUD |
| T-6-15 | rpc-dispatch.ts | Live config reference used (not spread copy); mutation fence prevents mid-batch SIGUSR2 restarts |
| T-6-16 | agent-handlers.ts | structuredClone captured BEFORE merge clause; persisted YAML contains only user's partial patch |

## Self-Check: PASSED

All 7 modified files exist. All 3 commits (5fd7eae, 28b9234, d42e5fc) verified in git log.
