// SPDX-License-Identifier: Apache-2.0
/**
 * createMemoryRecall — the single recall orchestrator (RANK-07).
 *
 * Composes the full recall pipeline as one function, REPLACING the inline
 * search/filter/dedup block that lived in executor/prompt-assembly.ts:
 *
 *   1. SEARCH      memoryPort.search (tenant+agent scoped; overfetch only when reranking)
 *   2. FUSE        N-lane RRF (single lane now = identity; entity lane is a Phase-83 seam)
 *   3. RERANK      opt-in cross-encoder (default-OFF per Phase-79); graceful degrade +
 *                  timeout -> fused order (RANK-01/03/08)
 *   4. SCORE       multiplicative recency/temporal/proof/trust boosts + trust tie-break
 *                  (RANK-05/06)
 *   5. TRUST-FILTER  drop trustLevels ∉ includeTrustLevels (mirrors the old inline filter)
 *   6. DEDUP       collapse near-identical content (reuse deduplicateResults)
 *
 * ARCHITECTURAL CUT (architecture.test.ts "agent -> memory"): this file imports ONLY
 * core types + shared + in-package fns (fuse/score/deduplicateResults). It must NEVER
 * import the memory package (a devDependency only). The reranker reaches recall as an
 * injected RerankerPort (the GGUF adapter is built in the daemon, not imported here).
 *
 * TIMEOUT WITHOUT setTimeout (globals.test.ts): the rerank is wrapped in withTimeout
 * (@comis/shared) using a schedule closure built from the injected TimerPort
 * (deps.timers.setTimeout). The raw global setTimeout is never referenced. Recency-"now"
 * is read from the injected ClockPort (deps.clock.now()), never Date.now().
 *
 * @module
 */

import type {
  MemoryPort,
  MemorySearchResult,
  MemoryEntityStore,
  RerankerPort,
  TrustLevel,
  TimerPort,
  ClockPort,
  SessionKey,
  ComisLogger,
  TypedEventBus,
} from "@comis/core";
import { tryGetContext } from "@comis/core";
// TYPE-only import of the recall-trace recorder from @comis/observability — an EXISTING
// production dep of @comis/agent (verified). This does NOT touch the agent↛MEMORY cut:
// the recorder imports @comis/observability, never @comis/memory.
import type { RecallTrace } from "@comis/observability";
import { ok, withTimeout, TimeoutError, type Result } from "@comis/shared";
import { fuse, type FusionLane } from "./fuse.js";
import { scoreWithBreakdown, type ScoringAlphas, type ScoreBreakdown } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";
import {
  buildRecallRecord,
  recallQueryDigest,
  vectorLaneCouldContribute,
  type RecallDegradation,
  type RecallRankedEntry,
  type RecallRerankOutcome,
} from "./recall-record.js";

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
   * Entity-associative lane knobs (sourced from RagConfig.entityLane). Optional so
   * callers that predate the lane (or the daemon before Plan 05 wiring) leave it
   * absent -> no entity lane. Default-OFF (`enabled: false`) -> RRF unchanged (ENT-04).
   */
  entityLane?: { enabled: boolean; seedCount: number; perEntityCap: number; weight: number };
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

/**
 * Build a recall orchestrator from injected deps + recall config.
 *
 * The returned `recall` composes search -> fuse -> rerank -> score -> trust-filter ->
 * dedup. With `rerank.enabled=false` (the default), the rerank stage is skipped and the
 * single-lane fuse is order-preserving, so the output equals the documented default
 * order (fusion order + boosts + trust filter + dedup) — pinned by the default-off
 * characterization test.
 */
