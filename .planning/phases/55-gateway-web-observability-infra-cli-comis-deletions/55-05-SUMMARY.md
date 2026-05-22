---
phase: 55-gateway-web-observability-infra-cli-comis-deletions
plan: 05
subsystem: observability
tags: [observability, config-audit, event-bus, dup-cons, bc-rem, event-clean, tdd]
requires: []
provides: [serialization-sentinel.ts]
affects: [packages/observability/src/config-audit, packages/observability/src/index.ts, packages/comis/src, packages/core/src/event-bus]
tech_stack:
  added: []
  patterns: [single-purpose-helper-extraction, tdd-red-then-green, atomic-3-commit-split]
key_files:
  created:
    - packages/observability/src/config-audit/serialization-sentinel.ts
    - packages/observability/src/config-audit/serialization-sentinel.test.ts
  modified:
    - packages/observability/src/config-audit/append.ts
    - packages/observability/src/config-audit/scrub.ts
    - packages/observability/src/config-audit/scrub.test.ts
    - packages/observability/src/config-audit/append-observe.ts
    - packages/observability/src/index.ts
    - packages/comis/src/observability.test.ts
    - packages/comis/src/index.test.ts
    - packages/core/src/event-bus/events-infra.ts
decisions:
  - "Sentinel extracted via TDD RED-then-GREEN cycle: failing test commit first, then module-creation commit."
  - "migrateRecordShape (pre-260519-rrm shape reader) deleted UNCONDITIONALLY per user no-BC policy — no migration script, no deferral. Two schema-migration tests in scrub.test.ts that asserted phase->event / nested-stat->flat / tsMs-drop migration deleted alongside the function they tested."
  - "stableStringify barrel re-export from @comis/observability dropped; canonical impl in shared/stable-stringify.js preserved (intra-package consumers still import directly)."
  - "Mirror-test sentinel switched from stableStringify to sanitizeForPersistence per RESEARCH Open Q #4 (longest known dependency chain — least drift risk)."
  - "Final commit (07da27ee) deletes the secret:modified event declaration and intentionally leaves pnpm validate RED — Plan 55-06 (Wave 2) closes the loop by deleting the 3 consumers in gateway SSE allowlist, web event-name list, and security view handler block."
metrics:
  duration_minutes: 16
  commits: 5
  files_touched: 10
  insertions: 66
  deletions: 243
  net_loc: -177
  completed_date: 2026-05-22
---

# Phase 55 Plan 05: Observability + secret:modified declaration consolidation Summary

Single-purpose `emitSerializationErrorSentinel` extracted to a new module via TDD, three byte-identical local copies deleted across `append.ts`/`scrub.ts`/`append-observe.ts`, `migrateRecordShape` (pre-260519-rrm legacy reader) deleted unconditionally, `stableStringify` barrel re-export dropped while preserving the canonical implementation, mirror tests switched to a longer-dependency-chain sentinel, and the `secret:modified` event declaration removed from `InfraEvents` (build-breaking until Plan 55-06 lands consumers).

## Commits

| # | Commit | Title |
|---|--------|-------|
| 1 | `7a848ca9` | test(55-05): add RED test for emitSerializationErrorSentinel (DUP-CONS-11) |
| 2 | `4455b45b` | feat(55-05): extract emitSerializationErrorSentinel to single home (GREEN) (DUP-CONS-11 a) |
| 3 | `90636c31` | refactor(55-05): retarget 3 sentinel callers + delete migrateRecordShape (DUP-CONS-11 b, BC-REM-03) |
| 4 | `fad8ce0d` | refactor(55-05): drop stableStringify barrel re-export; switch mirror-test sentinel to sanitizeForPersistence (DUP-CONS-10) |
| 5 | `07da27ee` | refactor(55-05): delete secret:modified event declaration in events-infra.ts (EVENT-CLEAN-02 declaration side) |

## Requirements Closed

- **DUP-CONS-10** — `stableStringify` barrel re-export dropped; canonical impl preserved at `packages/observability/src/shared/stable-stringify.js`.
- **DUP-CONS-11** — `emitSerializationErrorSentinel` consolidated to single home `packages/observability/src/config-audit/serialization-sentinel.ts`; 3 copies (one named function in `append.ts`, one named function in `scrub.ts`, one inline anonymous block in `append-observe.ts:259-275`) deleted.
- **BC-REM-03** — `migrateRecordShape` (pre-260519-rrm shape reader) deleted unconditionally per no-BC policy; `reEncodeRecord` simplified to pass parsed records through without shape migration.
- **EVENT-CLEAN-02 (declaration side)** — `secret:modified` removed from `InfraEvents` in `packages/core/src/event-bus/events-infra.ts` (consumer side closed in Plan 55-06).

## What Changed

### Task 1: TDD — Extract `serialization-sentinel.ts` (RED -> GREEN)

**RED commit (`7a848ca9`):** Created `packages/observability/src/config-audit/serialization-sentinel.test.ts` with three assertions before the module existed:
- Newline-terminated string
- Parses to canonical sentinel shape `{traceSchema, schemaVersion, __serializationError, ts}`
- `ts` matches ISO-8601 pattern `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`

