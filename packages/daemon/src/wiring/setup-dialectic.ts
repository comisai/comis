// SPDX-License-Identifier: Apache-2.0
/**
 * The dialectic wiring (Phase 109 — DIAL-01/02). Builds the ONE query-time synthesis
 * seam + a per-agent recall factory for the `memory.ask` RPC handler, daemon-side, so
 * `daemon.ts` gains ZERO net new lines (it is at the 3000-line cap): `buildRpcDispatchDeps`
 * calls `buildDialecticWiring(...)` and SPREADS its `{ dialecticSeam, buildDialecticRecall }`
 * into the dispatch-deps object the handler reads (the field-plumbing forward-presence belt
 * locks that the spread is not dropped — setup-dialectic.test.ts Test 4).
 *
 * The dialectic is OPT-IN and default-OFF (the cost gate): when `dialectic.enabled !== true`
 * this returns `{}` (no seam, no recall builder ⇒ the handler abstains gracefully). When on,
 * it resolves the CHEAP "cron"/cheap operation model (never the agent's primary) + the
 * provider apiKey BY NAME (never the value — `apiKey: ""` when unresolved ⇒ the seam degrades
 * to abstain at call time; the cron no-key discipline), builds `createDialecticSeam`, and a
 * `buildDialecticRecall(agentId)` factory that constructs the FULL `createMemoryRecall` (NOT
 * `memoryApi.search`) over the daemon's store set + the per-agent RagConfig — reconstructing
 * the A1 deps + config exactly as prompt-assembly's executor read path does.
 *
 * The agent receives the store port TYPEs only (the agent↛memory build cut is untouched —
 * every store dep is a @comis/core port type; the concrete adapters are daemon-constructed
 * in setup-memory and threaded here on the boot context).
 *
 * @module
 */