export function createMemoryRecall(deps: MemoryRecallDeps, cfg: MemoryRecallConfig): MemoryRecall {
  return {
    async recall(query, sessionKey, agentId) {
      // Trace capture is ADDITIVE: collected into local accumulators at the existing
      // stage snapshot points, assembled into ONE record at the end. When neither
      // deps.recallTrace nor deps.eventBus is present, these locals are computed but
      // never read (the default-off path is byte-identical to pre-Plan-03 — proven by
      // the default-off characterization test). recordRecall + emit are wrapped
      // non-fatal at the end so observability NEVER fails the recall hot path (T-86-13).
      const recallStart = deps.clock.now();
      const degradations: RecallDegradation[] = [];

      // 1. SEARCH — overfetch only when rerank is enabled (default pool size unchanged).
      const limit = cfg.rerank.enabled
        ? Math.max(cfg.maxResults, cfg.rerank.maxCandidates)
        : cfg.maxResults;
      const searched = await deps.memoryPort.search(sessionKey, query, {
        limit,
        minScore: cfg.minScore,
        agentId,
      });
      if (!searched.ok) return searched;

      // Lane-count snapshot (stage 1). `ftsCandidates` is the merged candidate count the
      // recall layer sees (the MemoryPort fuses fts+vector internally and returns one
      // scored list — it does NOT surface a vec-vs-fts split, so this is the honest
      // recall-layer view). `entityCandidates` is set when the entity lane fires below.
      const ftsCandidates = searched.value.length;
      let entityCandidates = 0;

      // OBS-03 vec→FTS-only gap: the operator-facing degradation signal lives where recall
      // decides (the memory store's DEBUG fallback stays for the store). The MemoryPort
      // boundary does not expose whether the vector lane fired, so we derive it
      // conservatively from the recall-layer-observable precondition: a query with no
      // embeddable text (empty/whitespace — the documented zero-length-embedding →
      // FTS-only case). When candidates exist but the vector lane could not contribute, we
      // log ONE WARN + record a vec_unavailable degradation. This fires only for a
      // degenerate query, never as per-recall noise (see vectorLaneCouldContribute).
      const vectorLaneActive = vectorLaneCouldContribute(query);
      if (ftsCandidates > 0 && !vectorLaneActive) {
        const hint = "vector lane unavailable; recall used FTS only";
        deps.logger.warn(
          { agentId, errorKind: "dependency" as const, hint },
          "recall vector-lane fallback",
        );
        degradations.push({ kind: "vec_unavailable", errorKind: "dependency", hint });
      }
      // WR-04: vectorCandidates is reported as 0 — HONEST until a real per-lane split
      // exists. The MemoryPort fuses vec+fts internally and returns ONE merged scored
      // list (no vec-vs-fts breakdown), so the recall layer cannot observe how many of
      // the candidates came from the vector lane. Reporting the merged count as the
      // "vector candidate" signal (the old `vectorLaneActive ? ftsCandidates : 0`) made
      // `laneUsage.vector` a silent DUPLICATE of `laneUsage.fts` on every recall and
      // inflated the fired-lane count by 1 — an operator-facing metric that implies a
      // measurement that is not happening. Until the port surfaces a true per-lane
      // breakdown, report 0; `vectorLaneActive` remains the separate, honest
      // could-the-lane-contribute signal (OBS-03), and the trace's `lanes.vector`
      // reflects the same honest 0.
      const vectorCandidates = 0;

      // 2. FUSE (N-lane RRF). The search lane is always present. The entity-associative
      // lane (ENT-02) is composed LAZILY: only when an entity store is injected, the
      // lane is enabled, AND the search produced seeds. The seeds are the top
      // `seedCount` search hits; the store's scoped self-join returns OTHER memories
      // sharing >= 1 entity (hydrated, most-shared-first), which fuse() rebases onto the
      // shared RRF rank scale so a shared-entity memory can outrank a non-sharing one.
      //
      // Every no-op path leaves the fused output identical to the pre-Phase-83
      // single-lane result (ENT-04): no store / disabled / no seeds / empty lane all
      // fall through to `fuse([searchLane])`. A lane err is NON-FATAL — recall never
      // fails because the entity lane failed (the search lane already succeeded); we
      // WARN and fall back to the search lane only. The lane SQL lives in the memory
      // package behind the injected MemoryEntityStore port — this file imports the TYPE
      // only (the agent↛memory build cut).
      const lanes: FusionLane[] = [{ results: searched.value, weight: 1.0 }];
      const el = cfg.entityLane;
      if (el?.enabled === true && deps.entityStore !== undefined && searched.value.length > 0) {
        const seedIds = searched.value.slice(0, el.seedCount).map((r) => r.entry.id);
        if (seedIds.length > 0) {
          // Scope mirrors memoryPort.search above: tenant from the session key, agent
          // from the recall arg (else the session key's agent, else "default"). The
          // lane's WHERE enforces this in SQL — the load-bearing isolation (ENT-03).
          const scope = {
            tenantId: sessionKey.tenantId,
            agentId: agentId ?? sessionKey.agentId ?? "default",
          };
          const laneRes = await deps.entityStore.associativeLane(seedIds, scope, el.perEntityCap);
          if (laneRes.ok) {
            // ENT-04: an empty lane pushes nothing -> fuse() stays single-lane, unchanged.
            if (laneRes.value.length > 0) {
              lanes.push({ results: laneRes.value, weight: el.weight });
              entityCandidates = laneRes.value.length; // stage-1 lane-count snapshot
            }
          } else {
            deps.logger.warn(
              {
                agentId,
                seedCount: seedIds.length,
                errorKind: "internal" as const,
                hint: "entity lane failed; using search lane only",
              },
              "entity lane fallback",
            );
          }
        }
      }
      let ranked = fuse(lanes);

      // Stage-2 snapshot: the post-fuse id order (the fused ranking before rerank/score).
      const fusedOrder = ranked.map((r) => r.entry.id);

      // Rerank-outcome capture (stage 3). Default is "fell_back" — the value used whenever
      // a rerank stage was NOT attempted OR degraded to fusion order. It flips to "ran" on
      // the success branch and "timed_out" on the TimeoutError catch. `rerankAttempted`
      // gates the memory:reranked emit (emit only when reranking was actually tried).
      let rerankOutcome: RecallRerankOutcome = "fell_back";
      let rerankAttempted = false;
      let rerankCandidateCount = 0;
      let preScores: number[] | undefined;
      let postScores: number[] | undefined;

      // Per-memory score breakdowns (OBS-01), keyed by memory id, populated at whichever
      // scoring path runs (rerank-success per-segment, or the global fused-order pass).
      // Consumed by the final-ranked-set explanation in the trace record.
      const breakdownById = new Map<string, ScoreBreakdown>();

      // Set once the rerank-SUCCESS path has already applied score() boosts
      // per-segment (pool, then tail). When false, the global score() pass below
      // boosts the fused/degraded order. This split is what prevents HI-01: a single
      // global score() over [CE-scored pool ++ RRF-scored tail] mixes two scales and
      // lets a high-RRF tail item leapfrog a low-absolute-CE pool item, undoing the
      // rerank. Scoring each segment independently keeps the pool-before-tail
      // partition intact (the cross-encoder's verdict is authoritative for the pool).
      let rerankApplied = false;

      // 3. RERANK (opt-in, default-OFF; graceful degrade + timeout -> fused order).
      // LO-01: a reranker rank() that never settles would hang recall forever when no
      // TimerPort is injected (the timeout cannot fire). So rerank requires deps.timers
      // — without it we skip reranking entirely and degrade to fused order rather than
      // awaiting an unbounded rank(). In production timers is always present
      // (PiExecutorDeps.timers); this guards the optional-deps surface only.
      const timers = deps.timers;
      if (
        cfg.rerank.enabled &&
        timers !== undefined &&
        deps.reranker?.isAvailable() === true &&
        ranked.length >= cfg.rerank.minResults
      ) {
        rerankAttempted = true; // a rerank stage ran → memory:reranked will emit
        const pool = ranked.slice(0, cfg.rerank.maxCandidates);
        const tail = ranked.slice(cfg.rerank.maxCandidates);
        const docs = pool.map((r) => r.entry.content);
        rerankCandidateCount = docs.length;
        // preScores = the fused (RRF/boost-free base) pool scores handed to the CE.
        preScores = pool.map((r) => r.score ?? 0);
        const schedule = (cb: () => void, ms: number): (() => void) => {
          const handle = timers.setTimeout(cb, ms);
          return () => handle.cancel();
        };
        try {
          const scored = await withTimeout(
            deps.reranker.rank(query, docs),
            cfg.rerank.timeoutMs,
            schedule,
            "rerank",
          );
          if (scored.ok) {
            // HI-01: apply boosts to each segment SEPARATELY on its own scale, then
            // concat pool-before-tail. No global re-sort across scales runs afterward.
            // The reranked pool's base score becomes the cross-encoder probability.
            //
            // LO-02: score() sorts by boosted score, then by trust (RANK-06) for equal
            // relevance. For pool docs with EQUAL CE *and* equal trust, the final
            // tie-break is the fused (pre-rerank) index: score() uses a stable sort and
            // we hand it the pool in fused order, so equal-on-both-keys ties resolve to
            // that order deterministically (not to sort happenstance).
            const rerankedPool = scoreWithBreakdown(
              pool.map((r, i) => ({ ...r, score: scored.value[i] ?? 0 })),
              cfg.scoring,
              deps.clock.now(),
            );
            const scoredTail = scoreWithBreakdown(tail, cfg.scoring, deps.clock.now());
            for (const r of rerankedPool) breakdownById.set(r.entry.id, r.breakdown);
            for (const r of scoredTail) breakdownById.set(r.entry.id, r.breakdown);
            ranked = rerankedPool.concat(scoredTail);
            rerankApplied = true;
            rerankOutcome = "ran";
            // postScores = the cross-encoder probabilities (pool-aligned with preScores).
            postScores = pool.map((_r, i) => scored.value[i] ?? 0);
          } else {
            const hint = "reranker returned err; using fusion order";
            deps.logger.warn(
              {
                agentId,
                rerankCandidates: docs.length,
                errorKind: "dependency" as const,
                hint,
              },
              "rerank fallback",
            );
            // ranked stays = fused order; global score() below applies boosts.
            rerankOutcome = "fell_back";
            degradations.push({ kind: "reranker_unavailable", errorKind: "dependency", hint });
          }
        } catch (e) {
          const kind: "timeout" | "dependency" = e instanceof TimeoutError ? "timeout" : "dependency";
          const hint = "rerank timed out/failed; using fusion order";
          deps.logger.warn(
            {
              agentId,
              rerankCandidates: docs.length,
              timeoutMs: cfg.rerank.timeoutMs,
              errorKind: kind,
              hint,
            },
            "rerank fallback",
          );
          // ranked stays = fused order; global score() below applies boosts.
          // Mirror the EXISTING WARN's errorKind+hint into the trace's degradations[].
          if (kind === "timeout") {
            rerankOutcome = "timed_out";
            degradations.push({ kind: "rerank_timeout", errorKind: "timeout", hint });
          } else {
            rerankOutcome = "fell_back";
            degradations.push({ kind: "reranker_unavailable", errorKind: "dependency", hint });
          }
        }
      }

      // 4. SCORE (boosts + trust tie-break) — only for the fused/degraded order. The
      //    rerank-success path already scored each segment above (rerankApplied), and
      //    re-running a global score() here would re-mix the CE and RRF scales (HI-01).
      //    scoreWithBreakdown produces the SAME ordering + scores as score() (proven by
      //    the Task-1 characterization), so using it here is behavior-preserving — it just
      //    additionally yields the per-memory breakdowns the trace records.
      if (!rerankApplied) {
        const scored = scoreWithBreakdown(ranked, cfg.scoring, deps.clock.now());
        for (const r of scored) breakdownById.set(r.entry.id, r.breakdown);
        ranked = scored;
      }

      // 5. TRUST-FILTER (mirrors the old inline filter). score() does not depend on the
      //    excluded entries, so filtering after scoring yields the same survivors.
      //    Capture the trust-filtered ids BEFORE the filter so the trace can explain the
      //    exclusion (reason "trust_filtered") rather than silently dropping them.
      const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
      const trustFilteredIds = ranked.filter((r) => !allowed.has(r.entry.trustLevel)).map((r) => r.entry.id);
      ranked = ranked.filter((r) => allowed.has(r.entry.trustLevel));

      // 6. DEDUP (reuse; kept last to match the injector's expectation). Diff pre/post to
      //    recover the deduped ids (reason "deduped") for the trace.
      const preDedupIds = ranked.map((r) => r.entry.id);
      const finalRanked = deduplicateResults(ranked);
      const finalIdSet = new Set(finalRanked.map((r) => r.entry.id));
      const dedupedIds = preDedupIds.filter((id) => !finalIdSet.has(id));

      // Observability tail (OBS-01/03/04). ADDITIVE + NON-FATAL: assemble ONE trace record
      // and emit the counts-only events. Skipped cleanly when neither sink is present.
      if (deps.recallTrace !== undefined || deps.eventBus !== undefined) {
        captureRecallObservability(deps, cfg, {
          query,
          agentId,
          sessionKey,
          lanes: { fts: ftsCandidates, vector: vectorCandidates, entity: entityCandidates },
          ftsCandidates,
          vectorCandidates,
          entityCandidates,
          vectorLaneActive,
          fusedOrder,
          rerankOutcome,
          rerankAttempted,
          rerankCandidateCount,
          preScores,
          postScores,
          finalRanked,
          trustFilteredIds,
          dedupedIds,
          breakdownById,
          degradations,
          durationMs: deps.clock.now() - recallStart,
        });
      }

      return ok(finalRanked);
    },
  };
}