Test failed with `Cannot find module './serialization-sentinel.js'` as required.

**GREEN commit (`4455b45b`):** Created `packages/observability/src/config-audit/serialization-sentinel.ts` (23 LOC, SPDX header + JSDoc + single `import { systemDateFrom, systemNowMs } from "@comis/core"` + the function). Test passes: 3/3.

### Task 2 Commit A (`90636c31`): Retarget callers + delete migrateRecordShape

| File | Action |
|------|--------|
| `packages/observability/src/config-audit/append.ts` | Added `import { emitSerializationErrorSentinel } from "./serialization-sentinel.js"`; deleted the 26-line local `function emitSerializationErrorSentinel()` (lines 420-446); call site at `:478` (now `:451` after deletion) unchanged. |
| `packages/observability/src/config-audit/scrub.ts` | Same import; deleted local `emitSerializationErrorSentinel` (12 LOC) AND `migrateRecordShape` (60 LOC); simplified `reEncodeRecord` to skip the migrator (pass parsed graph straight through); removed now-unused `import { systemDateFrom, systemNowMs } from "@comis/core"`. |
| `packages/observability/src/config-audit/append-observe.ts` | Same import; deleted the 17-line inline anonymous sentinel block inside `encodeObserveRecord` (lines 259-275); replaced with single-line `return emitSerializationErrorSentinel()`. `systemDateFrom`/`systemNowMs` import preserved (still used in `createConfigObserveAuditRecord`). |
| `packages/observability/src/config-audit/scrub.test.ts` | Deleted the entire `describe("scrubConfigAuditLog — schema migration (design §9.2)", ...)` block (~85 LOC) containing two tests that asserted `migrateRecordShape`'s phase->event / nested-stat->flat / tsMs-drop behavior. Tests deleted alongside the function they tested (per plan task 2 step 5). |

Verification: 4 config-audit test files / 37 tests pass.

### Task 2 Commit B (`fad8ce0d`): Drop stableStringify barrel + switch mirror sentinels

| File | Action |
|------|--------|
| `packages/observability/src/index.ts:56` | Deleted `export { stableStringify } from "./shared/stable-stringify.js"`. Canonical impl unchanged. |
| `packages/comis/src/observability.test.ts` | Switched all 3 sentinel references from `stableStringify` -> `sanitizeForPersistence` (description JSDoc + "exposes ... as a function" test + identity-equal test). |
| `packages/comis/src/index.test.ts:119-127` | Same switch on the umbrella namespace identity test. |

Verification: `pnpm vitest run packages/comis/src/observability.test.ts packages/comis/src/index.test.ts` -> 17/17 pass.

### Task 2 Commit C (`07da27ee`): Delete secret:modified event declaration

| File | Action |
|------|--------|
| `packages/core/src/event-bus/events-infra.ts:535-540` | Deleted the entire `"secret:modified"` entry from `InfraEvents` (7 lines including the leading `/** Secret lifecycle event (CRUD operations) */` comment + the trailing blank line). |

**Expected RED state introduced.** Three consumers reference the now-gone event-name in typed allowlists / handler maps and the build fails at:
- `packages/gateway/src/web/sse-endpoint.ts:62` — error TS2322: `Type '"secret:modified"' is not assignable to type 'keyof EventMap'`
- `packages/web/src/api/types/common-types.ts:70` — same allowlist type failure
- `packages/web/src/views/security.ts:434-447` — handler-map entry references the same now-gone discriminant

This is documented build-breaking behavior per the plan's task 2 step 4: "The build IS expected to break at this point. Plan 55-06 (which depends_on 55-05) deletes the consumers. The TWO plans together restore green."

`--no-verify` was used on commit C because the pre-commit hook runs `pnpm validate`, which would fail on the gateway/web errors. The orchestrator's `<parallel_execution>` block explicitly authorized this: *"DO commit your tasks atomically as planned... DO write SUMMARY.md noting this expected red state and that 55.06 will close it. Do NOT skip the declaration delete just because pnpm validate fails — Wave 2 closes the loop."*

## Verification

| Acceptance | Result |
|-----------|--------|
| `grep -rn 'function emitSerializationErrorSentinel' packages/observability/src --include='*.ts'` returns 1 | OK only `serialization-sentinel.ts` |
| `grep -rn 'migrateRecordShape' packages/observability/src --include='*.ts'` returns 0 | OK |
| `grep -n 'from "./serialization-sentinel' packages/observability/src/config-audit/append.ts` returns 1 | OK |
| `grep -n 'from "./serialization-sentinel' packages/observability/src/config-audit/scrub.ts` returns 1 | OK |
| `grep -n 'from "./serialization-sentinel' packages/observability/src/config-audit/append-observe.ts` returns 1 | OK |
| `grep -n 'stableStringify' packages/observability/src/index.ts` returns 0 | OK |
| `grep -n 'sanitizeForPersistence' packages/comis/src/observability.test.ts` returns >=1 | OK 6 |
| `grep -n '"secret:modified"' packages/core/src/event-bus/events-infra.ts` returns 0 | OK |
| `pnpm vitest run packages/observability` exits 0 | OK 40 files / 501 tests pass |
| `pnpm build --filter @comis/observability` exits 0 | OK |
| `pnpm validate` exits 0 (full repo) | EXPECTED RED — Plan 55-06 closes |

