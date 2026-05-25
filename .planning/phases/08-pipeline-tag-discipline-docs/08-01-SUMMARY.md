---
phase: 08-pipeline-tag-discipline-docs
plan: "01"
subsystem: observability/pipeline-discipline
tags: [hygiene, step-tags, arch-test, tdd, HYGIENE-01]
dependency_graph:
  requires: []
  provides: [pipeline-step-coverage-arch-test, step-tag-discipline-enforcement]
  affects: [packages/channels, packages/orchestrator, packages/agent, packages/memory, test/architecture]
tech_stack:
  added: []
  patterns: [step:-tagged-logger-calls, shrink-only-arch-test, LOOKBEHIND-200-walker]
key_files:
  created:
    - test/architecture/pipeline-step-coverage.test.ts
  modified:
    - packages/channels/src/discord/discord-adapter.ts
    - packages/channels/src/telegram/telegram-adapter/telegram-inbound.ts
    - packages/channels/src/telegram/telegram-adapter/telegram-outbound.ts
    - packages/channels/src/slack/slack-adapter.ts
    - packages/channels/src/whatsapp/whatsapp-adapter.ts
    - packages/channels/src/signal/signal-adapter.ts
    - packages/channels/src/line/line-adapter.ts
    - packages/channels/src/imessage/imessage-adapter.ts
    - packages/channels/src/irc/irc-adapter.ts
    - packages/channels/src/email/email-adapter.ts
    - packages/orchestrator/src/channel-manager.ts
    - packages/orchestrator/src/queue/command-queue.ts
    - packages/orchestrator/src/inbound/inbound-pipeline.ts
    - packages/agent/src/executor/pi-executor/pi-executor.ts
    - packages/agent/src/executor/executor-post-execution.ts
    - packages/agent/src/executor/model-retry.ts
    - packages/agent/src/bridge/pi-event-bridge.ts
    - packages/agent/src/bridge/pi-event-bridge.test.ts
    - packages/memory/src/sqlite-memory-adapter.ts
decisions:
  - "STAGE_TOKEN_MAP widened: inbound accepts channel-registry (channel-manager) alongside channels-inbound; existing orchestrator tags (chunking, block-delivery, response-filter, media-compress, audio-preflight, reset-trigger, export-trajectory) map delivery/context/security/mcp stages to already-tagged tokens — no new file edits required beyond plan's files_modified for those 4 stages"
  - "echo-adapter excluded from CHANNEL_INBOUND_SITES: it is a pure in-memory test stub with no logger instance and no Inbound message log call — 9 adapters tested rather than 10"
  - "retry stage covered via model-retry.ts Primary model prompt error WARN (canonical retry entry point); compaction stage covered via pi-event-bridge.ts Auto-compaction started/completed"
  - "model-retry.ts added to files_modified (not in plan's list) to cover retry stage — extends plan scope within allowed files boundary"
metrics:
  duration_minutes: 20
  completed_date: "2026-05-25"
  tasks_completed: 3
  files_modified: 19
---

# Phase 8 Plan 1: HYGIENE-01 Pipeline Step-Tag Coverage Summary

`step:` discipline (AGENTS.md §2.7) is now machine-enforced: a new shrink-only architecture test asserts every known pipeline stage emits at least one `step:`-tagged log line. Pre-plan step: coverage was ~10 tagged logger calls; post-plan coverage is 31 tagged calls across production code.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED arch test | 11f597d | test/architecture/pipeline-step-coverage.test.ts |
| 2 | GREEN: channel adapters | 812f2ba | 10 channel adapter files |
| 3 | GREEN: orchestrator + agent + memory | 3dca0d1 | 9 production files + 1 test fix |

## TDD Compliance

- RED commit `11f597d` lands before any production patches
- GREEN commits `812f2ba` and `3dca0d1` follow RED
- RED state is reproducible from `11f597d` alone (23 failures confirmed)
- Gate compliance: test → feat ordering maintained

## Final STAGE_TOKEN_MAP

