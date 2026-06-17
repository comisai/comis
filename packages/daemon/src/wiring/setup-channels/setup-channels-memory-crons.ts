// SPDX-License-Identifier: Apache-2.0
/**
 * The memory-cron sentinel handlers — extracted from setup-channels-credentials.ts
 * to keep that leaf under the 600L setup-channels cap. The LLM-backed sentinels
 * (__MEMORY_CONSOLIDATION__, __MEMORY_REASONING__, __USER_REPRESENTATION__,
 * __SOCIAL_MODELING__) resolve a cheap "cron" model + an API key (by NAME, never logged);
 * the KEYLESS __ONLINE_TUNING__ sentinel resolves none. The sibling-hosted sentinels
 * (__USEFULNESS_JUDGE__, __MEMORY_TRIPLE_EXTRACTION__ WS7 + the KEYLESS __MEMORY_LIFECYCLE__
 * FORGET-01/06 sweep) live in setup-channels-memory-crons-wire.ts (the 600L dir cap); the
 * fall-through delegates there.
 *
 * All mirror the review branch: the cron registers ONLY for an operator-enabled agent
 * (setup-schedulers), but each sentinel ALSO re-checks cfg.enabled + short-circuits ok when
 * off (defence-in-depth). Each injects its segregated store(s) as port TYPES only (the
 * agent↛memory cut) + (the LLM ones) the OFFLINE seam from the cheap model (prompts internal).
 *
 * @module
 */

import { parseFormattedSessionKey, KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL } from "@comis/core";
import { resolveOperationModel, resolveProviderFamily, runMemoryConsolidation, runMemoryReasoning, createReasoningSeam, runUserRepresentationBuild, createUserRepresentationSeam, runRelationshipBuild, createRelationshipSeam, runOnlineTuning, type UserRepresentationSourceMemory, type RelationshipSourceMemory, type OnlineTuningFeedEntry } from "@comis/agent";
import { resolveMemoryOpsCapability } from "./resolve-memory-ops-capability.js";
import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

export type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

/**
 * The per-intent tuned-alpha buckets the online-tuning bandit iterates when
 * `learningTuning.perIntent` is on (RANK-02): the GLOBAL '' bucket + the four deterministic
 * `classifyIntent` intents (`factual`/`temporal`/`preference`/`enumeration` — @comis/agent's
 * closed `Intent` union). Kept as a local closed list (the agent's `Intent` type is not on the
 * barrel and a TYPE cannot be iterated at runtime); a NEW intent on the agent side must be added
 * here too. The recall apply-site classifies live via `classifyIntent(query)`.
 */
