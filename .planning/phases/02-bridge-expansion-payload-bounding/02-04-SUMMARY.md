---
phase: 02-bridge-expansion-payload-bounding
plan: "04"
subsystem: trajectory-bridge
tags: [trajectory, event-bus-bridge, tdd, BRIDGE-02, BRIDGE-05, BRIDGE-06, retry, mcp, channel, pii-omission]
dependency_graph:
  requires: ["02-03"]
  provides: [retry-trajectory-events, mcp-trajectory-events, channel-trajectory-events]
  affects: [packages/observability]
tech_stack:
  added: []
  patterns: [bridge-mapping-expansion, tdd-red-green, dual-mapping-with-discriminator, conditional-spread-null-fields, pii-field-omission]
key_files:
  created: []
  modified:
    - packages/observability/src/trajectory/types.ts
    - packages/observability/src/trajectory/event-bus-bridge.ts
    - packages/observability/src/trajectory/event-bus-bridge.test.ts
decisions:
  - "channel:registered and channel:deregistered both map to channel.lifecycle with synthetic event:\"registered\"/\"deregistered\" discriminator — mirrors lkw_fallback_attempt precedent"
  - "channel:health_changed.error uses conditional spread (not unconditional) so null error value is absent from trajectory data"
  - "chatId+channelId provably absent from retry translator data — L3 PII invariant (T-02-09) enforced at translator level; sanitizeForPersistence is defense-in-depth"
  - "No EVENTS_NOT_TRAJECTORY_MAPPED changes required — BRIDGE-02/05/06 emitters are in packages/core/delivery, packages/skills, packages/channels (not arch-test scanned)"
metrics:
  duration: "~7 minutes"
  completed: "2026-05-24"
  tasks_completed: 2
  files_modified: 3
---

# Phase 02 Plan 04: Bridge retry/mcp/channel Events to Trajectory Summary

Expands `TRAJECTORY_BRIDGE_MAPPING` from 29 to 40 entries by bridging 3 delivery retry events (BRIDGE-02), 5 MCP server reliability events (BRIDGE-05), and 3 channel lifecycle/health events (BRIDGE-06). Closes G2 coverage for delivery resilience, MCP connection health, and channel wiring changes.

## Tasks Completed

| Task | Type | Commit | Status |
|------|------|--------|--------|
| Task 1: RED — failing bridge tests for retry/mcp/channel | TDD RED | 2b2ed9d | DONE |
| Task 2: GREEN — 10 type values + 11 mapping entries + 11 translators | TDD GREEN | 7fad583 | DONE |

## Bridge Mapping Growth

- Before: 29 entries in `TRAJECTORY_BRIDGE_MAPPING`, 33 values in `TRAJECTORY_EVENT_TYPES`
- After: **40 entries** in `TRAJECTORY_BRIDGE_MAPPING`, **43 values** in `TRAJECTORY_EVENT_TYPES`
- `EVENTS_NOT_TRAJECTORY_MAPPED` unchanged (BRIDGE-02/05/06 emitters not in arch-test scanned packages)

## New Trajectory Event Types

### BRIDGE-02: Delivery retry (events-channel.ts; emitter packages/core/delivery)

| Bus event | Trajectory type | Data fields | Omitted (PII / noise) |
|-----------|----------------|-------------|----------------------|
| `retry:attempted` | `delivery.retry` | attempt, maxAttempts, delayMs, error | **chatId** (L3 Telegram long-decimal), **channelId**, timestamp |
| `retry:exhausted` | `delivery.retry_exhausted` | totalAttempts, finalError | **chatId**, channelId, timestamp |
| `retry:markdown_fallback` | `delivery.markdown_fallback` | originalParseMode | **chatId**, channelId, timestamp |

### BRIDGE-05: MCP server reliability (events-infra.ts; emitter packages/skills)

| Bus event | Trajectory type | Data fields |
|-----------|----------------|-------------|
| `mcp:server:disconnected` | `mcp.disconnected` | serverName, reason |
| `mcp:server:reconnecting` | `mcp.reconnecting` | serverName, attempt, maxAttempts, nextDelayMs |
| `mcp:server:reconnect_failed` | `mcp.reconnect_failed` | serverName, attempts, lastError |
| `mcp:server:reconnected` | `mcp.reconnected` | serverName, attempt, toolCount, durationMs |
| `mcp:server:tools_changed` | `mcp.tools_changed` | serverName, previousToolCount, currentToolCount, addedTools, removedTools |

### BRIDGE-06: Channel lifecycle + health (events-channel.ts; emitter packages/channels)

| Bus event | Trajectory type | Data fields | Omitted |
|-----------|----------------|-------------|---------|
| `channel:health_changed` | `channel.health_changed` | channelType, previousState, currentState, connectionMode, error? | lastMessageAt, timestamp |
| `channel:registered` | `channel.lifecycle` | channelType, pluginId, event: "registered" (synthetic) | capabilities, timestamp |
| `channel:deregistered` | `channel.lifecycle` | channelType, pluginId, event: "deregistered" (synthetic) | timestamp |

## Security Invariants Verified

- `chatId` absent from all three retry translator cases: verified by `"chatId" in data` assertion
- `channelId` absent from all three retry translator cases: verified by `"channelId" in data` assertion
- `channel:health_changed.error: null` → absent from data: conditional spread (`...(payload.error !== null ? { error } : {})`)
- `capabilities` absent from `channel:registered` data: verified by `"capabilities" in data` assertion
- All envelope-only fields (agentId, sessionKey, traceId, sessionId) stripped — covered by the parameterized envelope-invariant test (now 40 events tested)

## Dual-Mapping Pattern (channel.lifecycle)

Both `channel:registered` and `channel:deregistered` map to the same `channel.lifecycle` trajectory type. The translator adds a synthetic `event: "registered" | "deregistered"` field to distinguish them. This mirrors the existing `model:fallback_attempt` + `model:lkw_fallback_attempt` → `model.fallback_attempt` precedent (lkw adds `lkw: true`).

## Arch Test Status

`pnpm vitest run test/architecture/trajectory-event-types-known.test.ts` — 7/7 tests pass.
No allowlist changes needed: BRIDGE-02/05/06 emitters live in `packages/core/delivery`, `packages/skills`, and `packages/channels` — not in the arch-test scanned packages (`packages/agent`, `packages/orchestrator`).

## TDD Gate Compliance

1. RED commit (`2b2ed9d`) — 14 failing tests for BRIDGE-02/05/06, confirmed via `grep -qE "(fail|✗|×|AssertionError)"` output
2. GREEN commit (`7fad583`) — all 14 tests pass + full 80-test file passes

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced. All security-surface events were explicitly threat-modeled in the plan's STRIDE register:
- T-02-09: retry:* chatId omission — mitigated by translator-level field omission (verified)
- T-02-10: mcp/channel error strings — accepted (connection error strings, low PII risk, bounded by BOUND-01)

## Self-Check

```
2b2ed9d ✓ test(02-04): add failing retry/mcp/channel bridge tests
7fad583 ✓ feat(02-04): bridge retry/mcp/channel events to trajectory (BRIDGE-02/05/06)
```

Files modified and committed:
- packages/observability/src/trajectory/event-bus-bridge.test.ts ✓
- packages/observability/src/trajectory/types.ts ✓
- packages/observability/src/trajectory/event-bus-bridge.ts ✓

## Self-Check: PASSED
