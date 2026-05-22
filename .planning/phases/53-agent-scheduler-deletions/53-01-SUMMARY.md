---
phase: 53-agent-scheduler-deletions
plan: 01
subsystem: dead-code-deletion

tags:
  - dead-module-deletion
  - barrel-first-ordering
  - agent-package
  - hexagonal-architecture
  - public-api-policy-shrink
  - architecture-allowlist-shrink

requires:
  - phase: roadmap-traceability
    provides: DEAD-MOD-08, DEAD-MOD-09, DEAD-MOD-10, SPEC-ABS-03 requirement IDs

provides:
  - "Pattern 1 barrel-first deletion ordering validated across 4 surgical barrel edits + 2 whole-file rm + 1 surgical-strip + 1 comment-only delete"
  - "Architecture invariants kept GREEN at every per-commit boundary (build, agent tests, architecture tests, cycles)"
  - "Public-API-policy.ts orphan baseline shrunk by 6 names (formatMemorySection retained); +1 RagConfig added with rationale per Rule 2 deviation"
  - "rag-retriever.ts as a 2-helper utility file (formatMemorySection + deduplicateResults) — matches the hybrid-memory-injector.ts:1-16 analog shape"

affects:
  - 53-02 (model-alias-resolver clean state proven for any future model-routing follow-ups)
  - 53-03 (scheduler heartbeat barrel-first pattern follows the same template used here)
  - 53-04 (event-bus deletions can reuse the public-api-policy-shrink discipline)
  - Any future phase that touches packages/agent/src/index.ts (4-line region freed at L66-67 + L172-173)

tech-stack:
  added: []
  patterns:
    - "barrel-first source deletion"
    - "shrink-only public-api-policy update with per-entry rationale comment"
    - "test rewrite from deleted factory to surviving canonical replacement (HybridMemoryInjector)"

key-files:
  created: []
  modified:
    - packages/agent/src/index.ts (barrel: 4 line-touches; DROP createModelAliasResolver + ModelAliasResolver/Deps + RagRetriever/Deps; EDIT createRagRetriever export to drop only the factory while keeping formatMemorySection)
    - packages/agent/src/rag/rag-retriever.ts (factory + interfaces stripped; 138-line file → 96-line helpers-only file; imports trimmed to {MemorySearchResult, WrapExternalContentOptions, systemDateFrom, wrapExternalContent, sanitizeToolOutput})
    - packages/agent/src/rag/rag-retriever.test.ts (594-line suite → 336-line helpers-only suite; covers formatMemorySection budget/header/taint-wrapping/date-source and deduplicateResults recency/case-insensitivity/ordering)
    - packages/agent/src/session/multi-agent-isolation.test.ts (rewritten against createHybridMemoryInjector; per-agent isolation now holds by construction since the injector takes caller-supplied result arrays)
    - packages/agent/src/executor/pi-executor/pi-executor.test.ts (orphaned createRagRetriever import dropped at L307; stale "Task 229" comment refreshed at L1846)
    - packages/agent/src/executor/tool-deferral.ts (SPEC-ABS-03: 5-line speculative "architectural slot" comment block removed at L387-391; surrounding MCP-rationale and small-model rule unchanged)
    - packages/agent/src/executor/prompt-assembly.ts (Rule-2 deviation: inline `import("@comis/core").TrustLevel` expression at L649 promoted to named type-import in the file-top `import type` block, restoring TrustLevel as a tracked @comis/core consumer for the public-export-consumers architecture test)
    - test/support/public-api-policy.ts (orphan baseline shrunk by 6 names: createModelAliasResolver, ModelAliasResolver, ModelAliasResolverDeps, createRagRetriever, RagRetriever, RagRetrieverDeps; KEEP formatMemorySection. Rule-2 deviation: +RagConfig added under @comis/core with rationale comment after `createRagRetriever` removal made it a true orphan)
  deleted:
    - packages/agent/src/model/model-alias-resolver.ts (115 LOC; DEAD-MOD-09)
    - packages/agent/src/planner/checklist-formatter.ts (57 LOC; DEAD-MOD-10)
    - packages/agent/src/model/model-alias-resolver.test.ts (149 LOC; co-located test)
    - packages/agent/src/planner/checklist-formatter.test.ts (122 LOC; co-located test)
    - packages/agent/src/rag/rag-retrieval-integration.test.ts (306 LOC; sole purpose was driving createRagRetriever end-to-end)

