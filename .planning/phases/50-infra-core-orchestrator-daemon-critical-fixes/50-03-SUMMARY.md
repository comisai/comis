---
phase: 50-infra-core-orchestrator-daemon-critical-fixes
plan: 03
subsystem: core/config + orchestrator/execution
tags:
  - core
  - config
  - schema
  - orchestrator
  - streaming
  - crit-05
requires:
  - StreamingConfigSchema (existing)
  - PerChannelStreamingConfigSchema (existing)
  - AGENTS.md §6.4 (schema-as-SSOT invariant)
provides:
  - StreamingConfigSchema.defaultChunkMinChars (new, default 100)
  - StreamingConfigSchema.defaultTypingCircuitBreakerThreshold (new, default 3)
  - StreamingConfigSchema.defaultTypingTtlMs (new, default 60000)
  - resolveStreamingConfig routes through PerChannelStreamingConfigSchema.parse({})
affects:
  - packages/core/src/config/schema-streaming.ts
  - packages/orchestrator/src/execution/execution-pipeline.ts
  - packages/orchestrator/src/execution/execution-pipeline.test.ts
  - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap (snapshot regen)
tech-stack:
  added: []
  patterns:
    - "Zod `.default()` + `.parse({})` as the single source of truth for nested config schemas (Pattern 3 from RESEARCH)"
    - "Spread-merge of schema defaults with global default* fields for the global-without-per-channel-override branch"
key-files:
  created: []
  modified:
    - packages/core/src/config/schema-streaming.ts
    - packages/orchestrator/src/execution/execution-pipeline.ts
    - packages/orchestrator/src/execution/execution-pipeline.test.ts
    - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap
decisions:
  - "Documented deviation from ROADMAP Success Criterion #3 verbatim wording: the resolver uses ONLY PerChannelStreamingConfigSchema.parse({}) because the resolver's return type is PerChannelStreamingConfig, not StreamingConfig. The StreamingConfigSchema.parse({}) lane is satisfied at AppConfig parse time. This preserves the SSOT property the ROADMAP intends without violating type safety (see RESEARCH §3 Anti-Pattern)."
  - "Removed call-site `?? \"code\"`, `?? \"first\"`, `?? true` fallbacks on global.defaultUseMarkdownIR, defaultTableMode, defaultReplyMode — AGENTS.md §6.4 mandates fallbacks live in `.default()`, not at call sites."
  - "Updated the pre-existing 'falls back to global defaults' test (line 265) to populate the 3 new required default* fields on its literal StreamingConfig object. The old test was incidentally passing because the buggy inline literals (100/3/60000) masked the missing schema fields."
metrics:
  duration: ~17 minutes
  completed: 2026-05-21T21:56Z
  tasks_completed: 4
  commits: 3
  files_modified: 4
  tests_added: 11
  tests_passing: 24412
---

# Phase 50 Plan 03: StreamingConfigSchema parity fix (CRIT-05) Summary

Restored schema-as-SSOT for streaming config by adding three previously-orphaned `default*` knobs to `StreamingConfigSchema` and routing `resolveStreamingConfig` through `PerChannelStreamingConfigSchema.parse({})` instead of inlining hardcoded literals — operator YAML knobs for `chunkMinChars`, `typingCircuitBreakerThreshold`, and `typingTtlMs` are now reachable end-to-end.

## What Changed

### Schema (packages/core/src/config/schema-streaming.ts)

Three new `.default()`-typed fields added to `StreamingConfigSchema`:

| Field | Type | Default | JSDoc |
|-------|------|---------|-------|
| `defaultChunkMinChars` | `z.number().int().nonnegative()` | `100` | Default minimum characters before allowing a split point (CRIT-05) |
| `defaultTypingCircuitBreakerThreshold` | `z.number().int().positive()` | `3` | Default consecutive sendTyping failures before circuit breaker trips (CRIT-05) |
| `defaultTypingTtlMs` | `z.number().int().positive()` | `60000` | Default maximum typing indicator duration in ms before auto-stop (CRIT-05) |

Defaults exactly match the corresponding `PerChannelStreamingConfigSchema` fields (verified at lines 64, 74, 76 of schema-streaming.ts pre-fix).

