// SPDX-License-Identifier: Apache-2.0
/**
 * Recall orchestrator public types (the deps + config + surface), extracted from
 * memory-recall.ts so BOTH the orchestrator and its extracted observability tail
 * (recall-observability.ts) can import them WITHOUT a source-level import cycle
 * (ARCH-BASE-05 / no-cycles.test.ts counts type-only edges). memory-recall.ts
 * re-exports these so existing consumers (the daemon composition, prompt-assembly,
 * the index barrel) are unaffected.
 *
 * Pure type module: TYPE-only imports from @comis/core + @comis/observability + the
 * in-package score/fuse types. No runtime code, no @comis/memory import (the
 * agent↛memory build cut is untouched — every store dep is a @comis/core port TYPE).
 *
 * @module
 */

import type {
  MemoryPort,
  MemoryEntityStore,
  MemoryTemporalStore,
  MemoryCausalStore,
  MemoryEmbeddingStore,
  MemoryUsefulnessStore,
  RerankerPort,
  TrustLevel,
  TimerPort,
  ClockPort,
  ComisLogger,
  TypedEventBus,
  TripleStorePort,
  MemorySearchResult,
  SessionKey,
} from "@comis/core";
import type { RecallTrace } from "@comis/observability";
import type { Result } from "@comis/shared";
import type { ScoringAlphas } from "./score.js";

/** Injected dependencies for the recall orchestrator. */
export interface MemoryRecallDeps {
  /** Tenant+agent-scoped memory search port (the candidate supply). */
  memoryPort: MemoryPort;
  /** Optional cross-encoder reranker. Absent/unavailable -> fusion order (RANK-03). */
  reranker?: RerankerPort;
  /**
   * Optional entity-associative store (ENT-02). When present AND entityLane.enabled,
   * the read path queries `associativeLane(seedIds, scope, cap)` for memories sharing
   * an entity with the top search hits and fuses them as a 2nd lane. Absent -> no
   * entity lane (graceful; RRF unchanged). TYPE-only from @comis/core — the agent
   * never imports the memory package (the agent↛memory build cut); the daemon injects
   * the concrete adapter (Plan 05).
   */
  entityStore?: MemoryEntityStore;
  /**
   * Optional temporal-spread store (LANES-02). When present AND cfg.lanes.temporal.enabled,
   * the read path queries `spreadLane(seedTimes, scope, windowMs, cap)` for memories near
   * the seed hits' `occurred_at` event times and fuses them as a 4th lane. Absent / disabled
   * / no seed times -> no temporal lane (graceful; RRF unchanged — the ENT-04 no-op). TYPE-only
   * from @comis/core — the agent never imports the memory package (the agent↛memory build cut);
   * the daemon injects the concrete adapter (the composition root).
   */
  temporalStore?: MemoryTemporalStore;
  /**
   * Optional causal store (EXTRACT-03). When present AND cfg.lanes.causal.enabled, the read path
   * queries `causalLane` (in appendCausalLane) for memories causally linked to the top base hits
   * and fuses them as a 5th lane; absent / disabled / no seeds -> no causal lane (RRF unchanged).
   * TYPE-only (the agent↛memory cut); the daemon injects the SAME store the write path uses for linkCausal.
   */
  causalStore?: MemoryCausalStore;
  /**
   * Optional trust-first triple store (KG-04). When present AND cfg.lanes.graphSpread.enabled,
   * recall queries `spreadLane` (in appendGraphSpreadLane) for memories STRUCTURALLY connected
   * to the top base hits (a bounded recursive-CTE walk over current-truth subject→object edges,
   * LLM-free) and fuses them as a 6th lane; absent / disabled / no seeds -> RRF unchanged (the
   * ENT-04 no-op). TYPE-only (the agent↛memory cut); the daemon injects the SqliteTripleStore (Plan 05).
   */
  tripleStore?: TripleStorePort;
  /**
   * Optional embedding read store (IQ-01). When present AND cfg.mmr.enabled AND ≥2 ranked
   * candidates, recall does a bulk SCOPED read of the post-rerank candidate ids' embeddings
   * (the adapter LEFT JOINs vec_memories per (tenant, agent)) and runs MMR diversity re-rank.
   * Absent / disabled / <2 embedded candidates → no read, no MMR (byte-identical). A FAILED
   * read is NON-FATAL (WARN + rank without MMR). TYPE-only from @comis/core — the agent never
   * imports @comis/memory (the agent↛memory cut); the daemon injects the concrete adapter
   * (the composition root, 102-05).
   */
  embeddingStore?: MemoryEmbeddingStore;
  /**
   * Optional usefulness store (FEED-03). When present AND cfg.feedback.enabled, recall does a
   * bulk read of the per-memory signal for the ranked ids and folds the used-rate into the
   * usefulnessFactor in score.ts. Absent or flag-off -> no read, usefulnessById stays
   * undefined, every usefulnessNorm(undefined) -> factor 1.0 (byte-identical to v2.6).
   * TYPE-only from @comis/core — the agent never imports the memory package (the agent↛memory
   * build cut); the daemon injects the concrete adapter (Plan 03 wiring).
   */
  usefulnessStore?: MemoryUsefulnessStore;
  /** Timer port for the rerank wall-clock deadline. Absent -> no timeout wrap. */
  timers?: TimerPort;
  /** Wall-clock reads for the recency boost (never Date.now()). */
  clock: ClockPort;
  /** Structural logger (WARN on degrade/timeout with errorKind + hint, counts only). */
  logger: ComisLogger;
  /**
   * Optional recall-trace recorder (OBS-01/02). When present, recall writes ONE rich
   * record per call (lanes+counts, fused order, rerank pre/post + outcome, the final
   * ranked set with per-memory breakdown + include/exclude reason, degradations). The
   * recorder is `null` when `diagnostics.recallTrace.enabled` is false at the
   * construction site, so an ABSENT recorder reproduces today's behavior exactly
   * (no record, zero overhead). TYPE-only from @comis/observability — the agent↛memory
   * cut is untouched. recordRecall is wrapped non-fatal: a recorder failure NEVER fails
   * the recall hot path (observability degrades, never errors — T-86-13).
   */
  recallTrace?: RecallTrace;
  /**
   * Optional event bus (OBS-04). When present, recall emits the counts-only
   * `memory:recalled` (once per recall) and `memory:reranked` (only when a rerank stage
   * was attempted). Payloads are counts/booleans/ids ONLY — never the query text or
   * memory bodies. Absent -> no emit (today's behavior). The emit is wrapped non-fatal.
   */
  eventBus?: TypedEventBus;
}

