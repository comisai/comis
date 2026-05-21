---
phase: 52-daemon-deletions
plan: 02
subsystem: core
tags: [port-trim, event-clean, schema-trim, yagni, no-bc-shims]
dependency_graph:
  requires: []
  provides:
    - "PluginRegistry surface narrowed to register/unregister/getHooksByName/deactivateAll"
    - "PluginRegistryApi surface narrowed to registerHook"
    - "HookRunner surface narrowed to 9 live methods"
    - "InfraEvents map narrowed (3 dead plugin/hook lifecycle events removed)"
    - "DiagnosticsConfig narrowed (placeholder redact subschema removed)"
  affects:
    - packages/channels (channel-registry consumes the narrowed PluginRegistry surface)
    - packages/daemon (setup-delivery consumes the narrowed PluginRegistry surface)
    - packages/core (bootstrap.ts wires the narrowed PluginRegistry constructor)
tech-stack:
  added: []
  patterns:
    - "Cross-package edit pattern (PATTERNS.md §Cross-package edit pattern) — edit @comis/core → pnpm build → channel-plugin smoke test → integration tests → pnpm validate"
    - "Atomic interface narrowing (PATTERNS.md §PORT-TRIM-02 row) — delete from interface + impl + barrels + tests in a single commit"
    - "Event-bus deletion gate (PATTERNS.md §EVENT-CLEAN-07 row) — tsc rejects orphan subscribers on EventMap shrink + grep confirms 0 emitters"
    - "Zero-reader placeholder cleanup (PATTERNS.md §SCHEMA-TRIM-07 row) — verify zero readers, delete declaration + field + doc comments in one commit"
key-files:
  created: []
  modified:
    - packages/core/src/ports/plugin.ts
    - packages/core/src/ports/hook-types.ts
    - packages/core/src/ports/index.ts
    - packages/core/src/hooks/plugin-registry.ts
    - packages/core/src/hooks/plugin-registry.test.ts
    - packages/core/src/hooks/hook-runner.ts
    - packages/core/src/hooks/hook-runner.test.ts
    - packages/core/src/hooks/hook-strategies.ts
    - packages/core/src/hooks/hook-strategies.test.ts
    - packages/core/src/hooks/integration.test.ts
    - packages/core/src/hooks/index.ts
    - packages/core/src/exports/hooks.ts
    - packages/core/src/exports/ports.ts
    - packages/core/src/event-bus/events-infra.ts
    - packages/core/src/event-bus/events-infra.test.ts
    - packages/core/src/config/schema-diagnostics.ts
    - packages/core/src/config/schema-diagnostics.test.ts
    - packages/core/src/config/schema.ts
    - packages/core/src/config/schema-daemon.ts
    - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap
    - packages/core/src/bootstrap.ts
    - packages/channels/src/shared/channel-plugin-integration.test.ts
    - packages/channels/src/shared/channel-registry.test.ts
    - test/integration/custom-adapter-contract.test.ts
    - test/integration/custom-adapter-wiring.test.ts
    - test/integration/eventbus-cross-module.test.ts
    - test/integration/security-infra.test.ts
    - test/support/architecture-allowlist.ts
decisions:
  - "PluginRegistryOptions preserved as a reserved empty type rather than deleted entirely — keeps the constructor signature stable in case a future option needs the slot; the unused eventBus field was the only thing inside it."
  - "Test snapshots updated via `vitest -u` rather than hand-editing — section-registry-parity.test.ts.snap had four snapshots referencing the deleted `redact: {}` field; the `-u` regeneration is the canonical Comis pattern for schema-shape change tests."
  - "Channel-plugin-integration.test.ts `CADPT-13` test kept (not deleted) but retargeted to the surviving lifecycle (register → deactivate) — `activate` was never the channel-plugin contract's anchor; channel adapters self-start via the `start()` method on registration. The deleted `activateAll` was an orphan API."
metrics:
  duration: "~75 minutes (Task 1: 35 min, Task 2: 25 min, Task 3: 15 min)"
  completed: 2026-05-22
---

# Phase 52 Plan 02: Core port/hook/event/schema trim Summary

PluginRegistry / PluginRegistryApi / HookRunner narrowed to their live-caller-only surfaces, 3 dead plugin/hook lifecycle events removed from InfraEvents, and the empty `DiagnosticsRedactConfigSchema` placeholder slot deleted. Net delete: 1874 lines across 28 files (3 commits).