key-decisions:
  - "Barrel-first ordering: edited packages/agent/src/index.ts in Task 1 BEFORE deleting any source file. Source files orphaned but compiled cleanly at every intermediate commit. Pattern matches PATTERNS.md sub-area 1 + AGENTS.md guidance."
  - "Preserved formatMemorySection AND deduplicateResults helpers inside rag-retriever.ts rather than moving them to a renamed file. PATTERNS.md flagged a rename to memory-formatters.ts as a follow-up cleanup option but specifically said 'Not recommended for this phase — adds noise; do as a follow-up cleanup.' Followed."
  - "Replaced rag-retriever.test.ts with a focused helpers-only suite instead of leaving it half-broken. The previous 4-describe-block suite (createRagRetriever, formatMemorySection, RAG deduplication, RAG taint wrapping, RAG search logging) was 96% factory-driven. The new 2-describe-block suite (formatMemorySection + deduplicateResults) keeps the same semantic coverage (header/budget/date+source/sanitization/taint-wrapping/dedup-recency/case-insensitivity/ordering) at 336 lines instead of 594."
  - "Promoted the inline `import('@comis/core').TrustLevel` expression in prompt-assembly.ts:649 to a real named type-import. The architecture test public-export-consumers.test.ts does not track inline import expressions as 'consumers'; after deleting rag-retriever.ts's named import of TrustLevel, the inline form left TrustLevel orphaned on @comis/core. Real named import in prompt-assembly restores it as a tracked consumer AND improves code quality."
  - "Tracked RagConfig as a planned orphan under @comis/core in test/support/public-api-policy.ts (not via inline-import recovery, because no production source code carries `RagConfig` as a value or type alias). Convention mirrors the 25+ existing planned-orphan entries in the same section (ContextStorePort, SessionStorePort, DeviceIdentity, etc.) — each with a per-entry rationale comment."

patterns-established:
  - "Pattern 1 (PATTERNS.md): Barrel-first deletion ordering — edit packages/<pkg>/src/index.ts BEFORE rm-ing source files."
  - "Per-commit shrink-only invariant: every BC-shim / orphan-baseline removal happens in the SAME commit as the source change (AGENTS.md §2.8). Validated across 3 commits: barrel edit (Task 1), public-api-policy shrink (Task 2), source rm + factory strip (Task 3)."
  - "Inline import-expression promotion: when removing a tracked import expression that was the sole named-import consumer of a public @comis/core export, promote any inline `import('@comis/core').X` reference at the call site to a top-of-file named import to keep public-export-consumers.test.ts green."

requirements-completed:
  - DEAD-MOD-08
  - DEAD-MOD-09
  - DEAD-MOD-10
  - SPEC-ABS-03

duration: 78 min
completed: 2026-05-22
---

# Phase 53 Plan 01: Agent dead-module deletions (barrel-first) Summary

**Three agent dead modules deleted with strict barrel-first ordering + rag-retriever factory stripped while preserving formatMemorySection + deduplicateResults helpers; 4 surgical agent/src/index.ts barrel edits, 2 whole-file rm + 1 surgical-strip + 1 comment-only deletion, 4 test files removed (3 whole-file + 1 replaced with smaller scope), public-api-policy orphan baseline shrunk by net 5 lines, ~1246 LOC net deletion**

## Performance