const TUNING_INTENT_BUCKETS = ["", "factual", "temporal", "preference", "enumeration"] as const;

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
  const { container, logger, clock, agents, tenantId, consolidationStore, tripleStore, userRepresentationStore, relationshipStore, tunedAlphaStore, usefulnessStore, memoryApi } = ctx;

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
    } else {
      // GENERAL-01/OBS-01: an INFO completion line + the daemon-side learning:memory_generalized
      // emit (counts-only, mirrors FORGET-06; generalize defaults OFF → counts 0). PLAIN emit
      // (never ?.) so EMIT_REGEX sees it; the memory body NEVER crosses the bus (SEC-01 / T-203-leak).
      // Defensive ?? 0: a value-less result (older job build) emits benign zero counts, never throws.
      const c = consolidationResult.value;
      const gen = { generalized: c?.generalized ?? 0, clustersConsidered: c?.clustersConsidered ?? 0, durationMs: c?.durationMs ?? 0 };
      logger.child({ agentId, submodule: "memory-consolidation" }).info({ agentId, ...gen }, "Memory consolidation generalization summary");
      container.eventBus.emit("learning:memory_generalized", { agentId, ...gen, timestamp: clock.now() });
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
    // `inspect` orders created_at DESC + applies `limit` BEFORE grouping, so a trust level with
    // > SOURCE_READ_LIMIT rows is SILENTLY truncated to the newest window across ALL users. No
    // offset to page → a read returning exactly the cap emits a counts-only WARN (§2.7 — no silent drop).
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
    // REVISE-01/OBS-01: sum the counts-only revision totals across all per-user builds for ONE
    // daemon-side learning:user_model_revised emit (mirrors FORGET-06). COUNTS ONLY (no body — SEC-01).
    let superseded = 0;
    let corroborated = 0;
    let inserted = 0;
    const reprStartMs = clock.now();
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
      } else {
        superseded += result.value.superseded;
        corroborated += result.value.corroborated;
        inserted += result.value.inserted;
      }
    }

    // REVISE-01/OBS-01: the daemon-side learning:user_model_revised emit (PLAIN — never ?. — so
    // EMIT_REGEX sees it) + an INFO completion line. COUNTS ONLY (no body/entryType/source ids — SEC-01).
    const reprDurationMs = clock.now() - reprStartMs;
    reprLogger.info(
      { agentId, superseded, corroborated, inserted, durationMs: reprDurationMs },
      "User representation revision summary",
    );
    container.eventBus.emit("learning:user_model_revised", {
      agentId,
      superseded,
      corroborated,
      inserted,
      durationMs: reprDurationMs,
      timestamp: clock.now(),
    });

    payload.onComplete?.({ status: anyError ? "error" : "ok", error: anyError ? "One or more per-user representation builds failed" : undefined });
    return true;
  }

  // -- Online-tuning bandit sentinel intercept --
  // The OFFLINE tuned-alpha bandit — DETERMINISTIC + KEYLESS (no model/key/build seam; it deletes
  // the LLM crons' work). Gate: memoryOnlineTuning.enabled (cron) AND learningTuning.enabled
  // (RANK-02/03: per-intent + bandit/nudge). When learning is on it iterates the intent buckets,
  // selecting the learner by config; off → the legacy single-bucket nudge (byte-identical). The
  // job is non-fatal + counts-only; trust is never tuned (config-sourced at the apply site).
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
    const maxSourceMemories = cfg.maxSourceMemories ?? 200;

    // The per-intent FEED-read seam scoped to (tenant, agent, intent) over a bounded recent
    // candidate-id set (the daemon's existing memory read surface; maxSourceMemories bounds it).
    // Omitted intent → the global '' bucket (byte-identical legacy read). A read failure is
    // non-fatal in the job — the bandit keeps the ranker's current weights.
    const makeReadUsefulness = (intent?: string) =>
      async (): Promise<Awaited<ReturnType<typeof usefulnessStore.readUsefulness>>> => {
        const ids = memoryApi
          ? memoryApi.inspect({ tenantId: tuningTenantId, agentId, limit: maxSourceMemories }).map((r) => r.id)
          : [];
        return usefulnessStore.readUsefulness(ids, {
          tenantId: tuningTenantId,
          agentId,
          ...(intent !== undefined ? { intent } : {}),
        });
      };

    // RANK-02/03 gate composition (resolved decision #3): `memoryOnlineTuning.enabled` runs the
    // cron (already checked above); `learningTuning.enabled` SELECTS the bandit + per-intent +
    // outcome-reward behavior. When OFF → the LEGACY single-bucket nudge (byte-identical). When
    // ON → per-intent runs (perIntent) selecting bandit-vs-nudge by `learner`.
    const learningTuning = agentConfig?.learningTuning;
    const runFor = (intent?: string) =>
      runOnlineTuning({
        agentId,
        tenantId: tuningTenantId,
        config: {
          enabled: cfg.enabled,
          maxSourceMemories,
          ...(learningTuning?.enabled ? { learner: learningTuning.learner, exploration: learningTuning.exploration } : {}),
          ...(intent !== undefined ? { intent } : {}),
        },
        // Injected from setup-memory (the composition-root join) — the port TYPE only.
        tunedAlphaStore,
        readUsefulness: makeReadUsefulness(intent) as () => Promise<import("@comis/shared").Result<Map<string, OnlineTuningFeedEntry>, Error>>,
        configScoring,
        clock,
        logger: tuningLogger,
        eventBus: container.eventBus,
      });

    let anyTuningError = false;
    if (learningTuning?.enabled && learningTuning?.perIntent) {
      // Per-intent: the global '' bucket + the closed deterministic intents (mirrors the agent's
      // classifyIntent union). Each bucket tunes its own (tenant, agent, intent) vector.
      for (const intent of TUNING_INTENT_BUCKETS) {
        const r = await runFor(intent);
        if (!r.ok) anyTuningError = true;
      }
    } else {
      // The LEGACY single-bucket path (learningTuning off, or on-but-not-per-intent): the global
      // '' bucket only — byte-identical to the pre-Plan-06 behaviour when learningTuning is off.
      const r = await runFor(undefined);
      if (!r.ok) anyTuningError = true;
    }

    payload.onComplete?.({ status: anyTuningError ? "error" : "ok", error: anyTuningError ? "one or more online-tuning intent runs failed" : undefined });
    return true;
  }

  // NOTE: the __MEMORY_LIFECYCLE__ sentinel (FORGET-01/06 — soft eviction + the
  // learning:memory_* daemon emits) lives in the sibling setup-channels-memory-crons-wire.ts
  // (the 600L dir cap); the fall-through delegates there.

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

    // Read HIGH-TRUST sources once, group by RESOLVED channelId (the per-channel write boundary;
    // no channel axis on InspectFilters), recovered via parseFormattedSessionKey. An unresolvable
    // channelId (NULL session key — system memories) is SKIPPED + counted, NEVER bucketed as
    // undefined (that collapses cross-channel sources into one leak bucket). entry.userId = SPEAKER.
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

  // WS7-wired sentinels live in the sibling leaf (600L cap); delegate the fall-through.
  return handleWireMemoryCronSentinel(resultText, payload, ctx);
}
