---
phase: 04-session-dag-bundle-exporter
plan: "01"
subsystem: observability/trajectory
tags:
  - trajectory
  - bundle-export
  - types
  - constants
  - pure-helpers
  - tdd
dependency_graph:
  requires:
    - "packages/observability/src/trajectory/types.ts (TrajectoryEvent, TrajectoryEventSource)"
  provides:
    - "TrajectoryBundleManifest (consumed by Plan 04-03 exportTrajectoryBundle)"
    - "TrajectoryBundleWarning (consumed by Plan 04-02 readSessionBranch, Plan 04-03)"
    - "buildTranscriptEvents (consumed by Plan 04-03)"
    - "sortTrajectoryEvents (consumed by Plan 04-03)"
    - "MAX_TRAJECTORY_* constants (consumed by Plans 04-02, 04-03)"
  affects:
    - "packages/observability/src/index.ts (barrel re-exports wired)"
    - "packages/observability/src/trajectory/types.ts (TRAJECTORY_EVENT_TYPES 44→45)"
tech_stack:
  added:
    - "packages/observability/src/trajectory/export.ts (new file)"
    - "packages/observability/src/trajectory/export.test.ts (new test file)"
  patterns:
    - "Pure helper functions (no I/O, no throws, total functions)"
    - "Closed-union type for warning codes (compile-time safety)"
    - "SOURCE_ORDER rank record for deterministic sort tiebreak"
    - "TDD RED→GREEN commit sequence per AGENTS.md §2.10"
key_files:
  created:
    - "packages/observability/src/trajectory/export.ts"
    - "packages/observability/src/trajectory/export.test.ts"
  modified:
    - "packages/observability/src/trajectory/types.ts"
    - "packages/observability/src/index.ts"
decisions:
  - "MAX_TRAJECTORY_SESSION_FILE_BYTES stored as 52_428_800 literal (not 50 * 1024 * 1024 expression) due to TypeScript restriction that as const cannot apply to arithmetic expressions"
  - "buildTranscriptEvents chains parentEntryId through synthesized predecessor (entries[i-1].id), not SDK raw parentId chain, so transcript DAG is self-contained within events.jsonl"
  - "session.transcript.entry added as single trajectory type for all SDK entry types; SDK entry type flows through data.entryType to avoid exploding closed union"
  - "sortTrajectoryEvents uses entryId as final lexicographic fallback for full determinism when (ts, source, sourceSeq) all match"
metrics:
  duration: "~8 minutes"
  completed_date: "2026-05-24"
  tasks_completed: 2
  files_changed: 4
---

# Phase 4 Plan 01: Bundle Foundations (Types + Constants + Helpers) Summary

Laid the complete type and pure-helper foundation for the BUNDLE-* family in `packages/observability/src/trajectory/export.ts`. Declared the manifest and warning types per design §6.2, the four hard-limit constants per design §5 D5, and two pure helpers (`buildTranscriptEvents`, `sortTrajectoryEvents`) for the exporter pipeline (Plan 04-03). RED tests pin the merge/tiebreak semantics deterministically.

## Files Created

### `packages/observability/src/trajectory/export.ts` (new)

Public surface (in declaration order):

| Symbol | Kind | Description |
|--------|------|-------------|
| `MAX_TRAJECTORY_RUNTIME_EVENTS` | `const` | 200_000 — runtime event cap |
| `MAX_TRAJECTORY_TOTAL_EVENTS` | `const` | 250_000 — total event cap |
| `MAX_TRAJECTORY_SESSION_FILE_BYTES` | `const` | 52_428_800 (50 MiB) — session file read cap |
| `MAX_TRAJECTORY_WARNING_ROWS` | `const` | 20 — rows-per-warning-code cap |
| `TrajectoryBundleWarning` | `interface` | 6-code closed union per design §6.2 |
| `TrajectoryBundleManifest` | `interface` | 14-field manifest per design §6.2 |
| `TranscriptEventBase` | `interface` | Envelope base for buildTranscriptEvents |
| `TranscriptSourceEntry` | `interface` | Structural SDK entry shape (no SDK type import) |
| `buildTranscriptEvents` | `function` | Synthesizes source:"transcript" events with chained parentEntryId |
| `sortTrajectoryEvents` | `function` | Non-mutating sort: ts → source-order → sourceSeq → entryId |

### `packages/observability/src/trajectory/export.test.ts` (new)