## Expected Red State (closed by Plan 55-06)

After commit C (`07da27ee`), `pnpm build` fails on:
- `packages/gateway/src/web/sse-endpoint.ts:62` — `"secret:modified"` in `SSE_EVENT_TYPES` const readonly array
- `packages/web/src/api/types/common-types.ts:70` — `"secret:modified"` in web-side event-name allowlist
- `packages/web/src/views/security.ts:434-447` — `secret:modified` handler-map entry

Plan 55-06 deletes all three in a single atomic commit, restoring `pnpm validate` green. Sequencing in plan 55-06 frontmatter: `depends_on: [55-05]`.

## TDD Gate Compliance

Plan-level type is `tdd`. The gate sequence is satisfied:

1. RED gate — `test(55-05)` commit `7a848ca9` lands first; test fails with "Cannot find module" as required.
2. GREEN gate — `feat(55-05)` commit `4455b45b` lands the module; test passes 3/3.
3. REFACTOR gate — Not required for this plan (the GREEN module is the minimum implementation, no follow-up refactor needed). The downstream caller-retargets in commit `90636c31` are deduplication, not refactor-of-the-newly-extracted-module.

The fail-fast invariant held: test failed on the expected ENOENT (no false-positive pre-GREEN pass).

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Worktree Path Hazard (one Rule 3 fix, no impact on commits)

**1. [Rule 3 — Blocking] Wrote initial test file to wrong absolute path (#3099 path-safety)**
- **Found during:** Task 1 RED step
- **Issue:** First `Write` call used the canonical-repo path `/Users/mosheanconina/Projects/comisai/comis/packages/...` (a `pwd` echo derived from the conversation context) rather than the worktree path. File landed in the main repo, not the worktree.
- **Fix:** Detected via `git status --short` showing zero changes in worktree, confirmed via two `ls -la` calls comparing both paths. Removed the stray file from the main repo with `rm`, then re-wrote via the worktree-absolute path `/Users/mosheanconina/Projects/comisai/comis/.claude/worktrees/agent-a51c0406a33d33ce7/packages/...`.
- **Files modified:** None permanently (stray file deleted before any commit). All subsequent Write/Edit calls verified inside `git rev-parse --show-toplevel`.
- **Commit:** N/A (pre-commit cleanup).

### Other observations

- pnpm `--filter @comis/comis` does not match — the package's npm name is `comisai`, not `@comis/comis`. The filter `comisai` works. Used full `pnpm build` instead, which has the same effect.

## Authentication Gates

None.

## Key Decisions

1. **Used `--no-verify` on commit C (`07da27ee`).** The plan's task 2 step 4 and the orchestrator's `<parallel_execution>` block both explicitly anticipated this — the pre-commit hook chain (`pnpm validate`) will fail because gateway/web reference the now-gone event. Bypassing the hook is the documented, deliberate way to commit the build-breaking declaration delete. Plan 55-06 closes the loop.
2. **Deleted both `scrub.test.ts` schema-migration tests.** Per plan task 2 step 5 ("If any scrub.ts test asserts a pre-260519-rrm legacy record is migrated, DELETE the test"), the two tests inside `describe("scrubConfigAuditLog — schema migration (design §9.2)", ...)` (lines 181-265 in pre-edit file) tested the deleted `migrateRecordShape` function and were removed alongside it. The remaining scrub tests (idempotency, concurrent-append guard, malformed-line pass-through, atomic rename pattern, argv redaction, symlink-safe tmp-write, sentinel-on-BigInt) all still pass.
3. **Imports of `systemDateFrom`/`systemNowMs` from `@comis/core`:** kept in `append.ts` (still used at `:240` in `createConfigWriteAuditRecordBase`) and `append-observe.ts` (still used at `:192` in `createConfigObserveAuditRecord`). Removed from `scrub.ts` (only the deleted sentinel + the deleted `migrateRecordShape` used them).

## Self-Check

- Created files exist (verified by `ls -la`):
  - `packages/observability/src/config-audit/serialization-sentinel.ts` — FOUND
  - `packages/observability/src/config-audit/serialization-sentinel.test.ts` — FOUND
- All 5 commits exist on branch `worktree-agent-a51c0406a33d33ce7` (verified by `git log`):
  - `7a848ca9` — FOUND
  - `4455b45b` — FOUND
  - `90636c31` — FOUND
  - `fad8ce0d` — FOUND
  - `07da27ee` — FOUND
- Observability package self-tests green: 501/501 pass (verified by `pnpm vitest run packages/observability`)
- Expected red state on full `pnpm build` confirmed (gateway TS2322 on `sse-endpoint.ts:62`)

## Self-Check: PASSED

.planning/ is gitignored per project config — SUMMARY.md is force-added via `git add -f` per the established pattern set by `7a39189f docs(52-04)` and `53e0371f docs(52-03)`.
