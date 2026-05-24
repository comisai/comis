---
phase: 03-boot-invariants-info-dedup
plan: "03"
subsystem: orchestrator/observability/core
tags: [dedup, inbound-pipeline, event-bus, trajectory-bridge, tdd]
dependency_graph:
  requires: []
  provides:
    - dedup:duplicate_inbound bus event type (ChannelEvents interface, @comis/core)
    - createDedupDetector() synchronous bounded-LRU duplicate detector (@comis/orchestrator)
    - dedup:duplicate_inbound → dedup.duplicate_inbound bridge mapping + translator (@comis/observability)
    - dedup check wired into processInboundMessage Phase 0→Phase 1 seam (@comis/orchestrator)
  affects:
    - packages/core/src/event-bus/events-channel.ts
    - packages/orchestrator/src/inbound/inbound-pipeline.ts
    - packages/observability/src/trajectory/event-bus-bridge.ts
    - packages/observability/src/trajectory/types.ts
tech_stack:
  added: []
  patterns:
    - synchronous Map-based FIFO LRU with per-check eviction (no setInterval)
    - injectable clock for deterministic test control
    - TDD RED → GREEN for each of 3 requirements
    - disjoint-set atomic bridge add (dedup:duplicate_inbound NOT in EVENTS_NOT_TRAJECTORY_MAPPED)
    - same-wave constraint: emit + bridge entry + type landed atomically
key_files:
  created:
    - packages/orchestrator/src/inbound/dedup-detector.ts
    - packages/orchestrator/src/inbound/dedup-detector.test.ts
  modified:
    - packages/core/src/event-bus/events-channel.ts
    - packages/orchestrator/src/inbound/inbound-pipeline.ts
    - packages/orchestrator/src/inbound/inbound-pipeline.test.ts
    - packages/observability/src/trajectory/event-bus-bridge.ts
    - packages/observability/src/trajectory/event-bus-bridge.test.ts
    - packages/observability/src/trajectory/types.ts
decisions:
  - source:"pipeline" used (not "queue") — the duplicate is caught in processInboundMessage which runs in the inbound pipeline, not the queue. 03-RESEARCH.md confirms this is the accurate value for this check site.
  - firstSeenAt stable in detector — timestamp is NOT refreshed on duplicate checks, so deltaMs grows monotonically within the window, matching the incident replay expectation.
  - Per-check synchronous eviction (no setInterval) — avoids timer coupling in a synchronous hot-path; O(front-of-map) sweep terminates at the first non-expired entry.
  - SAMPLE_PAYLOADS table in event-bus-bridge.test.ts extended — the "envelope-only correlation keys" parametric test iterates TRAJECTORY_BRIDGE_MAPPING and asserts every event has an entry; extending the table was required to keep 100% coverage.
metrics:
  duration: ~20 minutes
  completed: "2026-05-24"
  tasks: 3
  files: 7
---

# Phase 03 Plan 03: DEDUP-01+02+03 Summary

