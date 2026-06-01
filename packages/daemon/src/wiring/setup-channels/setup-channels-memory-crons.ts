// SPDX-License-Identifier: Apache-2.0
/**
 * The two LLM-backed memory-cron sentinel handlers — `__MEMORY_CONSOLIDATION__`
 * (Phase 84, CONS-07) and `__MEMORY_REASONING__` (Phase 101, REASON-02/03) —
 * extracted from setup-channels-credentials.ts to keep that leaf under the 600L
 * setup-channels cap.
 *
 * Both mirror the review branch 1:1: the cron is registered ONLY for an
 * operator-enabled agent (setup-schedulers), but each sentinel ALSO re-checks
 * cfg.enabled and short-circuits ok when off (defence-in-depth — a stale persisted
 * job must not run for a now-disabled agent). The cheap "cron" operation model +
 * the API key (resolved by NAME, never logged by value) are resolved identically.
 *
 * The reasoning sentinel injects BOTH segregated stores — `consolidationStore` (the
 * inductive applyConsolidation write) AND `tripleStore` (the deductive trust-first
 * upsertTriple write, the field-plumbing chain completed daemon → registry →
 * credentials) — plus the OFFLINE reason() seam built from the cheap cron model via
 * `createReasoningSeam` (the specialist prompts stay agent-internal). The agent
 * receives the stores as port TYPES only (the agent↛memory cut).
 *
 * @module
 */

