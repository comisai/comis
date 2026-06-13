// SPDX-License-Identifier: Apache-2.0
/**
 * The memory-cron sentinel handlers — extracted from setup-channels-credentials.ts
 * to keep that leaf under the 600L setup-channels cap. The LLM-backed sentinels
 * (__MEMORY_CONSOLIDATION__ P84, __MEMORY_REASONING__ P101, __USER_REPRESENTATION__
 * P107, __SOCIAL_MODELING__ P108) resolve a cheap "cron" model + an API key (by NAME,
 * never logged); the KEYLESS sentinels (__ONLINE_TUNING__ P111, __MEMORY_LIFECYCLE__
 * P112) resolve NO model + NO key.
 *
 * All mirror the review branch: the cron registers ONLY for an operator-enabled agent
 * (setup-schedulers), but each sentinel ALSO re-checks cfg.enabled + short-circuits ok
 * when off (defence-in-depth — a stale persisted job must not run for a now-disabled
 * agent). Each injects its segregated store(s) as port TYPES only (the agent↛memory cut)
 * + (the LLM ones) the OFFLINE seam built from the cheap model (prompts stay agent-internal).
 *
 * @module
 */

import type { AppContainer, ClockPort, MemoryConsolidationStore, TripleStorePort, UserRepresentationStore, RelationshipStore, TunedAlphaStore, MemoryUsefulnessStore, MemoryLifecyclePort } from "@comis/core";
import { parseFormattedSessionKey, KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi } from "@comis/memory";
import { resolveOperationModel, resolveProviderFamily, runMemoryConsolidation, runMemoryReasoning, createReasoningSeam, runUserRepresentationBuild, createUserRepresentationSeam, runRelationshipBuild, createRelationshipSeam, runOnlineTuning, type UserRepresentationSourceMemory, type RelationshipSourceMemory, type OnlineTuningFeedEntry } from "@comis/agent";
import { resolveMemoryOpsCapability } from "./resolve-memory-ops-capability.js";

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
  // All stores below are injected from setup-memory on the shared db; the agent
  // receives the port TYPE only (the agent↛memory cut). Each backs the named sentinel.
  /** The inductive applyConsolidation write (__MEMORY_CONSOLIDATION__). */
  consolidationStore?: MemoryConsolidationStore;
  /** The deductive trust-first upsertTriple write (__MEMORY_REASONING__). */
  tripleStore?: TripleStorePort;
  /** The per-user profile upsert write (__USER_REPRESENTATION__). */
  userRepresentationStore?: UserRepresentationStore;
  /** The per-(tenant, agent, channel) directional-edge upsert (__SOCIAL_MODELING__). */
  relationshipStore?: RelationshipStore;
  /** The tuned-alpha upsert write the KEYLESS bandit drives (__ONLINE_TUNING__). */
  tunedAlphaStore?: TunedAlphaStore;
  /** The accrued per-memory usefulness READ surface (`readUsefulness`)
   *  the __ONLINE_TUNING__ sentinel scopes the bandit's FEED signal over. */
  usefulnessStore?: MemoryUsefulnessStore;
  /** The DORMANT lifecycle sweep the KEYLESS __MEMORY_LIFECYCLE__
   *  sentinel drives (`runLifecycleSweep(scope)`, per (tenant, agent) + injected `now`).
   *  DORMANT — even when enabled the sweep evicts/demotes 0 rows (live policy deferred). */
  memoryLifecycleStore?: MemoryLifecyclePort;
  /** The `inspect` read surface the __USER_REPRESENTATION__ / __SOCIAL_MODELING__
   *  (grouped by channelId) / __ONLINE_TUNING__ (the bounded candidate-id set) sentinels
   *  scope their per-(tenant, agent[, user/channel]) high-trust source reads over. */
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
  const { container, logger, clock, agents, tenantId, consolidationStore, tripleStore, userRepresentationStore, relationshipStore, tunedAlphaStore, usefulnessStore, memoryLifecycleStore, memoryApi } = ctx;

  // -- Memory consolidation sentinel intercept --
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
      // The opt-in cost gate: a disabled agent does NO LLM work (clean ok run).
      logger.debug({ agentId }, "Memory consolidation disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // Resolve the cheap "cron" model (never the agent's primary) + API key by NAME (Pino auto-redacts).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? (KEYLESS_PROVIDER_TYPES.has(resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for memory consolidation`, errorKind: "config" as const }, "Skipping memory consolidation -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }
    const consolidationResult = await runMemoryConsolidation({
      agentId,
      tenantId: tenantId ?? container.config.tenantId ?? "default",
      config: consolidationConfig,
      // Injected from setup-memory — the port TYPE only, no agent→memory edge.
      consolidationStore: consolidationStore!,
      eventBus: container.eventBus,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      clock,
      logger: logger.child({ agentId, submodule: "memory-consolidation" }),
      // R6 (CR-01): small/nano cron model abstains via resolve-memory-ops-capability.ts (never fabricates into trusted storage).
      ...resolveMemoryOpsCapability(resolved, providerEntry?.capabilities),
    });

    if (!consolidationResult.ok) {
      logger.error({ agentId, err: consolidationResult.error, hint: "Memory consolidation failed -- will retry next cycle", errorKind: "internal" as const }, "Memory consolidation error");
    }
    payload.onComplete?.({ status: consolidationResult.ok ? "ok" : "error", error: consolidationResult.ok ? undefined : consolidationResult.error?.message });
    return true;
  }

  // -- Memory reasoning sentinel intercept --
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
      // The opt-in cost gate: a disabled agent does NO LLM work (clean ok run).
      logger.debug({ agentId }, "Memory reasoning disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // Resolve the cheap "cron" model (never the agent's primary) + API key by NAME (Pino auto-redacts).
    const resolved = resolveOperationModel({
      operationType: "cron",
      agentProvider: agentConfig.provider ?? "anthropic",
      agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: agentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
    });

    const providerEntry = container.config.providers?.entries?.[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey = container.secretManager.get(apiKeyName) ?? (KEYLESS_PROVIDER_TYPES.has(resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
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
      // BOTH stores injected from setup-memory — the port TYPES only.
      consolidationStore: consolidationStore!,   // inductive applyConsolidation
      tripleStore: tripleStore!,                 // deductive trust-first upsertTriple
      eventBus: container.eventBus,
      clock,
      logger: reasoningLogger,
      // The OFFLINE reasoning seam — a cheap-model completeSimple over the DEDUCTIVE/INDUCTIVE
      // prompts (agent-internal), bounded by maxReasoningTokens; non-fatal (malformed → empty).
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

  // -- Per-user representation sentinel intercept --
  // Mirrors the reasoning branch (opt-in cost gate + cheap "cron" model/key + the OFFLINE
  // build() seam, prompts agent-internal). Fires per (tenant, agent); builds a profile for
  // EACH distinct high-trust user via runUserRepresentationBuild once per userId, scoped to
  // (tenant, agent, user) with a readSources seam yielding ONLY that user's high-trust sources
  // (the anti-poisoning external-exclude + the redaction firewall live in the job).
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
    const apiKey = container.secretManager.get(apiKeyName) ?? (KEYLESS_PROVIDER_TYPES.has(resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for user representation build`, errorKind: "config" as const }, "Skipping user representation build -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const reprTenantId = tenantId ?? container.config.tenantId ?? "default";
    const reprLogger = logger.child({ agentId, submodule: "user-representation" });

    // Read the agent's HIGH-TRUST sources (system + learned) once, group by user here
    // (InspectFilters has no userId axis); each user's slice becomes that user's readSources seam.
    // `inspect` orders created_at DESC + applies `limit` BEFORE grouping, so a trust level
    // with > SOURCE_READ_LIMIT rows is SILENTLY truncated to the newest window across ALL users
    // (a chatty user crowds out a quieter one). No offset axis to page, so we make the truncation
    // OBSERVABLE: a read returning exactly the cap emits a counts-only WARN (§2.7 — no silent drop).
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
          // Per-build INPUT bounds (forwarded; the job also defaults them when absent).
          maxSourceMemories: userReprConfig.maxSourceMemories,
          maxSourceChars: userReprConfig.maxSourceChars,
        },
        userRepresentationStore, // injected from setup-memory — the port TYPE only.
        // The scoped read seam: this user's high-trust sources (the job runs external-exclude + redaction).
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

  // -- Online-tuning bandit sentinel intercept --
  // The OFFLINE tuned-alpha bandit. UNLIKE the consolidation/reasoning/user-rep/social
  // sentinels above, it is DETERMINISTIC + KEYLESS: there is NO resolveOperationModel, NO
  // providerEntry, NO apiKey, NO build() seam (it deletes work the LLM crons do). It
  // reads the accrued FEED signal for a bounded recent candidate-id set, runs the pure clamped
  // computeTunedAlphas step (inside runOnlineTuning), and upserts a four-alpha vector. The job
  // is non-fatal + counts-only; trust is never tuned (config-sourced at the apply site).
  if (resultText === "__ONLINE_TUNING__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Online tuning job fired without agentId", errorKind: "config" as const }, "Skipping online tuning -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for online tuning" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.memoryOnlineTuning;
    if (!cfg?.enabled) {
      // The opt-in gate: a disabled (or default-config) agent does NOTHING — short-circuit ok
      // so the scheduler records a clean run (mirror the reasoning/user-rep gate). Byte-identical.
      logger.debug({ agentId }, "Online tuning disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The write store + the FEED read surface MUST both be present (injected from setup-memory).
    // Absent => cannot run the bandit — surface a clean error rather than silently no-op.
    if (!tunedAlphaStore || !usefulnessStore) {
      logger.warn({ agentId, hint: "tunedAlphaStore/usefulnessStore not injected -- cannot run the bandit", errorKind: "config" as const }, "Skipping online tuning -- tuned-alpha/usefulness surface not wired");
      payload.onComplete?.({ status: "error", error: "tuned-alpha/usefulness surface not wired" });
      return true;
    }

    // NO cheap-model resolution, NO provider entry, NO secret/key lookup, NO offline build
    // seam here — the bandit is deterministic + keyless (the binding constraint). It costs
    // nothing in LLM spend (the deletion vs the LLM-backed sentinels above).

    const tuningTenantId = tenantId ?? container.config.tenantId ?? "default";
    const tuningLogger = logger.child({ agentId, submodule: "online-tuning" });
    // The static rag.scoring baseline (the four non-trust alphas) the bandit starts from when no
    // tuned row exists yet. NEVER the trust weight (the ship-gate — trust stays config-sourced).
    const scoring = agentConfig?.rag?.scoring;
    const configScoring = {
      recencyAlpha: scoring?.recencyAlpha ?? 0.2,
      temporalAlpha: scoring?.temporalAlpha ?? 0.2,
      proofAlpha: scoring?.proofAlpha ?? 0.1,
      usefulnessAlpha: scoring?.usefulnessAlpha ?? 0.1,
    };

    // The injected FEED-read seam scoped to (tenant, agent) over a bounded recent candidate-id set
    // (the daemon's existing memory read surface; maxSourceMemories bounds it). A read failure is
    // non-fatal in the job — the bandit keeps the ranker's current weights.
    const maxSourceMemories = cfg.maxSourceMemories ?? 200;
    const readUsefulness = async (): Promise<Awaited<ReturnType<typeof usefulnessStore.readUsefulness>>> => {
      const ids = memoryApi
        ? memoryApi.inspect({ tenantId: tuningTenantId, agentId, limit: maxSourceMemories }).map((r) => r.id)
        : [];
      // readUsefulness returns Map<id, {usedCount, ignoredCount, lastUsefulAt?}>; OnlineTuningFeedEntry
      // is the counts-only subset the job aggregates (structurally compatible).
      return usefulnessStore.readUsefulness(ids, { tenantId: tuningTenantId, agentId });
    };

    const result = await runOnlineTuning({
      agentId,
      tenantId: tuningTenantId,
      config: { enabled: cfg.enabled, maxSourceMemories },
      // Injected from setup-memory (the composition-root join) — the port TYPE only.
      tunedAlphaStore,
      readUsefulness: readUsefulness as () => Promise<import("@comis/shared").Result<Map<string, OnlineTuningFeedEntry>, Error>>,
      configScoring,
      clock,
      logger: tuningLogger,
      eventBus: container.eventBus,
    });

    payload.onComplete?.({ status: result.ok ? "ok" : "error", error: result.ok ? undefined : result.error?.message });
    return true;
  }

  // -- Memory lifecycle sentinel intercept --
  // The DORMANT lifecycle sweep. Like the __ONLINE_TUNING__ bandit (NOT the LLM crons) it is
  // KEYLESS: NO resolveOperationModel, NO providerEntry, NO apiKey, NO build() seam.
  // It re-checks memoryLifecycle.enabled (defence-in-depth) + short-circuits ok when off; when
  // on it invokes runLifecycleSweep per (tenant, agent) with the INJECTED clock.now (never
  // Date.now). DORMANT: even when on it evicts/demotes/promotes 0 rows (live policy deferred).
  // Non-fatal + counts-only (the report numbers — NEVER a body/query, §2.7).
  if (resultText === "__MEMORY_LIFECYCLE__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Memory lifecycle job fired without agentId", errorKind: "config" as const }, "Skipping memory lifecycle -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for memory lifecycle" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.memoryLifecycle;
    if (!cfg?.enabled) {
      // The opt-in gate (defence-in-depth re-check): a disabled agent does NOTHING (clean ok run).
      logger.debug({ agentId }, "Memory lifecycle disabled for agent, skipping");
      payload.onComplete?.({ status: "ok" });
      return true;
    }

    // The DORMANT sweep store MUST be present (injected from setup-memory). Absent => clean error.
    if (!memoryLifecycleStore) {
      logger.warn({ agentId, hint: "memoryLifecycleStore not injected -- cannot run the lifecycle sweep", errorKind: "config" as const }, "Skipping memory lifecycle -- lifecycle store not wired");
      payload.onComplete?.({ status: "error", error: "memory lifecycle store not wired" });
      return true;
    }

    // KEYLESS: no model, no provider entry, no secret/key, no build seam — deterministic + $0.
    const lifecycleTenantId = tenantId ?? container.config.tenantId ?? "default";
    const lifecycleResult = await memoryLifecycleStore.runLifecycleSweep({ tenantId: lifecycleTenantId, agentId, now: clock.now() });

    if (!lifecycleResult.ok) {
      logger.error({ agentId, err: lifecycleResult.error, hint: "Memory lifecycle sweep failed -- will retry next cycle", errorKind: "internal" as const }, "Memory lifecycle sweep error");
    } else {
      // Counts ONLY — the DORMANT report (promoted/demoted/evicted always 0 in the scaffold). §2.7.
      const r = lifecycleResult.value;
      logger.child({ agentId, submodule: "memory-lifecycle" }).debug({ agentId, scanned: r.scanned, promoted: r.promoted, demoted: r.demoted, evicted: r.evicted }, "Memory lifecycle sweep complete (DORMANT)");
    }
    payload.onComplete?.({ status: lifecycleResult.ok ? "ok" : "error", error: lifecycleResult.ok ? undefined : lifecycleResult.error?.message });
    return true;
  }

  // -- Social modeling sentinel intercept --
  // The offline DIRECTIONAL relationship builder. Fires per (tenant, agent); groups high-trust
  // sources by RESOLVED channelId (the per-channel privacy boundary) + invokes
  // runRelationshipBuild ONCE per channel, scoped to (tenant, agent, channel), with a readSources
  // seam yielding that channel's multi-user sources (sender attribution preserved; the job runs the
  // external-exclude + redaction firewall). The gate is STRICTER than the rep cron: BOTH enabled
  // AND a recorded privacy-review sign-off.
  if (resultText === "__SOCIAL_MODELING__") {
    const { agentId } = payload;
    if (!agentId) {
      logger.warn({ hint: "Social modeling job fired without agentId", errorKind: "config" as const }, "Skipping social modeling build -- no agentId");
      payload.onComplete?.({ status: "error", error: "No agentId for social modeling build" });
      return true;
    }

    const agentConfig = agents[agentId];
    const cfg = agentConfig?.socialModeling;
    // The dual gate (defense-in-depth with the scheduler registration): refuse to run
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
    const apiKey = container.secretManager.get(apiKeyName) ?? (KEYLESS_PROVIDER_TYPES.has(resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for social modeling build`, errorKind: "config" as const }, "Skipping social modeling build -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
      return true;
    }

    const relTenantId = tenantId ?? container.config.tenantId ?? "default";
    const relLogger = logger.child({ agentId, submodule: "social-modeling" });

    // Read HIGH-TRUST sources once, group by RESOLVED channelId (the per-channel write boundary)
    // here (no channel axis on InspectFilters). channelId is recovered per source via
    // parseFormattedSessionKey; an unresolvable one (NULL session key — system memories) is
    // SKIPPED + counted (NEVER bucket undefined — that collapses cross-channel sources
    // into one leak bucket). entry.userId is the SPEAKER (sender attribution preserved).
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
          // Counts-only skip — never bucket an unresolved channelId.
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
          // Per-build INPUT bounds (forwarded; the job also defaults them when absent).
          maxSourceMemories: cfg.maxSourceMemories,
          maxSourceChars: cfg.maxSourceChars,
        },
        relationshipStore, // injected from setup-memory — the port TYPE only.
        // The scoped read seam: this channel's high-trust sources (the job runs external-exclude + redaction).
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