Synchronized dedup detection for the inbound pipeline: `dedup:duplicate_inbound` bus event type, a synchronous bounded-LRU detector wired into processInboundMessage, and a trajectory bridge mapping routing it to `dedup.duplicate_inbound` (bridge entry #54).

## What Was Built

### DEDUP-01 — Bus event type
Added `dedup:duplicate_inbound` to the `ChannelEvents` interface in `packages/core/src/event-bus/events-channel.ts`. 7 primitive fields verbatim from design §6.3: `messageId`, `channelType`, `chatId`, `firstSeenAt`, `duplicateAt`, `deltaMs`, `source` (union `"queue" | "channel" | "pipeline"`). No imports needed.

### DEDUP-02 — Bounded-LRU detector
New file `packages/orchestrator/src/inbound/dedup-detector.ts`:

- Exports `DedupCheckResult`, `DedupDetector`, `DedupDetectorOptions`, `createDedupDetector()`
- Internal `Map<string, number>` (messageId → firstSeenAt); insertion order = FIFO
- Per-check synchronous eviction: sweeps expired entries from the front (oldest = front of Map), then enforces `maxEntries` cap by evicting the current oldest
- Default: `maxEntries = 1024`, `windowMs = 10_000 ms`, `now = systemNowMs`
- Injectable `now` clock for deterministic tests
- Entirely synchronous — no `await`, no `setInterval` (Landmine 5 mitigation)

Detector wired into `InboundPipelineDeps.dedupDetector?: DedupDetector` (optional). On duplicate within window:
- `eventBus.emit("dedup:duplicate_inbound", {..., source: "pipeline"})`
- `logger.warn({ ..., hint: "Same messageId processed twice; check channel adapter handler list and queue mode", errorKind: "internal" }, "Duplicate inbound message detected")`
- NO `return` — processing continues (design §5 D12 do-not-suppress)

Check point: between Phase 0 (allowFrom return) and Phase 1 (`resolveAndPreprocess`) in `processInboundMessage`.

### DEDUP-03 — Bridge mapping + trajectory type
- `"dedup.duplicate_inbound"` added to `TRAJECTORY_EVENT_TYPES` array in `types.ts`
- `"dedup:duplicate_inbound": "dedup.duplicate_inbound"` added to `TRAJECTORY_BRIDGE_MAPPING` in `event-bus-bridge.ts` (entry #54; total count: 54)
- Translator case returns 5-field subset: `{messageId, channelType, chatId, deltaMs, source}`; `firstSeenAt` and `duplicateAt` intentionally omitted (envelope `ts` covers timing per design §13 Appendix B)
- Disjoint-set discipline preserved: `dedup:duplicate_inbound` was NOT in `EVENTS_NOT_TRAJECTORY_MAPPED` → add-only to bridge mapping, nothing to remove

## Test Results

| Test suite | Files | Tests | Result |
|------------|-------|-------|--------|
| dedup-detector.test.ts (new) | 1 | 9 | GREEN |
| inbound-pipeline.test.ts (4 new) | 1 | 36 | GREEN |
| event-bus-bridge.test.ts (4 new + SAMPLE_PAYLOADS) | 1 | 114 | GREEN |
| trajectory-event-types-known.test.ts (arch) | 1 | 8 | GREEN |
| All modified packages | 227 | 4839 | GREEN |

Key assertions confirmed:
- deltaMs:1 on incident-replay (t=1000, t=1001 duplicate)
- Post-window eviction (check after 10001ms gap returns isDuplicate:false)
- Cap at 1024 entries (FIFO oldest eviction)
- Synchronous return (not a Promise)
- source:"pipeline" in emit payload
- firstSeenAt/duplicateAt absent from trajectory data
- Processing continues after duplicate (no suppression)
- Arch test green: emit site in orchestrator covered by TRAJECTORY_BRIDGE_MAPPING

## Deviations from Plan

None. Plan executed exactly as written.

**source:"pipeline" note:** The plan explicitly states `source: "pipeline"` (not `"queue"`) because the check point is `processInboundMessage` in the inbound pipeline. This matches 03-RESEARCH.md and design §9.2's intent for the check site's accurate label.

**SAMPLE_PAYLOADS extension (Rule 2):** The `event-bus-bridge.test.ts` parametric test "translatePayload_strips_correlation_keys_from_data" iterates every key in `TRAJECTORY_BRIDGE_MAPPING` and requires a corresponding entry in `SAMPLE_PAYLOADS`. Adding `dedup:duplicate_inbound` to the mapping caused this test to fail without a matching sample payload. Added the entry to `SAMPLE_PAYLOADS` — this is required correctness for the existing test invariant, not new behavior.

## Commits

| Commit | Message |
|--------|---------|
| `19807e0` | feat(03-03): DEDUP-01 event type + DEDUP-02 bounded-LRU dedup detector |
| `2deadaa` | feat(03-03): DEDUP-03 bridge entry #54 + trajectory type + translator |
| `9f1b2bb` | feat(03-03): DEDUP-02 wire dedup check into inbound-pipeline (emit + WARN) |

## Same-Wave Constraint Honored

The arch test `trajectory-event-types-known.test.ts` scans `packages/orchestrator/src/**` for `eventBus.emit("name", ...)` calls and requires each name to be in `TRAJECTORY_BRIDGE_MAPPING` OR `EVENTS_NOT_TRAJECTORY_MAPPED`. DEDUP-01 (type), DEDUP-02 (emit), and DEDUP-03 (bridge entry) all landed in this single plan so the arch test never observed an orphaned emit. The arch test remains GREEN at every commit.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `packages/orchestrator/src/inbound/dedup-detector.ts` | FOUND |
| `packages/orchestrator/src/inbound/dedup-detector.test.ts` | FOUND |
| `.planning/phases/03-boot-invariants-info-dedup/03-03-SUMMARY.md` | FOUND |
| Commit `19807e0` (DEDUP-01 + detector) | FOUND |
| Commit `2deadaa` (DEDUP-03 bridge) | FOUND |
| Commit `9f1b2bb` (DEDUP-02 wire) | FOUND |