/** Internal capture context handed to {@link captureRecallObservability}. */
interface RecallCaptureCtx {
  query: string;
  agentId: string | undefined;
  sessionKey: SessionKey;
  lanes: { fts: number; vector: number; entity: number };
  ftsCandidates: number;
  vectorCandidates: number;
  entityCandidates: number;
  vectorLaneActive: boolean;
  fusedOrder: string[];
  rerankOutcome: RecallRerankOutcome;
  rerankAttempted: boolean;
  rerankCandidateCount: number;
  preScores: number[] | undefined;
  postScores: number[] | undefined;
  finalRanked: MemorySearchResult[];
  trustFilteredIds: string[];
  dedupedIds: string[];
  breakdownById: Map<string, ScoreBreakdown>;
  degradations: RecallDegradation[];
  durationMs: number;
}

/**
 * Assemble + write the recall-trace record and emit the counts-only memory:recalled /
 * memory:reranked events. ALL of this is observability: a recorder or emit failure is
 * caught and logged at DEBUG so it NEVER fails the recall hot path (T-86-13 / RANK-03
 * spirit: degrade, never error). The query is recorded as a sha256 DIGEST, never raw
 * text (T-86-10). Event payloads are counts/booleans only — never query text or memory
 * bodies (T-86-11).
 */