import type { AppContainer, ClockPort, MemoryConsolidationStore, TripleStorePort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { resolveOperationModel, resolveProviderFamily, runMemoryConsolidation, runMemoryReasoning, createReasoningSeam } from "@comis/agent";

/** The minimal `scheduler:job_result` payload shape the sentinel handlers read. */
interface MemoryCronPayload {
  result?: string;
  agentId?: string;
  onComplete?: (result: { status: "ok" | "error"; error?: string }) => void;
}

/** Closure-captured context the sentinel handlers need (a subset of the deps). */
export interface MemoryCronContext {
  container: AppContainer;
  logger: ComisLogger;
  clock: ClockPort;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- container.config.agents PerAgentConfig map (erased at the dispatch boundary)
  agents: Record<string, any>;
  tenantId?: string;
  /** Injected from setup-memory (CONS-07): the inductive applyConsolidation write. */
  consolidationStore?: MemoryConsolidationStore;
  /** Injected from setup-memory (REASON-02): the deductive trust-first upsertTriple write. */
  tripleStore?: TripleStorePort;
}

/**
 * Handle an LLM-backed memory-cron sentinel (`__MEMORY_CONSOLIDATION__` /
 * `__MEMORY_REASONING__`). Returns `true` when the sentinel was recognized + handled
 * (the caller then returns), `false` when it is neither (the caller falls through to
 * the normal delivery path). Mirrors the prior inline blocks verbatim.
 */
export async function handleMemoryCronSentinel(
  resultText: string | undefined,
  payload: MemoryCronPayload,
  ctx: MemoryCronContext,
): Promise<boolean> {
  const { container, logger, clock, agents, tenantId, consolidationStore, tripleStore } = ctx;

  // -- Memory consolidation sentinel intercept (Phase 84, CONS-07) --
  if (resultText === "__MEMORY_CONSOLIDATION__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Memory consolidation job fired without agentId", errorKind: "config" as const }, "Skipping memory consolidation -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for memory consolidation" });
      return true;
    }

    const agentConfig = agents[agentId];
    const consolidationConfig = agentConfig?.memoryConsolidation;
    if (!consolidationConfig?.enabled) {
      // The opt-in cost gate (CONS-07): a disabled (or default-config) agent does
      // NO LLM work — short-circuit ok so the scheduler records a clean run.
      logger.debug({ agentId }, "Memory consolidation disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // Resolve the cheap model for consolidation via the "cron" operation type
    // (IDENTICAL to the review block) — never the agent's primary model.
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    // Resolve the API key for the provider. The no-key branch logs only the
    // env-var NAME + a hint — never the value (T-84-20; Pino also auto-redacts).
    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? "";
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for memory consolidation`, errorKind: "config" as const }, "Skipping memory consolidation -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const consolidationResult = await runMemoryConsolidation({
      agentId,
      tenantId: tenantId ?? container.config.tenantId ?? "default",
      config: consolidationConfig,
      // Injected from setup-memory (the composition-root join). The agent receives
      // the port TYPE only — no agent→memory edge (T-84-21).
      consolidationStore: consolidationStore!,
      eventBus: container.eventBus,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      clock,
      logger: logger.child({ agentId, submodule: "memory-consolidation" }),
    });

    if (!consolidationResult.ok) {
      logger.error({ agentId, err: consolidationResult.error, hint: "Memory consolidation failed -- will retry next cycle", errorKind: "internal" as const }, "Memory consolidation error");
    }
    payload.onComplete?.({ status: consolidationResult.ok ? "ok" : "error", error: consolidationResult.ok ? undefined : consolidationResult.error?.message });
    return true;
  }

  // -- Memory reasoning sentinel intercept (Phase 101, REASON-02/03 — 101-06) --
  // Mirrors the consolidation branch above 1:1, injecting BOTH stores + the OFFLINE
  // reason() seam (createReasoningSeam keeps the specialist prompts agent-internal).
  if (resultText === "__MEMORY_REASONING__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Memory reasoning job fired without agentId", errorKind: "config" as const }, "Skipping memory reasoning -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for memory reasoning" });
      return true;
    }

    const agentConfig = agents[agentId];
    const reasoningConfig = agentConfig?.memoryReasoning;
    if (!reasoningConfig?.enabled) {
      // The opt-in cost gate (T-101-06-02): a disabled (or default-config) agent
      // does NO LLM work — short-circuit ok so the scheduler records a clean run.
      logger.debug({ agentId }, "Memory reasoning disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // Resolve the cheap model for reasoning via the "cron" operation type
    // (IDENTICAL to the consolidation block) — never the agent's primary model.
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    // Resolve the API key for the provider. The no-key branch logs only the
    // env-var NAME + a hint — never the value (T-101-06-03; Pino also auto-redacts).
    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? "";
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for memory reasoning`, errorKind: "config" as const }, "Skipping memory reasoning -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const reasoningLogger = logger.child({ agentId, submodule: "memory-reasoning" });
    const reasoningResult = await runMemoryReasoning({
      agentId,
      tenantId: tenantId ?? container.config.tenantId ?? "default",
      config: reasoningConfig,
      // BOTH stores injected from setup-memory (the composition-root join). The
      // agent receives the port TYPES only — no agent→memory edge (T-101-06-01).
      consolidationStore: consolidationStore!,   // inductive applyConsolidation
      tripleStore: tripleStore!,                 // deductive trust-first upsertTriple
      eventBus: container.eventBus,
      clock,
      logger: reasoningLogger,
      // The OFFLINE reasoning seam — a cheap-model completeSimple over the
      // DEDUCTIVE/INDUCTIVE prompts + the lenient parsers, built in @comis/agent so
      // the prompt strings never cross the package boundary. Bounded by
      // maxReasoningTokens; non-fatal (a thrown/malformed call → empty arrays).
      reason: createReasoningSeam({
        provider: resolved.provider,
        modelId: resolved.modelId,
        apiKey,
        maxReasoningTokens: reasoningConfig.maxReasoningTokens ?? 1024,
        clock,
        logger: reasoningLogger,
        agentId,
      }),
    });

    if (!reasoningResult.ok) {
      logger.error({ agentId, err: reasoningResult.error, hint: "Memory reasoning failed -- will retry next cycle", errorKind: "internal" as const }, "Memory reasoning error");
    }
    payload.onComplete?.({ status: reasoningResult.ok ? "ok" : "error", error: reasoningResult.ok ? undefined : reasoningResult.error?.message });
    return true;
  }

  return false;
}
