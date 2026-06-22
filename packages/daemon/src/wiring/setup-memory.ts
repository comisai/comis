// SPDX-License-Identifier: Apache-2.0
/**
 * Memory + embedding subsystem setup: embedding provider/caching, SQLite memory
 * adapter, reindexing, batch indexing, session store, memory API, embedding queue.
 * @module
 */

import type { AppContainer, EmbeddingPort } from "@comis/core";
import { safePath, ContextEngineConfigSchema } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createCircuitBreaker, createSummarizerSpendBreaker, estimateMessageTokens } from "@comis/agent";
import type { SummarizerSpendBreaker } from "@comis/agent";
import { err, type Result } from "@comis/shared";
import {
  SqliteMemoryAdapter,
  createSessionStore,
  createLcdStore,
  buildProvenanceReadStore,
  createLcdBrowseStore, createMemoryApi,
  createEmbeddingProvider,
  createCachedEmbeddingPort,
  createSqliteEmbeddingCache,
  createFingerprintManager,
  createBatchIndexer,
  createEmbeddingQueue,
  createLocalRerankerProvider,
  rerankerModelPresent,
  createSqliteMemoryEntityStore,
  createSqliteMemoryConsolidationStore,
  createSqliteMemoryUsefulnessStore,
  createSqliteMemoryTemporalStore,
  createSqliteMemoryCausalStore,
  createSqliteTripleStore,
  createSqliteMemoryEmbeddingStore,
  createSqliteUserRepresentationStore,
  createSqliteRelationshipStore,
  createSqliteTunedAlphaStore,
  createSqliteMemoryLifecycleStore,
  createSqliteOutcomeStore, createSqliteLearnedSkillStore,
  type MemoryApi,
} from "@comis/memory";
import {
  wireRecallCounters,
  type RecallCountersWiring,
} from "../observability/recall-counters-wiring.js";
import { wireMemoryUsefulness } from "./setup-memory-usefulness-wiring.js";
import { resolveUserRepresentationHistoryCapOption } from "./setup-memory-history-cap.js";
import { setupLearningOutcomeWiring } from "./setup-learning.js";
import { buildReactionWiringDeps, wireLearningReactions, wireLearningCorrection } from "./setup-learning-reactions.js";
import { buildOutcomeJudgeWiring } from "./setup-learning-judge.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the memory/embedding setup phase. */
export interface MemoryResult {
  /** Dispose callback for embedding cache chain: L1 -> L2 -> provider. */
  disposeEmbedding?: () => Promise<void>;
  /** Cached embedding provider wrapper (optional). */
  cachedPort?: EmbeddingPort;
  /** SQLite memory adapter with FTS5 + vector search. */
  memoryAdapter: SqliteMemoryAdapter;
  /** Raw better-sqlite3 database handle (needed for shutdown close + startup banner). */
  db: ReturnType<SqliteMemoryAdapter["getDb"]>;
  /** Session persistence store. */
  sessionStore: ReturnType<typeof createSessionStore>;
  /** LCD lossless context store (Phase 127); the live append-on-turn write-path is wired in Phase 128. */
  lcdStore: ReturnType<typeof createLcdStore>;
  provenanceStore: ReturnType<typeof buildProvenanceReadStore>; // LCD provenance READ store (Phase 173, DIST-03) → createMemoryRecall's down-weighting pass; core TYPE only (agent↛memory cut)
  contextBrowse: ReturnType<typeof createLcdBrowseStore>; // ContextBrowsePort — backs context.conversations
  /** High-level memory query/store API. */
  memoryApi: MemoryApi;
  /** Background embedding queue for new entries (optional). */
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  /** Background indexing promise for shutdown coordination (optional). */
  backgroundIndexingPromise?: Promise<unknown>;
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  /** R1 (132-05): daemon-owned per-tenant summarizer spend+breaker. ONE instance (mirrors the embedding breaker) injected setupAgents -> createPiExecutor -> setupContextEngine; gated per tenant, bounds AGGREGATE spend. */
  summarizerSpendBreaker: SummarizerSpendBreaker;
  /** Cross-encoder reranker port. Defined only when at least one agent has
   *  `rag.rerank.enabled === true` AND the model loaded — otherwise undefined and recall
   *  degrades to fusion order. The all-default (rerank-off) config NEVER builds
   *  it, so the ~606MB GGUF is not downloaded by default. */
  rerankerPort?: import("@comis/core").RerankerPort;
  /** Whether the reranker GGUF is ALREADY present locally — computed
   *  ONCE here via the no-download `rerankerModelPresent` probe. The composition root threads
   *  this SAME boolean to `setupAgents` so the per-agent effective `rag.rerank.enabled`
   *  precedence and this build gate consult one source (no two-gate drift). */
  rerankerModelPresent: boolean;
  /** Entity-associative store. The SOLE adapter for the segregated
   *  `MemoryEntityStore` port — built UNCONDITIONALLY on the SAME shared `db` handle as the
   *  memory adapter (so entity tables + memories share one FK-enabled connection and the
   *  `ON DELETE CASCADE` fires). Unlike the reranker there is no model/IO cost to building it,
   *  so it is always present; the entity lane stays dormant until an operator opts in via
   *  `agents.<id>.rag.entityLane.enabled` (default OFF) — see setup-agents-runtime / the cron
   *  review wiring, which thread this port into the read + write paths. */
  entityStore: import("@comis/core").MemoryEntityStore;
  /** Temporal-spread store. The SOLE adapter for the segregated
   *  `MemoryTemporalStore` port — built UNCONDITIONALLY on the SAME shared `db` handle as the
   *  memory adapter (so the windowed `occurred_at` read shares the (tenant, agent) isolation
   *  + FK-enabled connection with the memory rows it spreads over). Unlike the entity store
   *  there is NO `ensure*` DDL (the `occurred_at` column already exists) and no model/IO cost,
   *  so it is always present; the temporal lane stays dormant until an operator opts in via
   *  `agents.<id>.rag.lanes.temporal.enabled` (default OFF) — see setup-agents-runtime, which
   *  threads this port into the recall read path. The agent receives the port TYPE only
   *  (the agent↛memory cut). */
  temporalStore: import("@comis/core").MemoryTemporalStore;
  /** Causal store. The SOLE adapter for the segregated
   *  `MemoryCausalStore` port (linkCausal WRITE + causalLane READ) — built UNCONDITIONALLY on
   *  the SAME shared `db` handle as the memory adapter (so memory_causal_edges + memories share
   *  one FK-enabled connection — the ON DELETE CASCADE fires — and the (tenant, agent) isolation
   *  scope is consistent). No model/IO cost, so it is always present; the causal lane stays
   *  dormant until an operator opts in via `agents.<id>.rag.lanes.causal.enabled` (default OFF),
   *  and the agent-side write guards on extracted causes. Threaded into BOTH the recall read
   *  path (setup-agents-*) AND the cron-review write path (setup-channels-*). The agent receives
   *  the port TYPE only (the agent↛memory cut). */
  causalStore: import("@comis/core").MemoryCausalStore;
  /** Triple store. The SOLE adapter for the segregated
   *  `TripleStorePort` (the trust-first bi-temporal knowledge graph: `upsertTriple` WRITE +
   *  `asOf`/`currentTruth`/`spreadLane` READs) — built UNCONDITIONALLY on the SAME shared `db`
   *  handle as the memory adapter (so `memory_triples` + memories share one FK-enabled
   *  connection — the `source_memory_id` ON DELETE CASCADE fires — and the (tenant, agent)
   *  isolation scope is consistent with the memory rows the triples reference and the
   *  graph-spread walk hydrates through). No model/IO cost, so it is always present; the 6th
   *  graph-spread recall lane stays dormant until an operator opts in via
   *  `agents.<id>.rag.lanes.graphSpread.enabled` (default OFF), and the offline
   *  triple-extraction job is its own default-OFF cost gate (never on the recall hot path).
   *  Threaded into the recall read path (setup-agents-*) as the port TYPE only — the daemon
   *  (composition root) is the one place this @comis/memory adapter and the @comis/agent
   *  consumers are joined (the agent↛memory cut). */
  tripleStore: import("@comis/core").TripleStorePort;
  /** Embedding read store. The SOLE adapter for the segregated
   *  `MemoryEmbeddingStore` port (the bulk `(tenant, agent)`-scoped LEFT JOIN vec_memories read
   *  that hydrates the MMR diversity re-rank) — built UNCONDITIONALLY on the SAME shared `db`
   *  handle as the memory adapter (so the embedding read sees the SAME `memories` rows + the
   *  SAME `vec_memories` index recall hydrates, and the (tenant, agent) isolation scope is
   *  consistent — an embedding read on a DIFFERENT handle would silently return an empty Map and
   *  MMR would no-op). No model/IO cost, so it is always present; the MMR re-rank stays dormant
   *  until an operator enables `agents.<id>.rag.mmr.enabled` (default OFF). Threaded into the
   *  recall read path (setup-agents-*) as the port TYPE only — the daemon (composition root) is
   *  the one place this @comis/memory adapter and the @comis/agent recall consumer are joined
   *  (the agent↛memory cut). */
  embeddingStore: import("@comis/core").MemoryEmbeddingStore;
  /** Per-user representation store. The SOLE adapter for the
   *  segregated `UserRepresentationStore` port (the `(tenant, agent, user)`-scoped upsert/read over
   *  the additive `user_representation` table) — built UNCONDITIONALLY on the SAME shared `db`
   *  handle as the memory adapter (so the `source_memory_id` ON DELETE CASCADE — which fires ONLY
   *  for single-source rows; the offline builder omits `sourceMemoryId`, see the adapter's
   *  provenance caveat — and the 3-way isolation scope stay consistent with the memory rows the
   *  profile is distilled from — a read on a DIFFERENT handle would silently return empty).
   *  No model/IO cost, so it is always
   *  present; the LLM-free `<user_profile>` injection stays dormant until the offline builder writes
   *  rows (its own default-OFF cost gate). Threaded into the recall read path (setup-agents-*) as the
   *  port TYPE only AND into the offline-builder cron — the daemon (composition root) is the one
   *  place this @comis/memory adapter and the @comis/agent consumers are joined (the agent↛memory cut). */
  userRepresentationStore: import("@comis/core").UserRepresentationStore;
  /** Directional relationship store. The SOLE adapter for the
   *  segregated `RelationshipStore` port (the `(tenant, agent, channel)`-scoped upsert/read over the
   *  additive `relationship` table of directional `(subjectUserId, aboutUserId)` edges) — built
   *  UNCONDITIONALLY on the SAME shared `db` handle the memory adapter owns (so the
   *  `source_memory_id` ON DELETE CASCADE + the channel-scoped isolation stay consistent with the
   *  memory rows the edges are distilled from — a read on a DIFFERENT handle would silently return
   *  empty). No model/IO cost, so it is always present; the LLM-free
   *  `<channel_relationships>` injection stays dormant until the offline builder writes rows AND an
   *  operator both enables `agents.<id>.socialModeling.enabled` AND records a privacy-review sign-off
   *  (`privacyReviewSignedOffBy`) — the dual gate. Threaded into the recall read path
   *  (setup-agents-*) as the port TYPE only AND into the offline-builder `__SOCIAL_MODELING__` cron —
   *  the daemon (composition root) is the one place this memory-package adapter and the agent-package
   *  consumers are joined (the agent↛memory cut). */
  relationshipStore: import("@comis/core").RelationshipStore;
  /** Consolidation store. SOLE `MemoryConsolidationStore` adapter; built unconditionally on
   *  the shared `db` (no model/IO cost). Cron dormant until `memoryConsolidation.enabled`
   *  (default OFF). Construction-site comment has the full rationale; the agent gets the port TYPE only. */
  consolidationStore: import("@comis/core").MemoryConsolidationStore;
  /** Recall-utility usefulness store. SOLE `MemoryUsefulnessStore` adapter; built unconditionally on
   *  the shared `db` (no model/IO cost). Feedback loop dormant until `rag.feedback.enabled` (default OFF);
   *  the write-back subscriber is wired separately. */
  usefulnessStore: import("@comis/core").MemoryUsefulnessStore;
  /** Tuned-alpha store. SOLE `TunedAlphaStore` adapter; shared `db`, no model/IO cost. Dormant
   *  until BOTH `rag.onlineTuning.enabled` (read) AND `memoryOnlineTuning.enabled` (keyless write). */
  tunedAlphaStore: import("@comis/core").TunedAlphaStore;
  /** Outcome-signal store (Verified Learning WS1). SOLE `OutcomeSignalPort` adapter; shared `db`,
   *  no model/IO cost; gated at observe/resolve (agent never receives it — SEC-01). Returned so the
   *  daemon can `prune(retentionDays)` at startup (OUTCOME-07); the observe/resolve subscriber is wired here. */
  outcomeStore: import("@comis/core").OutcomeSignalPort;
  learnedSkillStore: import("@comis/core").LearnedSkillStorePort; // WS2/skills (SKILL-01): SOLE LearnedSkillStorePort adapter, shared db (trust=learned); the daemon injects it into the __SKILL_SYNTHESIS__ cron admit (DORMANT until learningSkills.enabled).
  /** REACT-02 (Phase 199): outbound-message → trajectory capture callback, threaded into the delivery drain. `undefined` when learning-outcome is off for all agents (byte-identity: zero extra work). `participantId` (FLAG-2) is the conversation participant (inbound sender) so a reaction from an unmapped group bystander is inert. */
  recordOutboundMessage?: (messageId: string, scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string }) => void;
  /** WR-01 (Phase 199): tear down the reaction/session trajectory maps + the dedicated reaction rate limiter (cancels their unref'd TTL timers). Invoked from the daemon shutdown path. */
  destroyReactionWiring: () => void;
  /** Memory-lifecycle sweep store. SOLE `MemoryLifecyclePort` adapter; shared `db`, no model/IO cost. DORMANT
   *  (0 rows swept even when enabled); the KEYLESS __MEMORY_LIFECYCLE__ cron registers only when `memoryLifecycle.enabled`. */
  memoryLifecycleStore: import("@comis/core").MemoryLifecyclePort;
  /** Live in-process recall-counter wiring. The single `wireRecallCounters(container.eventBus)` subscriber is
   *  stood up HERE (the memory composition site holding the bus) → ONE shared registry for the daemon lifetime.
   *  Threaded into `MemoryApiDeps.recallCounters` so `memory.recall_stats` reads the SAME live counters. */
  recallCounters: RecallCountersWiring;
  /** Dispose callback for the reranker's native context (ranking ctx -> model -> llama).
   *  Registered in the daemon shutdown path; undefined when no reranker was built. */
  disposeReranker?: () => Promise<void>;
  /** Throttled WAL checkpoint — call every health tick, runs checkpoint every 10th call. */
  maintenanceTick: () => void;
}