/** Recall configuration (sourced from RagConfig at the call site). */
export interface MemoryRecallConfig {
  /** Maximum results to surface (the default-path search pool size). */
  maxResults: number;
  /** Minimum RRF score threshold passed to search. */
  minScore: number;
  /** Trust levels permitted into recall (external excluded by default). */
  includeTrustLevels: TrustLevel[];
  /** Cross-encoder rerank knobs (opt-in; default-OFF). */
  rerank: { enabled: boolean; maxCandidates: number; minResults: number; timeoutMs: number };
  /** Multiplicative scoring boost weights. */
  scoring: ScoringAlphas;
  /**
   * Per-lane RRF weights for the FTS + vector fusion lanes (LANES-01; sourced from
   * RagConfig.lanes). When the injected MemoryPort exposes `searchLanes`, recall builds
   * TWO lanes (fts + vector) and fuses them with these weights. Optional so a caller
   * predating the field leaves it absent -> the per-lane fallbacks {fts:1.0, vector:1.5}
   * (the parity defaults) apply. The defaults reproduce v2.6's pre-fused ranking
   * byte-for-byte (the parity guard, T-95-01).
   */
  lanes?: {
    fts: { weight: number };
    vector: { weight: number };
    /**
     * Temporal-spread lane knobs (LANES-02; from RagConfig.lanes.temporal). Default-OFF
     * (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the ENT-04 no-op).
     * Optional so a caller predating the field leaves it absent -> no temporal lane.
     */
    temporal?: { enabled: boolean; weight: number; windowDays: number };
    /** Causal one-hop lane knobs (EXTRACT-03; from RagConfig.lanes.causal). Default-OFF
     *  (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the ENT-04 no-op). */
    causal?: { enabled: boolean; weight: number };
    /** Graph-spread lane knobs (KG-04; from RagConfig.lanes.graphSpread). Default-OFF
     *  (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the ENT-04 no-op).
     *  `maxDepth` caps the recursive-CTE hop count, `fanOut` caps per-node expansion. */
    graphSpread?: { enabled: boolean; weight: number; maxDepth: number; fanOut: number };
  };
  /**
   * Entity-associative lane knobs (sourced from RagConfig.entityLane). Optional so
   * callers that predate the lane (or the daemon before Plan 05 wiring) leave it
   * absent -> no entity lane. Default-OFF (`enabled: false`) -> RRF unchanged (ENT-04).
   */
  entityLane?: { enabled: boolean; seedCount: number; perEntityCap: number; weight: number };
  /**
   * Recall-utility feedback toggle (FEED-03; sourced from RagConfig.feedback). The toggle
   * ONLY — there is NO usefulnessAlpha here. The boost MAGNITUDE is the single canonical
   * `rag.scoring.usefulnessAlpha` (on {@link MemoryRecallConfig.scoring}, exactly like the
   * other alphas), so there is no second knob and no drift. Optional so a caller predating
   * the field (or the daemon before Plan 03 wiring) leaves it absent -> off (no read). The
   * primary default-off guard is skipping the read entirely, so the alpha is irrelevant off.
   */
  feedback?: { enabled: boolean };
  /** MMR diversity re-rank knobs (IQ-01; sourced from RagConfig.mmr). Default-OFF
   *  (`enabled:false`) → no read, no MMR (byte-identical). λ in [0,1]; 1.0 = pure relevance =
   *  identity. Optional so a caller predating the field (or the daemon before 102-05 wiring)
   *  leaves it absent → off. */
  mmr?: { enabled: boolean; lambda: number };
  /** Query-understanding knobs (IQ-02/03; sourced from RagConfig.queryUnderstanding). All
   *  default-OFF → no reweight, no expansion, no range filter (byte-identical). Optional so a
   *  caller predating the field leaves it absent → off. */
  queryUnderstanding?: { intentReweight: boolean; synonyms: boolean; temporalParse: boolean };
}

/** The recall orchestrator surface — a single `recall` method. */
export interface MemoryRecall {
  /**
   * Run the full recall pipeline for a query. Returns the ranked, trust-filtered,
   * deduped results that the hybrid memory injector consumes. Chains by early-return
   * on a search error; a reranker failure/timeout degrades to fusion order (never
   * an error, never empty when the search itself succeeded with results).
   */
  recall(
    query: string,
    sessionKey: SessionKey,
    agentId?: string,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
