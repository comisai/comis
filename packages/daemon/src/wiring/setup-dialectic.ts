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

/** Injected dependencies for the dialectic wiring. CR-04: the dialectic resolves PER-AGENT —
 *  the seam (model/key/maxOutputTokens), the recall RagConfig, and the maxRecall DoS bound are
 *  all read from the INVOKING agent's config (resolved lazily + memoized per agent), not from
 *  the default agent. So a non-default agent with `dialectic.enabled: true` gets a live seam
 *  with its OWN settings even when the default agent has the dialectic off. */
export interface DialecticWiringDeps {
  /** The default agent id — the per-agent resolution fallback when a callerʼs agentId is not in
   *  `agentsConfig` (defense-in-depth; the handler always passes a real, configured agentId). */
  defaultAgentId: string;
  /** ALL per-agent configs (each: dialectic.enabled + maxOutputTokens + maxRecall + provider/
   *  model/operationModels + rag). The wiring enables when ANY agent opts in and resolves the
   *  seam/recall/maxRecall per invoking agent from THIS map. */
  agentsConfig: Record<string, PerAgentConfig>;
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

/** The dialectic wiring result spread into the memory.ask handler deps. All undefined when NO
 *  agent has the dialectic enabled (the cost gate) ⇒ the handler abstains gracefully. CR-04:
 *  each function resolves PER the invoking agentId. */
export interface DialecticWiring {
  /** The ONE query-time synthesis seam, resolved PER-AGENT (CR-04): the model/key/maxOutputTokens
   *  come from `agentId`ʼs OWN config (lazily resolved + memoized). The handler passes the
   *  invoking agentId so a non-default agent synthesizes with its own cheap model + key. */
  dialecticSeam?: (
    agentId: string,
    question: string,
    groundingText: string,
  ) => Promise<DialecticParsed>;
  /** A per-agent recall factory returning the FULL createMemoryRecall orchestrator built from
   *  the INVOKING agentʼs RagConfig (CR-04 — re-reads `agentsConfig[agentId].rag`). */
  buildDialecticRecall?: (agentId: string) => MemoryRecall;
  /** The per-agent `dialectic.maxRecall` DoS bound (CR-02/CR-04) — the grounding-set ceiling the
   *  handler clamps `limit` to, resolved from the INVOKING agentʼs config. */
  dialecticMaxRecall?: (agentId: string) => number;
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
 * would otherwise inline). CR-04: passes ALL per-agent configs so the wiring enables when ANY
 * agent opts in and resolves the seam/recall/maxRecall PER the invoking agent. Lives here so
 * daemon.ts stays at the line cap.
 */
export function dialecticWiringDepsFromBoot(c: DialecticBootSlice): DialecticWiringDeps {
  return {
    defaultAgentId: c.defaultAgentId,
    agentsConfig: c.agentsConfig,
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

/** The schema default maxRecall (mirrors DialecticConfigSchema) — the fallback ceiling when an
 *  agentʼs dialectic block is absent (defense-in-depth; the handler also defaults). */
const DIALECTIC_DEFAULT_MAX_RECALL = 10;

/**
 * Build the dialectic seam + the per-agent recall factory + the per-agent maxRecall resolver
 * for the memory.ask handler. CR-04: resolution is PER-AGENT. Returns `{}` (the cost gate) ONLY
 * when NO agent has the dialectic enabled — so a non-default agentʼs opt-in is never silently
 * dead. Each returned function resolves the invoking agentʼs OWN config (model/key/maxOutputTokens
 * for the seam, RagConfig for recall, maxRecall for the DoS bound), memoizing the seam per agent.
 */
export function buildDialecticWiring(deps: DialecticWiringDeps): DialecticWiring {
  const { defaultAgentId, agentsConfig, secretManager, providers, stores, clock, timers, eventBus, logger } = deps;

  // The cost gate: enable when ANY agent opts in (CR-04 — a non-default opt-in must not be dead).
  // No agent enabled ⇒ no seam/recall/maxRecall ⇒ the handler abstains (no query-time-LLM wired).
  const anyEnabled = Object.values(agentsConfig).some((a) => a?.dialectic?.enabled === true);
  if (!anyEnabled) {
    return {};
  }

  // Resolve the invoking agentʼs config, falling back to the default agent then the first
  // configured agent (defense-in-depth — the handler always passes a real, configured agentId).
  const configFor = (agentId: string): PerAgentConfig =>
    agentsConfig[agentId] ??
    agentsConfig[defaultAgentId] ??
    agentsConfig[Object.keys(agentsConfig)[0] ?? ""]!;

  // Per-agent seam memoization: resolve the cheap model + key from THAT agentʼs config once,
  // then reuse. Keyed by agentId so each agent synthesizes with its own model/key/token bound.
  const seamByAgent = new Map<string, (q: string, g: string) => Promise<DialecticParsed>>();
  const seamFor = (agentId: string): (q: string, g: string) => Promise<DialecticParsed> => {
    const cached = seamByAgent.get(agentId);
    if (cached !== undefined) return cached;
    const agentConfig = configFor(agentId);

    // Resolve the CHEAP "cron"/cheap operation model — never the agentʼs primary (mirrors the
    // memory-cron consolidation/review/userrep model resolution verbatim), from THIS agentʼs config.
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
      // key is set. Once per agent (memoized). Surfaced for operator observability.
      logger.warn(
        {
          agentId,
          provider: resolved.provider,
          hint: `Set ${apiKeyName} in secrets for the memory_ask dialectic (it will abstain until then)`,
          errorKind: "config" as const,
        },
        "Dialectic enabled but no API key resolved — memory.ask will abstain",
      );
    }

    // The ONE query-time synthesis seam (bounded by THIS agentʼs dialectic.maxOutputTokens — the
    // cost axis; falls back to the schema default when the agentʼs dialectic block is absent).
    const seamDeps: DialecticSeamDeps = {
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      maxOutputTokens: agentConfig.dialectic?.maxOutputTokens ?? 1024,
      clock,
      logger,
      agentId,
    };
    const seam = createDialecticSeam(seamDeps);
    seamByAgent.set(agentId, seam);
    return seam;
  };

  // CR-04: the seam the handler calls passes the invoking agentId so the per-agent model/key/
  // token bound are used (not the default agentʼs).
  const dialecticSeam = (agentId: string, question: string, groundingText: string) =>
    seamFor(agentId)(question, groundingText);

  // CR-04: the per-agent recall factory re-reads the INVOKING agentʼs RagConfig (the prior code
  // ignored its agentId param and always read the default agentʼs rag — so a non-default agentʼs
  // includeTrustLevels / maxResults / scoring were never honored). The FULL createMemoryRecall
  // (trust-filtered) is reconstructed exactly as prompt-assemblyʼs executor read path does.
  const buildDialecticRecall = (agentId: string): MemoryRecall => {
    const rag = configFor(agentId).rag;
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

  // CR-02/CR-04: the per-agent DoS bound the handler clamps `limit` to — the INVOKING agentʼs
  // dialectic.maxRecall (the schema default when its dialectic block is absent).
  const dialecticMaxRecall = (agentId: string): number =>
    configFor(agentId).dialectic?.maxRecall ?? DIALECTIC_DEFAULT_MAX_RECALL;

  return { dialecticSeam, buildDialecticRecall, dialecticMaxRecall };
}
