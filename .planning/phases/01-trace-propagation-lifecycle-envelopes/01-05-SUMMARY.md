---
phase: 01-trace-propagation-lifecycle-envelopes
plan: 05
subsystem: observability/agent
tags: [tdd, lifecycle-envelopes, LIFE-01, LIFE-02, trace.metadata, trace.artifacts, direct-emit]
dependency_graph:
  requires:
    - 01-01 (TRAJECTORY_EVENT_TYPES includes trace.metadata + trace.artifacts; DIRECT_EMIT carve-out)
  provides:
    - buildTraceMetadata(params): TraceMetadataPayload exported from @comis/observability (LIFE-01 payload)
    - buildTraceArtifacts(runState): TraceArtifactsPayload exported from @comis/observability (LIFE-02 payload)
    - trace.metadata emitted once per session after session.started (LIFE-01)
    - trace.artifacts emitted once per session before session.ended (LIFE-02)
    - SessionTrajectoryHandleRegistry.getRecorder() read accessor
    - ComisSessionManagerDeps.sessionStateProvider optional dep
  affects:
    - packages/observability/src/trajectory/metadata.ts
    - packages/observability/src/trajectory/artifacts.ts
    - packages/observability/src/trajectory/session-registry.ts
    - packages/agent/src/bridge/pi-event-bridge.ts
    - packages/agent/src/session/comis-session-manager.ts
    - packages/agent/src/executor/pi-executor/pi-executor.ts
tech_stack:
  added: []
  patterns:
    - Direct trajectory emit via recorder.recordEvent (no bus bridge) — DIRECT_EMIT pattern
    - compactObject helper omits undefined fields from payload subobjects
    - SessionStateProvider dep-injection for metric handoff across module boundaries
    - sanitizeForPersistence on config before writing to trajectory
key_files:
  created:
    - packages/observability/src/trajectory/metadata.ts
    - packages/observability/src/trajectory/metadata.test.ts
    - packages/observability/src/trajectory/artifacts.ts
    - packages/observability/src/trajectory/artifacts.test.ts
  modified:
    - packages/observability/src/trajectory/session-registry.ts
    - packages/observability/src/index.ts
    - packages/agent/src/bridge/pi-event-bridge.ts
    - packages/agent/src/bridge/pi-event-bridge.test.ts
    - packages/agent/src/session/comis-session-manager.ts
    - packages/agent/src/session/comis-session-manager.test.ts
    - packages/agent/src/executor/pi-executor/pi-executor.ts
decisions:
  - Canonical trace.metadata emit site is pi-event-bridge.ts (bridge), not pi-executor.ts — plan spec and CONTEXT.md §6 specify "agent executor emits via bridge" which is equivalent since the bridge is the pi-coding-agent event translator inside execute(). CONTEXT.md decision #6 wording noted.
  - sessionStateProvider for LIFE-02 is defined as optional dep on ComisSessionManagerDeps; fallback "destroyed" payload used when provider not registered. Full BridgeMetricsState handoff deferred to Phase 2 (LIFE-02 deferred metric wiring).
  - getRecorder() added to SessionTrajectoryHandleRegistry as a pure-read accessor returning TrajectoryRecorder | null | undefined — null for env-disabled entries, undefined for unknown keys.
  - runtimeSnapshot.harness.version uses "unknown" placeholder in executor wiring — deps.appVersion not in PiExecutorDeps; Phase 2 will thread the actual version constant.
  - PiEventBridgeDeps.runtimeSnapshot uses lazy import type for TraceMetadataParams to avoid circular dep.
metrics:
  duration: ~45 minutes
  completed: "2026-05-24"
  completed_tasks: 4
  files_changed: 11
---

# Phase 1 Plan 05: Lifecycle Envelope Emit Sites Summary

**One-liner:** Direct-emit lifecycle envelopes wired — trace.metadata emitted once per session after session:started via pi-event-bridge, trace.artifacts emitted once per session before session:ended via comis-session-manager, both using recorder.recordEvent (no bus bridge).

## Tasks Completed

### Task 1: buildTraceMetadata module + tests (LIFE-01 payload assembly)
**Status:** Complete (RED → GREEN)

**RED commit:** `c584b3d` — `test(observability): require buildTraceMetadata module + payload shape per design §5 D4 (LIFE-01)`
**GREEN commit:** `77b704d` — `feat(observability): add buildTraceMetadata module for trace.metadata lifecycle envelope (LIFE-01)`

