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
 * the A1 deps + config exactly as prompt-assembly's executor read path does, INCLUDING the
 * `forget` FadeMem decay gate the main path passes (the main↔dialectic recall-parity fix;
 * default-OFF ⇒ byte-identical recall). Recall scoring is the fixed `rag.scoring` alphas — the
 * tuned-alpha bandit overlay was deleted in Phase 224 (RECALL-02/03).
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
  resolveProviderApiKey,
  type AuthStorage,
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
  /** FLAG-3: per-agent OAuth-credential resolver factory. Returns a per-call `getApiKey` for the
   *  resolved cheap provider when that agent has an OAuth manager (openai-codex), else `undefined`.
   *  Built in `dialecticWiringDepsFromBoot` from the boot `oauthManagers` map (the SAME the Codex
   *  image/video/vision bundles use). Without it, an OAuth provider resolves no API key and the seam
   *  abstains on every `memory.ask`. */
  getResolveCredential?: (agentId: string, provider: string) => (() => Promise<string>) | undefined;
  /** Provider entries (for apiKeyName lookup + the R6 capabilities override) —
   *  `container.config.providers?.entries`. `capabilities` supplies the optional
   *  operator capabilityClass override the dialectic seam's R6 routing reads (CR-01). */
  providers: Record<string, (JudgeProviderEntry & { capabilities?: ProviderCapabilities }) | undefined>;
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
  /** FLAG-3: per-agent OAuth managers (the boot `oauthManagers` map on PostChannelsBootContext —
   *  the SAME one threaded to the Codex image/video/vision bundles). Read to build the dialectic
   *  credential resolver so OAuth providers (openai-codex) don't abstain on a missing API key. */
  oauthManagers?: Map<string, import("@comis/core").OAuthTokenManager>;
  /** FLAG-3 (approach A): per-agent pi AuthStorage (piAuthStorage) — the runtime-override target.
   *  `resolveProviderApiKey` calls `authStorage.setRuntimeApiKey(token)` so the dialectic's pi model
   *  picks up the OAuth bearer (the PROVEN main-agent path; passing the token as `apiKey` does NOT work
   *  for openai-codex — empirically verified live 2026-06-22). Threaded beside `oauthManagers`. */
  authStorages?: Map<string, AuthStorage>;
  container: {
    secretManager: { get: (name: string) => string | undefined };
    config: {
      providers?: { entries?: Record<string, (JudgeProviderEntry & { capabilities?: ProviderCapabilities }) | undefined> };
      /** The configured tenant (the daemon-wide `container.config.tenantId`). */
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
    // FLAG-3: per-agent OAuth-credential resolver — returns a per-call getApiKey for the cheap
    // provider when that agent has an OAuth manager (openai-codex), else undefined (seam falls back
    // to the static apiKey). Resolves the OAuth bearer so memory.ask no longer abstains on OAuth deployments.
    getResolveCredential: (agentId, provider) => {
      // eslint-disable-next-line security/detect-object-injection -- agentId is the invoking agent's configured id
      const mgr = c.oauthManagers?.get(agentId);
      // eslint-disable-next-line security/detect-object-injection -- agentId is the invoking agent's configured id
      const authStorage = c.authStorages?.get(agentId);
      if (mgr === undefined || authStorage === undefined) return undefined;
      // eslint-disable-next-line security/detect-object-injection -- agentId is the invoking agent's configured id
      const agentConfig = c.agentsConfig[agentId];
      // resolveProviderApiKey resolves the OAuth bearer AND writes it via authStorage.setRuntimeApiKey
      // (pi runtime-override, HIGHEST priority) so the dialectic's completeSimple picks it up — the proven
      // main-agent path. Returned per-call so a rotated OAuth token never goes stale.
      // `mgr` is typed as @comis/core OAuthTokenManager; resolveProviderApiKey wants the agent-local
      // OAuthTokenManager (adds `invalidate`). The runtime object IS the full manager (authProvider.oauth),
      // so cast the deps to the param type — sound at runtime, only the static types are duplicated.
      return () => resolveProviderApiKey(provider, { authStorage, oauthManager: mgr, agentConfig } as Parameters<typeof resolveProviderApiKey>[1]);
    },
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
 * for the memory.ask handler. Resolution is PER-AGENT. Returns `{}` (the cost gate) ONLY
 * when NO agent has the dialectic enabled — so a non-default agentʼs opt-in is never silently
 * dead. Each returned function resolves the invoking agentʼs OWN config (model/key/maxOutputTokens
 * for the seam, RagConfig for recall, maxRecall for the DoS bound), memoizing the seam per agent.
 */
export function buildDialecticWiring(deps: DialecticWiringDeps): DialecticWiring {
  const { defaultAgentId, agentsConfig, costFeaturesEnabled, secretManager, providers, stores, clock, timers, eventBus, logger, getResolveCredential } = deps;

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
    // FLAG-3: per-call OAuth-credential resolver for THIS agent's cheap provider. Undefined for
    // non-OAuth/keyless providers ⇒ the seam keeps using the static `apiKey` (pre-fix behavior).
    const resolveCredential = getResolveCredential?.(agentId, resolved.provider);
    const seamDeps: DialecticSeamDeps = {
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey,
      ...(resolveCredential !== undefined ? { resolveCredential } : {}),
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
  //
  // Recall scoring is the FIXED `rag.scoring` alphas (Phase 224, RECALL-02/03): the UCB
  // tuned-alpha bandit + its overlay were DELETED, so memory.ask — like the main prompt-assembly
  // recall path — applies the config-sourced alphas only (no learned-weight read). The factory is
  // SYNCHRONOUS (`(agentId) => MemoryRecall`; the handler reads it without an `await`).
  const buildDialecticRecall = (agentId: string): MemoryRecall => {
    const rag = configFor(agentId).rag;
    // `feedback` predates its config landing — structural-widen like prompt-assembly.
    const ragFeedback = (rag as typeof rag & { feedback?: { enabled: boolean } }).feedback;

    // Construct the FULL orchestrator with the fixed config `scoring`. Everything is identical to
    // the main path's recall deps/config.
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
        // Fixed config-sourced scoring alphas — no learned overlay (Phase 224, RECALL-02/03).
        scoring: rag.scoring,
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
  };

  // The per-agent DoS bound the handler clamps `limit` to — the INVOKING agentʼs
  // dialectic.maxRecall (the schema default when its dialectic block is absent).
  const dialecticMaxRecall = (agentId: string): number =>
    configFor(agentId).dialectic?.maxRecall ?? DIALECTIC_DEFAULT_MAX_RECALL;

  return { dialecticSeam, buildDialecticRecall, dialecticMaxRecall };
}
