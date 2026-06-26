// SPDX-License-Identifier: Apache-2.0
/**
 * The memory-cron sentinel handlers — extracted from setup-channels-credentials.ts
 * to keep that leaf under the 600L setup-channels cap. The LLM-backed sentinels
 * (__MEMORY_CONSOLIDATION__, __MEMORY_REASONING__, __USER_REPRESENTATION__,
 * __SOCIAL_MODELING__) resolve a cheap "cron" model + an API key (by NAME, never logged);
 * (the KEYLESS __ONLINE_TUNING__ bandit sentinel was deleted in Phase 224). The sibling-hosted sentinels
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

import { parseFormattedSessionKey } from "@comis/core";
import { resolveCronJobCredential, cronCredentialSkipHint } from "./setup-channels-cron-credential.js";
// Phase 225 FOLD: the consolidation/reasoning/user-rep symbols were dropped here with their
// intercept branches (their work folds into __REFLECT__, Plan 04) — and they would become
// TS2305-broken once Plan 05 deletes the job files. The 5 survivors below feed the
// __SOCIAL_MODELING__ branch (Phase 226 scope) which stays live.
import { resolveOperationModel, resolveProviderFamily, runRelationshipBuild, createRelationshipSeam, type RelationshipSourceMemory } from "@comis/agent";
// resolveMemoryOpsCapability was dropped with the consolidation/reasoning branches (Phase 225
// FOLD) — only those branches threaded the small-model abstain capabilityClass; __SOCIAL_MODELING__
// does not. The helper file remains for Plan 05 / 226.
import { cronCustomModelOpt } from "./setup-channels-cron-credential.js";
import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

export type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

/**
 * Handle an LLM-backed memory-cron sentinel. Returns `true` when the sentinel was
 * recognized + handled (the caller then returns), `false` when it is neither (the
 * caller falls through to the normal delivery path).
 *
 * Phase 225 FOLD §3.2: the `__MEMORY_CONSOLIDATION__` / `__MEMORY_REASONING__` /
 * `__USER_REPRESENTATION__` intercepts were REMOVED — their work folds into the ONE
 * `__REFLECT__` cron (Plan 04), and their scheduler registrations are gone, so the
 * sentinels never fire. The surviving LLM-backed intercept here is `__SOCIAL_MODELING__`
 * (Phase 226 scope); the WS7-wired sentinels live in the sibling wire leaf (the
 * fall-through delegates there).
 */
export async function handleMemoryCronSentinel(
  resultText: string | undefined,
  payload: MemoryCronPayload,
  ctx: MemoryCronContext,
): Promise<boolean> {
  const { container, logger, clock, agents, tenantId, relationshipStore, memoryApi } = ctx;

  // NOTE: the __ONLINE_TUNING__ bandit sentinel was DELETED in Phase 224 (v2.31) — the UCB
  // tuned-alpha bandit is gone; recall scoring is the fixed config.rag.scoring alphas.

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

    const cred = await resolveCronJobCredential(container, agentId, resolved.provider, ctx.resolveAccessToken);
    const apiKey = cred.apiKey;
    if (!apiKey) {
      logger.warn({ agentId, provider: resolved.provider, hint: cronCredentialSkipHint(cred, resolved.provider, "social modeling build"), errorKind: "config" as const }, "Skipping social modeling build -- no API key");
      payload.onComplete?.({ status: "error", error: `No API key for ` + resolved.provider });
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
      ...cronCustomModelOpt(container.config.providers?.entries?.[resolved.provider], resolved.provider, resolved.modelId),
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
