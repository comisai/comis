// SPDX-License-Identifier: Apache-2.0
/**
 * The dialectic wiring. Builds the ONE query-time synthesis
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
 * the A1 deps + config exactly as prompt-assembly's executor read path does, INCLUDING the two
 * recall-config inputs the main path passes (the main↔dialectic recall-parity fix): the
 * `forget` FadeMem decay gate and the LLM-free tuned-alpha overlay
 * (gated on `rag.onlineTuning.enabled`, applied via `buildScoringAlphas`
 * with the trust weight STILL config-frozen, belt #2). Both default-OFF ⇒ byte-identical recall.
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
  buildScoringAlphas,
  type MemoryRecall,
  type DialecticParsed,
  type DialecticSeamDeps,
} from "@comis/agent";
import { resolveMemoryOpsCapability } from "./setup-channels/resolve-memory-ops-capability.js";
import { buildCustomJudgeModelSpec, type JudgeProviderEntry } from "./setup-learning-judge.js";
import { KEYLESS_PROVIDER_TYPES, KEYLESS_API_KEY_SENTINEL } from "@comis/core";
import type {
  PerAgentConfig,
  ProviderCapabilities,
  ClockPort,
  TimerPort,
  MemoryPort,
  MemoryPinnedStore,
  RerankerPort,
  MemoryEntityStore,
  MemoryTemporalStore,
  MemoryCausalStore,
  TripleStorePort,
  MemoryEmbeddingStore,
  MemoryUsefulnessStore,
  TunedAlphaStore,
  TunedAlphaVector,
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
  /** Pinned-memory store. The SAME `SqliteMemoryAdapter` already in `memoryPort`
   *  implements both `MemoryPort` AND `MemoryPinnedStore`. Supplied here as the
   *  segregated `MemoryPinnedStore` port so the dialectic recall's Step-0 pinned-first
   *  lane can fire (mirrors the main path R6 fix). Absent OR `rag.pinned.enabled=false` ⇒
   *  no query runs (default-OFF byte-identity). A @comis/core port TYPE (the agent↛memory cut). */
  pinnedStore?: MemoryPinnedStore;
  /** Tuned-alpha store. When present AND the invoking agent's
   *  `rag.onlineTuning.enabled`, the dialectic recall reads the learned 4-tuple at recall time
   *  (scoped to (tenant, agent)) and overlays the four non-trust alphas via `buildScoringAlphas`
   *  — the SAME deterministic, LLM-free overlay prompt-assembly applies (the main↔dialectic recall
   *  parity fix). Absent OR tuning-off OR no learned row ⇒ the static `rag.scoring` is used
   *  unchanged (default-OFF byte-identity). The TRUST weight is NEVER tuned (config-sourced in
   *  buildScoringAlphas, belt #2). A @comis/core port TYPE (the agent↛memory cut). */
  tunedAlphaStore?: TunedAlphaStore;
}

/** Injected dependencies for the dialectic wiring. The dialectic resolves PER-AGENT —
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
  /** The master cost-feature kill switch (`memory.costFeatures.enabled`, opt-out posture).
   *  The dialectic (`memory_ask`) is the ONE query-time LLM tool in the memory stack — a
   *  cost-bearing feature — so when this is `false` the wiring returns the dead `{}` (no seam,
   *  no recall builder, no maxRecall ⇒ the handler abstains, the tool is never exposed) EVEN
   *  for an agent whose own `dialectic.enabled` is true. The cost switch wins over the per-agent
   *  opt-in. Default `true` (the schema default) ⇒ byte-identical to the pre-switch behavior. */
  costFeaturesEnabled: boolean;
  /** Resolves the provider apiKey VALUE by NAME (never logged). */
  secretManager: { get: (name: string) => string | undefined };
  /** Provider entries (for apiKeyName lookup + the R6 capabilities override) —
   *  `container.config.providers?.entries`. `capabilities` supplies the optional
   *  operator capabilityClass override the dialectic seam's R6 routing reads (CR-01). */
  providers: Record<string, (JudgeProviderEntry & { capabilities?: ProviderCapabilities }) | undefined>;
  /** The daemon-constructed recall store set (the SAME stores prompt-assembly wires). */
  stores: DialecticStoreSet;
  /** The configured tenant (`container.config.tenantId`) — the (tenant, agent) scope for the
   *  tuned-alpha read on the dialectic recall path, mirroring prompt-assembly's
   *  `deps.tenantId ?? sessionKey.tenantId` apply-site scope. Required so a tuned vector written
   *  under one tenant is never read for another. */
  tenantId: string;
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
 *  agent has the dialectic enabled (the cost gate) ⇒ the handler abstains gracefully. Each
 *  function resolves PER the invoking agentId. */
