// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/orchestrator — Inbound orchestration package.
 *
 * Phase 32 commit 3: inbound/* + execution/* moved in from
 * packages/channels/src/shared/. Subsequent commits land additional
 * orchestrator-internals:
 *   commit 4: channel-manager.ts (createChannelManager, ChannelManager,
 *             ChannelManagerDeps + ProcessInboundMessageFn) — landed.
 *   commit 6: commands/* (parseSlashCommand, createCommandHandler, ...)
 *   commit 7: routing/message-router.ts
 *   commit 8: queue/* (createCommandQueue, CommandQueue, ...)
 *   commit 9: session-key/session-key-builder.ts
 *   commit 11: cross-session/* (cross-session-sender, announcement-batcher,
 *              announcement-dead-letter) — landed.
 *
 * @module
 */

// Inbound pipeline (commit 3 — bucket A from packages/channels/src/shared/)
export * from "./inbound/inbound-pipeline.js";
export * from "./inbound/inbound-route.js";
export * from "./inbound/inbound-resolve.js";
export * from "./inbound/inbound-gate.js";
export * from "./inbound/inbound-preprocess.js";
export * from "./inbound/inbound-setup.js";

// Execution coordination (commit 3 — bucket A; OQ-3 resolution per
// packages/orchestrator/HELPER-OWNERSHIP-INVENTORY.md: execution-deliver and
// execution-policy are both bucket A, moving with execution-pipeline).
export * from "./execution/execution-pipeline.js";
export * from "./execution/execution-execute.js";
export * from "./execution/execution-filter.js";
export * from "./execution/execution-deliver.js";
export * from "./execution/execution-policy.js";

// Channel manager lifecycle (commit 4 — moved from packages/channels/src/shared/).
// Exports: createChannelManager (factory), ChannelManager (interface),
// ChannelManagerDeps (deps shape), ProcessInboundMessageFn (callback type alias).
// The `processInboundMessage` dep-inject callback (added at Wave 3 when channels
// could not back-edge import orchestrator) remains in the deps shape post-move:
// daemon still wires it from the single construction site (setup-channels.ts:730)
// and the audit-coverage test enforces this required field.
export * from "./channel-manager.js";

// ORCH-EXT-01 canonical-name alias. `createOrchestrator` is the
// requirement-level name; `createChannelManager` is the implementation-level
// name retained for callsite stability. Both refer to the same factory.
export { createChannelManager as createOrchestrator } from "./channel-manager.js";

// Commands (commit 6 — moved from packages/agent/src/commands/, ORCH-EXT-08).
// Slash command parser + handler + budget command + prompt-skill matcher.
// Exports: parseSlashCommand, createCommandHandler, matchPromptSkillCommand,
// detectSkillCollisions, RESERVED_COMMAND_NAMES, parseUserTokenBudget,
// MIN_USER_BUDGET, MAX_USER_BUDGET, plus type re-exports.
// `createCostTracker` is NOT here — it lives at packages/agent/src/budget/.
export * from "./commands/index.js";

// Routing (commit 7 — moved from packages/agent/src/routing/, ORCH-EXT-08).
// Config-driven binding resolution for multi-agent dispatch.
// Exports: createMessageRouter (factory), resolveAgent (pure function),
// MessageRouter (interface), RoutableMessage (input shape).
export { createMessageRouter, resolveAgent } from "./routing/message-router.js";
export type { MessageRouter, RoutableMessage } from "./routing/message-router.js";

// Queue (commit 8 — moved from packages/agent/src/queue/, ORCH-EXT-08; Wave A close).
// Per-session command serialization, debounce buffering, follow-up triggering,
// priority scheduling, and overflow / coalescer utilities.
// Named (not `export *`) for parity with the original agent/src/index.ts pattern
// (lines 208-219 pre-move) and to keep the public surface auditable.
export {
  createCommandQueue,
  createDebounceBuffer,
  createFollowupTrigger,
  createPriorityScheduler,
  applyOverflowPolicy,
  coalesceMessages,
} from "./queue/index.js";
export type {
  CommandQueue,
  CommandQueueDeps,
  QueueStats,
  SessionLane,
  OverflowResult,
  DebounceBuffer,
  DebounceBufferDeps,
  FollowupTrigger,
  FollowupTriggerDeps,
  PriorityScheduler,
  PrioritySchedulerDeps,
  LaneStats,
} from "./queue/index.js";

// Session key builder (commit 9 — surgical extraction from agent/src/session/,
// ORCH-EXT-08; Wave B start). Builds scoped session keys for DM/group routing
// with DM scope modes (none / per-peer / per-channel-peer / agent-prefix /
// thread-isolation). Only the builder + its co-located test + the
// dm-scope-integration.test.ts moved — other agent/src/session/ files
// (session-lifecycle, session-write-lock, session-reset-policy,
// session-label-store, comis-session-manager) stay in agent.
export { buildScopedSessionKey, extractThreadId } from "./session-key/session-key-builder.js";
export type { DmScopeMode, ScopedSessionKeyParams } from "./session-key/session-key-builder.js";

// Cross-session orchestration (commit 11 — moved from packages/daemon/src/,
// ORCH-EXT-11). These helpers are orchestration over channels, not daemon-internal
// composition: the cross-session sender drives fire-and-forget / wait / ping-pong
// agent-to-agent messaging; the announcement batcher coalesces near-simultaneous
// sub-agent completions; the dead-letter queue persists failed announcement
// deliveries for later retry. The two daemon-relative imports
// (ANNOUNCE_PARENT_TIMEOUT_MS, SubAgentRunnerLogger) that the batcher/DLQ relied
// on were inlined at move time to remove what would otherwise have been an
// orchestrator->daemon back-edge (forbidden per @comis/orchestrator architecture
// invariants); daemon's `SubAgentRunnerLogger` shape remains structurally
// compatible with the new `AnnouncementLogger` so existing daemon call sites
// (setup-cross-session.ts, sub-agent-runner.ts, sub-agent-result-processor.ts,
// graph-coordinator-state.ts) pass their loggers through unchanged.
export * from "./cross-session/cross-session-sender.js";
export * from "./cross-session/announcement-batcher.js";
export * from "./cross-session/announcement-dead-letter.js";