```typescript
{
  inbound:    ["channels-inbound", "channel-registry"],
  queue:      ["queue-enqueue", "queue-dequeue"],
  execution:  ["agent-execute"],
  retry:      ["retry"],
  delivery:   ["channels-outbound", "delivery", "block-delivery", "chunking"],
  memory:     ["memory-store"],
  context:    ["context", "audio-preflight", "media-compress", "reset-trigger"],
  security:   ["security", "response-filter", "empty-response", "outbound-media", "outbound-media-delivered"],
  mcp:        ["mcp", "export-trajectory"],
  compaction: ["compaction"],
  dedup:      ["dedup"],
}
```

## Step: Tags Added — Site Inventory

| File | Line | Tag | Message |
|------|------|-----|---------|
| packages/channels/src/discord/discord-adapter.ts | ~157 | channels-inbound | Inbound message |
| packages/channels/src/discord/discord-adapter.ts | ~421 | channels-outbound | Outbound message (sendMessage) |
| packages/channels/src/discord/discord-adapter.ts | ~461 | channels-outbound | Outbound message (editMessage) |
| packages/channels/src/telegram/telegram-adapter/telegram-inbound.ts | ~71 | channels-inbound | Inbound message |
| packages/channels/src/telegram/telegram-adapter/telegram-outbound.ts | ~120 | channels-outbound | Outbound message (sendMessage) |
| packages/channels/src/telegram/telegram-adapter/telegram-outbound.ts | ~170 | channels-outbound | Outbound message (editMessage) |
| packages/channels/src/slack/slack-adapter.ts | ~186 | channels-inbound | Inbound message |
| packages/channels/src/slack/slack-adapter.ts | ~387 | channels-outbound | Outbound message (postMessage) |
| packages/channels/src/slack/slack-adapter.ts | ~422 | channels-outbound | Outbound message (editMessage) |
| packages/channels/src/whatsapp/whatsapp-adapter.ts | ~182 | channels-inbound | Inbound message |
| packages/channels/src/whatsapp/whatsapp-adapter.ts | ~294 | channels-outbound | Outbound message (send) |
| packages/channels/src/whatsapp/whatsapp-adapter.ts | ~329 | channels-outbound | Outbound message (edit) |
| packages/channels/src/signal/signal-adapter.ts | ~100 | channels-inbound | Inbound message |
| packages/channels/src/signal/signal-adapter.ts | ~261 | channels-outbound | Outbound message |
| packages/channels/src/line/line-adapter.ts | ~132 | channels-inbound | Inbound message |
| packages/channels/src/line/line-adapter.ts | ~301 | channels-outbound | Outbound message |
| packages/channels/src/imessage/imessage-adapter.ts | ~141 | channels-inbound | Inbound message |
| packages/channels/src/imessage/imessage-adapter.ts | ~269 | channels-outbound | Outbound message |
| packages/channels/src/irc/irc-adapter.ts | ~140 | channels-inbound | Inbound message |
| packages/channels/src/irc/irc-adapter.ts | ~297 | channels-outbound | Outbound message |
| packages/channels/src/email/email-adapter.ts | ~175 | channels-inbound | Inbound message |
| packages/orchestrator/src/channel-manager.ts | ~374 | channel-registry | Adapter registered |
| packages/orchestrator/src/queue/command-queue.ts | ~240 | queue-dequeue | Message dequeued |
| packages/orchestrator/src/queue/command-queue.ts | ~283 | queue-enqueue | Message enqueued |
| packages/orchestrator/src/inbound/inbound-pipeline.ts | ~199 | dedup | Duplicate inbound message detected |
| packages/agent/src/executor/pi-executor/pi-executor.ts | ~1284 | agent-execute | Execution started |
| packages/agent/src/executor/executor-post-execution.ts | ~534 | agent-execute | Execution complete |
| packages/agent/src/executor/model-retry.ts | ~235 | retry | Primary model prompt error |
| packages/agent/src/bridge/pi-event-bridge.ts | ~1451 | compaction | Auto-compaction started |
| packages/agent/src/bridge/pi-event-bridge.ts | ~1519 | compaction | Auto-compaction completed |
| packages/memory/src/sqlite-memory-adapter.ts | ~95 | memory-store | Memory store complete |