- **Duration:** ~78 min
- **Started:** 2026-05-22T08:34Z (worktree spawn)
- **Completed:** 2026-05-22T09:15Z
- **Tasks:** 3
- **Files modified:** 8 (incl. 1 Rule-2 deviation file)
- **Files deleted:** 5

## Accomplishments

- Reclaimed ~272 prod LOC + ~847 test LOC (per ROADMAP estimate); actual net diff -1246 LOC.
- Eliminated three dead factories with zero production callers: `createRagRetriever`, `createModelAliasResolver`, `formatChecklistForInjection`.
- Preserved `formatMemorySection` + `deduplicateResults` (consumed downstream by `hybrid-memory-injector.ts:16,81,91` and `prompt-assembly.ts:69,654`).
- Removed the SPEC-ABS-03 speculative "architectural slot" comment in `tool-deferral.ts` (zero behavior change; pure text removal).
- Rewrote `multi-agent-isolation.test.ts` against the canonical `createHybridMemoryInjector` post-deletion entry point; per-agent isolation now holds by construction.
- Shrunk `test/support/public-api-policy.ts` orphan baseline by 6 names (DROP `createModelAliasResolver`, `ModelAliasResolver`, `ModelAliasResolverDeps`, `createRagRetriever`, `RagRetriever`, `RagRetrieverDeps`; KEEP `formatMemorySection`). +1 `RagConfig` added under `@comis/core` per Rule 2.
- Kept `enforceFinalTag` UNTOUCHED (operator-facing config per RESEARCH.md Sub-area 6 — explicit critical invariant preserved).
- Held `pnpm build`, `packages/agent $ pnpm test`, `pnpm test:architecture`, `pnpm cycles` green at every commit.

## Task Commits

Each task was committed atomically:

1. **Task 1: Barrel-first prune of packages/agent/src/index.ts** — `8de2938f` (refactor)
   - 4 line-touches (3 deletions + 1 edit) at L66-67 and L172-173
   - `pnpm build`/`pnpm cycles` green; source files still on disk and still compiled (orphaned barrel exports gone; internal callers verified zero)
2. **Task 2: Test rewrites + dead-test removal + public-api-policy shrink** — `2fe91f9a` (test)
   - Rewrote `multi-agent-isolation.test.ts` to drive `createHybridMemoryInjector`
   - Replaced `rag-retriever.test.ts` with a 336-line helpers-only suite
   - Dropped orphaned `createRagRetriever` import in `pi-executor.test.ts`
   - Deleted 3 dedicated test files (model-alias-resolver, checklist-formatter, rag-retrieval-integration)
   - Shrunk public-api-policy orphan baseline by 6 names
3. **Task 3: Source deletions + factory strip + SPEC-ABS-03 comment removal** — `e33afcd4` (refactor)
   - rm of model-alias-resolver.ts and checklist-formatter.ts (whole-file)
   - Surgical strip of rag-retriever.ts (drop interfaces + factory + unused imports; rewrite module JSDoc to analog of hybrid-memory-injector.ts:1-16)
   - Comment removal in tool-deferral.ts (SPEC-ABS-03)
   - Rule-2 deviation: inline-import promotion in prompt-assembly.ts + RagConfig orphan tracking

## Files Created/Modified

(see frontmatter `key-files` for the full enumeration with per-file rationale)

## Decisions Made

(see frontmatter `key-decisions`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Architecture invariant] Restored TrustLevel as a tracked @comis/core named-import consumer**

