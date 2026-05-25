---
phase: 07-log-rotation-alert-budget
plan: 02
subsystem: observability
tags: [log-rotation, docs, ROTATE-03]

requires:
  - phase: 07-log-rotation-alert-budget
    plan: 01
    provides: "LogRotationConfigSchema + sweepRotatedFiles + pino-roll MB conversion"

provides:
  - "docs/operations/logging.mdx: observability.logRotation cross-stream policy section with 5 streams, YAML example, defaults table, storage budget, per-stream behavior, and backward-compat guidance"

affects:
  - operator-facing docs

tech-stack:
  added: []
  patterns:
    - "docs-only plan: TDD-exempt per AGENTS.md §2.10"

key-files:
  created: []
  modified:
    - docs/operations/logging.mdx

key-decisions:
  - "Kept legacy daemon.logging table intact and cross-referenced it from the new observability.logRotation section — operators who have not migrated still see their keys documented"
  - "Placed storage budget (1.25 GB worst-case → ~300 MB gzip) in a dedicated subsection after the defaults table so operators planning disk can find it immediately"

requirements-completed: [ROTATE-03]

duration: 9min
completed: 2026-05-25
---

# Phase 07 Plan 02: Rotation Docs (ROTATE-03) Summary

**Extended `docs/operations/logging.mdx` with the `observability.logRotation` cross-stream policy: 5 streams, copy-pasteable YAML, defaults table, `comis config get` example, 1.25 GB → ~300 MB storage budget, per-stream behavior, and backward-compat guidance for legacy `daemon.logging` knobs.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-05-25T04:52:57Z
- **Completed:** 2026-05-25T05:01:34Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Rewrote the `## Log Rotation` section of `docs/operations/logging.mdx` — now documents the `observability.logRotation` cross-stream policy end-to-end
- Lists all 5 rotation streams by exact filename: `daemon.log`, `cache-trace.jsonl`, `config-audit.jsonl`, `session-index.YYYY-MM-DD.jsonl`, `*.trajectory.jsonl`
- Copy-pasteable YAML example with all 4 schema fields at their canonical defaults (maxSizeBytes=52428800, maxFiles=5, maxAgeDays=30, compressAged=true)
- Defaults table aligned to Mintlify table syntax matching the rest of the file
- `comis config get observability.logRotation` verification example
- Storage budget calculation: 5 × 5 × 50 MB = 1.25 GB worst-case; ~300 MB with gzip
- Per-stream behavior paragraph for each of the 5 streams (rotation mechanism + startup sweep behavior)
- Backward compatibility subsection: legacy `daemon.logging.maxSize`/`maxFiles` documented as still-working with cross-reference and `<Info>` migration callout
- All 10 grep gates pass: ≥3 occurrences of `observability.logRotation`, `52428800`, `1.25 GB`, `300 MB`, all 5 stream filenames, all 4 schema field names

## Task Commits

1. **Task 1: Rewrite log rotation section** - `b188bc8` (docs)

## Files Modified

- `docs/operations/logging.mdx` — Log Rotation section expanded from 29 lines to ~115 lines covering full policy, 5 streams, YAML, defaults table, storage budget, per-stream detail, and backward compat

## Decisions Made

- Legacy `daemon.logging` table kept verbatim (not deleted) — only re-framed with a heading "Legacy `daemon.logging` Configuration" and a cross-reference link to the new section, satisfying the plan requirement that the legacy table remain intact
- Used Mintlify `<Info>` block for migration callout (matches existing doc conventions)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — docs-only plan, no code stubs.

## Threat Flags

None — doc cites only literal default values; no environment variables, secrets, or real paths beyond `~/.comis/`.

## Self-Check: PASSED

Files verified:
- docs/operations/logging.mdx: FOUND

Commits verified:
- b188bc8 (docs): FOUND

Grep gates:
- `observability.logRotation` occurrences: 8 (requirement: ≥3): PASS
- `52428800` present: PASS
- `1.25 GB` present: PASS
- `300 MB` present: PASS
- `session-index.YYYY-MM-DD.jsonl` present: PASS
- `*.trajectory.jsonl` present: PASS
- `cache-trace.jsonl` present: PASS
- `config-audit.jsonl` present: PASS
- `compressAged` present: PASS
- `maxAgeDays` present: PASS
