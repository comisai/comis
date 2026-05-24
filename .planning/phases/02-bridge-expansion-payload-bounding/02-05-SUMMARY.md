---
phase: 02-bridge-expansion-payload-bounding
plan: "05"
subsystem: trajectory-bridge
tags: [trajectory, event-bus-bridge, tdd, BRIDGE-04, BRIDGE-07, BRIDGE-08, BRIDGE-09, security, compaction, context, approval, pii-omission, arch-test]
dependency_graph:
  requires: ["02-04"]
  provides: [security-trajectory-events, compaction-trajectory-events, context-trajectory-events, approval-trajectory-events, bridge-count-gate]
  affects: [packages/observability, test/architecture]
tech_stack:
  added: []
  patterns: [bridge-mapping-expansion, tdd-red-green, pii-field-omission, conditional-spread-optional-fields, envelope-only-empty-data]
key_files:
  created: []
  modified:
    - packages/observability/src/trajectory/types.ts
    - packages/observability/src/trajectory/event-bus-bridge.ts
    - packages/observability/src/trajectory/event-bus-bridge.test.ts
    - test/architecture/trajectory-event-types-known.test.ts
decisions:
  - "security:memory_tainted.patterns[] omitted (L4 — verbatim taint strings); security:warn.message omitted (L5 — may reference secret names/config paths)"
  - "approval:requested.params omitted entirely (L2 HIGHEST risk — raw unbounded tool arguments; sanitizeForPersistence is defense-in-depth only, not substitute)"
  - "compaction:started returns empty data {} — all 3 source fields (agentId, sessionKey, timestamp) are envelope-only (L6); event is a pure lifecycle signal"
  - "context:integrity NOT removed from EVENTS_NOT_TRAJECTORY_MAPPED — it was never there (optional-chaining emit escapes arch-test regex)"
  - "security:memory_tainted removed from EVENTS_NOT_TRAJECTORY_MAPPED (was listed despite research claiming it was not — auto-fix deviation Rule 1; disjoint-set invariant requires removal)"
  - "approval:resolved.reason and approval:requested.channelType use conditional spread — both optional on source event"
  - "Final mapping count: 53 (18 existing + 35 added across Phase 2 plans 01-05); BRIDGE-09 >=45 gate satisfied with margin"
metrics:
  duration: "~20 minutes"
  completed: "2026-05-24"
  tasks_completed: 3
  files_modified: 4
---

# Phase 02 Plan 05: Bridge security/compaction/context/approval Events Summary

Completes the Phase 2 bridge expansion by adding 13 new mapping entries covering the non-scanned security events (`security:memory_tainted`, `security:warn`), all compaction signals (`compaction:{started,flush,recommended}`), all Phase-2 context engine events (`context:{evicted,masked,reread,overflow,integrity,rehydrated}`), and approval/human-in-the-loop events (`approval:{requested,resolved}`). Removes 9 events from `EVENTS_NOT_TRAJECTORY_MAPPED` (8 compaction/context + 1 security). Adds the BRIDGE-09 architecture test gate confirming the mapping has ≥45 entries (actual: 53).

## Tasks Completed

| Task | Type | Commit | Status |
|------|------|--------|--------|
| Task 1: RED — failing bridge tests + >=45 count | TDD RED | 704508d | DONE |
| Task 2: GREEN — 13 type values + 13 mapping entries + 13 translators | TDD GREEN | b9c4604 | DONE |
| Task 3: GREEN — remove 9 events from allowlist; verify >=45 | TDD GREEN | e36bb12 | DONE |

## Bridge Mapping Growth

- Before: 40 entries in `TRAJECTORY_BRIDGE_MAPPING`, 43 values in `TRAJECTORY_EVENT_TYPES`
- After: **53 entries** in `TRAJECTORY_BRIDGE_MAPPING`, **56 values** in `TRAJECTORY_EVENT_TYPES`
- `EVENTS_NOT_TRAJECTORY_MAPPED` shrank by 9: 3 compaction + 5 context + 1 security

## New Trajectory Event Types

### BRIDGE-04 rest: Security (non-scanned emitters)

| Bus event | Trajectory type | Data fields | Omitted (SECURITY) |
|-----------|----------------|-------------|---------------------|
| `security:memory_tainted` | `security.memory_tainted` | originalTrustLevel, adjustedTrustLevel, blocked | **patterns[]** (L4 — verbatim taint strings), agentId, timestamp |
| `security:warn` | `security.warn` | category | **message** (L5 — may reference secret names/config paths), agentId, timestamp |

### BRIDGE-07: Compaction signals (events-messaging.ts)

| Bus event | Trajectory type | Data fields | Omitted |
|-----------|----------------|-------------|---------|
| `compaction:started` | `compaction.started` | _(empty — all envelope-only, L6)_ | agentId, sessionKey, timestamp |
| `compaction:flush` | `compaction.flush` | memoriesWritten, trigger, success | sessionKey, timestamp |
| `compaction:recommended` | `compaction.recommended` | contextPercent, contextTokens, contextWindow | agentId, sessionKey, timestamp |

### BRIDGE-07: Context engine events (events-messaging.ts)

