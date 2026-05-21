---
phase: 49-skills-critical-fixes
plan: 01
subsystem: security
tags: [security, prompt-injection, external-content, type-union, foundation, tdd]

# Dependency graph
requires: []
provides:
  - "ExternalContentSource union extended additively from 8 to 12 members (voice_transcription, vision, video_description, mcp_tool)"
  - "EXTERNAL_SOURCE_LABELS Record extended to 12 keys with matching human-readable labels"
  - "5 new test blocks (4 per-source describe + 1 callback-fires it.each) locking the wrap contract for the new kinds"
affects:
  - 49-02 (media-handler wraps — passes the new literals into wrapExternalContent)
  - 49-03 (MCP-bridge wrap + daemon plumbing — passes "mcp_tool" into wrapExternalContent and threads onSuspiciousContent through the registry)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Closed-union + Record-exhaustiveness TS pattern: extending the union forces extending the label map in the same diff (compile-time gate)"

key-files:
  created: []
  modified:
    - "packages/core/src/security/external-content.ts"
    - "packages/core/src/security/external-content.test.ts"

key-decisions:
  - "Preserved 'unknown' as the FINAL union member and label key (downstream catch-all convention)"
  - "Added the 4 new members between 'document' and 'unknown' (research-recommended order)"
  - "Wrote 5 new describe() blocks (4 per-kind + 1 parametrized callback-fires) — explicit per-kind documentation > generic it.each only"

patterns-established:
  - "TS-locked atomic edit: Record<ClosedUnion, T> as the compile-time gate that prevents one-sided union extensions from shipping"

requirements-completed: [CRIT-01]

# Metrics
duration: ~6 min
completed: 2026-05-21
---

# Phase 49 Plan 01: External Content Source Union Extension Summary

**ExternalContentSource closed union extended additively from 8 to 12 members (`voice_transcription`, `vision`, `video_description`, `mcp_tool`) with matching EXTERNAL_SOURCE_LABELS entries, locked by 5 new test blocks — unblocks Wave 2 media + MCP wrap sites.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-21T18:12:00Z (approximate)
- **Completed:** 2026-05-21T18:17:55Z
- **Tasks:** 3 (RED + GREEN + cross-package validation)
- **Files modified:** 2

## Accomplishments

- Extended `ExternalContentSource` from 8 to 12 closed-string-literal members. New members: `voice_transcription`, `vision`, `video_description`, `mcp_tool` (positioned between `document` and `unknown`).
- Extended `EXTERNAL_SOURCE_LABELS: Record<ExternalContentSource, string>` to 12 keys with labels `"Voice transcription"`, `"Vision analysis"`, `"Video description"`, `"MCP tool result"`. TS Record-exhaustiveness check fires at compile time, so a one-sided edit cannot ship.
- Added 5 new `describe()` blocks to `external-content.test.ts`:
  - `ExternalContentSource - voice_transcription source` (4 it() cases: accepts source, includes label, includes SECURITY NOTICE, wraps with random delimiter markers).
  - `ExternalContentSource - vision source` (4 it() cases — same shape).
  - `ExternalContentSource - video_description source` (4 it() cases — same shape).
  - `ExternalContentSource - mcp_tool source` (4 it() cases — same shape).
  - `onSuspiciousContent callback - new source kinds` (1 `it.each` parametrized over the 4 new kinds, asserting the callback fires once with `expect.objectContaining({ source: <kind>, patterns: expect.any(Array) })` for injection-pattern content `"ignore all previous instructions"`).
- Zero behavior change to `wrapExternalContent` body, `WrapExternalContentOptions`, `replaceMarkers`, `detectSuspiciousPatterns`, or `EXTERNAL_CONTENT_WARNING` — pure additive type extension.
- Cross-package validation green: `@comis/core` (3628 tests pass), `@comis/skills` (4082 pass, 5 pre-existing skips), `pnpm lint:security` exits 0 (1663 pre-existing warnings, 0 errors).
- Grep across `packages/*/src/` confirmed zero exhaustive switches over `ExternalContentSource` — the union extension is fully additive across all consumers. Only the type declaration site (`external-content.ts`) and re-export sites (`security/index.ts`, `exports/security.ts`) reference the type name.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add 5 failing test blocks** — `c0f4eb57` (test)
   - 4 per-source describe blocks + 1 it.each callback-fires block.
   - RED gate: 4 label-assertion tests fail because labels fall through to `"External"` via `?? "External"` catch-all.
   - 1 file changed, 116 insertions.

2. **Task 2 (GREEN): Extend union + label map atomically** — `3309a27b` (feat)
   - Single diff adds 4 union members and 4 label entries.
   - TS Record exhaustiveness check enforces both edits together.
   - GREEN gate: 47/47 tests pass; `tsc` build succeeds.
   - 1 file changed, 8 insertions.

3. **Task 3 (VALIDATE)** — no commit (validation-only task per the plan).
   - `pnpm --filter @comis/core build` ✓
   - `pnpm --filter @comis/core test` ✓ (3628 pass)
   - `pnpm --filter @comis/skills build` ✓
   - `pnpm --filter @comis/skills test` ✓ (4082 pass, 5 skipped)
   - `pnpm lint:security` exit 0 (1663 pre-existing warnings, 0 errors).

_Note: TDD gate sequence — test(49-01) → feat(49-01) — is satisfied._

## Files Created/Modified