- **Found during:** Task 3 (after deleting `rag-retriever.ts`'s `import type { ..., TrustLevel } from "@comis/core"` block)
- **Issue:** `test/architecture/public-export-consumers.test.ts` flagged `TrustLevel` (and `RagConfig`) as orphan exports of `@comis/core` with no in-repo named-import consumer. The architecture test only counts `import { X } from "@comis/core"` (named imports); it does NOT count inline `import("@comis/core").X` expressions. The pre-edit `prompt-assembly.ts:649` form `Set<import("@comis/core").TrustLevel>(...)` did not register as a consumer.
- **Fix:** Added `TrustLevel` to the existing `import type { ... } from "@comis/core"` block at `prompt-assembly.ts:14-30` and switched L649 to use the imported name directly: `Set<TrustLevel>(config.rag.includeTrustLevels)`. This is also a code-quality improvement (inline import expressions are awkward TS style).
- **Files modified:** `packages/agent/src/executor/prompt-assembly.ts` (2 line-touches: imports block + L649)
- **Verification:** `pnpm vitest run --project architecture public-export-consumers` 11/11 green; `pnpm build` green (no new type errors); `cd packages/agent && pnpm test` 222 files / 5114 tests green.
- **Committed in:** `e33afcd4` (Task 3 commit)

**2. [Rule 2 - Architecture invariant] Tracked RagConfig as a planned-orphan in public-api-policy under @comis/core**

- **Found during:** Same architecture-test failure as above (RagConfig was the second orphan).
- **Issue:** After `createRagRetriever` deletion, no production code carries `import { RagConfig } from "@comis/core"`. `prompt-assembly.ts` reads `config.rag.includeTrustLevels` via the typed-by-schema `PerAgentConfig.rag` slot, so a real named-import recovery is not natural for `RagConfig`. The architecture test expects either a consumer or a documented policy entry.
- **Fix:** Added `"RagConfig"` to `test/support/public-api-policy.ts` under the `@comis/core` orphan-baseline set, with an 8-line rationale comment explaining the post-deletion state and the typed-by-schema access pattern. Matches the convention used by 25+ other entries in the same section (e.g., ContextStorePort, SessionStorePort, DeviceIdentity).
- **Files modified:** `test/support/public-api-policy.ts`
- **Verification:** `pnpm vitest run --project architecture public-export-consumers` 11/11 green; the broader `pnpm test:architecture` suite 45 files / 278 tests green (no allowlist-shrink test regression).
- **Committed in:** `e33afcd4` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 2 — architecture invariant preservation)
**Impact on plan:** Both auto-fixes essential to keep the architecture-test contract green. No scope creep — both changes are tightly coupled to symbols whose import sites this plan deleted (TrustLevel and RagConfig were imported from `@comis/core` in the now-deleted rag-retriever.ts). Plan's `must_haves.truths` are all satisfied; no plan acceptance criterion relaxed.

## Issues Encountered

- **Workspace-wide `pnpm test` has pre-existing concurrency flakes** in unrelated packages (memory `embedding-cache-sqlite.test.ts` TTL prune timer, channels `email/*` mock cleanup, daemon `setup-output-retention` + `setup-shutdown` timing). All confirmed to pass in isolation and unrelated to Plan 53-01 (none reference the symbols this plan deletes). Verified pre-existing by isolation runs. Documented in `.planning/phases/53-agent-scheduler-deletions/deferred-items.md`.
- **Pre-existing `pnpm lint:security` error** at `packages/core/src/hooks/plugin-registry.ts:38` (`@typescript-eslint/no-empty-object-type`). Originates from Phase 52 plan that emptied `PluginRegistryOptions` for EVENT-CLEAN-07. Verified pre-existing on base commit; out of Plan 53-01 scope. Documented in `deferred-items.md`.
- **Orchestrator package vitest config error** (`packages/orchestrator/test/architecture` non-existing) — pre-existing config quirk in this worktree's pnpm setup; unrelated to my changes.

## Cross-Phase Coordination

- **Phase 51 parallel-safe.** Phase 51 also edits `packages/agent/src/index.ts` (drops the identity-link entries at L160-161). Plan 53-01 edits L66-67 and L172-173. Disjoint line ranges; rebase-safe per RESEARCH.md.
- **Phase 52 already merged.** No interference.
- **Phase 53 sibling plans (53-02 through 53-07) parallel-safe.** None of the sibling plans touches the files modified here (verified by reading their PLAN.md frontmatter `files_modified` lists; none mention agent/src/index.ts, agent/src/rag/, agent/src/model/, agent/src/planner/, test/support/public-api-policy.ts).