function captureRecallObservability(
  deps: MemoryRecallDeps,
  cfg: MemoryRecallConfig,
  ctx: RecallCaptureCtx,
): void {
  // Build the per-memory ranked explanation: included (with breakdown) + excluded
  // (trust_filtered / deduped) so the trace explains every memory's fate, not just the
  // survivors. "below_budget" applies when a maxResults cap drops tail items from the
  // final set (the injector's char budget is applied downstream; the count cap is here).
  const ranked: RecallRankedEntry[] = ctx.finalRanked
    .slice(0, cfg.maxResults)
    .map((r) => {
      const breakdown = ctx.breakdownById.get(r.entry.id);
      return breakdown !== undefined
        ? { id: r.entry.id, reason: "included" as const, breakdown }
        : { id: r.entry.id, reason: "included" as const };
    });
  for (const r of ctx.finalRanked.slice(cfg.maxResults)) {
    ranked.push({ id: r.entry.id, reason: "below_budget" });
  }
  for (const id of ctx.trustFilteredIds) ranked.push({ id, reason: "trust_filtered" });
  for (const id of ctx.dedupedIds) ranked.push({ id, reason: "deduped" });

  try {
    deps.recallTrace?.recordRecall(
      buildRecallRecord({
        query: ctx.query,
        lanes: ctx.lanes,
        vectorLaneActive: ctx.vectorLaneActive,
        fusedOrder: ctx.fusedOrder,
        rerankOutcome: ctx.rerankOutcome,
        rerankCandidateCount: ctx.rerankCandidateCount,
        ...(ctx.preScores !== undefined ? { preScores: ctx.preScores } : {}),
        ...(ctx.postScores !== undefined ? { postScores: ctx.postScores } : {}),
        ranked,
        degradations: ctx.degradations,
        durationMs: ctx.durationMs,
      }),
    );
  } catch (e) {
    deps.logger.debug(
      {
        agentId: ctx.agentId,
        err: e instanceof Error ? e : new Error(String(e)),
        errorKind: "internal" as const,
        hint: "recall-trace recordRecall failed; the recall itself is unaffected",
      },
      "recall-trace capture failed (non-fatal)",
    );
  }

  if (deps.eventBus === undefined) return;
  // queryDigest is computed but intentionally NOT placed on the bus payload — the events
  // are counts-only. It exists here only to prove (in tests) that the raw query never
  // leaves this function except as a digest in the trace record above.
  void recallQueryDigest(ctx.query);
  const rerankerAvailable = deps.reranker?.isAvailable() === true;
  const traceId = tryGetContext()?.traceId ?? ctx.sessionKey.tenantId ?? ctx.agentId ?? "default";
  const laneCount =
    (ctx.ftsCandidates > 0 ? 1 : 0) +
    (ctx.vectorCandidates > 0 ? 1 : 0) +
    (ctx.entityCandidates > 0 ? 1 : 0);
  try {
    deps.eventBus.emit("memory:recalled", {
      agentId: ctx.agentId ?? "default",
      sessionKey: formatTenantSessionKey(ctx.sessionKey),
      traceId,
      lanes: laneCount,
      ftsCandidates: ctx.ftsCandidates,
      vectorCandidates: ctx.vectorCandidates,
      entityCandidates: ctx.entityCandidates,
      finalCount: ctx.finalRanked.length,
      rerankerAvailable,
      durationMs: ctx.durationMs,
      timestamp: deps.clock.now(),
    });
    // memory:reranked emits ONLY when a rerank stage was attempted.
    if (ctx.rerankAttempted) {
      deps.eventBus.emit("memory:reranked", {
        agentId: ctx.agentId ?? "default",
        traceId,
        candidateCount: ctx.rerankCandidateCount,
        hitCount: ctx.finalRanked.length,
        rerankerAvailable,
        timedOut: ctx.rerankOutcome === "timed_out",
        fellBack: ctx.rerankOutcome === "fell_back",
        durationMs: ctx.durationMs,
        timestamp: deps.clock.now(),
      });
    }
  } catch (e) {
    deps.logger.debug(
      {
        agentId: ctx.agentId,
        err: e instanceof Error ? e : new Error(String(e)),
        errorKind: "internal" as const,
        hint: "memory:recalled/reranked emit failed; the recall itself is unaffected",
      },
      "recall event emit failed (non-fatal)",
    );
  }
}

/**
 * Format a SessionKey into the counts-only sessionKey string for the event envelope.
 * Best-effort: a non-string field falls back to the tenant id so the emit never throws.
 */
function formatTenantSessionKey(key: SessionKey): string {
  const k = key as unknown as { tenantId?: string; agentId?: string; channelId?: string; userId?: string };
  const parts = [k.tenantId, k.channelId ?? k.agentId, k.userId].filter((p): p is string => typeof p === "string");
  return parts.length > 0 ? parts.join(":") : (k.tenantId ?? "default");
}
