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

import type { AppContainer, ClockPort, MemoryConsolidationStore, TripleStorePort, UserRepresentationStore, RelationshipStore } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi } from "@comis/memory";
import { resolveOperationModel, resolveProviderFamily, runMemoryConsolidation, runMemoryReasoning, createReasoningSeam, runUserRepresentationBuild, createUserRepresentationSeam, runRelationshipBuild, createRelationshipSeam, type UserRepresentationSourceMemory, type RelationshipSourceMemory } from "@comis/agent";

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
  /** Injected from setup-memory (USER-03): the per-user profile upsert write path
   *  (the __USER_REPRESENTATION__ sentinel). The agent receives the port TYPE only. */
  userRepresentationStore?: UserRepresentationStore;
  /** Injected from setup-memory (Phase 108, SOCIAL-01/02): the per-(tenant, agent, channel)
   *  directional-edge upsert write path the __SOCIAL_MODELING__ sentinel drives. The agent
   *  receives the port TYPE only (the agent↛memory cut). */
  relationshipStore?: RelationshipStore;
  /** Injected from setup-memory (USER-04): the read surface the __USER_REPRESENTATION__
   *  sentinel scopes the per-(tenant, agent, user) high-trust source read over (the
   *  concrete `readSources` seam runUserRepresentationBuild injects — kept daemon-side so
   *  the agent imports no memory package). The SAME `inspect` surface backs the
   *  __SOCIAL_MODELING__ sentinel (grouped by resolved channelId in Task 2). */
  memoryApi?: MemoryApi;
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
  const { container, logger, clock, agents, tenantId, consolidationStore, tripleStore, userRepresentationStore, relationshipStore, memoryApi } = ctx;

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

  // -- Per-user representation sentinel intercept (Phase 107, USER-03/04 — Track E1) --
  // Mirrors the reasoning branch above 1:1: the opt-in cost gate (re-check enabled), the cheap
  // "cron" model + key (resolved by NAME, never logged), then the OFFLINE build() seam
  // (createUserRepresentationSeam keeps USER_REPRESENTATION_PROMPT agent-internal). The cron
  // fires per (tenant, agent); it builds a profile for EACH distinct user the agent has
  // high-trust memories for — runUserRepresentationBuild is invoked once per userId, scoped to
  // (tenant, agent, user), with a readSources seam that yields ONLY that user's high-trust
  // sources (the anti-poisoning external-exclude + the redaction firewall live in the job).
  if (resultText === "__USER_REPRESENTATION__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "User representation job fired without agentId", errorKind: "config" as const }, "Skipping user representation build -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for user representation build" });
      return true;
    }

    const agentConfig = agents[agentId];
    const userReprConfig = agentConfig?.memoryUserRepresentation;
    if (!userReprConfig?.enabled) {
      // The opt-in cost gate: a disabled (or default-config) agent does NO LLM work —
      // short-circuit ok so the scheduler records a clean run (mirror the reasoning gate).
      logger.debug({ agentId }, "User representation build disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The read surface MUST be present (injected from setup-memory). Absent => cannot scope
    // the per-user source read — surface a clean error rather than silently no-op.
    if (!memoryApi || !userRepresentationStore) {
      logger.warn({ agentId, hint: "memoryApi/userRepresentationStore not injected -- cannot build per-user profile", errorKind: "config" as const }, "Skipping user representation build -- store/read surface missing");
      payload.onComplete?.({ status: "error", error: "User representation read/write surface not wired" });
      return true;
    }

    // Resolve the cheap model via the "cron" operation type (IDENTICAL to the reasoning block).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? "";
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for user representation build`, errorKind: "config" as const }, "Skipping user representation build -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const reprTenantId = tenantId ?? container.config.tenantId ?? "default";
    const reprLogger = logger.child({ agentId, submodule: "user-representation" });

    // Read the agent's HIGH-TRUST source memories (system + learned) once, then group by user.
    // InspectFilters has no userId axis, so the read is per-(tenant, agent) and the grouping is
    // done here; each user's slice becomes that user's readSources seam (the anti-poisoning
    // external-exclude is the job's, but inspecting only system|learned is a first belt).
    //
    // MR-01: `inspect` orders `created_at DESC` and applies `limit` BEFORE grouping, so a
    // trust level with > SOURCE_READ_LIMIT rows is SILENTLY truncated to the newest window
    // across ALL users (a chatty user can crowd out a quieter one; older identity/preference
    // facts never reach the builder). We cannot page here without an offset axis on
    // InspectFilters, so at minimum we make the truncation OBSERVABLE: when a read returns
    // exactly the cap, emit a counts-only WARN with a hint so an operator can diagnose a thin
    // profile (per AGENTS.md §2.7 observability discipline — no SILENT truncation).
    const SOURCE_READ_LIMIT = 1000;
    const sourcesByUser = new Map<string, UserRepresentationSourceMemory[]>();
    for (const trustLevel of ["system", "learned"] as const) {
      const rows = memoryApi.inspect({ tenantId: reprTenantId, agentId, trustLevel, limit: SOURCE_READ_LIMIT });
      if (rows.length >= SOURCE_READ_LIMIT) {
        reprLogger.warn(
          {
            agentId,
            trustLevel,
            limit: SOURCE_READ_LIMIT,
            returned: rows.length,
            errorKind: "validation" as const,
            hint: "high-trust source read hit the per-trust-level cap — only the NEWEST sources are distilled into per-user profiles this run; older facts are dropped and per-user profiles may be incomplete/non-deterministic. Reduce retention or split the agent if this persists",
          },
          "User representation source read truncated at the per-trust-level cap (MR-01)",
        );
      }
      for (const row of rows) {
        const list = sourcesByUser.get(row.userId) ?? [];
        list.push({ id: row.id, content: row.content, trustLevel: row.trustLevel as "system" | "learned" | "external" });
        sourcesByUser.set(row.userId, list);
      }
    }

    // Build the cheap-model seam ONCE (reused across users — the prompt is per-source-text).
    const build = createUserRepresentationSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: 1024,
      clock,
      logger: reprLogger,
      agentId,
    });

    let anyError = false;
    for (const [userId, sources] of sourcesByUser) {
      const result = await runUserRepresentationBuild({
        agentId,
        tenantId: reprTenantId,
        userId,
        config: {
          enabled: userReprConfig.enabled,
          maxEntriesPerRun: userReprConfig.maxEntriesPerRun,
          // MR-02 per-build INPUT bounds (forwarded so an operator's knobs reach the
          // job; the job also defaults them when absent).
          maxSourceMemories: userReprConfig.maxSourceMemories,
          maxSourceChars: userReprConfig.maxSourceChars,
        },
        // Injected from setup-memory (the composition-root join) — the port TYPE only.
        userRepresentationStore,
        // The scoped read seam: this user's already-fetched high-trust sources (the job
        // runs its own external-exclude + redaction firewall over them).
        readSources: () => Promise.resolve({ ok: true as const, value: sources }),
        clock,
        logger: reprLogger,
        eventBus: container.eventBus,
        build,
      });
      if (!result.ok) {
        anyError = true;
        reprLogger.error({ agentId, userId, err: result.error, hint: "User representation build failed for user -- will retry next cycle", errorKind: "internal" as const }, "User representation build error");
      }
    }

    payload.onComplete?.({ status: anyError ? "error" : "ok", error: anyError ? "One or more per-user representation builds failed" : undefined });
    return true;
  }

  // -- Social modeling sentinel intercept (Phase 108, SOCIAL-01/02/03) --
  // The offline DIRECTIONAL relationship builder. It fires per (tenant, agent); it groups the
  // agent's high-trust sources by RESOLVED channelId (the SOCIAL-02 per-channel privacy boundary)
  // and invokes runRelationshipBuild ONCE per channel, scoped to (tenant, agent, channel), with a
  // readSources seam yielding that channel's multi-user sources (sender attribution preserved). The
  // anti-poisoning external-exclude + the redaction firewall live in the job. The gate is STRICTER
  // than the representation cron: it requires BOTH enabled AND a recorded privacy-review sign-off.
  if (resultText === "__SOCIAL_MODELING__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Social modeling job fired without agentId", errorKind: "config" as const }, "Skipping social modeling build -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for social modeling build" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.socialModeling;
    // The SOCIAL-03 dual gate (defense-in-depth with the scheduler registration): refuse to run
    // unless the feature is enabled AND a privacy-review sign-off is recorded. A knob-on-but-not-
    // signed-off agent does NO LLM work + NO write — short-circuit ok (clean no-op, byte-identical).
    if (!cfg?.enabled || !cfg?.privacyReviewSignedOffBy) {
      logger.debug({ agentId }, "Social modeling disabled or not privacy-signed-off for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The read surface + the write store MUST be present (injected from setup-memory). Absent =>
    // cannot scope the per-channel source read / write — surface a clean error rather than no-op.
    if (!memoryApi || !relationshipStore) {
      logger.warn({ agentId, hint: "memoryApi/relationshipStore not injected -- cannot build per-channel relationships", errorKind: "config" as const }, "Skipping social modeling build -- store/read surface missing");
      payload.onComplete?.({ status: "error", error: "Social modeling read/write surface not wired" });
      return true;
    }

    // Resolve the cheap model via the "cron" operation type (IDENTICAL to the representation block).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? "";
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for social modeling build`, errorKind: "config" as const }, "Skipping social modeling build -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const relTenantId = tenantId ?? container.config.tenantId ?? "default";
    const relLogger = logger.child({ agentId, submodule: "social-modeling" });

    // Read the agent's HIGH-TRUST source memories (system + learned) once, then group by the
    // RESOLVED channelId (the SOCIAL-02 write-side boundary). InspectFilters has no channel axis,
    // so the read is per-(tenant, agent) and the grouping is done here (mirror the per-user grouping
    // in the representation cron). channelId is recovered from each source's session key via
    // parseFormattedSessionKey; a source whose channelId CANNOT be resolved (NULL session key —
    // system/non-conversation memories) is SKIPPED + counted (Pitfall 1: NEVER bucket undefined —
    // that would collapse cross-channel sources into one leak bucket). entry.userId is the SPEAKER
    // (the subject candidate; sender attribution is preserved into the build seam, RQ3).
    const SOURCE_READ_LIMIT = 1000;
    const sourcesByChannel = new Map<string, RelationshipSourceMemory[]>();
    let skippedNoChannel = 0;
    for (const trustLevel of ["system", "learned"] as const) {
      const rows = memoryApi.inspect({ tenantId: relTenantId, agentId, trustLevel, limit: SOURCE_READ_LIMIT });
      if (rows.length >= SOURCE_READ_LIMIT) {
        relLogger.warn(
          {
            agentId,
            trustLevel,
            limit: SOURCE_READ_LIMIT,
            returned: rows.length,
            errorKind: "validation" as const,
            hint: "high-trust source read hit the per-trust-level cap — only the NEWEST sources are distilled into per-channel relationships this run; older facts are dropped and per-channel edges may be incomplete/non-deterministic. Reduce retention or split the agent if this persists",
          },
          "Social modeling source read truncated at the per-trust-level cap (MR-01)",
        );
      }
      for (const row of rows) {
        const channelId = row.source?.sessionKey
          ? parseFormattedSessionKey(row.source.sessionKey)?.channelId
          : undefined;
        if (!channelId) {
          // Counts-only skip — never bucket an unresolved channelId (Pitfall 1).
          skippedNoChannel++;
          continue;
        }
        const list = sourcesByChannel.get(channelId) ?? [];
        list.push({ id: row.id, userId: row.userId, content: row.content, trustLevel: row.trustLevel as "system" | "learned" | "external" });
        sourcesByChannel.set(channelId, list);
      }
    }
    if (skippedNoChannel > 0) {
      // Observable (counts-only) — an operator can diagnose a thin per-channel set vs message volume.
      relLogger.warn(
        { agentId, skippedNoChannel, errorKind: "validation" as const, hint: "sources with an unresolvable channel id (NULL/system session key) were skipped — they are NOT bucketed into any channel (the SOCIAL-02 per-channel boundary)" },
        "Social modeling skipped sources with no resolvable channel id",
      );
    }

    // Build the cheap-model seam ONCE (reused across channels — the prompt is per-source-text).
    const build = createRelationshipSeam({
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: 1024,
      clock,
      logger: relLogger,
      agentId,
    });

    let anyError = false;
    for (const [channelId, sources] of sourcesByChannel) {
      const result = await runRelationshipBuild({
        agentId,
        tenantId: relTenantId,
        channelId,
        config: {
          enabled: cfg.enabled,
          maxEntriesPerRun: cfg.maxEntriesPerRun,
          // MR-02 per-build INPUT bounds (forwarded so an operator's knobs reach the job; the job
          // also defaults them when absent).
          maxSourceMemories: cfg.maxSourceMemories,
          maxSourceChars: cfg.maxSourceChars,
        },
        // Injected from setup-memory (the composition-root join) — the port TYPE only.
        relationshipStore,
        // The scoped read seam: this channel's already-fetched high-trust sources (the job runs its
        // own external-exclude + redaction firewall over them).
        readSources: () => Promise.resolve({ ok: true as const, value: sources }),
        clock,
        logger: relLogger,
        eventBus: container.eventBus,
        build,
      });
      if (!result.ok) {
        anyError = true;
        relLogger.error({ agentId, channelId, err: result.error, hint: "Social modeling build failed for channel -- will retry next cycle", errorKind: "internal" as const }, "Social modeling build error");
      }
    }

    payload.onComplete?.({ status: anyError ? "error" : "ok", error: anyError ? "One or more per-channel relationship builds failed" : undefined });
    return true;
  }

  return false;
}
