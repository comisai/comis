// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config schema.
 *
 * Re-exports all Zod schemas + the top-level AgentConfigSchema. The split
 * keeps AppConfigSchema.agents byte-identical so the section-registry-parity
 * snapshot reproduces verbatim post-split.
 *
 * Module layout (4 leaves):
 *   - schema-agent-model.ts    — Model selection (Budget, CircuitBreaker,
 *                                ModelRoutes, ModelFailover, PromptTimeout,
 *                                OperationModels, plus types)
 *   - schema-agent-context.ts  — Session lifecycle (ResetPolicy, DmScope,
 *                                Pruning, SessionCompaction) + Context engine
 *                                (ContextEngineConfig) + Context guard
 *                                (ContextPruning, SourceGate)
 *   - schema-agent-prompt.ts   — Auxiliary helpers (Routing, Rag, Bootstrap,
 *                                Concurrency, Broadcast, ElevatedReply,
 *                                Tracing, SdkRetry, ContextGuard,
 *                                ToolLifecycle, DeferredTools, Sep)
 *   - schema-agent-runtime.ts  — Composition root: AgentConfigSchema,
 *                                PerAgentConfigSchema, PerAgent scheduler /
 *                                heartbeat / cron, AgentsMapSchema
 *
 * Dependency direction (one-directional):
 *   runtime ← { model, context, prompt }   // composition root
 *   { model, context, prompt }: no cross-leaf imports
 *
 * @module
 */
export * from "./schema-agent-model.js";
export * from "./schema-agent-context.js";
export * from "./schema-agent-prompt.js";
export * from "./schema-agent-autonomy.js";
// 213-03: the autonomy BOUNDS sub-blocks + the honest-degrade path live in
// sibling leaves (file-size cap + concern split); exported here so the public
// surface is unchanged. `*-bounds` imports only zod; `*-degrade` imports one-way
// from `*-autonomy` (no cycle — see no-cycles.test.ts).
export * from "./schema-agent-autonomy-bounds.js";
export * from "./schema-agent-autonomy-degrade.js";
// Phase 216: the autonomy.durability sub-block schema (nested into
// AutonomyConfigSchema). Exported so the daemon reads DurabilityConfigSchema
// for the boot-time durability resolution.
export * from "./schema-agent-autonomy-durability.js";
export * from "./schema-agent-runtime.js";