**Verification:** 6/6 tests pass in `metadata.test.ts`. Exported from `@comis/observability`.

---

### Task 2: buildTraceArtifacts module + tests (LIFE-02 payload assembly)
**Status:** Complete (RED → GREEN)

**RED commit:** `87057fd` — `test(observability): require buildTraceArtifacts module + payload shape (LIFE-02)`
**GREEN commit:** `23ce4e0` — `feat(observability): add buildTraceArtifacts module for trace.artifacts lifecycle envelope (LIFE-02)`

**Verification:** 8/8 tests pass in `artifacts.test.ts`. Exported from `@comis/observability`.

---

### Task 3: Wire LIFE-01 emit site — pi-event-bridge.ts
**Status:** Complete (RED → GREEN → executor wiring)

**RED commit:** `45df5b8` — `test(agent): require pi-event-bridge to emit trace.metadata once per session after session:started (LIFE-01)`
**GREEN commit (bridge):** `7db9b8b` — `feat(agent): emit trace.metadata via recorder.recordEvent in pi-event-bridge (LIFE-01)`
**GREEN commit (executor wiring):** `efb63e9` — `feat(agent): thread runtimeSnapshot into pi-event-bridge for trace.metadata payload (LIFE-01)`

Changes:
- Added `getRecorder(formattedKey)` to `SessionTrajectoryHandleRegistry` interface and implementation
- Added `runtimeSnapshot?: TraceMetadataParams` to `PiEventBridgeDeps`
- Added LIFE-01 direct emit after `markSessionStarted` in `agent_start` case
- Threaded `runtimeSnapshot` from pi-executor at bridge-creation time

**Verification:** 223/223 tests pass in `pi-event-bridge.test.ts`.

---

### Task 4: Wire LIFE-02 emit site — comis-session-manager.ts
**Status:** Complete (RED → GREEN; executor sessionStateProvider deferred)

**RED commit:** `9162660` — `test(agent): require comis-session-manager to emit trace.artifacts before session:ended (LIFE-02)`
**GREEN commit:** `a16c38a` — `feat(agent): emit trace.artifacts via recorder before session:ended in destroySession (LIFE-02)`

Changes:
- Added `sessionStateProvider?: (sessionKey: string) => TraceArtifactsRunState | undefined` to `ComisSessionManagerDeps`
- Added LIFE-02 direct emit block before `eventBus.emit("session:ended", ...)` in `destroySession`
- Fallback "destroyed" payload used when no `sessionStateProvider` registered

**Verification:** 13/13 tests pass in `comis-session-manager.test.ts`.

---

## Commits (8 total)

| Hash | Message |
|------|---------|
| `c584b3d` | test(observability): require buildTraceMetadata module + payload shape per design §5 D4 (LIFE-01) |
| `77b704d` | feat(observability): add buildTraceMetadata module for trace.metadata lifecycle envelope (LIFE-01) |
| `87057fd` | test(observability): require buildTraceArtifacts module + payload shape (LIFE-02) |
| `23ce4e0` | feat(observability): add buildTraceArtifacts module for trace.artifacts lifecycle envelope (LIFE-02) |
| `45df5b8` | test(agent): require pi-event-bridge to emit trace.metadata once per session after session:started (LIFE-01) |
| `7db9b8b` | feat(agent): emit trace.metadata via recorder.recordEvent in pi-event-bridge (LIFE-01) |
| `efb63e9` | feat(agent): thread runtimeSnapshot into pi-event-bridge for trace.metadata payload (LIFE-01) |
| `9162660` | test(agent): require comis-session-manager to emit trace.artifacts before session:ended (LIFE-02) |
| `a16c38a` | feat(agent): emit trace.artifacts via recorder before session:ended in destroySession (LIFE-02) |

## Sample trajectory.jsonl lifecycle bracket