import {
  resolveOperationModel,
  resolveProviderFamily,
  createDialecticSeam,
  createMemoryRecall,
  type MemoryRecall,
  type DialecticParsed,
  type DialecticSeamDeps,
} from "@comis/agent";
import type {
  PerAgentConfig,
  ClockPort,
  TimerPort,
  MemoryPort,
  RerankerPort,
  MemoryEntityStore,
  MemoryTemporalStore,
  MemoryCausalStore,
  TripleStorePort,
  MemoryEmbeddingStore,
  MemoryUsefulnessStore,
  TypedEventBus,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** The recall store set (the SAME concrete adapters daemon.ts threads into createPiExecutor;
 *  here every field is a @comis/core port TYPE — the agent↛memory cut). */
export interface DialecticStoreSet {
  /** Tenant+agent-scoped memory search port (the candidate supply — `memoryAdapter`). */
  memoryPort: MemoryPort;
  rerankerPort?: RerankerPort;
  entityStore?: MemoryEntityStore;
  temporalStore?: MemoryTemporalStore;
  causalStore?: MemoryCausalStore;
  tripleStore?: TripleStorePort;
  embeddingStore?: MemoryEmbeddingStore;
  usefulnessStore?: MemoryUsefulnessStore;
}

/** Injected dependencies for the dialectic wiring (the daemon-wide slice — the dialectic
 *  config + model resolution is read for the resolving agent; the per-agent RagConfig is
 *  re-read inside buildDialecticRecall at call time). */
export interface DialecticWiringDeps {
  /** The agent whose dialectic config + model are resolved for the daemon-wide seam. */
  agentId: string;
  /** The per-agent config (dialectic.enabled + maxOutputTokens + maxRecall + provider/model/
   *  operationModels + rag). */
  agentConfig: PerAgentConfig;
  /** Resolves the provider apiKey VALUE by NAME (never logged). */
  secretManager: { get: (name: string) => string | undefined };
  /** Provider entries (for apiKeyName lookup) — `container.config.providers?.entries`. */
  providers: Record<string, { apiKeyName?: string } | undefined>;
  /** The daemon-constructed recall store set (the SAME stores prompt-assembly wires). */
  stores: DialecticStoreSet;
  /** Wall-clock reads for the seam + recall recency boost (via the injected clock port, never a wall-clock global). */
  clock: ClockPort;
  /** Timer port for the recall rerank deadline + the seam abort timer wrapping. */
  timers?: TimerPort;
  /** Optional event bus for recall's counts-only emit (never bodies). */
  eventBus?: TypedEventBus;
  /** Counts-only structural logger (the seam logs failures with hint + errorKind; the
   *  wiring NEVER logs the key value). */
  logger: ComisLogger;
}

/** The dialectic wiring result spread into the memory.ask handler deps. Both undefined when
 *  the dialectic is off (the cost gate) ⇒ the handler abstains gracefully. */
export interface DialecticWiring {
  /** The ONE query-time synthesis seam (Plan 02's createDialecticSeam output). */
  dialecticSeam?: (question: string, groundingText: string) => Promise<DialecticParsed>;
  /** A per-agent recall factory returning the FULL createMemoryRecall orchestrator. */
  buildDialecticRecall?: (agentId: string) => MemoryRecall;
}

/** The boot-context slice `buildRpcDispatchDeps` reads to assemble the wiring deps. Typed
 *  structurally (the relevant `c` fields only) so daemon.ts can map the boot context to the
 *  wiring deps in ONE expression — keeping daemon.ts at zero net new wiring lines (it is at
 *  the 3000-line cap; all the mapping lives here). The concrete adapters are the SAME ones
 *  daemon.ts threads into createPiExecutor (A1: daemon-constructed in setup-memory). */
export interface DialecticBootSlice {
  defaultAgentId: string;
  agentsConfig: Record<string, PerAgentConfig>;
  container: {
    secretManager: { get: (name: string) => string | undefined };
    config: { providers?: { entries?: Record<string, { apiKeyName?: string } | undefined> } };
    eventBus?: TypedEventBus;
  };
  memoryAdapter: MemoryPort;
  rerankerPort?: RerankerPort;
  entityStore?: MemoryEntityStore;
  temporalStore?: MemoryTemporalStore;
  causalStore?: MemoryCausalStore;
  tripleStore?: TripleStorePort;
  embeddingStore?: MemoryEmbeddingStore;
  usefulnessStore?: MemoryUsefulnessStore;
  clock: ClockPort;
  timers?: TimerPort;
  logger: ComisLogger;
}

/**
 * Map the post-channels boot context to the dialectic wiring deps (the mapping daemon.ts
 * would otherwise inline). Resolves the dialectic config from the default agent (the per-agent
 * tool opt-in already gated registration); the per-agent RagConfig is re-read inside
 * buildDialecticRecall. Lives here so daemon.ts stays at the line cap.
 */
export function dialecticWiringDepsFromBoot(c: DialecticBootSlice): DialecticWiringDeps {
  // The resolving agent: the default agent, or the first configured agent as a fallback.
  const agentConfig =
    c.agentsConfig[c.defaultAgentId] ?? c.agentsConfig[Object.keys(c.agentsConfig)[0] ?? ""];
  return {
    agentId: c.defaultAgentId,
    // agentConfig is guaranteed present at boot (the daemon always has ≥1 agent); the `!`
    // narrows the structural lookup. A missing block ⇒ buildDialecticWiring returns {} (the gate).
    agentConfig: agentConfig!,
    secretManager: c.container.secretManager,
    providers: c.container.config.providers?.entries ?? {},
    stores: {
      memoryPort: c.memoryAdapter,
      rerankerPort: c.rerankerPort,
      entityStore: c.entityStore,
      temporalStore: c.temporalStore,
      causalStore: c.causalStore,
      tripleStore: c.tripleStore,
      embeddingStore: c.embeddingStore,
      usefulnessStore: c.usefulnessStore,
    },
    clock: c.clock,
    timers: c.timers,
    eventBus: c.container.eventBus,
    logger: c.logger,
  };
}

/**
 * Build the dialectic seam + the per-agent recall factory for the memory.ask handler.
 * Returns `{}` (the cost gate) when the dialectic is not enabled for the resolving agent.
 */
export function buildDialecticWiring(deps: DialecticWiringDeps): DialecticWiring {
  const { agentConfig, secretManager, providers, stores, clock, timers, eventBus, logger } = deps;

  // The cost gate: default-OFF byte-identity. An absent/off `dialectic` block ⇒ no seam,
  // no recall builder ⇒ the handler abstains (no query-time-LLM surface wired).
  if (agentConfig.dialectic?.enabled !== true) {
    return {};
  }

  // Resolve the CHEAP "cron"/cheap operation model — never the agent's primary (mirrors the
  // memory-cron consolidation/review/userrep model resolution verbatim).
  const resolved = resolveOperationModel({
    operationType: "cron",
    agentProvider: agentConfig.provider ?? "anthropic",
    agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
    operationModels: agentConfig.operationModels ?? {},
    providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
  });

  // Resolve the apiKey BY NAME. No key ⇒ "" ⇒ the seam degrades to abstain at call time
  // (the seam itself is the gate; the cron warn-and-continue discipline). NEVER log the value.
  const providerEntry = providers[resolved.provider];
  const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
  const apiKey = secretManager.get(apiKeyName) ?? "";
  if (apiKey.length === 0) {
    // Counts/NAME-only WARN (never the value) — the seam will abstain on every call until a
    // key is set. Surfaced for operator observability (the dialectic is opt-in + enabled but
    // has no usable key).
    logger.warn(
      {
        agentId: deps.agentId,
        provider: resolved.provider,
        hint: `Set ${apiKeyName} in secrets for the memory_ask dialectic (it will abstain until then)`,
        errorKind: "config" as const,
      },
      "Dialectic enabled but no API key resolved — memory.ask will abstain",
    );
  }

  // The ONE query-time synthesis seam (bounded by dialectic.maxOutputTokens — the cost axis).
  const seamDeps: DialecticSeamDeps = {
    provider: resolved.provider,
    modelId: resolved.modelId,
    apiKey,
    maxOutputTokens: agentConfig.dialectic.maxOutputTokens,
    clock,
    logger,
    agentId: deps.agentId,
  };
  const dialecticSeam = createDialecticSeam(seamDeps);

  // The per-agent recall factory: the FULL createMemoryRecall (trust-filtered + redaction-
  // aware), reconstructing the A1 deps + config exactly as prompt-assembly's executor read
  // path (prompt-assembly.ts:784-816). The agentId param re-reads the per-agent RagConfig at
  // call time; here it is the resolving agent's `rag` (the daemon-wide seam serves the agent
  // whose tool was registered — the per-agent opt-in already gated registration).
  const buildDialecticRecall = (_agentId: string): MemoryRecall => {
    const rag = agentConfig.rag;
    // FEED-03: `feedback` predates its config landing — structural-widen like prompt-assembly.
    const ragFeedback = (rag as typeof rag & { feedback?: { enabled: boolean } }).feedback;
    return createMemoryRecall(
      {
        memoryPort: stores.memoryPort,
        ...(stores.rerankerPort !== undefined ? { reranker: stores.rerankerPort } : {}),
        ...(stores.entityStore !== undefined ? { entityStore: stores.entityStore } : {}),
        ...(stores.temporalStore !== undefined ? { temporalStore: stores.temporalStore } : {}),
        ...(stores.causalStore !== undefined ? { causalStore: stores.causalStore } : {}),
        ...(stores.tripleStore !== undefined ? { tripleStore: stores.tripleStore } : {}),
        ...(stores.embeddingStore !== undefined ? { embeddingStore: stores.embeddingStore } : {}),
        ...(stores.usefulnessStore !== undefined ? { usefulnessStore: stores.usefulnessStore } : {}),
        ...(timers !== undefined ? { timers } : {}),
        clock,
        logger,
        ...(eventBus !== undefined ? { eventBus } : {}),
      },
      {
        maxResults: rag.maxResults,
        minScore: rag.minScore,
        includeTrustLevels: rag.includeTrustLevels,
        rerank: rag.rerank,
        scoring: rag.scoring,
        lanes: rag.lanes,
        entityLane: rag.entityLane,
        mmr: rag.mmr,
        queryUnderstanding: rag.queryUnderstanding,
        ...(ragFeedback !== undefined ? { feedback: ragFeedback } : {}),
      },
    );
  };

  return { dialecticSeam, buildDialecticRecall };
}
