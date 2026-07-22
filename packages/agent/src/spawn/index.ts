// SPDX-License-Identifier: Apache-2.0
/**
 * Spawn module: SpawnPacketBuilder factory, parent summary generation,
 * result condensation pipeline, and sub-agent spawn lifecycle.
 *
 * @module
 */

export { createSpawnPacketBuilder } from "./spawn-packet-builder.js";
export type { SpawnPacketBuilderDeps, SpawnPacketBuildParams } from "./spawn-packet-builder.js";

export { generateParentSummary } from "./generate-parent-summary.js";
export type { GenerateParentSummaryDeps } from "./generate-parent-summary.js";

export { createResultCondenser } from "./result-condenser.js";
export type { ResultCondenserDeps, CondenseParams } from "./result-condenser.js";

export { createNarrativeCaster } from "./narrative-caster.js";
export type { NarrativeCasterConfig, CastParams } from "./narrative-caster.js";

export { createLifecycleHooks, deriveSubagentContextEngineConfig } from "./lifecycle-hooks.js";
export type { LifecycleHooksDeps } from "./lifecycle-hooks.js";

export { createEphemeralComisSessionManager } from "./pi-mono-adapters.js";

export { createSubAgentRunner, SubAgentSpawnPausedError } from "./sub-agent-runner.js";
export type {
  SubAgentRunnerDeps,
  SubAgentRun,
  SubAgentQueuedRun,
  SubAgentRunningRun,
  SubAgentCompletedRun,
  SubAgentFailedRun,
  SubAgentCompletion,
  SubAgentRunTelemetry,
  SubAgentWaitResult,
  SpawnParams,
  SubAgentRunnerLogger,
  SubAgentSpawnAdmissionState,
  SubAgentSpawnAdmissionMutation,
} from "./sub-agent-runner.js";

export { sweepResultFiles, buildAnnouncementMessage, deliverFailureNotification } from "./sub-agent-result-processor.js";
// createDeliveryDedup + DeliveryDedup cross the package boundary (the orchestrator
// batcher + daemon wiring share one bounded delivered-key store). buildAnnounceKey
// and MAX_DELIVERED_KEYS stay agent-internal (used only within spawn/ + the agent's
// own tests via relative import) — not re-exported, to avoid a dead public export.
export { createDeliveryDedup } from "./announce-key.js";
export type { DeliveryDedup } from "./announce-key.js";

// Pure sandbox-posture primitive. The comparator + resolver are a
// @comis/agent leaf; the daemon wiring injects a resolver closure over
// container.config.agents into the sub-agent runner, so the TYPE + comparator must
// cross the package boundary here.
export { comparePosture, resolvePostureFromSkills } from "./sandbox-posture.js";
export type {
  SandboxPosture,
  PostureDimension,
  PostureComparison,
  SkillsPostureSlice,
} from "./sandbox-posture.js";
