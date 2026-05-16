// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config schema (Phase 43 split per FILE-SPLIT-14).
 *
 * Re-exports all Zod schemas + the top-level AgentConfigSchema. The split
 * keeps AppConfigSchema.agents byte-identical so section-registry-parity.test.ts
 * (CONFIG-DELIV-03) snapshot reproduces verbatim post-split.
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
export * from "./schema-agent-runtime.js";