15 vitest cases in `describe("export.ts foundations (Plan 04-01)", ...)`:
1. MAX_TRAJECTORY_RUNTIME_EVENTS equals 200_000
2. MAX_TRAJECTORY_TOTAL_EVENTS equals 250_000
3. MAX_TRAJECTORY_SESSION_FILE_BYTES equals 50 * 1024 * 1024
4. MAX_TRAJECTORY_WARNING_ROWS equals 20
5. buildTranscriptEvents produces 1 event per entry with source:transcript
6. buildTranscriptEvents chains parentEntryId from synthesized predecessor
7. buildTranscriptEvents assigns 1-indexed sourceSeq in chronological order
8. buildTranscriptEvents uses SDK entry.timestamp as ts
9. buildTranscriptEvents sets entryId to entry.id (no new UUIDs)
10. sortTrajectoryEvents primary ts sort — ascending chronological order
11. sortTrajectoryEvents tiebreak source order — runtime before transcript
12. sortTrajectoryEvents tiebreak sourceSeq — ascending numeric, undefined sorts last
13. sortTrajectoryEvents is non-mutating — input array unchanged after sort
14. TrajectoryBundleManifest is structurally assignable to design §6.2 shape
15. TrajectoryBundleWarning code is a closed union — @ts-expect-error on invalid code

## Files Modified

### `packages/observability/src/trajectory/types.ts`

Appended `"session.transcript.entry"` to `TRAJECTORY_EVENT_TYPES` closed union. Union grows from 44 → 45 literals. This is a forward-compatible additive change per AGENTS.md §2.9. The architecture test `trajectory-event-types-known.test.ts` validates the union via `TRAJECTORY_EVENT_TYPES` — the new literal does not affect bridge-mapping coverage checks.

### `packages/observability/src/index.ts`

Added trajectory bundle export section after existing `buildTraceArtifacts` block at line 167. Re-exports:
- `buildTranscriptEvents`, `sortTrajectoryEvents` (named functions)
- `MAX_TRAJECTORY_RUNTIME_EVENTS`, `MAX_TRAJECTORY_TOTAL_EVENTS`, `MAX_TRAJECTORY_SESSION_FILE_BYTES`, `MAX_TRAJECTORY_WARNING_ROWS` (constants)
- `TrajectoryBundleManifest`, `TrajectoryBundleWarning`, `TranscriptEventBase`, `TranscriptSourceEntry` (types)

## session.transcript.entry Closed-Union Addition

`"session.transcript.entry"` is the single new `TrajectoryEventType` literal added in this plan. It is used by `buildTranscriptEvents` as the `type` field on all synthesized transcript events. The SDK SessionEntry.type value is preserved verbatim in `data.entryType` — downstream consumers can branch on `data.entryType` without needing more type literals.

Consumers that need to identify transcript events: `event.source === "transcript"` is sufficient (all transcript events use this source). The `type === "session.transcript.entry"` field is a secondary discriminator.

**Plans 04-02 and 04-03 consumers:** `readSessionBranch` (Plan 04-02) returns the entries array; `exportTrajectoryBundle` (Plan 04-03) calls `buildTranscriptEvents(branchEntries, base)` and `sortTrajectoryEvents([...runtimeEvents, ...transcriptEvents])`.

## TDD Gate Compliance

RED commit predates GREEN commit — confirmed:

| Gate | Commit | Message |
|------|--------|---------|
| RED | `5192c3f` | `test(observability): add failing tests for export.ts foundations (Phase 4 Plan 01)` |
| GREEN | `2f12eee` | `feat(observability): export.ts foundations — TrajectoryBundleManifest/Warning types, hard-limit constants, buildTranscriptEvents, sortTrajectoryEvents (Phase 4 Plan 01)` |

RED confirmed by `Cannot find module './export.js'` failure before export.ts was created.

## No Production Callers Yet

`buildTranscriptEvents` and `sortTrajectoryEvents` have no production callers in this plan. Plan 04-03 (`exportTrajectoryBundle`) wires them. This is by design — Plan 04-01 establishes the contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `as const` on arithmetic expression**
- **Found during:** Task 2 (GREEN), TypeScript build
- **Issue:** `50 * 1024 * 1024 as const` is invalid TypeScript — `as const` cannot be applied to an arithmetic expression (TS error 1355)
- **Fix:** Replaced with pre-computed literal `52_428_800 as const` with a comment citing the arithmetic formula. Value is mathematically identical (`50 * 1024 * 1024 = 52_428_800`). Tests remain green since `toBe(50 * 1024 * 1024)` evaluates to 52_428_800 at runtime.
- **Files modified:** `packages/observability/src/trajectory/export.ts` (line 53)
- **Commit:** Included in GREEN commit `2f12eee`

None other — plan executed as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries in this plan. `export.ts` contains only pure functions and type declarations — no I/O. The threat model in the plan (T-04-01-01 through T-04-01-03) is satisfied by the pure-function constraint; no new threat surface introduced.

## Self-Check: PASSED

- `packages/observability/src/trajectory/export.ts`: FOUND
- `packages/observability/src/trajectory/export.test.ts`: FOUND
- Commit `5192c3f` (RED): FOUND
- Commit `2f12eee` (GREEN): FOUND
- `session.transcript.entry` in types.ts: FOUND (line 151)
- `buildTranscriptEvents` re-export in index.ts: FOUND (line 174)
- All 4 constants in export.ts: FOUND (8 non-comment lines reference them)
- `pnpm build`: clean
- All 15 tests: passing
- `pnpm lint:security`: 0 errors (pre-existing warnings unchanged)
- `pnpm cycles`: no circular dependencies