## User Setup Required

None — pure deletion phase. No external services, no env vars, no schemas, no operator-facing config touched. (`enforceFinalTag` operator config was explicitly preserved per CRITICAL_INVARIANTS.)

## Next Phase Readiness

- The 3 deleted dead modules are reclaimed prod LOC; `pnpm validate`-equivalent gates (build/agent-tests/architecture/cycles) green.
- The pattern of "barrel-first → tests → source rm + policy shrink" is now demonstrated working across the agent package; sibling plans 53-03 (scheduler heartbeat dead modules) and 53-04 (event-bus declarations) can reuse the same per-commit-shrink-only discipline.
- The `rag-retriever.ts` file shape is now a clean 2-helper file consistent with `hybrid-memory-injector.ts`'s analog. If a future phase ever wants to rename it to `memory-formatters.ts`, the change is a 2-line file rename + 2 importer updates (prompt-assembly + hybrid-memory-injector) — no factory plumbing to chase.

## Verification Commands Run (all GREEN at HEAD)

```bash
# Source-deletion checks
test ! -f packages/agent/src/model/model-alias-resolver.ts        # PASS
test ! -f packages/agent/src/planner/checklist-formatter.ts        # PASS
test ! -f packages/agent/src/model/model-alias-resolver.test.ts    # PASS
test ! -f packages/agent/src/planner/checklist-formatter.test.ts   # PASS
test ! -f packages/agent/src/rag/rag-retrieval-integration.test.ts # PASS

# Surgical-edit checks (file survives)
test -f packages/agent/src/rag/rag-retriever.ts                    # PASS
test -f packages/agent/src/index.ts                                # PASS
test -f packages/agent/src/executor/tool-deferral.ts               # PASS

# Symbol-presence checks
grep -q "export function formatMemorySection" packages/agent/src/rag/rag-retriever.ts   # PASS
grep -q "export function deduplicateResults"   packages/agent/src/rag/rag-retriever.ts  # PASS
! grep -q "createRagRetriever\|RagRetrieverDeps\|export interface RagRetriever" \
    packages/agent/src/rag/rag-retriever.ts                                              # PASS

# Public-API-policy shrink
grep -q "formatMemorySection" test/support/public-api-policy.ts                          # PASS
! grep -qE "createModelAliasResolver|ModelAliasResolverDeps|createRagRetriever|RagRetrieverDeps" \
    test/support/public-api-policy.ts                                                    # PASS

# SPEC-ABS-03 comment removal
! grep -q "comment-only architectural slot\|future budget-pressure rule" \
    packages/agent/src/executor/tool-deferral.ts                                         # PASS

# Global symbol-elimination grep (only doc comments + non-presence assertions remain)
grep -rn "createRagRetriever\|createModelAliasResolver\|formatChecklistForInjection" \
    packages/*/src/                                                                       # 6 hits: all JSDoc / // / not.toContain() / module-doc
# Categorized:
#   - rag-retriever.ts:4                            (JSDoc documenting deletion)
#   - rag-retriever.test.ts:7                       (JSDoc documenting deletion)
#   - pi-executor/pi-executor.test.ts:1846          (// comment documenting deletion)
#   - executor-response-filter.test.ts:519,522      (regression test ASSERTING absence)
#   - multi-agent-isolation.test.ts:13              (module-doc comment)
# Zero callable references / zero imports / zero type references.

# Full pipeline (every commit per-task GREEN, full chain GREEN at HEAD)
pnpm build                                                              # PASS
cd packages/agent && pnpm test                                          # PASS: 222 files / 5114 tests
pnpm test:architecture                                                  # PASS: 45 files / 278 tests
pnpm cycles                                                             # PASS: no circular deps
```

---
*Phase: 53-agent-scheduler-deletions*
*Plan: 01*
*Completed: 2026-05-22*
