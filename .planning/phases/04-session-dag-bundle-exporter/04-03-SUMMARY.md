---
phase: 04-session-dag-bundle-exporter
plan: "03"
subsystem: observability/trajectory
tags: [trajectory, bundle-exporter, tdd, file-split, architecture]
dependency_graph:
  requires:
    - 04-01 (buildTranscriptEvents, sortTrajectoryEvents, TrajectoryBundleManifest/Warning types)
    - 04-02 (readSessionBranch, ReadSessionBranchResult)
  provides:
    - exportTrajectoryBundle (BUNDLE-01/02/04 pipeline)
    - ExportTrajectoryBundleParams, ExportTrajectoryBundleError, ExportTrajectoryBundleSuccess
  affects:
    - packages/observability/src/index.ts (new public exports)
    - packages/observability/src/trajectory/export.test.ts (15 new test cases)
tech_stack:
  added: []
  patterns:
    - "file-split: bundle-exporter.ts extracted from export.ts to stay under 800-line cap"
    - "one-directional import: bundle-exporter.ts -> export.ts (no reverse; avoids circular)"
    - "fixed-point manifest self-size iteration"
    - "soft-fail JSONL reader (missing/corrupt runtime file emits warnings, never throws)"
    - "pointer-file resolution: <session>.trajectory-path.json checked before fallback"
key_files:
  created:
    - packages/observability/src/trajectory/bundle-exporter.ts
  modified:
    - packages/observability/src/trajectory/export.ts
    - packages/observability/src/trajectory/export.test.ts
    - packages/observability/src/index.ts
decisions:
  - "Extracted exportTrajectoryBundle into bundle-exporter.ts (691 lines) rather than adding to export.ts (now 529 lines) — both files stay under the 800-line architecture cap enforced by file-size.test.ts"
  - "index.ts exports Plan 03 symbols directly from ./trajectory/bundle-exporter.js to avoid export.ts -> bundle-exporter.ts -> export.ts circular dependency detected by madge"
  - "Output path drops redundant .comis/ from design §5 D5: <workspaceDir>/trace-exports/comis-trace-<sid8>-<ts>/ (not <workspaceDir>/.comis/trace-exports/...) since workspaceDir already ends in .comis/workspace"
  - "ensureContainedDir uses options-object signature { dir, mode } — plan pseudocode showed positional args; actual impl differs"
  - "systemDateFrom(ms) used for all ISO timestamps — new Date() prohibited by globals.test.ts architecture rule"
metrics:
  duration: "~24 hours (across two sessions)"
  completed: "2026-05-25"
  tasks_completed: 2
  files_created: 1
  files_modified: 3
---

# Phase 4 Plan 03: exportTrajectoryBundle Pipeline Summary

**One-liner:** 8-file trajectory bundle exporter with auto-populated manifest, soft-fail JSONL reader, pointer-file resolution, and 0o700 directory + 0o600 file mode enforcement.

## What Was Built

`exportTrajectoryBundle(params)` writes a self-contained 8-file directory under `<workspaceDir>/trace-exports/comis-trace-<sid8>-<ts>/`:

| File | Source |
|---|---|
| `manifest.json` | Auto-populated via fixed-point iteration (all 8 content entries with bytes) |
| `events.jsonl` | Runtime JSONL events + transcript events, merged via sortTrajectoryEvents |
| `session-branch.json` | Raw output of readSessionBranch ({header, leafId, branchEntries}) |
| `metadata.json` | Latest `trace.metadata` event payload; falls back to `{}` |
| `artifacts.json` | Latest `trace.artifacts` event payload; falls back to `{}` |
| `prompts.json` | Reconstructed from `trace.metadata.prompting` + `.skills`; falls back to `{}` |
| `system-prompt.txt` | Plain-text system prompt from `trace.metadata.prompting`; falls back to `""` |
| `tools.json` | Tool definitions from `tool.call` events, sorted+dedup'd by name, capped at 256 |

## Architecture: File Split

The 800-line cap (enforced by `architecture/file-size.test.ts`) required splitting:

- `export.ts` — Plans 01+02: types, constants, `buildTranscriptEvents`, `sortTrajectoryEvents`, `readSessionBranch` (529 lines)
- `bundle-exporter.ts` — Plan 03: `exportTrajectoryBundle` + 4 capture helpers (691 lines)

Import direction is one-way: `bundle-exporter.ts → export.ts`. No re-exports in `export.ts`. `index.ts` imports Plan 03 symbols directly from `bundle-exporter.js` to avoid a circular dependency that `madge` would detect.

## TDD Gate Compliance

