---
phase: 06-providers-manage-tool
plan: 01
subsystem: config
tags: [zod, managed-sections, provider-registration, ollama, keyless-auth, barrel-exports]

# Dependency graph
requires: []
provides:
  - MANAGED_SECTIONS providers redirect entry (pathPrefix "providers" -> providers_manage tool)
  - AppConfigSchema startup invariant rejecting providers.entries.default
  - KEYLESS_PROVIDER_TYPES gate and ollama-no-auth sentinel for keyless provider registration
  - Barrel exports for createProvidersManageTool from @comis/skills
affects: [06-02, 06-03, 06-04, 06-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "KEYLESS_PROVIDER_TYPES set-based gating for local inference servers"
    - "Sentinel apiKey coalescing (ollama-no-auth) for keyless provider types"
    - "superRefine on AppConfigSchema for cross-field startup invariants"

key-files:
  created: []
  modified:
    - packages/core/src/config/managed-sections.ts
    - packages/core/src/config/managed-sections.test.ts
    - packages/core/src/config/schema.ts
    - packages/agent/src/model/model-registry-adapter.ts
    - packages/agent/src/model/model-registry-adapter.test.ts
    - packages/skills/src/builtin/platform/index.ts
    - packages/skills/src/index.ts

key-decisions:
  - "KEYLESS_PROVIDER_TYPES uses a Set for O(1) lookup and easy future extension (vllm, lm-studio)"
  - "Sentinel value 'ollama-no-auth' chosen over empty string to be explicit in wire traces"
  - "superRefine on AppConfigSchema preserves z.infer type identity (no wrapper type change)"
  - "apiKey verification via registry.getApiKeyForProvider() since Model type does not expose apiKey"

patterns-established:
  - "KEYLESS_PROVIDER_TYPES: extend by adding type strings to the set for future local inference servers"
  - "superRefine for cross-field config invariants: chain after z.strictObject without type disruption"

requirements-completed: [PROVIDER-01, PROVIDER-03]

# Metrics
duration: 6min
completed: 2026-04-29
---

# Phase 06 Plan 01: Core Infrastructure Summary

**MANAGED_SECTIONS providers redirect, AppConfigSchema startup invariant for reserved 'default' name, KEYLESS_PROVIDER_TYPES gate with ollama-no-auth sentinel, and barrel exports for createProvidersManageTool**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-29T11:20:41Z
- **Completed:** 2026-04-29T11:26:21Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- MANAGED_SECTIONS now includes providers entry at correct position (pathPrefix length sequence 24>14>9>8>6)
- AppConfigSchema rejects providers.entries.default at parse time with actionable rename hint
- Keyless Ollama providers register successfully with ollama-no-auth sentinel; cloud providers without keys still rejected
- Barrel exports wired for createProvidersManageTool (resolves when Plan 03 creates the tool file)

## Task Commits

Each task was committed atomically:

1. **Task 1: MANAGED_SECTIONS redirect + startup invariant** - `4af5e83` (feat)
2. **Task 2: Keyless provider registration fix** - `4892d88` (test/RED), `49b052b` (feat/GREEN)
3. **Task 3: Skills barrel exports** - `53049e0` (chore)

_Note: Task 2 followed TDD (RED then GREEN). No refactor commit needed._

## Files Created/Modified
- `packages/core/src/config/managed-sections.ts` - Added providers entry to MANAGED_SECTIONS array
- `packages/core/src/config/managed-sections.test.ts` - Added 2 redirect tests for providers paths
- `packages/core/src/config/schema.ts` - Added superRefine rejecting providers.entries.default
- `packages/agent/src/model/model-registry-adapter.ts` - Added KEYLESS_PROVIDER_TYPES, gate relaxation, sentinel coalescing
- `packages/agent/src/model/model-registry-adapter.test.ts` - Added 4 keyless provider tests
- `packages/skills/src/builtin/platform/index.ts` - Added createProvidersManageTool export
- `packages/skills/src/index.ts` - Added createProvidersManageTool re-export

## Decisions Made
- Used `getApiKeyForProvider()` in tests instead of `found!.apiKey` because pi-ai's Model type does not expose apiKey (stored at provider level)
- Sentinel string "ollama-no-auth" is explicit rather than empty string, making it identifiable in wire traces and logs
- superRefine chosen over transform to preserve `z.infer<typeof AppConfigSchema>` type identity

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test assertion adjusted for Model type shape**
- **Found during:** Task 2 (GREEN phase)
- **Issue:** Plan specified `found!.apiKey` assertion, but pi-ai Model interface does not expose apiKey property
- **Fix:** Changed tests to use `registry.getApiKeyForProvider()` which returns the stored apiKey for the provider
- **Files modified:** packages/agent/src/model/model-registry-adapter.test.ts
- **Verification:** All 21 tests pass
- **Committed in:** 49b052b (part of GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Test assertion adapted to actual API surface. No scope creep.

## Issues Encountered
None - vitest flag `-x` not supported in v4.1.5, used `--bail 1` instead (cosmetic, no impact).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MANAGED_SECTIONS redirect is live: immutability rejections for providers.* paths now include providers_manage tool hint
- Startup invariant is live: config.yaml with providers.entries.default rejected at parse time
- Keyless provider registration unblocks Ollama/vLLM/LM Studio provider entries
- Barrel exports ready: Plan 03 (providers-manage-tool.ts) will resolve the import chain
- Plans 02-06 can proceed; Plan 04 (Wave 2) is the first that compiles the full export chain

---
*Phase: 06-providers-manage-tool*
*Completed: 2026-04-29*