A well-formed trajectory JSONL file now contains this lifecycle bracket:
```jsonl
{"traceSchema":"comis-trajectory","schemaVersion":1,"source":"runtime","type":"session.started","ts":"2026-05-24T18:00:00.000Z","seq":1,"agentId":"my-agent","sessionId":"k","traceId":"uuid1","entryId":"entry-1","data":{...}}
{"traceSchema":"comis-trajectory","schemaVersion":1,"source":"runtime","type":"trace.metadata","ts":"2026-05-24T18:00:00.001Z","seq":2,"agentId":"my-agent","sessionId":"k","traceId":"uuid1","entryId":"entry-2","data":{"harness":{"type":"comis","version":"unknown","os":"darwin","node":"v22.0.0"},"model":{"provider":"anthropic","modelId":"claude-sonnet-4-20250514"},"config":{"appName":"comis"},"plugins":[],"skills":[],"prompting":{},"redaction":{"policy":"platform-aware"}}}
{"traceSchema":"comis-trajectory","schemaVersion":1,"source":"runtime","type":"tool.call","ts":"2026-05-24T18:00:01.000Z","seq":3,...}
{"traceSchema":"comis-trajectory","schemaVersion":1,"source":"runtime","type":"trace.artifacts","ts":"2026-05-24T18:00:05.000Z","seq":10,...,"data":{"finalStatus":"destroyed","aborted":false,"usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"cumulativeCostUsd":0,"turnCount":0}}
{"traceSchema":"comis-trajectory","schemaVersion":1,"source":"runtime","type":"session.ended","ts":"2026-05-24T18:00:05.001Z","seq":11,...}
```

## Architecture test verification

`pnpm vitest run test/architecture/trajectory-event-types-known.test.ts` — 7/7 pass. The `DIRECT_EMIT_TRAJECTORY_TYPES` carve-out from Plan 01-01 correctly absorbs `trace.metadata` and `trace.artifacts` without arch-test regression.

## Deviations from Plan

### Deferred items

**1. [Deferred] sessionStateProvider BridgeMetricsState wiring from pi-executor**
- **Found during:** Task 4 executor wiring
- **Issue:** `sessionAdapter` is provided via `PiExecutorDeps.sessionAdapter` and is created externally (daemon composition root). There is no per-session bridge registry accessible at `destroySession` call time from within the executor.
- **Resolution:** Interface and fallback are in place. When `sessionStateProvider` is absent (current production state), `destroySession` emits a minimal `finalStatus: "destroyed"` artifacts payload with zero-count usage. Full BridgeMetricsState handoff requires Phase 2 work at the daemon composition root where both the session manager and the per-session bridge handle are available.
- **Files deferred:** daemon/setup-agents-runtime.ts (not in this plan's scope)

**2. [Deviation] harness.version is "unknown" in runtimeSnapshot**
- **Found during:** Task 3 executor wiring
- **Issue:** `deps.appVersion` does not exist in `PiExecutorDeps` at HEAD.
- **Resolution:** Used `"unknown"` placeholder with JSDoc comment. Phase 2 will thread the version constant.
- **Files modified:** `packages/agent/src/executor/pi-executor/pi-executor.ts`

### Plan specification drift

**3. [Acknowledged] Canonical trace.metadata emit site is pi-event-bridge (bridge), not pi-executor**
- The plan specification (and the pre-execution note) acknowledge this drift. The bridge is constructed inside `execute()` and is the pi-coding-agent event translator — functionally equivalent to "the executor" for lifecycle purposes. This approach is correct per design §6.2 Appendix B.

## Known Stubs

None — both lifecycle envelopes emit concrete payloads. The `trace.metadata` harness.version is "unknown" (acknowledged deviation above), and the `trace.artifacts` payload uses the "destroyed" fallback status when no sessionStateProvider is registered. Neither prevents the plan's goal from being achieved.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary schema changes. The `sanitizeForPersistence` call in `buildTraceMetadata` ensures the config field (which may contain operator-configured API keys) is redacted before it reaches the trajectory JSONL file.

## Self-Check

### Created files:
- [x] `packages/observability/src/trajectory/metadata.ts` — FOUND
- [x] `packages/observability/src/trajectory/metadata.test.ts` — FOUND
- [x] `packages/observability/src/trajectory/artifacts.ts` — FOUND
- [x] `packages/observability/src/trajectory/artifacts.test.ts` — FOUND

### Commits:
- [x] `c584b3d` — FOUND
- [x] `77b704d` — FOUND
- [x] `87057fd` — FOUND
- [x] `23ce4e0` — FOUND
- [x] `45df5b8` — FOUND
- [x] `7db9b8b` — FOUND
- [x] `efb63e9` — FOUND
- [x] `9162660` — FOUND
- [x] `a16c38a` — FOUND