// ---------------------------------------------------------------------------
// Circuit breaker decorator for embedding port
// ---------------------------------------------------------------------------

/**
 * Wraps an EmbeddingPort with a circuit breaker that blocks calls when the
 * provider has failed repeatedly. Cache layers sit above this decorator so
 * cache hits bypass the breaker entirely.
 * @param inner  - The raw embedding provider to protect
 * @param cb     - A CircuitBreaker instance (threshold + reset already configured)
 * @param logger - Logger for diagnostics (unused in hot path to avoid log spam)
 */
export function createEmbeddingCircuitBreaker(
  inner: EmbeddingPort,
  cb: import("@comis/agent").CircuitBreaker,
  logger: ComisLogger,
): EmbeddingPort {
  // Suppress unused-var lint -- logger reserved for future diagnostics
  void logger;
  return {
    provider: inner.provider,
    dimensions: inner.dimensions,
    modelId: inner.modelId,

    async dispose(): Promise<void> {
      await inner.dispose?.();
    },

    async embed(text: string): Promise<Result<number[], Error>> {
      if (cb.isOpen()) {
        return err(new Error("Embedding circuit breaker is open"));
      }
      const result = await inner.embed(text);
      if (result.ok) cb.recordSuccess();
      else cb.recordFailure();
      return result;
    },

    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      if (cb.isOpen()) {
        return err(new Error("Embedding circuit breaker is open"));
      }
      const result = await inner.embedBatch(texts);
      if (result.ok) cb.recordSuccess();
      else cb.recordFailure();
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full memory and embedding subsystem: embedding provider with
 * auto-selection (local-first, remote fallback), caching, SQLite memory
 * adapter with adjusted dimensions, fingerprint-based reindexing, background
 * batch indexing for startup, session store, memory API, and embedding queue.
 * @param deps.container    - Bootstrap output (config, event bus, secret manager)
 * @param deps.memoryLogger - Module-bound logger for memory subsystem
 */
export async function setupMemory(deps: {
  container: AppContainer;
  memoryLogger: ComisLogger;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /** setTimeout scheduling (TimerPort) — the reaction trajectory map + rate limiter need it (REACT-02/03). */
  timers: import("@comis/core").TimerPort;
  /** WR-01: shared per-agent learned-skill SURFACE registry — forwarded into setupLearningOutcomeWiring so the promote/demote loop can re-refresh an agent's surface (next-session pickup). */
  learnedSkillSurfaceRegistry?: import("./setup-agents/learned-skill-surface-registry.js").LearnedSkillSurfaceRegistry;
}): Promise<MemoryResult> {
  const { container, memoryLogger, clock, timers } = deps;
  const memoryConfig = container.config.memory;
  const embeddingConfig = container.config.embedding;

  // 6.5.1. Create embedding provider (auto-select local-first, fallback to remote)
  let embeddingPort: EmbeddingPort | undefined;
  let embeddingCbRef: import("@comis/agent").CircuitBreaker | undefined;
  if (embeddingConfig?.enabled) {
    const remoteConfig = embeddingConfig.provider !== "local"
      ? (() => {
          const apiKey = container.secretManager.get("OPENAI_API_KEY");
          return apiKey
            ? { apiKey, model: embeddingConfig.openai.model, dimensions: embeddingConfig.openai.dimensions }
            : undefined;
        })()
      : undefined;

    const providerResult = await createEmbeddingProvider({
      provider: embeddingConfig.provider,
      local: embeddingConfig.provider !== "openai"
        ? { modelUri: embeddingConfig.local.modelUri, modelsDir: safePath(container.config.dataDir || ".", embeddingConfig.local.modelsDir), contextSize: embeddingConfig.local.contextSize }
        : undefined,
      remote: remoteConfig,
    });

    if (providerResult.ok) {
      embeddingPort = providerResult.value;
      memoryLogger.debug(
        { provider: embeddingPort.provider, modelId: embeddingPort.modelId, dimensions: embeddingPort.dimensions },
        "Embedding provider initialized",
      );

      // Circuit breaker wraps raw provider for batch failure resilience.
      // Placed BEFORE cache layers so cache hits bypass the breaker entirely.
      // Note: halfOpenTimeoutMs exists in CircuitBreakerConfig schema but is unused
      // by createCircuitBreaker at runtime -- omitted here for clarity.
      const embeddingCb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 60_000,
        halfOpenTimeoutMs: 30_000,
      }, clock);
      embeddingCbRef = embeddingCb;
      embeddingPort = createEmbeddingCircuitBreaker(embeddingPort, embeddingCb, memoryLogger);
      memoryLogger.debug("Embedding circuit breaker active (threshold=3, reset=60s)");
    } else {
      memoryLogger.warn({ err: providerResult.error.message, hint: "Set OPENAI_API_KEY or configure an embedding provider in integrations.media", errorKind: "config" as const }, "No embedding provider available, using FTS5 only");
    }
  }

  // 6.5.1a-R1 (132-05). The per-tenant summarizer spend+breaker — ONE daemon-owned
  // instance (mirrors the embedding breaker above, reusing the same injected
  // `clock`), constructed UNCONDITIONALLY (it is cheap + I/O-free, and the
  // summarizer seam exists in `dag` mode regardless of embeddings). Threaded
  // through setupAgents -> createPiExecutor -> setupContextEngine so
  // `getSummarizerDeps` wraps the leaf seam with `gate(tenantId, inner)`; ONE
  // instance partitions internally by tenantId so it bounds AGGREGATE per-tenant
  // summarizer spend across all of a tenant's sessions/agents (Pitfall 1). The
  // breaker/spend KNOBS are the daemon-level ContextEngine defaults
  // (failureThreshold 5; 500k tok/h, 5M tok/day) — a per-tenant aggregate cannot
  // coherently read a single agent's per-agent override since a tenant's sessions
  // span many agents, so the schema default is the daemon-global source. Token
  // estimates reuse the agent `estimateMessageTokens` heuristic (RESEARCH
  // "Don't Hand-Roll the estimator").
  const ceDefaults = ContextEngineConfigSchema.parse({});
  const summarizerSpendBreaker = createSummarizerSpendBreaker({
    breakerConfig: ceDefaults.summarizerBreaker,
    spendConfig: ceDefaults.summarizerSpend,
    clock,
    // Input estimate: sum the chunk messages via the shared estimator.
    estimateInputTokens: (messages) =>
      messages.reduce(
        (acc, m) => acc + estimateMessageTokens(m as unknown as Parameters<typeof estimateMessageTokens>[0]),
        0,
      ),
    // Output estimate: the produced summary as a user-role string.
    estimateOutputTokens: (out) =>
      estimateMessageTokens({ role: "user", content: out } as unknown as Parameters<typeof estimateMessageTokens>[0]),
  });
  memoryLogger.debug(
    {
      failureThreshold: ceDefaults.summarizerBreaker.failureThreshold,
      maxTokensPerTenantPerHour: ceDefaults.summarizerSpend.maxTokensPerTenantPerHour,
      maxTokensPerTenantPerDay: ceDefaults.summarizerSpend.maxTokensPerTenantPerDay,
    },
    "Per-tenant summarizer spend+breaker active",
  );

  // 6.5.1b. Build the cross-encoder reranker — ONLY when at least one agent enables
  // rerank. Building it downloads a ~606MB GGUF on first run, so the all-default
  // (rerank-off) config must NEVER trigger it (rerank is opt-in/default-OFF).
  // Scanning the in-memory agent configs is the cheapest correct gate (no I/O). When no
  // reranker is built, recall degrades to fusion order.
  let rerankerPort: import("@comis/core").RerankerPort | undefined;
  let disposeReranker: (() => Promise<void>) | undefined;
  // The gate is no longer explicit-on ONLY — it also auto-builds
  // when the GGUF is already cached locally, while still NEVER downloading on a fresh
  // install. Resolve the models dir ONCE (the SAME safePath value the factory builds with —
  // probe and build must consult one dir so the two gates can't drift) and probe
  // presence ONCE (no download — rerankerModelPresent uses resolveModelFile{download:false}).
  // The whole resolve+probe degrades to `modelPresent = false` (the safe posture)
  // if anything goes wrong: an unconfigured model URI, or a dataDir/modelsDir pair safePath
  // rejects (e.g. a relative dataDir that lets "models" escape its base). Auto-on is a
  // best-effort convenience; a config that can't even locate the models dir must never throw
  // into daemon startup — it just stays OFF and recall degrades to fusion.
  let rerankerModelsDir: string | undefined;
  let modelPresent = false;
  if (memoryConfig.rerankerModel) {
    try {
      rerankerModelsDir = safePath(container.config.dataDir || ".", memoryConfig.rerankerModelsDir || "models");
      modelPresent = await rerankerModelPresent({
        modelUri: memoryConfig.rerankerModel,
        modelsDir: rerankerModelsDir,
      });
    } catch (e) {
      rerankerModelsDir = undefined;
      modelPresent = false;
      memoryLogger.warn(
        { err: String(e), hint: "Set memory.dataDir to an absolute path so the reranker models dir resolves; reranker auto-on stays OFF", errorKind: "config" as const },
        "Reranker model-present probe skipped (models dir unresolved)",
      );
    }
  }
  // someAgentExplicitOn preserves the explicit opt-in DOWNLOAD path (operator set
  // `rag.rerank.enabled: true` on a fresh machine still fetches).
  // Read the SAME raw pre-Zod-default signal the per-agent effective-rerank
  // precedence consumes (container.rawAgentRerankEnabled), NOT the parsed
  // container.config.agents. Both gates therefore share ONE definition of "explicitly
  // on" — a future change to the rerank schema default can no longer silently desync the
  // build gate from the per-agent flip. Falls back to scanning the parsed config only
  // when the raw map is absent (non-bootstrap AppContainer); there `=== true` is still
  // correct because Zod defaults unset to false, so `true` can only be an explicit opt-in.
  const rawRerankMap = container.rawAgentRerankEnabled;
  const someAgentExplicitOn = rawRerankMap
    ? [...rawRerankMap.values()].some((enabled) => enabled === true)
    : Object.values(container.config.agents ?? {}).some(
        (agent) => agent?.rag?.rerank?.enabled === true,
      );
  const shouldBuildReranker = someAgentExplicitOn || modelPresent;
  // Boundary decision an operator must be able to reconstruct (AGENTS.md §2.7). Booleans
  // only — never the model-path body beyond the non-secret config path.
  memoryLogger.debug(
    { modelPresent, someAgentExplicitOn, willBuild: shouldBuildReranker },
    modelPresent
      ? "Reranker model present -> auto-enable candidate"
      : "Reranker model absent -> no download",
  );
  if (shouldBuildReranker) {
    // Resolve the build models dir ONCE, inside a guard. Reuse the dir the probe
    // resolved (one shared value); it is only unset on the explicit-opt-in path
    // when the probe's safePath threw — recompute there so the operator's opt-in gets the
    // same root-confined resolution. CRITICAL: that recompute uses the SAME args that just
    // threw on the probe, so without this guard it would throw AGAIN — now UNCAUGHT —
    // propagating into daemon startup. Catch it and degrade to the same WARN + fusion the
    // auto-on path uses (recall falls back to fusion order), never crash boot.
    let modelsDirForBuild: string | undefined;
    if (rerankerModelsDir !== undefined) {
      modelsDirForBuild = rerankerModelsDir;
    } else {
      try {
        modelsDirForBuild = safePath(container.config.dataDir || ".", memoryConfig.rerankerModelsDir || "models");
      } catch (e) {
        modelsDirForBuild = undefined;
        memoryLogger.warn(
          { err: String(e), hint: "Set memory.dataDir to an absolute path so the reranker models dir resolves; recall will use fusion order", errorKind: "config" as const },
          "Reranker build skipped (models dir unresolved)",
        );
      }
    }
    if (modelsDirForBuild !== undefined) {
      const rr = await createLocalRerankerProvider({
        modelUri: memoryConfig.rerankerModel,
        modelsDir: modelsDirForBuild,
        gpu: memoryConfig.rerankerGpu,
        threads: memoryConfig.rerankerThreads,
      });
      if (rr.ok) {
        // Capture the resolved port so the dispose closure has a non-nullable
        // reference (no `rerankerPort!.dispose!()` non-null clusters; AGENTS.md).
        const port = rr.value;
        rerankerPort = port;
        disposeReranker = port.dispose
          ? async () => { await port.dispose?.(); }
          : undefined;
        memoryLogger.debug({ model: memoryConfig.rerankerModel }, "Reranker provider initialized");
      } else {
        memoryLogger.warn(
          { err: rr.error.message, hint: "Reranker model unavailable; recall will use fusion order", errorKind: "dependency" as const },
          "Reranker provider unavailable",
        );
      }
    }
  }

  // 6.5.2. Create memory adapter with raw provider dimensions
  // Adapter uses embedding port only at query time (search()), not during construction.
  // Created BEFORE cache wiring because createSqliteEmbeddingCache needs the db handle.
  const effectiveDimensions = embeddingPort ? embeddingPort.dimensions : memoryConfig.embeddingDimensions;
  const adjustedMemoryConfig = { ...memoryConfig, embeddingDimensions: effectiveDimensions };
  const memoryAdapter = new SqliteMemoryAdapter(adjustedMemoryConfig, embeddingPort, memoryLogger);
  const db = memoryAdapter.getDb();

  // 6.5.2b. Entity-associative store. Built on the SAME `db` handle the
  // memory adapter owns — NOT a second Database — so the entity tables
  // (memory_entities / memory_entity_links) and the memories table share one
  // FK-enabled connection. That is what makes the link `ON DELETE CASCADE` fire and
  // keeps the (tenant, agent) isolation scope consistent with the memory rows it joins.
  // Always constructed (no model/IO cost); the entity recall lane stays dormant until an
  // operator enables `agents.<id>.rag.entityLane.enabled` (default OFF).
  const entityStore = createSqliteMemoryEntityStore({ db, logger: memoryLogger });

  // 6.5.2b'. Temporal-spread store. Built on the SAME `db` handle the
  // memory adapter owns — NOT a second Database — so the windowed `occurred_at` read shares
  // one FK-enabled connection and the (tenant, agent) isolation scope is consistent with the
  // memory rows it spreads over. Unlike the entity store there is NO `ensure*` DDL — the
  // `occurred_at` column already exists. Always constructed (no model/IO cost); the
  // temporal lane stays dormant until an operator enables `agents.<id>.rag.lanes.temporal.enabled`
  // (default OFF). Composition-root join — the agent receives the port TYPE only.
  const temporalStore = createSqliteMemoryTemporalStore({ db, logger: memoryLogger });

  // 6.5.2b''. Causal store. Built on the SAME shared `db` handle the
  // memory adapter owns — so memory_causal_edges + memories share one FK-enabled connection
  // (the ON DELETE CASCADE on both edge endpoints fires) and the (tenant, agent) isolation
  // scope is consistent with the memory rows the edges link. Always constructed (no model/IO
  // cost); the causal lane stays dormant until an operator enables `agents.<id>.rag.lanes.causal.
  // enabled` (default OFF), and the agent-side linkCausal write guards on extracted causes.
  // Composition-root join — the agent receives the port TYPE only (the agent↛memory cut). This
  // SAME store is threaded into BOTH the recall read path (setup-agents-*) AND the cron-review
  // write path (setup-channels-*).
  const causalStore = createSqliteMemoryCausalStore({ db, logger: memoryLogger });

  // 6.5.2b'''. Triple store. Built on the SAME shared `db` handle the
  // memory adapter owns — so `memory_triples` + memories share one FK-enabled connection (the
  // source_memory_id ON DELETE CASCADE fires when a source memory is deleted) and the
  // (tenant, agent) isolation scope is consistent with the memory rows the triples reference
  // AND the graph-spread walk hydrates through (the scoped JOIN memories ON
  // source_memory_id = id). Always constructed (no model/IO cost); the 6th graph-spread recall
  // lane stays dormant until an operator enables `agents.<id>.rag.lanes.graphSpread.enabled`
  // (default OFF), and the offline triple-extraction job is its own default-OFF cost gate
  // (NEVER on the recall hot path). Composition-root join — the agent receives the port TYPE
  // only (the agent↛memory cut). Threaded into the recall read path (setup-agents-*).
  const tripleStore = createSqliteTripleStore({ db, logger: memoryLogger });

  // 6.5.2b''''. Embedding read store. Built on the SAME shared `db` handle
  // the memory adapter owns — so the bulk `(tenant, agent)`-scoped LEFT JOIN vec_memories read
  // sees the SAME `memories` rows + `vec_memories` index recall hydrates (an embedding read on a
  // DIFFERENT handle would silently return an empty Map and MMR would no-op). Always
  // constructed (no model/IO cost); the MMR diversity re-rank
  // stays dormant until an operator enables `agents.<id>.rag.mmr.enabled` (default OFF), so the
  // scoped read never runs by default. Composition-root join — the agent receives the port TYPE
  // only (the agent↛memory cut). Threaded into the recall read path (setup-agents-*).
  const embeddingStore = createSqliteMemoryEmbeddingStore({ db, logger: memoryLogger });

  // 6.5.2b'''''. Per-user representation store. Built on the SAME shared `db` handle the memory
  // adapter owns — NEVER a second Database: the `source_memory_id` ON DELETE CASCADE + the
  // `(tenant, agent, user)` 3-way isolation scope must stay consistent with the memory rows the
  // profile is distilled from (a DIFFERENT handle silently returns empty — the embedding-store hazard).
  // Always constructed (no model/IO cost); the LLM-free `<user_profile>` injection stays dormant until
  // the offline builder writes rows (`memoryUserRepresentation.enabled`, default OFF). Composition-root
  // join — the agent receives the port TYPE only (agent↛memory cut). Threaded into the recall read path
  // (setup-agents-*) AND the offline-builder cron (setup-channels). REVISE-02 (203): the MAX per-agent historyCap → this SINGLE store (resolver in setup-memory-history-cap.ts; absent ⇒ default 10).
  const userRepresentationStore = createSqliteUserRepresentationStore({ db, logger: memoryLogger, ...resolveUserRepresentationHistoryCapOption(container.config.agents) });

  // 6.5.2b''''''. Directional relationship store. Built on the
  // SAME shared `db` handle the memory adapter owns — NEVER a second Database: the
  // `source_memory_id` ON DELETE CASCADE + the `(tenant, agent, channel)` channel-scoped isolation
  // must stay consistent with the memory rows the directional edges are distilled from; a read on a
  // DIFFERENT handle would silently return empty (the same hazard as the embedding / user-representation
  // stores above). Always constructed (no model/IO cost); the LLM-free `<channel_relationships>`
  // injection stays dormant until the offline builder writes rows AND the operator enables the
  // dual gate (`socialModeling.enabled` + a recorded `privacyReviewSignedOffBy`). Composition-
  // root join — the agent receives the port TYPE only (the agent↛memory cut). Threaded into the recall
  // read path (setup-agents-*) AND the `__SOCIAL_MODELING__` offline-builder cron (setup-channels).
  const relationshipStore = createSqliteRelationshipStore({ db, logger: memoryLogger });

  // 6.5.2c. Consolidation store. Built on the SAME `db` handle the memory
  // adapter owns — NOT a second Database — so the observation columns (proof_count /
  // source_ids / consolidated_at / confidence / history) and the memories table share
  // one FK-enabled connection, and the (tenant, agent) isolation scope is consistent
  // with the memory rows the consolidation job reads + marks. Always constructed (no
  // model/IO cost, like the entity store); the consolidation cron stays dormant until an
  // operator enables `agents.<id>.memoryConsolidation.enabled` (default OFF — the cost
  // gate). This is the composition-root join: the daemon builds the @comis/memory
  // adapter here and injects it into the @comis/agent job as the port TYPE (no agent→memory
  // edge — the architecture-graph cut is preserved).
  const consolidationStore = createSqliteMemoryConsolidationStore({ db, logger: memoryLogger });

  // 6.5.2d. Recall-utility usefulness store. Built on the SAME `db`
  // handle the memory adapter owns — NOT a second Database — so the memory_usefulness
  // table and the memories table share one FK-enabled connection (the memory_id ON DELETE
  // CASCADE fires) and the (tenant, agent) isolation scope is consistent with the memory
  // rows it scores. Always constructed (no model/IO cost, like the entity + consolidation
  // stores); the feedback loop stays dormant until an operator enables
  // `agents.<id>.rag.feedback.enabled` (default OFF). This is the composition-root build
  // ONLY; the attribution write-back subscriber is wired separately
  // (it depends on a recall-attribution bus event not yet declared at this point).
  const usefulnessStore = createSqliteMemoryUsefulnessStore({ db, logger: memoryLogger });

  // 6.5.2d-bis. Tuned-alpha store. Built on the SAME
  // shared `db` handle the memory adapter owns — NOT a second Database — so the
  // tuned_alpha table and the memories table share one connection and the (tenant, agent)
  // isolation scope is consistent. Always constructed (no model/IO cost, like the
  // usefulness store); it stays dormant until BOTH the recall-side gate
  // (`agents.<id>.rag.onlineTuning.enabled` — the gated read) AND the offline
  // KEYLESS bandit cron (`agents.<id>.memoryOnlineTuning.enabled` — the __ONLINE_TUNING__
  // write) are on. This is the composition-root join: the daemon builds the @comis/memory
  // adapter here and threads the port TYPE into BOTH the recall read path (setup-agents-*
  // -> createPiExecutor -> prompt-assembly's buildScoringAlphas) AND the __ONLINE_TUNING__
  // cron (setup-channels) — the agent receives the port TYPE only (the agent↛memory cut).
  const tunedAlphaStore = createSqliteTunedAlphaStore({ db, logger: memoryLogger });
  // 6.5.2d-quater. Outcome-signal store (Verified Learning WS1, OUTCOME-01). UNCONDITIONAL on the shared `db` (no model/IO cost; gated at observe/resolve). SOLE OutcomeSignalPort adapter; agent never receives it (SEC-01); only wireLearningOutcome + the startup prune consume it (closed-graph).
  const outcomeStore = createSqliteOutcomeStore({ db, logger: memoryLogger });
  // 6.5.2d-quinquies. Learned-skill store (WS2/skills, SKILL-01). UNCONDITIONAL on the shared `db` (DB-CHECK forces trust=learned). SOLE LearnedSkillStorePort adapter; agent↛memory cut — the daemon injects it into the __SKILL_SYNTHESIS__ cron. DORMANT until learningSkills.enabled.
  const learnedSkillStore = createSqliteLearnedSkillStore({ db, logger: memoryLogger });

  // 6.5.2d-ter. Memory-lifecycle sweep store. Built on the SAME shared `db` (NOT a second Database) so the sweep
  // scans the SAME `memories` rows under one (tenant, agent)-scoped FK-enabled connection. Always constructed (no
  // model/IO cost); DORMANT (the KEYLESS __MEMORY_LIFECYCLE__ cron, default OFF, evicts/demotes 0 rows). Threaded as
  // the port TYPE into the cron sentinel (setup-channels), NOT createPiExecutor (the agent↛memory cut).
  const memoryLifecycleStore = createSqliteMemoryLifecycleStore({ db, logger: memoryLogger });

  // 6.5.2e. Recall-counter composition. Stand up the SINGLE in-process recall-counter registry +
  // subscribe it to the `memory:*` bus events HERE (the memory composition site already holds the
  // bus). The daemon threads the returned `{ snapshot }` into `MemoryApiDeps.recallCounters` so
  // `memory.recall_stats` reads the SAME live registry the `memory:*` events feed — never a fresh
  // registry per call. Daemon-lifetime gauge (resets on restart); counts only cross the bus (§2.7).
  const recallCounters = wireRecallCounters(container.eventBus);

  // 6.5.2f. Recall-utility write-back subscriber.
  // Subscribe `memory:recall_used` (emitted by @comis/agent's postExecution) →
  // usefulnessStore.recordUsage HERE — the composition root holds BOTH the bus
  // AND the @comis/memory adapter (the agent↛memory cut: the agent emits ids+counts,
  // the daemon writes). Mirrors the wireRecallCounters subscriber above. The
  // `feedbackEnabled` gate scans the parsed per-agent config (mirroring the
  // someAgentExplicitOn rerank-gate scan above) so default-off (no agent has
  // feedback on) makes the subscriber a no-op write AND keeps the read-side off.
  // (Once the `feedback` schema field is added this access is live; until
  // then the forward-declared view yields false = off.) Fire-and-forget/non-fatal.
  wireMemoryUsefulness({
    eventBus: container.eventBus,
    usefulnessStore,
    clock,
    logger: memoryLogger,
    feedbackEnabled: () =>
      Object.values(container.config.agents ?? {}).some(
        (a) =>
          (a?.rag as ({ feedback?: { enabled?: boolean } } | undefined))?.feedback
            ?.enabled === true,
      ),
  });

  // 6.5.2f'. WS1 outcome subscriber + RANK/FORGET reward-at-resolve + OUTCOME-04 LLM-judge fallback (own leaf, byte-identity-gated); lcdStore created here for the judge transcript reader.
  const lcdStore = createLcdStore(db);
  const judge = buildOutcomeJudgeWiring(container, clock, memoryLogger, lcdStore);
  setupLearningOutcomeWiring({
    eventBus: container.eventBus, outcomeStore, learnedSkillStore,
    usefulnessStore, clock,
    logger: memoryLogger,
    config: container.config,
    learnedSkillSurfaceRegistry: deps.learnedSkillSurfaceRegistry,
    outcomeJudge: judge.outcomeJudge, learningOutcomeJudgeEnabled: judge.learningOutcomeJudgeEnabled, readTurnTranscript: judge.readTurnTranscript,
  });

  // 6.5.2f''. Reaction + correction outcome wiring (Verified Learning WS1, Phase 199 — the corroborating sources) behind the byte-identity gate; bulk lives in the co-located helper.
  const reactionWiring = buildReactionWiringDeps(
    { config: container.config, secretManager: container.secretManager, eventBus: container.eventBus, outcomeStore, logger: memoryLogger },
    clock, timers);
  wireLearningReactions(reactionWiring.deps);
  wireLearningCorrection(reactionWiring.deps);
  const { recordOutboundMessage, destroyReactionWiring } = reactionWiring; // WR-01: destroy* tears down the reaction/session maps + rate-limiter timers at shutdown

  // 6.5.3. Wire caching: L1(L2(provider)) when persistent, L1(provider) otherwise
  let cachedPort: EmbeddingPort | undefined;
  let embeddingCacheStats: (() => import("@comis/memory").EmbeddingCacheStats) | undefined;
  if (embeddingPort && embeddingConfig && embeddingConfig.cache.maxEntries > 0) {
    let innerForL1: EmbeddingPort = embeddingPort;

    // L2: persistent SQLite cache (config-gated)
    if (embeddingConfig.cache.persistent) {
      innerForL1 = createSqliteEmbeddingCache(embeddingPort, {
        db,
        maxEntries: embeddingConfig.cache.persistentMaxEntries,
        ttlMs: embeddingConfig.cache.ttlMs,
        pruneIntervalMs: embeddingConfig.cache.pruneIntervalMs,
      });
    }

    // L1: in-memory LRU wraps L2 (or raw provider if persistent=false)
    const cachedPortWithStats = createCachedEmbeddingPort(innerForL1, {
      maxEntries: embeddingConfig.cache.maxEntries,
      ttlMs: embeddingConfig.cache.ttlMs,
    });
    cachedPort = cachedPortWithStats;
    embeddingCacheStats = () => cachedPortWithStats.getCacheStats();
  } else {
    cachedPort = embeddingPort;
  }

  // 6.5.4. Fingerprint check + batch indexing
  let backgroundIndexingPromise: Promise<unknown> | undefined;
  let embeddingQueue: ReturnType<typeof createEmbeddingQueue> | undefined;

  if (cachedPort && embeddingConfig) {
    const fingerprintMgr = createFingerprintManager(db);
    fingerprintMgr.ensureTable();

    if (embeddingConfig.autoReindex && fingerprintMgr.hasChanged(cachedPort)) {
      memoryLogger.info("Embedding model changed, triggering full reindex");
      // Note: reindex happens in background (non-blocking startup)
      const batchIndexer = createBatchIndexer(db, cachedPort, {
        batchSize: embeddingConfig.batch.batchSize,
        logger: memoryLogger,
      });
      backgroundIndexingPromise = batchIndexer.reindexAll().then(({ indexed, failed, lastError }) => {
        if (failed > 0 && lastError) {
          memoryLogger.warn(
            { indexed, failed, lastError, hint: "Check embedding provider connectivity and model configuration", errorKind: "dependency" as const },
            "Embedding reindex complete with failures",
          );
        } else {
          memoryLogger.info({ indexed, failed }, "Embedding reindex complete");
        }
      }).catch((e) => {
        memoryLogger.warn({ err: String(e), hint: "Check database integrity and embedding provider connectivity", errorKind: "dependency" as const }, "Background embedding reindex failed");
      });
    } else if (embeddingConfig.batch.indexOnStartup) {
      const batchIndexer = createBatchIndexer(db, cachedPort, {
        batchSize: embeddingConfig.batch.batchSize,
        logger: memoryLogger,
      });
      const count = batchIndexer.unembeddedCount();
      if (count > 0) {
        memoryLogger.info({ unembedded: count }, "Indexing unembedded memories in background");
        backgroundIndexingPromise = batchIndexer.indexUnembedded().then(({ indexed, failed, lastError }) => {
          if (failed > 0 && lastError) {
            memoryLogger.warn(
              { indexed, failed, lastError, hint: "Check embedding provider connectivity and model configuration", errorKind: "dependency" as const },
              "Background embedding indexing complete with failures",
            );
          } else {
            memoryLogger.info({ indexed, failed }, "Background embedding indexing complete");
          }
        }).catch((e) => {
          memoryLogger.warn({ err: String(e), hint: "Check database integrity and embedding provider connectivity", errorKind: "dependency" as const }, "Background embedding indexing failed");
        });
      }
    }

    // Save current fingerprint for next startup comparison
    fingerprintMgr.save(fingerprintMgr.computeFingerprint(cachedPort));

    // Create and wire embedding queue for new entries
    embeddingQueue = createEmbeddingQueue(db, cachedPort);
  }

  const sessionStore = createSessionStore(db); // lcdStore is created earlier (6.5.2d-sexies) for the judge reader
  const provenanceStore = buildProvenanceReadStore(db); // DIST-03 read side (Phase 173 carry-in); same db handle; threaded to createMemoryRecall's down-weighting pass (built-but-not-wired fix)
  const contextBrowse = createLcdBrowseStore(db); // ContextBrowsePort (context.conversations)
  const memoryApi: MemoryApi = createMemoryApi(db, memoryAdapter, sessionStore, memoryConfig);
  memoryLogger.debug(
    { dbPath: memoryConfig.dbPath, embedding: !!cachedPort },
    "Memory services initialized",
  );

  // Build dispose callback: L1 -> L2 -> provider
  const disposeEmbedding = cachedPort?.dispose
    ? async () => { await cachedPort!.dispose!(); }
    : undefined;

  // Throttled WAL checkpoint: runs PASSIVE checkpoint every 10th call (~5 min at 30s health interval)
  let maintenanceTickCount = 0;
  const maintenanceTick = (): void => {
    maintenanceTickCount++;
    if (maintenanceTickCount % 10 !== 0) return;
    try {
      const pages = memoryAdapter.checkpoint();
      if (pages > 0) {
        memoryLogger.debug({ pages }, "WAL checkpoint moved pages");
      }
    } catch { /* checkpoint failure must not crash health tick */ }
  };

  return {
    disposeEmbedding,
    cachedPort,
    memoryAdapter,
    db,
    sessionStore,
    lcdStore, provenanceStore, contextBrowse,
    memoryApi,
    embeddingQueue,
    backgroundIndexingPromise,
    embeddingCacheStats,
    embeddingCircuitBreakerState: embeddingCbRef ? () => embeddingCbRef!.getState() : undefined,
    summarizerSpendBreaker,
    rerankerPort,
    rerankerModelPresent: modelPresent,
    disposeReranker,
    entityStore,
    temporalStore,
    causalStore,
    tripleStore,
    embeddingStore,
    userRepresentationStore,
    relationshipStore,
    consolidationStore,
    usefulnessStore,
    tunedAlphaStore,
    outcomeStore,
    learnedSkillStore,
    recordOutboundMessage,
    destroyReactionWiring,
    memoryLifecycleStore,
    recallCounters,
    maintenanceTick,
  };
}