export interface DialecticWiring {
  /** The ONE query-time synthesis seam, resolved PER-AGENT: the model/key/maxOutputTokens
   *  come from `agentId`ʼs OWN config (lazily resolved + memoized). The handler passes the
   *  invoking agentId so a non-default agent synthesizes with its own cheap model + key. */
  dialecticSeam?: (
    agentId: string,
    question: string,
    groundingText: string,
  ) => Promise<DialecticParsed>;
  /** A per-agent recall factory returning the FULL createMemoryRecall orchestrator built from
   *  the INVOKING agentʼs RagConfig (re-reads `agentsConfig[agentId].rag`). */
  buildDialecticRecall?: (agentId: string) => MemoryRecall;
  /** The per-agent `dialectic.maxRecall` DoS bound — the grounding-set ceiling the
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
    config: {
      providers?: { entries?: Record<string, (JudgeProviderEntry & { capabilities?: ProviderCapabilities }) | undefined> };
      /** The configured tenant — the (tenant, agent) scope for the tuned-alpha read on
       *  the dialectic recall path (the SAME field daemon.ts reads for the handler's tenantId). */
      tenantId: string;
      /** The master cost-feature kill switch (`memory.costFeatures.enabled`). Threaded into the
       *  dialectic wiring so the query-time `memory_ask` tool is force-disabled when the operator
       *  turns all cost features off. */
      memory: { costFeatures: { enabled: boolean } };
    };
    eventBus?: TypedEventBus;
  };
  /** The memory adapter — implements BOTH `MemoryPort` (the candidate supply) AND
   *  `MemoryPinnedStore` (the pinned-first lane). The same `SqliteMemoryAdapter` instance
   *  satisfies both; widened here so `dialecticWiringDepsFromBoot` can use it for both
   *  `stores.memoryPort` and `stores.pinnedStore` without a cast. */
  memoryAdapter: MemoryPort & MemoryPinnedStore;
  rerankerPort?: RerankerPort;
  entityStore?: MemoryEntityStore;
  temporalStore?: MemoryTemporalStore;
  causalStore?: MemoryCausalStore;
  tripleStore?: TripleStorePort;
  embeddingStore?: MemoryEmbeddingStore;
  usefulnessStore?: MemoryUsefulnessStore;
  /** Tuned-alpha store — the SAME concrete adapter daemon.ts threads into
   *  createPiExecutor (built in setup-memory on the shared db). Threaded onto the dialectic recall
   *  so `memory.ask` applies the SAME tuned-alpha overlay as prompt-assembly. A @comis/core port
   *  TYPE (the agent↛memory cut); the seam/recall consume the TYPE only. */
  tunedAlphaStore?: TunedAlphaStore;
  clock: ClockPort;
  timers?: TimerPort;
  logger: ComisLogger;
}

/**
 * Map the post-channels boot context to the dialectic wiring deps (the mapping daemon.ts
 * would otherwise inline). Passes ALL per-agent configs so the wiring enables when ANY
 * agent opts in and resolves the seam/recall/maxRecall PER the invoking agent. Lives here so
 * daemon.ts stays at the line cap.
 */