### Resolver (packages/orchestrator/src/execution/execution-pipeline.ts)

`resolveStreamingConfig` body rewritten:

- **Default branch (no global config):** `return PerChannelStreamingConfigSchema.parse({});` (1 line) replaces a 13-line inline literal object.
- **Global-without-per-channel-override branch:** `return { ...PerChannelStreamingConfigSchema.parse({}), enabled: streamingConfig.enabled, ..., chunkMinChars: streamingConfig.defaultChunkMinChars, typingCircuitBreakerThreshold: streamingConfig.defaultTypingCircuitBreakerThreshold, typingTtlMs: streamingConfig.defaultTypingTtlMs, ... };` propagates all 3 new global defaults.
- **Removed inline literals:** `chunkMinChars: 100`, `typingCircuitBreakerThreshold: 3`, `typingTtlMs: 60000` (all three CRIT-05 bugs).
- **Removed call-site `??` fallbacks:** `?? "code"`, `?? "first"`, `?? true` are gone — schema's `.default()` makes these fields populated unconditionally post-parse (AGENTS.md §6.4).

Code-line delta (excluding blanks and comments): **38 → 25 (–13 lines)**.

The new resolver carries a 13-line inline documentation comment explaining the documented deviation (so file-level line count is similar). The comment cites RESEARCH Anti-Pattern §3 directly inside the function body.

### Imports

`packages/orchestrator/src/execution/execution-pipeline.ts:19` adds a value import:
```typescript
import { PerChannelStreamingConfigSchema } from "@comis/core";
```

`@comis/core` already exports `PerChannelStreamingConfigSchema` from its barrel (line 156 of `packages/core/src/config/index.ts`) — no core change needed.

## Tests Added

Total: **11 new test cases** in `packages/orchestrator/src/execution/execution-pipeline.test.ts`, partitioned into 4 nested describe blocks under `"resolveStreamingConfig + StreamingConfigSchema defaults (CRIT-05)"`:

| Branch | Tests | What it verifies |
|--------|-------|------------------|
| Schema-level defaults | 3 | `StreamingConfigSchema.parse({}).defaultChunkMinChars === 100` (and 2 sibling knobs) — schema invariant |
| Default branch (no global) | 3 | `resolveStreamingConfig("telegram", undefined).chunkMinChars === 100` (and 2 sibling knobs) — resolver returns schema defaults |
| Global propagation | 3 | `StreamingConfigSchema.parse({ defaultChunkMinChars: 50 }) → resolveStreamingConfig → result.chunkMinChars === 50` — operator YAML propagates end-to-end (and 2 sibling knobs) |
| Per-channel override regression | 2 | Per-channel override still wins over globals for `chunkMinChars` and `typingCircuitBreakerThreshold` |

Pre-fix RED state (after Task 1): **8 of 11 new tests failed** with Zod `unrecognized_keys` errors (strictObject rejects the 3 unknown keys at parse time, before the resolver runs). The 3 "default branch" tests passed coincidentally because the buggy inline literals happened to match the schema defaults.

Post-fix GREEN state (after Task 3): all 11 new tests pass, plus 43 pre-existing execution-pipeline tests = **54 tests passing** in execution-pipeline.test.ts.

## Downstream Serializer / SECTION_REGISTRY Check (RESEARCH Assumption A5)

Verified:
```bash
grep -rn 'defaultChunkMinChars\|defaultTypingCircuitBreakerThreshold\|defaultTypingTtlMs' packages/core/src/config/ --include='*.ts' --exclude='*.test.ts'
```
Returns matches **only** in `packages/core/src/config/schema-streaming.ts` (the 3 new field definitions).

- `section-registry.ts:286-290` registers `streaming` via the full `StreamingConfigSchema` (`schemaSerializable: false, fieldMetadataVisible: true`) — derives metadata from the schema, no explicit field allowlisting needed.
- `field-metadata.ts` has no hardcoded streaming field references — picks up new fields automatically via the schema.
- `managed-sections.ts` has no streaming refs.
- `migrate.ts` handles legacy keys (`defaultPacingMinMs`, `defaultPacingMaxMs`, `coalesceMaxChars`) — unaffected by the new fields.

