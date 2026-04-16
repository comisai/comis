/**
 * Spawn module: SpawnPacketBuilder factory, parent summary generation,
 * and result condensation pipeline.
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
