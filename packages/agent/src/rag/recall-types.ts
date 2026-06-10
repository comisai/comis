// SPDX-License-Identifier: Apache-2.0
/**
 * Recall orchestrator public types (the deps + config + surface), extracted from
 * memory-recall.ts so BOTH the orchestrator and its extracted observability tail
 * (recall-observability.ts) can import them WITHOUT a source-level import cycle
 * (no-cycles.test.ts counts type-only edges). memory-recall.ts
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
  MemoryPinnedStore,
  RerankerPort,
  TrustLevel,
  TimerPort,
  ClockPort,
  ComisLogger,
  TypedEventBus,
  TripleStorePort,
  MemorySearchResult,
  SessionKey,
  LcdProvenanceReadStore,
} from "@comis/core";
import type { RecallTrace } from "@comis/observability";
import type { Result } from "@comis/shared";
import type { ScoringAlphas } from "./score.js";

/** Injected dependencies for the recall orchestrator. */
export interface MemoryRecallDeps {
  /** Tenant+agent-scoped memory search port (the candidate supply). */
  memoryPort: MemoryPort;
  /** Optional cross-encoder reranker. Absent/unavailable -> fusion order. */
  reranker?: RerankerPort;
  /**
   * Optional entity-associative store. When present AND entityLane.enabled,
   * the read path queries `associativeLane(seedIds, scope, cap)` for memories sharing
   * an entity with the top search hits and fuses them as a 2nd lane. Absent -> no
   * entity lane (graceful; RRF unchanged). TYPE-only from @comis/core — the agent
   * never imports the memory package (the agent↛memory build cut); the daemon injects
   * the concrete adapter.
   */
  entityStore?: MemoryEntityStore;
  /**
   * Optional temporal-spread store. When present AND cfg.lanes.temporal.enabled,
   * the read path queries `spreadLane(seedTimes, scope, windowMs, cap)` for memories near
   * the seed hits' `occurred_at` event times and fuses them as a 4th lane. Absent / disabled
   * / no seed times -> no temporal lane (graceful; RRF unchanged — the empty-lane no-op). TYPE-only
   * from @comis/core — the agent never imports the memory package (the agent↛memory build cut);
   * the daemon injects the concrete adapter (the composition root).
   */
  temporalStore?: MemoryTemporalStore;
  /**
   * Optional causal store. When present AND cfg.lanes.causal.enabled, the read path
   * queries `causalLane` (in appendCausalLane) for memories causally linked to the top base hits
   * and fuses them as a 5th lane; absent / disabled / no seeds -> no causal lane (RRF unchanged).
   * TYPE-only (the agent↛memory cut); the daemon injects the SAME store the write path uses for linkCausal.
   */
  causalStore?: MemoryCausalStore;
  /**
   * Optional trust-first triple store. When present AND cfg.lanes.graphSpread.enabled,
   * recall queries `spreadLane` (in appendGraphSpreadLane) for memories STRUCTURALLY connected
   * to the top base hits (a bounded recursive-CTE walk over current-truth subject→object edges,
   * LLM-free) and fuses them as a 6th lane; absent / disabled / no seeds -> RRF unchanged (the
   * empty-lane no-op). TYPE-only (the agent↛memory cut); the daemon injects the SqliteTripleStore.
   */
  tripleStore?: TripleStorePort;
  /**
   * Optional embedding read store. When present AND cfg.mmr.enabled AND ≥2 ranked
   * candidates, recall does a bulk SCOPED read of the post-rerank candidate ids' embeddings
   * (the adapter LEFT JOINs vec_memories per (tenant, agent)) and runs MMR diversity re-rank.
   * Absent / disabled / <2 embedded candidates → no read, no MMR (byte-identical). A FAILED
   * read is NON-FATAL (WARN + rank without MMR). TYPE-only from @comis/core — the agent never
   * imports @comis/memory (the agent↛memory cut); the daemon injects the concrete adapter
   * (the composition root).
   */
  embeddingStore?: MemoryEmbeddingStore;
  /**
   * Optional usefulness store. When present AND cfg.feedback.enabled, recall does a
   * bulk read of the per-memory signal for the ranked ids and folds the used-rate into the
   * usefulnessFactor in score.ts. Absent or flag-off -> no read, usefulnessById stays
   * undefined, every usefulnessNorm(undefined) -> factor 1.0 (byte-identical to the pre-feedback path).
   * TYPE-only from @comis/core — the agent never imports the memory package (the agent↛memory
   * build cut); the daemon injects the concrete adapter.
   */
  usefulnessStore?: MemoryUsefulnessStore;
  /**
   * Optional pinned-memory read store. When present AND cfg.pinned.enabled,
   * recall fetches pinned entries for the scope BEFORE the fused search and
   * prepends them (bounded by cfg.pinned.maxPinnedInjection) to the final result.
   * Pinned IDs are removed from the fused candidate set BEFORE mmrRerank (Step 5b-pre)
   * to prevent double-injection. DEFAULT-OFF BYTE-IDENTITY: with pinned.enabled=false,
   * no pinnedStore, or no pinned entries, this block is SKIPPED — no query runs.
   * TYPE-only from @comis/core — the agent never imports @comis/memory (the
   * agent↛memory build cut); the daemon injects the concrete adapter.
   */
  pinnedStore?: MemoryPinnedStore;
  /**
   * Optional LCD provenance read store (DIST-03). When present AND a selected recall
   * result carries the "lcd_distilled" tag, the post-fusion provenance pass (after
   * mmrRerank, before observability capture) down-weights same-conversation paired
   * memories whose covered range overlaps the distilled summary's (score multiplier
   * ×0.5, NEVER deleted — the memory stays accessible). It also queries
   * `getProvenanceForSummary(scope, summaryId)` for any distilled summary that carries
   * a `summary:<id>` tag, down-weighting the EXACT provenance-linked memoryIds. TYPE-only
   * from @comis/core — the agent never imports @comis/memory (the agent↛memory build cut).
   * Absent / no lcd_distilled result → NO-OP (byte-identical; getProvenanceForSummary is
   * never called). A FAILED pass is NON-FATAL (WARN + recall results unaffected). DEFAULT-OFF.
   *
   * INJECTED AT THE COMPOSITION ROOT IN PHASE 173 (C2): the daemon builds the concrete
   * LcdProvenanceReadStore (setup-memory's buildProvenanceReadStore) and threads it here,
   * and the distillation runner stamps the `summary:<id>` tag — so the precise-provenance
   * branch is the primary selector. The pass is live but stays a byte-identical no-op when
   * this store is absent (e.g. a unit harness that omits it).
   */
  provenanceStore?: LcdProvenanceReadStore;
  /** Timer port for the rerank wall-clock deadline. Absent -> no timeout wrap. */
  timers?: TimerPort;
  /** Wall-clock reads for the recency boost (never Date.now()). */
  clock: ClockPort;
  /** Structural logger (WARN on degrade/timeout with errorKind + hint, counts only). */
  logger: ComisLogger;
  /**
   * Optional recall-trace recorder. When present, recall writes ONE rich
   * record per call (lanes+counts, fused order, rerank pre/post + outcome, the final
   * ranked set with per-memory breakdown + include/exclude reason, degradations). The
   * recorder is `null` when `diagnostics.recallTrace.enabled` is false at the
   * construction site, so an ABSENT recorder reproduces today's behavior exactly
   * (no record, zero overhead). TYPE-only from @comis/observability — the agent↛memory
   * cut is untouched. recordRecall is wrapped non-fatal: a recorder failure NEVER fails
   * the recall hot path (observability degrades, never errors).
   */
  recallTrace?: RecallTrace;
  /**
   * Optional event bus. When present, recall emits the counts-only
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
   * Per-lane RRF weights for the FTS + vector fusion lanes (sourced from
   * RagConfig.lanes). When the injected MemoryPort exposes `searchLanes`, recall builds
   * TWO lanes (fts + vector) and fuses them with these weights. Optional so a caller
   * predating the field leaves it absent -> the per-lane fallbacks {fts:1.0, vector:1.5}
   * (the parity defaults) apply. The defaults reproduce the prior pre-fused ranking
   * byte-for-byte (the parity guard).
   */
  lanes?: {
    fts: { weight: number };
    vector: { weight: number };
    /**
     * Temporal-spread lane knobs (from RagConfig.lanes.temporal). Default-OFF
     * (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the empty-lane no-op).
     * Optional so a caller predating the field leaves it absent -> no temporal lane.
     */
    temporal?: { enabled: boolean; weight: number; windowDays: number };
    /** Causal one-hop lane knobs (from RagConfig.lanes.causal). Default-OFF
     *  (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the empty-lane no-op). */
    causal?: { enabled: boolean; weight: number };
    /** Graph-spread lane knobs (from RagConfig.lanes.graphSpread). Default-OFF
     *  (`enabled:false`) -> the lane is never pushed -> RRF unchanged (the empty-lane no-op).
     *  `maxDepth` caps the recursive-CTE hop count, `fanOut` caps per-node expansion. */
    graphSpread?: { enabled: boolean; weight: number; maxDepth: number; fanOut: number };
  };
  /**
   * Entity-associative lane knobs (sourced from RagConfig.entityLane). Optional so
   * callers that predate the lane (or the daemon before the entity-lane wiring) leave it
   * absent -> no entity lane. Default-OFF (`enabled: false`) -> RRF unchanged.
   */
  entityLane?: { enabled: boolean; seedCount: number; perEntityCap: number; weight: number };
  /**
   * Recall-utility feedback toggle (sourced from RagConfig.feedback). The toggle
   * ONLY — there is NO usefulnessAlpha here. The boost MAGNITUDE is the single canonical
   * `rag.scoring.usefulnessAlpha` (on {@link MemoryRecallConfig.scoring}, exactly like the
   * other alphas), so there is no second knob and no drift. Optional so a caller predating
   * the field (or the daemon before the feedback wiring) leaves it absent -> off (no read). The
   * primary default-off guard is skipping the read entirely, so the alpha is irrelevant off.
   */
  feedback?: { enabled: boolean };
  /** MMR diversity re-rank knobs (sourced from RagConfig.mmr). Default-OFF
   *  (`enabled:false`) → no read, no MMR (byte-identical). λ in [0,1]; 1.0 = pure relevance =
   *  identity. Optional so a caller predating the field (or the daemon before the MMR wiring)
   *  leaves it absent → off. */
  mmr?: { enabled: boolean; lambda: number };
  /** Pinned-memory injection knobs (sourced from RagConfig.pinned). Default-OFF
   *  (`enabled:false`) → no pinned-first lane runs (byte-identical). Optional so a caller
   *  predating the field (or the daemon before the pinning wiring) leaves it absent → off.
   *  `maxPinnedInjection` caps the bounded set — only this many pinned entries are fetched
   *  and prepended to the final result, preventing context budget exhaustion. */
  pinned?: { enabled: boolean; maxPinnedInjection: number };
  /** FadeMem per-type decay gate (sourced from RagConfig.forget). The toggle ONLY —
   *  there is NO forgetAlpha here. The decay MAGNITUDE is the single canonical
   *  `rag.scoring.forgetAlpha` (on {@link MemoryRecallConfig.scoring}, exactly like the other
   *  alphas), so there is no second knob and no drift. Default-OFF (`enabled:false`) → score.ts
   *  forces the forgetFactor to EXACTLY 1.0 → byte-identical recall (the safety gate, way #1);
   *  the neutral-importance byte-identity holds even when ON (event-age 0 → factor 1.0, way #2).
   *  Optional so a caller predating the field leaves it absent → off. */
  forget?: { enabled: boolean };
  /** Query-understanding knobs (sourced from RagConfig.queryUnderstanding). All
   *  default-OFF → no reweight, no expansion, no range filter (byte-identical). Optional so a
   *  caller predating the field leaves it absent → off. */
  queryUnderstanding?: { intentReweight: boolean; synonyms: boolean; temporalParse: boolean };
  /** Minimum BASE relevance score (pre-boost) for memory injection (R3 floor).
   *  Filter runs AFTER scoreWithBreakdown() (breakdownById populated) and BEFORE
   *  trust-filter. Gates on ScoreBreakdown.base — NOT on r.score (the boosted value).
   *  Fallback: if a memory has no breakdown entry, gates on r.score (safe degrade).
   *  Default=0 (absent or 0) → no filtering (byte-identical to the pre-R3 path).
   *  Optional so a caller predating the field leaves it absent → no floor applied.
   *
   *  WR-02 (Phase 173): when {@link MemoryRecallConfig.relevanceFirst} is true, an
   *  UNCONFIGURED floor (0) is NOT silently skipped — it is enforced at the class
   *  default (see RELEVANCE_FIRST_DEFAULT_BASE_FLOOR in memory-recall.ts). See that
   *  field's doc. */
  baseFloor?: number;
  /**
   * RETR-04 / WR-02 (Phase 173): the unified-arbiter-active signal (from
   * ScaffoldDefaults.relevanceFirst). When `true` (small/nano relevance-first), the
   * recall path ranks LTM T3/T4 candidates relevance-first and the baseFloor gate is
   * FAIL-CLOSED: an unconfigured floor (0) resolves to the class default and the filter
   * runs — an arbiter that ranks LTM against history needs the floor enforced (design
   * §17 S6). When `false`/absent (frontier/mid recency-first, the default), the gate
   * keeps the legacy `> 0` skip → byte-identical to v2.14 (LOCKED #2). Optional so a
   * caller predating the field leaves it absent → off (recency-first, byte-identical).
   */
  relevanceFirst?: boolean;
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
