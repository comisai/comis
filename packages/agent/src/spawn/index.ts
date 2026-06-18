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

export { createSubAgentRunner, ANNOUNCE_PARENT_TIMEOUT_MS } from "./sub-agent-runner.js";
export type { SubAgentRunnerDeps, SubAgentRun, SpawnParams, SubAgentRunnerLogger } from "./sub-agent-runner.js";

export { sweepResultFiles, buildAnnouncementMessage, deliverFailureNotification, classifyErrorContext } from "./sub-agent-result-processor.js";
export { buildAnnounceKey, createDeliveryDedup, MAX_DELIVERED_KEYS } from "./announce-key.js";
export type { DeliveryDedup } from "./announce-key.js";