**Total: 31 step:-tagged logger calls** (pre-plan: ~10)

## Step: Coverage Before and After

| Metric | Before | After |
|--------|--------|-------|
| Production step: tag count | ~10 | 31 |
| ROADMAP SC1 stages covered | 4/11 (delivery/context/security/mcp via existing tags) | 11/11 |
| Forensic INFO events with step: | 0/7 | 7/7 |
| Channel-inbound sites with step: | 0/9 | 9/9 |
| Arch test assertions GREEN | N/A | 28/28 |

## Architecture Test

`test/architecture/pipeline-step-coverage.test.ts` — 28 tests across 3 describe blocks:
1. "each known pipeline stage emits at least one step:-tagged log line" (11 tests, one per ROADMAP SC1 stage)
2. "7 forensic INFO events carry step: tags" (7 tests, mirroring forensic-events-info-level.test.ts shape)
3. "9 channel-inbound 'Inbound message' sites carry step:'channels-inbound'" (9 tests + 1 sanity check)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] pi-event-bridge.test.ts assertion broken by step: addition**
- **Found during:** Task 3 / pnpm validate
- **Issue:** Existing test asserted exact match `{ sessionKey: "t1:u1:c1" }` for "Auto-compaction started" logger call; adding `step: "compaction"` broke the exact-match assertion
- **Fix:** Updated test to `{ step: "compaction", sessionKey: "t1:u1:c1" }` — payload is additive, test is corrected to reflect new reality
- **Files modified:** packages/agent/src/bridge/pi-event-bridge.test.ts
- **Commit:** 3dca0d1

### STAGE_TOKEN_MAP Widened (Planned Deviation per Task 3 action)

Per Task 3 action instructions: "Prefer the latter approach (no new file edits beyond the 6 in this task's files_modified) ... Update Task 1's STAGE_TOKEN_MAP accordingly."

- `inbound` tokens widened from `["channels-inbound"]` to `["channels-inbound", "channel-registry"]` — covers channel-manager.ts Adapter registered site which uses `step: "channel-registry"` per plan artifacts
- `delivery`, `context`, `security`, `mcp` stages accept pre-existing tags in the codebase — no new files needed

### echo-adapter Excluded from CHANNEL_INBOUND_SITES (Planned Deviation)

The plan mentions tagging echo-adapter but the echo-adapter is a pure in-memory test stub (EchoChannelAdapter class) with no logger instance and no "Inbound message" logger.info call. It routes injected messages directly through handlers without logging. The arch test covers 9 production adapters instead of 10. Adding a logger to echo would require an interface change (constructor injection of a logger) that is out of scope and could break existing tests that use the echo adapter in isolation.

### model-retry.ts Added (Beyond Plan's files_modified)

- `packages/agent/src/executor/model-retry.ts` not in plan's files_modified but was added to cover the `retry` stage which had no existing step:-tagged emit
- "Primary model prompt error" WARN is the canonical entry point for the retry flow
- This is a minimal addition (1 line) confined to one file; no new imports or interfaces

## Self-Check

Files exist:
- test/architecture/pipeline-step-coverage.test.ts: FOUND
- packages/channels/src/discord/discord-adapter.ts: FOUND (step: channels-inbound + channels-outbound)
- packages/orchestrator/src/queue/command-queue.ts: FOUND (step: queue-enqueue + queue-dequeue)
- packages/memory/src/sqlite-memory-adapter.ts: FOUND (step: memory-store)

Commits exist:
- 11f597d: FOUND (RED arch test)
- 812f2ba: FOUND (channel adapters)
- 3dca0d1: FOUND (orchestrator/agent/memory)

Final arch test result: 43/43 GREEN (28 pipeline-step-coverage + 15 forensic-events-info-level)

## Self-Check: PASSED