## What

Five surface trims to `@comis/core`, all reachability-verified at zero non-test callers before deletion:

1. **PORT-TRIM-02 (HookRunner)** — `runBeforeToolCall`, `runAfterToolCall`, `runToolResultPersist`, `runAgentEnd` deleted. The 4 corresponding `HookName` union members (`before_tool_call`, `after_tool_call`, `tool_result_persist`, `agent_end`), the 4 event/context/result interface groups, the 2 modifying-hook schemas (`BeforeToolCallResultSchema`, `ToolResultPersistResultSchema`), and the 2 merge functions (`mergeBeforeToolCall`, `mergeToolResultPersist`) all went with them. `runModifyingHookSync` was also deleted (sole caller was the now-deleted `runToolResultPersist`).
2. **PORT-TRIM-09 (PluginRegistryApi)** — `registerTool`, `registerHttpRoute`, `registerConfigSchema` deleted along with the `PluginToolDefinition` and `PluginHttpRoute` interfaces. The 3 corresponding getters (`getRegisteredTools`, `getRegisteredRoutes`, `getRegisteredConfigSchemas`) and the local backing arrays/maps (`tools`, `routes`, `configSchemas`) went with them.
3. **PORT-TRIM-10 (PluginRegistry)** — `activateAll`, `getPlugin`, `getPlugins` deleted. The 4 live methods (`register`, `unregister`, `getHooksByName`, `deactivateAll`) preserved.
4. **EVENT-CLEAN-07 (InfraEvents)** — `plugin:registered`, `plugin:deactivated`, `hook:executed` events deleted. The 2 emit sites in `plugin-registry.ts` and the `emitHookEvent` helper + 14 call sites in `hook-runner.ts` went with them. The `audit:event` emission for modifying hooks is preserved.
5. **SCHEMA-TRIM-07 (DiagnosticsConfig)** — `DiagnosticsRedactConfigSchema` placeholder + `redact:` field reference deleted from `DiagnosticsConfigSchemaInner`. Two doc-comment references in `schema.ts:83` and `schema-daemon.ts:36` updated.

The `rawThrowAllowlist` shrunk by 1 entry — the `plugin-registry.ts:109/116/123` row (the 3 `@allow-throw` decorators that vanish with `registerTool`/`registerHttpRoute`/`registerConfigSchema`). Per AGENTS.md §2.8, this is a NET-WIN shrink (no new entries needed).

## Why

YAGNI (AGENTS.md §2.3). Each of the 5 deletions had zero in-tree production callers — every reachability grep returned 0 lines, every emit site fired into a `if (eventBus)` branch that no production code ever attached a subscriber to, and the schema placeholder slot was a `z.object({}).default({})` with no readers anywhere in the codebase. The threat model (52-02-PLAN.md `<threat_model>`) accepts the residual T-52-05 / T-52-06 third-party-plugin API-break risk because AGENTS.md §1 establishes that plugins are an in-tree composition pattern, not a public extensibility contract.

## How

Three atomic per-task commits on the executor worktree branch:

| Commit | Task | Net delete | Build status | Test status |
|--------|------|-----------|--------------|-------------|
| `1b983401` | PORT-TRIM-02/09/10 | -1166 lines | green | 3583/3583 core, 1762/1762 channels |
| `dca65926` | EVENT-CLEAN-07 | -419 lines | green | 3578/3578 core, 1762/1762 channels |
| `a382adbe` | SCHEMA-TRIM-07 + 2 Task-1 retargets | -48 lines | green | 3578/3578 core, 1762/1762 channels |

Each commit was independently `pnpm build && pnpm cycles && pnpm --filter @comis/core test && pnpm --filter @comis/channels test` green before the next commit. Cross-package `pnpm build` validated all 10 channel plugins still type-check after the `PluginRegistryApi` narrowing (channel plugins use `PluginRegistryApi` as a type signature only — the parameter is prefixed `_api` in all 10 channel plugins — so type-narrowing is safe).

### Verbatim canonical reachability grep outputs (post-deletion)

