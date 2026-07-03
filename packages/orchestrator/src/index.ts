// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/orchestrator — Inbound orchestration package.
 *
 * Houses inbound pipeline, execution coordination, channel manager lifecycle,
 * commands, routing, queue, session-key builder, and cross-session helpers.
 *
 * @module
 */

// Inbound pipeline
export * from "./inbound/inbound-pipeline.js";
export * from "./inbound/setup-and-route.js";
export * from "./inbound/resolve-and-preprocess.js";
export * from "./inbound/inbound-gate.js";

// Dedup detector. Re-exported so test/integration replay harness
// and the perf test can import createDedupDetector from @comis/orchestrator.
// Consumer: test/integration/incident-replay-2026-05-24.test.ts
export { createDedupDetector } from "./inbound/dedup-detector.js";
export type { DedupDetector, DedupDetectorOptions, DedupCheckResult } from "./inbound/dedup-detector.js";

// Execution coordination — execution-deliver travels with
// execution-pipeline (same ownership bucket). The former
// execution-policy phase was inlined into execution-pipeline.
export * from "./execution/execution-pipeline.js";
export * from "./execution/execution-execute.js";
export * from "./execution/execution-filter.js";
export * from "./execution/execution-deliver.js";

// Per-turn activity coordinator. The daemon
// composition root builds `ExecutionPipelineDeps.coordinatorFactory`
// from `createActivityTurnCoordinator` — capturing the per-channel renderer +
// injected TimerPort/ClockPort/logger, adapting acpProjection to the unified
// ActivityProjection signature. Imports ONLY @comis/core (the port + types); the
// orchestrator gains no @comis/observability dependency.
export {
  createActivityTurnCoordinator,
  type ActivityTurnCoordinator,
  type ActivityTurnCoordinatorDeps,
  type ActivityTurnCounters,
  type ActivityProjection,
  type ActivityBreakerGate,
  type ActivityKillSwitch,
  type CoordinatorFactory,
} from "./execution/activity-turn-coordinator.js";

// Auto-managed per-agent×channel circuit breaker (§17.7).
// Classifies on the ActivityRenderError.kind union: 3 consecutive `permission`
// errors trip STICKY (reset only on config reload), 5 consecutive
// `internal`|`transient_network` errors trip with a clock-delta half-open probe
// after 5 min. The daemon composition root will construct one instance and feed
// `isTripped`/`record` into the coordinator + `getTripped()` into the /status
// accessor — the live thread-through is the same documented composition-root
// follow-on as the kill switch factory wiring.
export {
  createActivityCircuitBreaker,
  type ActivityCircuitBreaker,
  type ActivityCircuitBreakerOptions,
  type BreakerKey,
  type BreakerReason,
  type RecordOutcome,
  type TrippedEntry,
} from "./execution/activity-circuit-breaker.js";

// Channel manager lifecycle.
// Exports: createChannelManager (factory), ChannelManager (interface),
// ChannelManagerDeps (deps shape), ProcessInboundMessageFn (callback type alias).
// The `processInboundMessage` dep-inject callback remains in the deps shape
// because channels cannot back-edge import orchestrator. Daemon wires it
// from the single construction site (setup-channels.ts:730) and the
// audit-coverage test enforces this required field.
export * from "./channel-manager.js";

// Canonical-name alias. `createOrchestrator` is the requirement-level name;
// `createChannelManager` is the implementation-level name retained for
// callsite stability. Both refer to the same factory.
export { createChannelManager as createOrchestrator } from "./channel-manager.js";

// Commands.
// Slash command parser + handler + budget command + prompt-skill matcher.
// Exports: parseSlashCommand, createCommandHandler, matchPromptSkillCommand,
// detectSkillCollisions, RESERVED_COMMAND_NAMES, parseUserTokenBudget,
// MIN_USER_BUDGET, MAX_USER_BUDGET, plus type re-exports.
// `createCostTracker` is NOT here — it lives at packages/agent/src/budget/.
export * from "./commands/index.js";

// Routing.
// Config-driven binding resolution for multi-agent dispatch.
// Exports: createMessageRouter (factory), resolveAgent (pure function),
// MessageRouter (interface), RoutableMessage (input shape).
export { createMessageRouter, resolveAgent } from "./routing/message-router.js";
export type { MessageRouter, RoutableMessage } from "./routing/message-router.js";

// Queue.
// Per-session command serialization, debounce buffering, follow-up triggering,
// and overflow / coalescer utilities.
// Named (not `export *`) to keep the public surface auditable.
export {
  createCommandQueue,
  createDebounceBuffer,
  createFollowupTrigger,
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
} from "./queue/index.js";

// Session key builder. Builds scoped session keys for DM/group routing
// with DM scope modes (none / per-peer / per-channel-peer / agent-prefix /
// thread-isolation). Only the builder + its co-located test + the
// dm-scope-integration.test.ts live here — other session files
// (session-lifecycle, session-write-lock, session-reset-policy,
// session-label-store, comis-session-manager) stay in agent.
export { buildScopedSessionKey, extractThreadId } from "./session-key/session-key-builder.js";
export type { DmScopeMode, ScopedSessionKeyParams } from "./session-key/session-key-builder.js";

// Cross-session orchestration. These helpers are orchestration over
// channels, not daemon-internal composition: the cross-session sender
// drives fire-and-forget / wait / ping-pong agent-to-agent messaging;
// the announcement batcher coalesces near-simultaneous sub-agent
// completions; the dead-letter queue persists failed announcement
// deliveries for later retry. ANNOUNCE_PARENT_TIMEOUT_MS and
// SubAgentRunnerLogger are inlined here
// to avoid an orchestrator->daemon back-edge (forbidden per
// @comis/orchestrator architecture invariants); daemon's
// `SubAgentRunnerLogger` shape remains structurally compatible with the
// `AnnouncementLogger` so existing daemon call sites
// (setup-cross-session.ts, sub-agent-runner.ts, sub-agent-result-processor.ts,
// graph-coordinator-state.ts) pass their loggers through unchanged.
export * from "./cross-session/cross-session-sender.js";
export * from "./cross-session/announcement-batcher.js";
export * from "./cross-session/announcement-dead-letter.js";

// Interactive approval router. The single server-side authority
// that parses signed button callbacks (lookup-FIRST-then-verify), rejects
// cross-session + post-resolution replays, and dispatches to ApprovalGate.
// Channels never import this — they reach signing via the @comis/core primitive.
export * from "./approval/index.js";