export function dialecticWiringDepsFromBoot(c: DialecticBootSlice): DialecticWiringDeps {
  return {
    defaultAgentId: c.defaultAgentId,
    agentsConfig: c.agentsConfig,
    // The master cost-feature kill switch — the dialectic (memory_ask) is a cost feature, so a
    // `false` here force-disables it regardless of any agent's per-agent dialectic.enabled.
    costFeaturesEnabled: c.container.config.memory.costFeatures.enabled,
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
      // R6: c.memoryAdapter implements BOTH MemoryPort AND MemoryPinnedStore (SqliteMemoryAdapter
      // satisfies both); pass it here as the segregated pinnedStore so the dialectic recall's
      // Step-0 pinned-first lane can fire — parity with the main path (prompt-assembly) fix.
      pinnedStore: c.memoryAdapter,
      // Thread the tuned-alpha store so the dialectic recall applies the SAME
      // buildScoringAlphas overlay as the main path (the main↔dialectic recall-parity fix).
      tunedAlphaStore: c.tunedAlphaStore,
    },
    // The (tenant, agent) scope for the dialectic's tuned-alpha read (mirrors the handler's tenantId).
    tenantId: c.container.config.tenantId,
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
 * for the memory.ask handler. Resolution is PER-AGENT. Returns `{}` (the cost gate) ONLY
 * when NO agent has the dialectic enabled — so a non-default agentʼs opt-in is never silently
 * dead. Each returned function resolves the invoking agentʼs OWN config (model/key/maxOutputTokens
 * for the seam, RagConfig for recall, maxRecall for the DoS bound), memoizing the seam per agent.
 */
export function buildDialecticWiring(deps: DialecticWiringDeps): DialecticWiring {
  const { defaultAgentId, agentsConfig, costFeaturesEnabled, secretManager, providers, stores, tenantId, clock, timers, eventBus, logger } = deps;

  // The master cost-feature kill switch (opt-out posture). The dialectic (memory_ask) is the
  // ONE query-time LLM tool — a cost-bearing feature — so when the operator turns all cost
  // features off this returns the dead `{}` (no seam, no recall builder, no maxRecall ⇒ the
  // handler abstains, the tool is never exposed) EVEN when an agent's own dialectic.enabled is
  // true. The kill switch wins over the per-agent opt-in. Checked BEFORE the per-agent gate so a
  // single false short-circuits the whole wiring.
  if (!costFeaturesEnabled) {
    return {};
  }

  // The per-agent cost gate: enable when ANY agent opts in (a non-default opt-in must not
  // be dead). No agent enabled ⇒ no seam/recall/maxRecall ⇒ the handler abstains (no query-time-LLM wired).
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

    // Resolve the apiKey BY NAME. For a KEYLESS provider (ollama / lm-studio) there is no
    // secret to resolve — use the keyless sentinel so the seam still RUNS (mirrors the #223
    // judge resolver). A genuinely missing key on a key-REQUIRING provider ⇒ "" ⇒ abstain.
    const providerEntry = providers[resolved.provider];
    const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
    const apiKey =
      secretManager.get(apiKeyName) ??
      (KEYLESS_PROVIDER_TYPES.has(providerEntry?.type ?? resolved.provider)
        ? KEYLESS_API_KEY_SENTINEL
        : "");
    if (apiKey.length === 0) {
      // Counts/NAME-only WARN (never the value) — a key-REQUIRING provider with no key abstains
      // on every call until a key is set (keyless providers never reach here). Once per agent.
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

    // Custom-provider model spec (the resolved …/v1 baseUrl) so a keyless/local YAML provider
    // the pi-ai catalog can't see still resolves a Model. Without it, memory.ask abstained
    // "model not found" on every keyless ask — even with a CAPABLE model (live 2026-06-20; the
    // #223 judge-resolver bug class, this seam was the missed sibling). Undefined for built-ins.
    const customModel = buildCustomJudgeModelSpec(
      providerEntry,
      resolved.provider,
      resolved.modelId,
    );

    // R6 (CR-01): derive the capability routing for the cron/memory model that
    // actually makes the synthesis LLM call. A small/nano cron model (absent an
    // operator capable override) routes synthesize() to { abstain: true } so a weak
    // model never fabricates citations into the dialectic answer (T-153-fabricate).
    const seamCapability = resolveMemoryOpsCapability(
      { provider: resolved.provider, modelId: resolved.modelId },
      providerEntry?.capabilities,
    );

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
      // R6 routing (CR-01): keys on the cron/memory model, not the agent primary.
      capabilityClass: seamCapability.capabilityClass,
      hasCapableModelOverride: seamCapability.hasCapableModelOverride,
      ...(customModel !== undefined ? { customModel } : {}),
    };
    const seam = createDialecticSeam(seamDeps);
    seamByAgent.set(agentId, seam);
    return seam;
  };

  // The seam the handler calls passes the invoking agentId so the per-agent model/key/
  // token bound are used (not the default agentʼs).
  const dialecticSeam = (agentId: string, question: string, groundingText: string) =>
    seamFor(agentId)(question, groundingText);

  // The per-agent recall factory re-reads the INVOKING agentʼs RagConfig (the prior code
  // ignored its agentId param and always read the default agentʼs rag — so a non-default agentʼs
  // includeTrustLevels / maxResults / scoring were never honored). The FULL createMemoryRecall
  // (trust-filtered) is reconstructed exactly as prompt-assemblyʼs executor read path does.
  //
  // The main↔dialectic recall-parity fix:
  //   - `forget` (the FadeMem decay gate) is now passed — the SAME
  //     field the main path passes at prompt-assembly.ts:854 — so memory.ask applies the per-type
  //     decay when `rag.forget.enabled`. Default-OFF byte-identity holds (score.ts forces the
  //     forgetFactor to EXACTLY 1.0 when off).
  //   - The LLM-free tuned-alpha overlay. GATED on
  //     `rag.onlineTuning.enabled` AND a present `tunedAlphaStore`, the learned 4-tuple is read
  //     (scoped to (tenant, agent)) at recall time and overlaid via `buildScoringAlphas` — the
  //     SAME deterministic, single-source-of-truth overlay prompt-assembly applies. Default-OFF
  //     byte-identity holds (no gate / no store / no row ⇒ the static `rag.scoring` unchanged).
  //     The TRUST weight stays config-sourced (buildScoringAlphas belt #2) — the bandit can NEVER
  //     move trust on the dialectic path, exactly as on the main path.
  //
  // The factory stays SYNCHRONOUS (`(agentId) => MemoryRecall`; the handler reads it without an
  // `await`). The tuned-alpha read is async + needs the (tenant, agent) scope, so it runs at
  // recall-CALL time inside the returned orchestrator's `.recall()` — where the live SessionKey
  // scope exists — exactly once per memory.ask (mirroring prompt-assembly's once-per-recall read).
  const buildDialecticRecall = (agentId: string): MemoryRecall => {
    const rag = configFor(agentId).rag;
    // `feedback` predates its config landing — structural-widen like prompt-assembly.
    const ragFeedback = (rag as typeof rag & { feedback?: { enabled: boolean } }).feedback;
    // `onlineTuning` is read through a structural widening (the SAME posture as
    // prompt-assembly.ts:804-806) so the gate compiles regardless of RagConfig type drift.
    const onlineTuningEnabled =
      (rag as typeof rag & { onlineTuning?: { enabled: boolean } }).onlineTuning?.enabled === true;

    // Construct the FULL orchestrator with a resolved `scoring` (config, or the tuned overlay).
    // Everything except `scoring` is identical to the main path's recall deps/config.
    const buildWithScoring = (scoring: typeof rag.scoring): MemoryRecall =>
      createMemoryRecall(
        {
          memoryPort: stores.memoryPort,
          ...(stores.rerankerPort !== undefined ? { reranker: stores.rerankerPort } : {}),
          ...(stores.entityStore !== undefined ? { entityStore: stores.entityStore } : {}),
          ...(stores.temporalStore !== undefined ? { temporalStore: stores.temporalStore } : {}),
          ...(stores.causalStore !== undefined ? { causalStore: stores.causalStore } : {}),
          ...(stores.tripleStore !== undefined ? { tripleStore: stores.tripleStore } : {}),
          ...(stores.embeddingStore !== undefined ? { embeddingStore: stores.embeddingStore } : {}),
          ...(stores.usefulnessStore !== undefined ? { usefulnessStore: stores.usefulnessStore } : {}),
          // R6: wire the pinned store so the dialectic recall's Step-0 pinned-first lane can
          // fire — parity with the main path (prompt-assembly) fix. Default-OFF byte-identity:
          // with `rag.pinned.enabled=false` (the default), no query runs even when the store is present.
          ...(stores.pinnedStore !== undefined ? { pinnedStore: stores.pinnedStore } : {}),
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
          // The deterministic apply overlay (config alphas, or the tuned 4-tuple with
          // the trust weight STILL from config — belt #2). buildScoringAlphas with `undefined`
          // returns `rag.scoring` unchanged (the default-OFF byte-identity no-op).
          scoring,
          lanes: rag.lanes,
          entityLane: rag.entityLane,
          mmr: rag.mmr,
          queryUnderstanding: rag.queryUnderstanding,
          // The FadeMem decay gate — the SAME field prompt-assembly.ts:854 passes.
          forget: rag.forget,
          // R6: forward the pinned-memory injection config so the dialectic recall's
          // Step-0 knows the cap. A fully-defaulted RagConfig field (same posture as mmr/forget).
          // Default-OFF (`enabled:false`) ⇒ the pinned lane is skipped (byte-identical).
          pinned: rag.pinned,
          ...(ragFeedback !== undefined ? { feedback: ragFeedback } : {}),
        },
      );

    // Default-OFF fast path: no tuning gate OR no store ⇒ the tuned store is NEVER read and the
    // recall config is byte-identical to a static-scoring build (no wrapper indirection cost).
    if (!onlineTuningEnabled || stores.tunedAlphaStore === undefined) {
      return buildWithScoring(rag.scoring);
    }

    // Tuning ON + a store present: do the gated, scoped tuned-alpha read at recall-CALL time
    // (where the live scope exists), overlay via buildScoringAlphas, then delegate. The read is
    // PURE + non-fatal (a read failure → undefined → byte-identical config fallback); NO model
    // call crosses onto the recall hot path. Scoped to (tenant, agent) — a tuned vector written
    // under one scope is never read for another (the TunedAlphaStore isolation boundary).
    const tunedAlphaStore = stores.tunedAlphaStore;
    return {
      async recall(query, sessionKey, recallAgentId) {
        let tunedVector: TunedAlphaVector | undefined;
        const tr = await tunedAlphaStore.read({ tenantId, agentId });
        if (tr.ok) tunedVector = tr.value;
        const inner = buildWithScoring(buildScoringAlphas(rag.scoring, tunedVector));
        return inner.recall(query, sessionKey, recallAgentId);
      },
    };
  };

  // The per-agent DoS bound the handler clamps `limit` to — the INVOKING agentʼs
  // dialectic.maxRecall (the schema default when its dialectic block is absent).
  const dialecticMaxRecall = (agentId: string): number =>
    configFor(agentId).dialectic?.maxRecall ?? DIALECTIC_DEFAULT_MAX_RECALL;

  return { dialecticSeam, buildDialecticRecall, dialecticMaxRecall };
}