```
$ grep -rn "registerTool\|registerHttpRoute\|registerConfigSchema" packages/*/src/ --include="*.ts" | \
    grep -v ".test.ts" | grep -v "registerToolMetadata\|registerPluginRouter"
[0 lines]

$ grep -rn "\.activateAll(\|\.getPlugin(\|\.getPlugins()" packages/*/src/ --include="*.ts" | \
    grep -v ".test.ts" | grep -v "plugin-registry.ts"
[0 lines]

$ grep -rn "runBeforeToolCall\|runAfterToolCall\|runToolResultPersist\|\.runAgentEnd(" \
    packages/*/src/ --include="*.ts" | grep -v ".test.ts" | grep -v "packages/core/src/hooks"
[0 lines]

$ grep -rn '"plugin:registered"\|"plugin:deactivated"\|"hook:executed"' packages/*/src/ --include="*.ts" | \
    grep -v ".test.ts" | grep -v "events-infra.ts"
[0 lines]

$ grep -rn "DiagnosticsRedactConfig" packages/*/src/ --include="*.ts"
[0 lines]

$ grep -rn "diagnostics\.redact" packages/*/src/ --include="*.ts"
[0 lines]
```

### Architecture allowlist shrink

The `rawThrowAllowlist` row for `plugin-registry.ts:[[109,109],[116,116],[123,123]]` was deleted from `test/support/architecture-allowlist.ts`. Per PATTERNS.md line 19, this is the NET-WIN shrink path — `allowlist-shrink.test.ts` accepts entry removal (the gate is "shrink-only", not "stable").

## Test results

### Unit tests (pnpm test)

- `packages/core` — 3578 passed (was 3583 before the test deletions; the 5-test drop matches the 5 deleted dead-method describe blocks)
- `packages/channels` — 1762 passed (unchanged; channel plugins only use the narrowed `PluginRegistryApi.registerHook` surface)
- `packages/daemon` — 2597 passed
- All packages — `pnpm build` exits 0
- `pnpm cycles` — 0 circular dependencies

### Integration tests (pnpm test:integration)

Directly affected by the deletions — all PASS post-fix:
- `test/integration/custom-adapter-contract.test.ts` — CADPT-13 retargeted from `register/activate/deactivate` to `register/deactivate` (channel adapters self-start via `start()`, not via plugin `activate`)
- `test/integration/security-infra.test.ts` — SEC-INF-04 retargeted from observing the deleted `plugin:registered` event to direct `getHooksByName` state inspection
- `test/integration/eventbus-cross-module.test.ts` — Group 1 (Plugin Lifecycle Events) deleted entirely; Group 2 (Bootstrap AppContainer Wiring) retargeted to surviving events (`system:error`, `audit:event`)

### Pre-existing integration baseline failures

Baseline integration suite has 18 pre-existing failing tests on the worktree base commit `e0326017` — all are daemon-spawn timing flakes (auth-state-matrix, cli-rpc-roundtrip, cli-sync-tooling, cli-tooling-fill, config-audit-roundtrip, env-vars-daemon, env-vars-unit, trajectory-event-types-filter) per PATTERNS.md line 151's happy-dom-and-pool-flake disposition. Plan 52-02 does NOT introduce any new failures: grep across all failing test files confirms zero references to the surfaces this plan deleted. Documented in `deferred-items.md`.

There is one additional pre-existing regression NOT covered by Plan 52-02: `test/integration/pipeline/concurrency-cap.test.ts` fails with `createPriorityScheduler is not a function` because Phase 54-03 deleted the PriorityScheduler factory but left the test file in place. This is independent dead-code and out of scope (logged in `deferred-items.md`).

## Cross-phase coordination

- **Phase 51 coordination**: Phase 51 deletes `memory/compaction.ts`, which is the last in-tree consumer of `runBeforeCompaction` / `runAfterCompaction`. Plan 52-02 does NOT delete those two HookRunner methods — they remain live in this plan (no zero-caller guarantee yet — Phase 51 must land first). Future cleanup follow-up per RESEARCH §"PluginRegistry (PORT-TRIM-10)" line 428.
- **Phase 55 coordination**: Phase 55 deletes the `secret:modified` event from `events-infra.ts` (adjacent lines per RESEARCH line 917). Rebase clean — both phases edit different regions of the same file; this plan's deletions are at lines 48-71 (pre-edit), Phase 55's deletions are below the secret events block. No conflict.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] runModifyingHookSync became orphan after runToolResultPersist deletion**