**Snapshot regeneration required:** `section-registry-parity.test.ts.snap` had 3 snapshots referencing the streaming section's full default object and the flat field-metadata array. The 3 new fields were added to all 3 snapshots in the natural alphabetical order. Updated via `pnpm vitest run packages/core/src/config/section-registry-parity.test.ts --update` and committed in Task 2.

No follow-ups needed.

## Documented Deviation (Success Criterion #3)

ROADMAP Phase 50 Success Criterion #3 and REQUIREMENTS.md CRIT-05 verbatim wording is:
> "routes through `StreamingConfigSchema.parse({})` and `PerChannelStreamingConfigSchema.parse({})`"

This is satisfied as a **two-lane coupling**:

**Lane A — operator YAML → AppConfig:** Operator YAML flows through `StreamingConfigSchema.parse(...)` at `AppConfig` parse time, already wired in `packages/core/src/config/schema.ts:94` (`streaming: StreamingConfigSchema.default(() => StreamingConfigSchema.parse({}))`). No resolver call-site change needed for this lane — the schema parse happens during config loading.

**Lane B — resolver call site:** Inside `resolveStreamingConfig`, only `PerChannelStreamingConfigSchema.parse({})` is used to produce the resolver's return value. Using `StreamingConfigSchema.parse({})` at the resolver call site would emit a `StreamingConfig` (root shape), which is the **wrong return type** — the resolver must return a `PerChannelStreamingConfig` (leaf shape) so it can be consumed by `inbound-setup.ts:156` as `Pick<>` slot.

This deviation is justified by RESEARCH §"Anti-Patterns to Avoid" item 3 ("DO NOT route resolveStreamingConfig through the parent StreamingConfigSchema.parse({})") and preserves the SSOT property the ROADMAP intends. The deviation is documented inline at `execution-pipeline.ts:146-156` for future readers.

## Validation

Final `pnpm validate` output (last 10 lines):

```
 Test Files  1326 passed (1326)
      Tests  24412 passed | 12 skipped (24424)
     Errors  1 error
   Start at  21:56:15
   Duration  67.85s (transform 140.45s, setup 784ms, import 600.86s, tests 227.16s, environment 35.77s)

 ELIFECYCLE  Test failed. See above for more details.
 ELIFECYCLE  Command failed with exit code 1.
```

