---
phase: 06-providers-manage-tool
plan: 05
subsystem: agent-bootstrap
tags: [tool-discovery, tool-descriptions, system-prompt, providers-manage]
dependency_graph:
  requires: [06-01, 06-03]
  provides: [providers_manage-tool-discovery, providers_manage-system-prompt-integration]
  affects: [packages/agent/src/bootstrap/sections/tool-descriptions.ts, packages/agent/src/bootstrap/sections/tooling-sections.ts]
tech_stack:
  added: []
  patterns: [admin-tool-dynamic-description, tool-guide-jit-injection, privileged-tool-registration]
key_files:
  created: []
  modified:
    - packages/agent/src/bootstrap/sections/tool-descriptions.ts
    - packages/agent/src/bootstrap/sections/tool-descriptions.test.ts
    - packages/agent/src/bootstrap/sections/tooling-sections.ts
    - packages/agent/src/bootstrap/sections/tooling-sections.test.ts
decisions:
  - "providers_manage TOOL_GUIDE verbatim from design doc section 4.8 -- comprehensive coverage of credential workflow, provider types, read-modify-write patterns, fleet management, and clearing-field limitation"
  - "providers_manage placed after models_manage in TOOL_ORDER and PRIVILEGED_TOOL_NAMES to maintain logical grouping"
  - "Added providers_manage to resolveDescription admin suffix pattern test to ensure dynamic builder coverage"
metrics:
  duration: 242s
  completed: 2026-04-29T11:52:45Z
  tasks: 2
  files: 4
---

# Phase 06 Plan 05: Tool Discovery and Description Registration Summary

providers_manage added to all 5 tool discovery/description registries with comprehensive guide covering credential workflow, provider types, read-modify-write patterns, fleet management, and clearing-field limitation.

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add providers_manage to tool-descriptions.ts | ebaafdf | packages/agent/src/bootstrap/sections/tool-descriptions.ts |
| 2 | Add to tooling-sections.ts + update all tests | 64a7d96 | packages/agent/src/bootstrap/sections/tooling-sections.ts, tooling-sections.test.ts, tool-descriptions.test.ts |

## Changes Made

### TOOL_SUMMARIES (51 -> 52)
Added `providers_manage: "Manage LLM provider endpoints (admin)"` after models_manage.

### LEAN_TOOL_DESCRIPTIONS (45 -> 46)
Added dynamic function builder with admin-aware suffix pattern matching other privileged tools.

### TOOL_ORDER
Inserted `"providers_manage"` after `"models_manage"` in the privileged tools cluster.

### TOOL_GUIDES (12 -> 13)
Added comprehensive provider management guide covering:
- Credential Workflow (two-step: gateway env_set then providers_manage create)
- After Creating a Provider (switch agent via agents_manage update)
- Switching an Agent's Provider or Model (preconditions, timing)
- Configuring Model Failover (fallbackModels pattern)
- Adding vs Replacing a Fallback (read-modify-write for arrays)
- Auth Key Rotation (auth profiles pattern)
- Provider Types (11 types: openai, anthropic, google, ollama, mistral, groq, together, deepseek, cerebras, xai, openrouter)
- Local Providers (no API key, omit apiKeyName)
- Models (only id required)
- Adding vs Replacing a Model (read-modify-write)
- Headers (shallow-merged per key, no read-modify-write needed)
- Clearing a Field (persistToConfig limitation: disable -> delete -> recreate)
- Fleet-Wide Operations (providers_manage + agents_manage list + update x N)

### PRIVILEGED_TOOL_NAMES (10 -> 11)
Added `"providers_manage"` to the privileged tools array, updated doc comment.

### buildPrivilegedToolsSection
- Gated actions: `providers_manage: create, delete`
- Read-only actions: `providers_manage: list, get, update, enable, disable`
- Fleet management patterns: provider-then-agent, failover chain, add-vs-replace fallback, fleet-wide changes

### Test Assertions Updated
- LEAN_TOOL_DESCRIPTIONS count: 45 -> 46
- TOOL_SUMMARIES count: 51 -> 52
- TOOL_GUIDES keys: 12 -> 13 (added providers_manage to expected sorted keys list)
- TOOL_GUIDES describe block label: "all 12 guided tools" -> "all 13 guided tools"
- PRIVILEGED_TOOL_NAMES test: 10 -> 11 entries with providers_manage
- resolveDescription admin suffix test: added providers_manage to privileged builders list

## Verification

```
tool-descriptions.test.ts: 45 passed (45)
tooling-sections.test.ts: 61 passed (61)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing coverage] Added providers_manage to admin suffix pattern test**
- **Found during:** Task 2
- **Issue:** The resolveDescription test checking "all privileged tool dynamic builders follow admin suffix pattern" listed 9 tools but did not include providers_manage, which is now a dynamic builder
- **Fix:** Added "providers_manage" to the privileged array in the test
- **Files modified:** packages/agent/src/bootstrap/sections/tool-descriptions.test.ts
- **Commit:** 64a7d96

## Threat Mitigation

| Threat ID | Status | Implementation |
|-----------|--------|----------------|
| T-6-17 (Information Disclosure) | Mitigated | TOOL_GUIDE explicitly states "API keys are NEVER stored in provider config" and teaches the two-step gateway env_set workflow |
| T-6-18 (Tampering) | Mitigated | providers_manage listed in PRIVILEGED_TOOL_NAMES (11 entries), ensuring LLM identifies it as requiring admin trust |

## Self-Check: PASSED

All 4 modified files exist. Both task commits (ebaafdf, 64a7d96) verified in git log. SUMMARY.md present.
