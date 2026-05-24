---
phase: 02-bridge-expansion-payload-bounding
plan: "03"
subsystem: trajectory-bridge
tags: [trajectory, event-bus-bridge, tdd, BRIDGE-01, BRIDGE-03, BRIDGE-04, queue, execution, security, sender]
dependency_graph:
  requires: ["02-01", "02-02"]
  provides: [queue-trajectory-events, execution-trajectory-events, security-trajectory-events, sender-trajectory-events]
  affects: [packages/observability, test/architecture]
tech_stack:
  added: []
  patterns: [bridge-mapping-expansion, tdd-red-green, disjoint-set-invariant, pii-field-omission]
key_files:
  created: []
  modified:
    - packages/observability/src/trajectory/types.ts
    - packages/observability/src/trajectory/event-bus-bridge.ts
    - packages/observability/src/trajectory/event-bus-bridge.test.ts
    - test/architecture/trajectory-event-types-known.test.ts
decisions:
  - "execution:signed_replay_recovered maps to execution.replay_recovered (not execution.signed_replay_recovered) per research table canonical name"
  - "patterns[] (L4) provably absent from security.injection_detected translator — only source+riskLevel forwarded"
  - "senderId+channelId provably absent from sender.blocked translator — only channelType forwarded"
  - "Pre-existing config-handlers worker timeout flake in full-suite run is out-of-scope; test passes in isolation"
metrics:
  duration: "~12 minutes"
  completed: "2026-05-24"
  tasks_completed: 3
  files_modified: 4
---

# Phase 02 Plan 03: Bridge Queue/Execution/Sender Events to Trajectory Summary

Expands `TRAJECTORY_BRIDGE_MAPPING` from 18 to 29 entries by bridging 4 queue events (BRIDGE-01), 5 execution events (BRIDGE-03), and 2 security/sender events (the scanned subset of BRIDGE-04). Includes the incident-replay test for the 2026-05-24 double-enqueue bug — the single trajectory query that would have diagnosed it in seconds.

## Tasks Completed

| Task | Type | Commit | Status |
|------|------|--------|--------|
| Task 1: RED — failing bridge tests + incident replay | TDD RED | c8b93e1 | DONE |
| Task 2: GREEN — 11 types + 11 mapping entries + 11 translators | TDD GREEN | 7bd3517 | DONE |
| Task 3: GREEN — remove 11 events from EVENTS_NOT_TRAJECTORY_MAPPED | TDD GREEN | 813684a | DONE |

## Bridge Mapping Growth

- Before: 18 entries in `TRAJECTORY_BRIDGE_MAPPING`, 22 values in `TRAJECTORY_EVENT_TYPES`
- After: **29 entries** in `TRAJECTORY_BRIDGE_MAPPING`, **33 values** in `TRAJECTORY_EVENT_TYPES`
- `EVENTS_NOT_TRAJECTORY_MAPPED` shrank by 11 entries (disjoint-set invariant holds)

## New Trajectory Event Types

### BRIDGE-01: Queue lifecycle (events-channel.ts)

| Bus event | Trajectory type | Data fields |
|-----------|----------------|-------------|
| `queue:enqueued` | `queue.enqueued` | channelType, queueDepth, mode |
| `queue:dequeued` | `queue.dequeued` | channelType, waitTimeMs |
| `queue:overflow` | `queue.overflow` | channelType, policy, droppedCount |
| `queue:coalesced` | `queue.coalesced` | channelType, messageCount |

### BRIDGE-03: Execution control (events-messaging.ts)

| Bus event | Trajectory type | Data fields |
|-----------|----------------|-------------|
| `execution:aborted` | `execution.aborted` | reason |
| `execution:budget_warning` | `execution.budget_warning` | totalTokens, llmCallCount, projectedCallsLeft |
| `execution:prompt_timeout` | `execution.prompt_timeout` | timeoutMs |
| `execution:output_escalated` | `execution.output_escalated` | originalMaxTokens, escalatedMaxTokens |
| `execution:signed_replay_recovered` | `execution.replay_recovered` | blocksRemoved, thoughtSignaturesStripped, succeeded |

### BRIDGE-04 (scanned subset): Security + Sender

| Bus event | Trajectory type | Data fields | Omitted (security) |
|-----------|----------------|-------------|---------------------|
| `security:injection_detected` | `security.injection_detected` | source, riskLevel | patterns[] (L4 — verbatim attacker strings) |
| `sender:blocked` | `sender.blocked` | channelType | senderId+channelId (L4/L2 — user identifier) |

## Incident Replay Test

The `incident_replay_2026_05_24_double_enqueue_produces_two_queue.enqueued_events_with_queueDepth_1_then_2` test replays the 2026-05-24 duplicate-adapter bug: two `queue:enqueued` emissions on the same sessionKey produce two `queue.enqueued` trajectory events with `queueDepth: 1` then `queueDepth: 2`. This is the signal that would have diagnosed the bug in one query.

## Security Invariants Verified

- `patterns[]` absent from `security.injection_detected` data: verified by `"patterns" in data` assertion
- `senderId` absent from `sender.blocked` data: verified by `"senderId" in data` assertion
- All envelope-only fields (agentId, sessionKey, traceId, sessionId) stripped from all 11 translators

## Arch Test Status

`pnpm vitest run test/architecture/trajectory-event-types-known.test.ts` — 7/7 tests pass including:
- "every eventBus.emit name is either trajectory-mapped or explicitly allowlisted"
- "EVENTS_NOT_TRAJECTORY_MAPPED is disjoint from TRAJECTORY_BRIDGE_MAPPING (no double-coverage)"

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced. All security-surface events (security:injection_detected, sender:blocked) were explicitly threat-modeled in the plan's STRIDE register (T-02-06, T-02-07, T-02-08) and handled per those mitigations.

## Self-Check

```
c8b93e1 ✓ test(02-03): add failing queue/execution/sender bridge tests + incident replay
7bd3517 ✓ feat(02-03): bridge queue/execution/sender events to trajectory (BRIDGE-01/03/04)
813684a ✓ test(02-03): remove 11 bridged events from EVENTS_NOT_TRAJECTORY_MAPPED (BRIDGE-09 disjoint-set)
```

Files modified and committed:
- packages/observability/src/trajectory/types.ts ✓
- packages/observability/src/trajectory/event-bus-bridge.ts ✓
- packages/observability/src/trajectory/event-bus-bridge.test.ts ✓
- test/architecture/trajectory-event-types-known.test.ts ✓

## Self-Check: PASSED