| Gate | Commit | Description |
|---|---|---|
| RED | `accb736` | 15 failing tests for exportTrajectoryBundle (BUNDLE-01/02/04) |
| GREEN | `235d06d` | Implementation — all 37 tests pass (22 prior + 15 new) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `new Date()` replaced with `systemDateFrom()`**
- **Found during:** GREEN implementation
- **Issue:** `new Date(nowMs).toISOString()` triggered `architecture/globals.test.ts` which prohibits the `Date` global constructor
- **Fix:** Added `systemDateFrom` to the `@comis/core` import; replaced both `new Date(nowMs)` calls
- **Files modified:** `bundle-exporter.ts`
- **Commit:** `235d06d`

**2. [Rule 1 - Bug] `ensureContainedDir` positional-arg signature corrected to options-object**
- **Found during:** GREEN implementation
- **Issue:** Plan pseudocode showed `ensureContainedDir(workspaceDir, "trace-exports", { mode })` positional call; actual implementation requires `ensureContainedDir({ dir, mode })`
- **Fix:** Used options-object form; computed path manually via `safePath()` before calling the function (since `EnsureContainedDirSuccess` has no `dirPath` in its value, only `{ created: boolean }`)
- **Files modified:** `bundle-exporter.ts`
- **Commit:** `235d06d`

**3. [Rule 3 - Blocking] Circular dependency broken by removing re-exports**
- **Found during:** GREEN implementation (cycles test)
- **Issue:** When `export.ts` re-exported from `bundle-exporter.ts` while `bundle-exporter.ts` imported from `export.ts`, `madge` detected a cycle: `export.d.ts > bundle-exporter.d.ts`
- **Fix:** Removed re-exports from `export.ts`; updated `export.test.ts` and `index.ts` to import Plan 03 symbols from `bundle-exporter.js` directly
- **Files modified:** `export.ts`, `export.test.ts`, `index.ts`
- **Commit:** `235d06d`

**4. [Rule 3 - Blocking] File extracted into `bundle-exporter.ts` to satisfy 800-line cap**
- **Found during:** GREEN implementation (file-size test)
- **Issue:** Adding exportTrajectoryBundle to `export.ts` would grow it to 1156+ lines, exceeding the 800-line cap; adding to the allowlist is blocked by `allowlist-shrink.test.ts`
- **Fix:** Extracted all Plan 03 code into new `bundle-exporter.ts` (691 lines); `export.ts` remains at 529 lines
- **Files modified:** new `bundle-exporter.ts`; `export.ts` kept at 529 lines
- **Commit:** `235d06d`

### Design Deviations (Documented per Plan)

**D5: Output path drops redundant `.comis/`**

Design §5 D5 showed `<workspaceDir>/.comis/trace-exports/...`. Since `<workspaceDir>` typically ends in `.comis/workspace`, an additional `.comis/` would produce `.comis/workspace/.comis/trace-exports/` — an unusual nested pattern. Plan 03 explicitly drops it: the actual output is `<workspaceDir>/trace-exports/comis-trace-<sid8>-<ts>/`.

**Privacy Warning (Design §8.5)**

`session-branch.json` is written with raw content (PII present). Redaction is Phase 5 D9 — out of scope here. The module docstring in `bundle-exporter.ts` documents this explicitly.

**WR-01 sessionStateProvider fold — deferred to Phase 5**

Per research §6: `sessionStateProvider` is wired-undefined in production; folding requires inverting executor↔session-manager construction order. Bundle exporter reads `trace.metadata`/`trace.artifacts` events directly from the runtime trajectory JSONL. Deferred.

## Test Coverage

37 total tests in `export.test.ts` after this plan (22 prior + 15 new):

New cases cover:
- Exact 8-file output names
- Bundle directory mode 0o700, file mode 0o600
- Manifest shape (traceSchema, schemaVersion, generatedAt, eventCount, contents array)
- events.jsonl sort order (runtime events before transcript events at same ts)
- Round-trip: fixture SDK session + 5 runtime events → events.jsonl reconstructs timeline
- session-branch.json, metadata.json, artifacts.json, prompts.json, system-prompt.txt, tools.json (dedup+sort)
- 50MB refuse guard
- Corrupt JSONL emits warning but succeeds
- Missing runtime file (no trajectory file) — soft-fail
- Pointer file precedence: `<session>.trajectory-path.json` used over direct fallback

## Self-Check: PASSED

Files exist:
- FOUND: `packages/observability/src/trajectory/bundle-exporter.ts`
- FOUND: `packages/observability/src/trajectory/export.ts` (modified)
- FOUND: `packages/observability/src/trajectory/export.test.ts` (modified)
- FOUND: `packages/observability/src/index.ts` (modified)

Commits exist:
- RED: `accb736` — test(observability): add failing tests for exportTrajectoryBundle
- GREEN: `235d06d` — feat(observability): exportTrajectoryBundle pipeline