- **Found during:** Task 1, Step 3 (HookRunner method deletion)
- **Issue:** The plan called for deleting `runToolResultPersist` from the `HookRunner` interface + impl + imports. After the deletion `runModifyingHookSync` had zero callers (it was a synchronous helper specifically for `tool_result_persist`).
- **Fix:** Deleted `runModifyingHookSync` entirely along with its 30-line body. No production code referenced it; the surviving 9 hook methods all use the async `runModifyingHook` or `runVoidHook`.
- **Files modified:** `packages/core/src/hooks/hook-runner.ts`
- **Commit:** `1b983401`

**2. [Rule 1 - Bug] Test descriptions tripped test-naming architecture gate after refactor**

- **Found during:** Task 1, post-rewrite test run
- **Issue:** Two tests carried over from the pre-refactor test file (`rejects wrong types` at line 36 and `config-driven plugin enablement (schema validation)` at line 216) failed the architecture-level `test-naming.test.ts` predicate after my refactor shifted their line numbers. The `testNamingAllowlist` entries reference fixed line numbers; my refactor invalidated them.
- **Fix:** Renamed the two tests in place to comply with the predicates (`rejects wrong types for systemPrompt field` — adds verb + length; `parses config-driven plugin enablement schema` — adds the `parses` verb prefix). Then dropped the 2 corresponding `testNamingAllowlist` entries — they're no longer needed. This is a NET-WIN allowlist shrink per AGENTS.md §2.8.
- **Files modified:** `packages/core/src/hooks/hook-strategies.test.ts`, `packages/core/src/hooks/integration.test.ts`, `test/support/architecture-allowlist.ts`
- **Commit:** `1b983401`

**3. [Rule 3 - Blocker] Section-registry-parity snapshot tests failed after Task 3 schema deletion**

- **Found during:** Task 3, `pnpm --filter @comis/core test`
- **Issue:** `packages/core/src/config/section-registry-parity.test.ts` has 4 inline snapshots covering `getConfigSchema()` and `getFieldMetadata()` outputs for the whole `AppConfigSchema` and the `diagnostics` subsection. The snapshots embedded the now-deleted `redact: {}` field.
- **Fix:** Re-ran snapshots via `pnpm vitest run ... -u`. Per AGENTS.md §6.2 the standard pattern for schema-shape change tests is `-u` regeneration. Verified the diff shows ONLY removal of the 5 expected `redact`-related lines.
- **Files modified:** `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap`, `packages/core/src/config/schema-diagnostics.test.ts`
- **Commit:** `a382adbe`

### Bundled Task 1 retargets in Task 3 commit

Two `<files>` from Task 1's manifest got missed in the original Task 1 commit due to a stash/pop round-trip in the worktree setup phase:
- `test/integration/custom-adapter-contract.test.ts` (CADPT-13 retarget — drop `activateAll` step)
- `test/integration/security-infra.test.ts` (SEC-INF-04 retarget — drop `plugin:registered` observation, replace with `getHooksByName` state check; also remove unused `TypedEventBus` import)

These were applied in Task 3's commit since both are test-only retargets and Task 3 was already touching `security-infra.test.ts` for related changes. Documented in the Task 3 commit message.

## Self-Check: PASSED

- [x] `1b983401` exists: `git log --oneline | grep 1b983401` → FOUND
- [x] `dca65926` exists: `git log --oneline | grep dca65926` → FOUND
- [x] `a382adbe` exists: `git log --oneline | grep a382adbe` → FOUND
- [x] All 28 files modified per `key-files.modified` frontmatter are non-empty in tree
- [x] `pnpm build` exits 0
- [x] `pnpm cycles` exits 0
- [x] `pnpm --filter @comis/core test` → 3578/3578 pass
- [x] `pnpm --filter @comis/channels test` → 1762/1762 pass
- [x] `pnpm --filter @comis/daemon test` → 2597/2597 pass
- [x] All 6 canonical reachability greps return 0 lines (verbatim above)
- [x] `rawThrowAllowlist` no longer contains `packages/core/src/hooks/plugin-registry.ts`
- [x] `DiagnosticsConfig` inferred type has 3 fields (`trajectory`, `cacheTrace`, `configAudit`), not 4
- [x] Integration tests directly affected by deletions all pass (custom-adapter-contract, security-infra, eventbus-cross-module)