| Bus event | Trajectory type | Data fields |
|-----------|----------------|-------------|
| `context:evicted` | `context.evicted` | evictedCount, evictedChars, categories |
| `context:masked` | `context.masked` | maskedCount, totalChars, persistedToDisk |
| `context:reread` | `context.reread` | rereadCount, rereadTools |
| `context:overflow` | `context.overflow` | contextTokens, budgetTokens, recoveryAction |
| `context:integrity` | `context.integrity` | conversationId, issueCount, repairsApplied, errorsLogged, issueTypes, durationMs |
| `context:rehydrated` | `context.rehydrated` | sectionsInjected, filesInjected, skillsInjected, overflowStripped |

### BRIDGE-08: Approval events (events-infra.ts)

| Bus event | Trajectory type | Data fields | Omitted (SECURITY) |
|-----------|----------------|-------------|---------------------|
| `approval:requested` | `approval.requested` | requestId, toolName, action, trustLevel, timeoutMs, channelType? | **params** (L2 — raw unconstrained tool arguments, HIGHEST risk field in phase), agentId, sessionKey, createdAt |
| `approval:resolved` | `approval.resolved` | requestId, approved, approvedBy, reason? | resolvedAt |

## Security Invariants Verified

All PII-omission assertions are load-bearing tests (provably absent via `"field" in data === false`):

- `security:memory_tainted.patterns[]` absent: verified by `"patterns" in data` assertion (L4)
- `security:warn.message` absent: verified by `"message" in data` assertion (L5)
- `approval:requested.params` absent: verified by `"params" in data` assertion (L2 — highest risk)
- `context:integrity` content fields absent: only counts/sizes/types forwarded (no raw content)
- All envelope-only fields (agentId, sessionKey, traceId, sessionId) stripped — covered by the parameterized envelope-invariant test (now 53 events tested)

## BRIDGE-09 Count Gate

`Object.keys(TRAJECTORY_BRIDGE_MAPPING).length === 53 >= 45` — asserted in arch test.

Phase 2 bridge expansion complete (18 → 53):
- 18 original entries (Phase 1)
- +4 BRIDGE-01 (queue)
- +5 BRIDGE-03 (execution)
- +2 BRIDGE-04 scanned (security:injection_detected + sender:blocked)
- +3 BRIDGE-02 (retry delivery)
- +5 BRIDGE-05 (mcp)
- +3 BRIDGE-06 (channel)
- +13 BRIDGE-04rest/07/08 this plan
= **53 total**

## Allowlist Removals (EVENTS_NOT_TRAJECTORY_MAPPED)

9 events removed (now bridge-mapped):

| Removed | Block | Note |
|---------|-------|------|
| `compaction:started` | Compaction signals | Entire block deleted |
| `compaction:flush` | Compaction signals | Entire block deleted |
| `compaction:recommended` | Compaction signals | Entire block deleted |
| `context:evicted` | Context-engine internals | Kept: context:compacted, context:pipeline:cache |
| `context:masked` | Context-engine internals | |
| `context:overflow` | Context-engine internals | |
| `context:rehydrated` | Context-engine internals | |
| `context:reread` | Context-engine internals | |
| `security:memory_tainted` | Security/safety | See deviation below |

## TDD Gate Compliance

1. RED commit (`704508d`) — 16 failing tests confirmed (bridge-data tests + count assertion)
2. GREEN commit (`b9c4604`) — all 109 bridge tests pass
3. GREEN commit (`e36bb12`) — all 8 arch tests pass (disjoint-set + >=45 count)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] security:memory_tainted was in EVENTS_NOT_TRAJECTORY_MAPPED (contrary to research)**
- **Found during:** Task 3 — disjoint-set arch test failed with `security:memory_tainted` in both sets
- **Issue:** The research document stated "security:memory_tainted emitter is packages/daemon — not scanned. Neither is in EVENTS_NOT_TRAJECTORY_MAPPED." This was incorrect — the event WAS listed in the allowlist's "Security / safety" block (line 78 in the arch test file at task time).
- **Fix:** Removed `security:memory_tainted` from `EVENTS_NOT_TRAJECTORY_MAPPED`. Added comment explaining all three security events now flow via `TRAJECTORY_BRIDGE_MAPPING`.
- **Files modified:** `test/architecture/trajectory-event-types-known.test.ts`
- **Commit:** e36bb12 (included in Task 3 commit)

## WR-01/WR-02 Deferral (explicitly out of scope)

Phase 1 carry-overs WR-01 (populate `trace.metadata.prompting`) and WR-02 (redact `userPromptPrefixText`) remain DEFERRED to Phase 3. PII-leak landmine: if WR-01 lands before WR-02, `userPromptPrefixText` reaches the trajectory unredacted. WR-01 and WR-02 MUST land in the same wave.

## Known Stubs

None — all 13 new mappings forward real diagnostic data from live event payloads.

## Self-Check

```
704508d ✓ test(02-05): add failing security/compaction/context/approval bridge tests + >=45 count
b9c4604 ✓ feat(02-05): bridge security/compaction/context/approval events (BRIDGE-04/07/08)
e36bb12 ✓ test(02-05): remove 8 compaction/context events from allowlist; bridge >=45 (BRIDGE-09)
```

Files modified and committed:
- packages/observability/src/trajectory/event-bus-bridge.test.ts ✓
- packages/observability/src/trajectory/types.ts ✓
- packages/observability/src/trajectory/event-bus-bridge.ts ✓
- test/architecture/trajectory-event-types-known.test.ts ✓

## Self-Check: PASSED