**All 24412 test assertions pass; 12 skipped (test-level skips); 1 worker-process unhandled error from a pre-existing happy-dom flake** (`TypeError: URL is not a constructor` originating in `packages/web/src/views/setup-wizard.ts:387` and `packages/web/src/views/session-list.ts:428` anchor-click `window.open()` flows under happy-dom's DetachedBrowserFrame.goto). This is infrastructure-level and unrelated to CRIT-05 — the streaming config and orchestrator code paths have no web view surface.

Individual validation steps:
- `pnpm build` → exit 0 (all 15 packages compile)
- `pnpm test` → 24412 assertions pass / 12 skipped / 1 worker flake (pre-existing happy-dom)
- `pnpm lint:security` → exit 0 (0 errors, 1663 warnings — all pre-existing)
- `pnpm cycles` → exit 0 (no circular dependencies)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug-in-test] Updated pre-existing `falls back to global defaults` test**
- **Found during:** Task 3 (resolver fix)
- **Issue:** The test at `execution-pipeline.test.ts:265-293` constructs a `StreamingConfig` literal object that was missing the 3 new required `default*` fields. With the old buggy resolver, this test passed because the hardcoded inline literals (100/3/60000) masked the absence of these schema fields. After Task 3's fix, the resolver propagates `streamingConfig.defaultChunkMinChars` etc., which were `undefined` in the literal — breaking the test.
- **Fix:** Added `defaultChunkMinChars: 100`, `defaultTypingCircuitBreakerThreshold: 3`, `defaultTypingTtlMs: 60000` to the literal object in the test. The expected assertion (already specifying the 3 corresponding leaf-shape fields at lines 282/287/288) remains unchanged.
- **Why this counts as a bug:** The test was relying on resolver behavior that the plan correctly identifies as buggy. Updating the test reflects the fix, not a behavioral change to what the resolver should do.
- **Files modified:** `packages/orchestrator/src/execution/execution-pipeline.test.ts`
- **Commit:** `e9f1c017` (combined with the resolver fix since they're coupled)

### Deferred Items (Pre-existing, Out of Scope)

**1. Happy-dom `URL is not a constructor` flake in web view tests**
- **Where:** `packages/web/src/views/setup-wizard.ts:387` `_downloadYaml` and `packages/web/src/views/session-list.ts:428` `_handleBulkExport` — both trigger anchor-click `<a>` element clicks that hit happy-dom v20.9.0's `DetachedBrowserFrame.goto` which fails with `TypeError: URL is not a constructor`.
- **Why deferred:** Pre-existing infrastructure issue in happy-dom + web view test harness, completely unrelated to CRIT-05 (streaming config has no web view surface). The error is a worker-process unhandled rejection — does not fail any test assertion (all 24412 assertions pass), only triggers non-zero exit on `vitest` via `vitest-pool: Worker forks emitted error`.
- **Recommendation:** Pin or upgrade happy-dom; or wrap `window.open(downloadHref)` in a try/catch in the web view; or use `pnpm test --reporter=verbose` to identify the failing worker. Out of scope for CRIT-05.

**2. Architecture-test flake (`secrets-handlers integrity > every secrets.* contract is admin-scoped`)**
- **Where:** `packages/core/src/__tests__/architecture.test.ts:489`
- **Why deferred:** Test times out at 5000ms under heavy parallel load (24411 tests / 160s runtime). Passes in isolation in 1.0s. Pre-existing flake in async test discovery; unrelated to streaming config.
- **Recommendation:** Increase test timeout or refactor async discovery. Out of scope for CRIT-05.

## Closeout Grep Invariants (Task 4 acceptance criteria)

```bash
$ grep -nE 'defaultChunkMinChars|defaultTypingCircuitBreakerThreshold|defaultTypingTtlMs' packages/core/src/config/schema-streaming.ts
102:    defaultChunkMinChars: z.number().int().nonnegative().default(100),
112:    defaultTypingCircuitBreakerThreshold: z.number().int().positive().default(3),
114:    defaultTypingTtlMs: z.number().int().positive().default(60000),
# → exactly 3 lines ✓

$ grep -cE 'chunkMinChars: 100,|typingCircuitBreakerThreshold: 3,|typingTtlMs: 60000,' packages/orchestrator/src/execution/execution-pipeline.ts
0
# → 0 (inline literals deleted) ✓

$ grep -c 'PerChannelStreamingConfigSchema\.parse(\s*{\s*}\s*)' packages/orchestrator/src/execution/execution-pipeline.ts
4
# (2 code-level: line 159 default branch + line 168 global branch; 2 in inline documentation comment) ✓
```

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `d99f9ad4` | test | Add failing schema + parity tests for 3 new streaming knobs (RED gate) |
| `c4a083ea` | feat | Extend StreamingConfigSchema with 3 default knobs (CRIT-05) — schema-level fields |
| `e9f1c017` | fix | Route resolveStreamingConfig through schema parse (CRIT-05) — resolver + test fixup |

TDD gate sequence verified: `test(...)` → `feat(...)` → `fix(...)`. Together these constitute the RED → GREEN gates for CRIT-05. No REFACTOR commit (Task 4 was validation-only; no code changes were warranted).

## Self-Check: PASSED

- **Files created:** none (modified existing files)
- **Files modified — verified present:**
  - `packages/core/src/config/schema-streaming.ts` — FOUND, contains 3 new fields ✓
  - `packages/orchestrator/src/execution/execution-pipeline.ts` — FOUND, contains 2 `PerChannelStreamingConfigSchema.parse({})` code call sites and 0 inline `100,|3,|60000,` literals ✓
  - `packages/orchestrator/src/execution/execution-pipeline.test.ts` — FOUND, contains 11 new test cases in CRIT-05 describe block ✓
  - `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` — FOUND, includes 3 new field entries ✓
- **Commits exist:** `d99f9ad4`, `c4a083ea`, `e9f1c017` all FOUND in `git log --oneline 1785551f..HEAD` ✓
- **All 54 execution-pipeline tests pass** ✓
- **All 1026 core config tests pass** ✓
- **No new circular dependencies (`pnpm cycles` exit 0)** ✓
- **No new security lint errors (`pnpm lint:security` exit 0)** ✓
