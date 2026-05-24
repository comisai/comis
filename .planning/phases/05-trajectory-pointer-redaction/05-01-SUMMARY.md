---
phase: 05-trajectory-pointer-redaction
plan: 01
subsystem: observability
tags: [trajectory, pointer-file, config, env-layer, tdd, zod]

requires:
  - phase: 04-trajectory-bundle-export
    provides: trajectory bundle pipeline + pointer-file writer implementation

provides:
  - POINTER-01 acceptance tests: 8 it() blocks covering shape, mode, suffix pin, symlink-noop, truncation, writer/reader symmetry
  - POINTER-02 schema: observability.trajectory.dirOverride?: string in ObservabilityConfigSchema (strictObject)
  - POINTER-02 env-layer: COMIS_TRAJECTORY_DIR -> observability.trajectory.dirOverride projection in buildGatewayEnvLayer
  - POINTER-02 daemon wiring: diagnostics.trajectory.dir ?? observability.trajectory.dirOverride precedence in recorder wiring

affects: [05-02, 05-03, 05-04, daemon-wiring, env-layer, config-schema]

tech-stack:
  added: []
  patterns:
    - "Env-layer projection: extend GatewayEnvSource + buildGatewayEnvLayer to add new env vars; return merged observability/gateway blocks"
    - "Schema extension pattern: add strictObject sub-schema + wire into parent with .default(() => SubSchema.parse({}))"
    - "Daemon precedence chain: diagnostics.trajectory.dir ?? observability.trajectory.dirOverride for trajectory directory"

key-files:
  created:
    - .planning/phases/05-trajectory-pointer-redaction/05-01-SUMMARY.md
  modified:
    - packages/observability/src/trajectory/pointer-file.test.ts
    - packages/core/src/config/schema-observability.ts
    - packages/core/src/config/schema-observability.test.ts
    - packages/core/src/config/env-layer.ts
    - packages/core/src/config/env-layer.test.ts
    - packages/core/src/config/index.ts
    - packages/core/src/config/types.ts
    - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap
    - packages/daemon/src/wiring/setup-agents/setup-agents-runtime.ts

key-decisions:
  - "Keep .trajectory-path.json suffix (not .trajectory-pointer.json) — writer+reader pair already consistent; renaming is churn"
  - "TrajectoryObservabilityConfigSchema uses strictObject (not z.object) to match existing schema-observability.ts pattern"
  - "paths.ts:readEnvDir() direct env read stays as defense-in-depth; env-layer projection adds comis config get visibility"
  - "Daemon wiring: diagnostics.trajectory.dir takes precedence (operator-visible YAML); observability.trajectory.dirOverride is the env-driven fallback"

patterns-established:
  - "Env-layer projection: add field to GatewayEnvSource + handle in buildGatewayEnvLayer, return merged layer with spread"
  - "Config sub-schema: define strictObject schema above root schema, wire with .default(() => SubSchema.parse({}))"

requirements-completed:
  - POINTER-01
  - POINTER-02

duration: 11min
completed: 2026-05-25
---

# Phase 05 Plan 01: POINTER-01/02 Verification + Schema/Env/Wiring Summary

**Trajectory pointer-file acceptance tests (8 cases) + observability.trajectory.dirOverride schema/env-layer/daemon wiring enabling COMIS_TRAJECTORY_DIR to relocate runtime trajectory files**

## Performance

- **Duration:** 11 min
- **Started:** 2026-05-25T02:23:19Z
- **Completed:** 2026-05-25T02:34:59Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- POINTER-01: Added suffix pin (`suffix_is_trajectory_path_json`) and writer/reader symmetry (`writer_reader_symmetry`) tests to `pointer-file.test.ts` — total 8 acceptance dimensions covered
- POINTER-02 schema: Added `TrajectoryObservabilityConfigSchema` (strictObject with optional `dirOverride`) wired into `ObservabilityConfigSchema` with back-compat default `{}`; exported `TrajectoryObservabilityConfig` type
- POINTER-02 env-layer: Extended `GatewayEnvSource` with `COMIS_TRAJECTORY_DIR` and `buildGatewayEnvLayer` to project it to `observability.trajectory.dirOverride`; merged return handles gateway + observability blocks together
- POINTER-02 daemon wiring: `setup-agents-runtime.ts` now reads `diagnostics.trajectory.dir ?? observability.trajectory.dirOverride` for the recorder's effective trajectory directory