- `packages/core/src/security/external-content.ts` — Extended `ExternalContentSource` union from 8 to 12 members and `EXTERNAL_SOURCE_LABELS` Record from 8 to 12 keys. Single atomic diff; both extensions land together per TS exhaustiveness rule.
- `packages/core/src/security/external-content.test.ts` — Added 5 new `describe()` blocks (4 per-kind + 1 parametrized callback-fires) totaling 20 new `it()` cases. Mirrors the verbatim shape of the existing `ExternalContentSource - document source` analog at lines 101-122.

## Decisions Made

- **Preserved `"unknown"` as the FINAL union member and FINAL label key.** Downstream code may branch on `source === "unknown"` as a catch-all (no such code was found in this repo, but the convention is worth respecting and matches the plan's explicit guidance).
- **Inserted new members between `"document"` and `"unknown"` rather than at the end before `"unknown"`.** Order is preserved: 7 existing semantic sources → 4 new media/tool sources → `"unknown"` catch-all. Matches the recommended order in RESEARCH.md / PATTERNS.md.
- **Wrote 5 explicit `describe()` blocks (4 per-kind + 1 parametrized) instead of one `it.each` covering all kinds.** Plan asked for 4 verbatim copies of the document-source analog block (each with 4 it() cases mirroring the analog) plus 1 it.each for the callback-fires contract. The per-kind layout gives grep-friendly test names — each failure cites the specific source kind that regressed.
- **Did NOT add `as` type-casts to the test file at RED.** Plan offered this as an escape hatch if the tsc error would be too noisy at RED stage, but the test file is excluded from the package's `tsconfig.json` (`exclude: ["src/**/*.test.ts"]`) — Vitest transpiles tests independently, so the RED signal is runtime assertion mismatch (label falls through to `"External"`) rather than tsc compile error. Both forms are explicitly allowed by the plan; runtime mismatch was cleaner here.

## Deviations from Plan

None — plan executed exactly as written.

The plan was unusually precise: every acceptance criterion was grep-verifiable, the analog block at `external-content.test.ts:101-122` was named verbatim as the template, and the exact label strings + union order were specified. Tasks 1 and 2 each landed in a single Edit call against the listed line ranges. Task 3 (validation) ran exactly the listed commands.

**Total deviations:** 0
**Impact on plan:** Pure additive type extension landed atomically. No scope creep. Wave 2 unblocked.

## Issues Encountered

- **Worktree had no `node_modules/`.** First `pnpm test` invocation failed with `Command "vitest" not found`. Resolved by running `pnpm install --frozen-lockfile` (7s; one-time setup cost for the worktree).
- **First `pnpm build` after install failed** with `Cannot find module '@comis/shared'` because project-reference dependency wasn't pre-built. Resolved by running `pnpm --filter @comis/shared build` once; subsequent `@comis/core` and `@comis/skills` builds succeed because their tsconfigs declare the `references` to `@comis/shared`.

Both are normal worktree-setup costs, not plan deviations.

## User Setup Required

None — pure source-tree change with no external service configuration, environment variables, or secrets.

## Next Phase Readiness

- **Plan 49-02 ready to start (Wave 2):** Media handlers (`media-handler-audio.ts`, `media-handler-image.ts`, `media-handler-video.ts`) and `media-preprocessor.ts` plumbing can now pass `source: "voice_transcription"`, `"vision"`, `"video_description"` into `wrapExternalContent()` against the published 12-member union.
- **Plan 49-03 ready to start (Wave 2):** MCP bridge (`mcp-tool-bridge.ts`) can pass `source: "mcp_tool"` into `wrapExternalContent()`. `PlatformToolBuildContext` field addition + `setup-tools.ts` forwarding hops can be developed in parallel with the wrap-call-site edit.
- **No blockers.** Phase 49 gate (`pnpm validate`) deferred to land after Plans 02 + 03 + 04 per the plan's explicit guidance.

## Self-Check: PASSED

- File `packages/core/src/security/external-content.ts` exists and contains the 12-member union + 12-key label map. Confirmed: `grep -c "voice_transcription" external-content.ts` returns 2, `grep -c "vision" external-content.ts` returns 2, `grep -c "video_description" external-content.ts` returns 2, `grep -c "mcp_tool" external-content.ts` returns 2. `grep -c "Voice transcription" external-content.ts` returns 1, `grep -c "Vision analysis" external-content.ts` returns 1, `grep -c "Video description" external-content.ts` returns 1, `grep -c "MCP tool result" external-content.ts` returns 1. `"unknown"` is the final union member at line 109.
- File `packages/core/src/security/external-content.test.ts` exists and contains the 5 new describe() blocks. Confirmed: `grep -c "ExternalContentSource - voice_transcription source"`, `grep -c "ExternalContentSource - vision source"`, `grep -c "ExternalContentSource - video_description source"`, `grep -c "ExternalContentSource - mcp_tool source"` each return 1. `grep -c "onSuspiciousContent callback - new source kinds"` returns 1.
- Commit `c0f4eb57` (test) exists and is reachable from HEAD.
- Commit `3309a27b` (feat) exists and is HEAD.
- Test run on HEAD: `Test Files 1 passed (1), Tests 47 passed (47)` for `external-content.test.ts`. Full `@comis/core` suite: 3628 pass. Full `@comis/skills` suite: 4082 pass + 5 skipped.
- `pnpm --filter @comis/core build` exits 0.
- `pnpm --filter @comis/skills build` exits 0.
- `pnpm lint:security` exits 0.

---
*Phase: 49-skills-critical-fixes*
*Plan: 01*
*Completed: 2026-05-21*