## Task Commits

1. **Task 1: POINTER-01 verification tests** - `83bcd3f` (test)
2. **RED #1 schema tests** - `9e48251` (test)
3. **GREEN #1 schema production** - `b1f5fdd` (feat)
4. **RED #2 env-layer tests** - `b35a360` (test)
5. **GREEN #2 env-layer production** - `fca4d8f` (feat)
6. **GREEN #3 daemon wiring** - `7f9d62c` (feat)

_TDD: 3 RED commits + 3 GREEN commits landed in RED-then-GREEN order per AGENTS.md §2.10_

## Files Created/Modified

- `packages/observability/src/trajectory/pointer-file.test.ts` - Added suffix pin + writer/reader symmetry tests; imported `resolveTrajectoryPointerFilePath` from `./paths.js`
- `packages/core/src/config/schema-observability.ts` - Added `TrajectoryObservabilityConfigSchema`, wired `trajectory` field into `ObservabilityConfigSchema`, exported `TrajectoryObservabilityConfig`
- `packages/core/src/config/schema-observability.test.ts` - Added 3 RED tests for dirOverride acceptance, strict rejection, back-compat default
- `packages/core/src/config/env-layer.ts` - Extended `GatewayEnvSource` + `buildGatewayEnvLayer` with `COMIS_TRAJECTORY_DIR` projection
- `packages/core/src/config/env-layer.test.ts` - Added 3 RED tests for COMIS_TRAJECTORY_DIR projection, empty drop, combined keys
- `packages/core/src/config/index.ts` - Added `TrajectoryObservabilityConfig` to type exports
- `packages/core/src/config/types.ts` - Added `TrajectoryObservabilityConfig` to type re-exports
- `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` - Updated to include new `trajectory` field in observability schema snapshot
- `packages/daemon/src/wiring/setup-agents/setup-agents-runtime.ts` - Daemon recorder wiring reads `diagnostics.trajectory.dir ?? observability.trajectory.dirOverride`

## Decisions Made

- Kept `.trajectory-path.json` suffix (not `.trajectory-pointer.json`) — writer and reader pair were already consistent on this suffix; the wire-level contract is the `traceSchema: "comis-trajectory-pointer"` literal in the body, not the filename
- `paths.ts:readEnvDir()` direct env read stays in place — it provides defense-in-depth so the recorder resolves `COMIS_TRAJECTORY_DIR` even when the daemon composition path is bypassed in tests
- The env-layer projection adds `comis config get observability.trajectory.dirOverride` visibility without changing the defense-in-depth fallback semantics
- Section-registry-parity snapshots updated (Rule 1 auto-fix) — new `trajectory` field legitimately changes schema metadata output

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated section-registry-parity snapshots after schema extension**
- **Found during:** Task 2 GREEN #1 (schema production code)
- **Issue:** Adding `trajectory` field to `ObservabilityConfigSchema` changed the full schema JSON and field-metadata flat array; 2 snapshot tests failed
- **Fix:** Ran `pnpm vitest run ... -u` to regenerate the snapshots with the new trajectory field included
- **Files modified:** `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap`
- **Verification:** All 1023 core config tests pass after snapshot update
- **Committed in:** `b1f5fdd` (GREEN #1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — snapshot update required by legitimate schema change)
**Impact on plan:** Auto-fix necessary for correctness. No scope creep.

## Issues Encountered

None — plan executed cleanly. The snapshot update was the only extra step.

## Known Stubs

None — all wiring is fully connected end-to-end.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns introduced beyond what the plan's threat model covers.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- POINTER-01 acceptance dimensions fully verified (8 tests)
- POINTER-02 schema + env-layer + daemon wiring complete; `comis config get observability.trajectory.dirOverride` returns the configured value
- Ready for 05-02 (bundle exporter reads pointer to locate relocated runtime file)

---
*Phase: 05-trajectory-pointer-redaction*
*Completed: 2026-05-25*

## Self-Check: PASSED

All key files exist. All 6 task commits verified in git log.
