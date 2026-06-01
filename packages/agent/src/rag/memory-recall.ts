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

// The recall DEPS/CONFIG/SURFACE types (and the store ports they reference) live in
// recall-types.ts — see the re-export below. memory-recall.ts itself imports only the
// @comis/core types it uses DIRECTLY in the pipeline body (the usefulness side-map +
// the trust-filter set); the agent↛memory cut holds (every store is a @comis/core port TYPE).
import type { UsefulnessSignal, TrustLevel } from "@comis/core";
import { ok, withTimeout, TimeoutError } from "@comis/shared";
import { fuse, type FusionLane } from "./fuse.js";
import { scoreWithBreakdown, type ScoreBreakdown } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";
import { appendCausalLane } from "./recall-causal-lane.js";
import { appendGraphSpreadLane } from "./recall-graph-spread-lane.js";
import { captureRecallObservability } from "./recall-observability.js";
import {
  vectorLaneCouldContribute,
  type RecallDegradation,
  type RecallRerankOutcome,
} from "./recall-record.js";

// The recall public types (deps + config + surface) live in recall-types.ts so the
// extracted observability tail (recall-observability.ts) can share them WITHOUT a
// source-level import cycle (ARCH-BASE-05). Re-exported here so existing consumers
// (the daemon composition, prompt-assembly, the index barrel) import them unchanged.
export type { MemoryRecallDeps, MemoryRecallConfig, MemoryRecall } from "./recall-types.js";
import type { MemoryRecallDeps, MemoryRecallConfig, MemoryRecall } from "./recall-types.js";

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

      // LANES-01: when the MemoryPort exposes the un-fused split (searchLanes), build the
      // FTS + vector lanes SEPARATELY so fuse() applies the operator-tunable weights and the
      // recall-trace reports TRUE per-lane counts. When it is ABSENT (an older / search-only
      // adapter), fall back to the single-lane search() path VERBATIM — a graceful degrade,
      // NOT a compat toggle (mirrors the absent-reranker / absent-entityStore degrade).
      //
      // BOTH paths produce ONE base lane that is CAPPED to cfg.maxResults and minScore-filtered
      // (W1 parity): on the fallback path search()->hybridSearch already does this internally
      // (filteredIds.slice(0, limit) then the adapter's minScore filter); on the searchLanes
      // path the lanes are PRE-filter candidate pools, so recall reproduces that here — fuse
      // the fts+vector lanes (operator weights applied), slice the fused union to maxResults
      // (mirroring hybridSearch's slice), then minScore-filter. The result is the single
      // pre-fused base lane v2.6 carried, so the downstream entity/temporal append + final
      // fuse() is byte-identical to v2.6 at default config (count AND id order), and the
      // entity/temporal lanes still legitimately add candidates ON TOP of the capped base.
      const baseLanes: FusionLane[] = [];
      // ftsCandidates is assigned on BOTH reachable paths below (the searchLanes branch and
      // the search() fallback) before any read, so a `= 0` initializer is provably dead
      // (no-useless-assignment). vectorCandidates KEEPS its `0` initializer: on the search()
      // fallback the split is not observable so it stays 0 (the WR-04 honest stub).
      let ftsCandidates: number;
      let vectorCandidates = 0;
      // minScore is applied exactly ONCE on the capped base on BOTH paths now (the searchLanes
      // branch applies it below after the cap; the fallback's search() applies it internally),
      // so the post-fuse re-application is fully retired — the base lane is already filtered,
      // and v2.6 never minScore-filtered the entity/temporal lane contributions post-fuse.
      if (typeof deps.memoryPort.searchLanes === "function") {
        // Two-lane path. NB: no minScore passed — the lanes are pre-filter candidate pools.
        const laneRes = await deps.memoryPort.searchLanes(sessionKey, query, { limit, agentId });
        if (!laneRes.ok) return laneRes;
        const ftsWeight = cfg.lanes?.fts.weight ?? 1.0;
        const vectorWeight = cfg.lanes?.vector.weight ?? 1.5;
        ftsCandidates = laneRes.value.fts.length;
        vectorCandidates = laneRes.value.vector.length;
        // DROP EMPTY LANES before fuse() (Pitfall 1 subtlety 3): a lone non-empty FTS lane
        // MUST hit fuse()'s single-lane pass-through (order + score preserved) rather than
        // the multi-lane rank-ramp, so the FTS-only degrade keeps today's BM25-distributed
        // scores. fuse() of [ftsLane, emptyVectorLane] would otherwise run the 2-lane RRF.
        const ftsVecLanes: FusionLane[] = [];
        if (laneRes.value.fts.length > 0) ftsVecLanes.push({ results: laneRes.value.fts, weight: ftsWeight });
        if (laneRes.value.vector.length > 0) ftsVecLanes.push({ results: laneRes.value.vector, weight: vectorWeight });
        // W1 cap: fuse the fts+vector lanes, slice the fused union to cfg.maxResults
        // (mirroring hybridSearch.ts's `filteredIds.slice(0, options.limit)` — the cap the
        // LANES-01 unfuse dropped), then minScore-filter. This single pre-fused base lane is
        // exactly what v2.6's search() returned, so the entity/temporal append + final fuse
        // reproduce v2.6's default-config result SET (not merely its head ordering). RRF
        // depends only on per-lane ranks, so the slice drops only tail items — ranking parity
        // (the proven LANES-01 guard) is untouched. An empty fts+vector union pushes nothing.
        if (ftsVecLanes.length > 0) {
          const base = fuse(ftsVecLanes)
            .slice(0, cfg.maxResults)
            .filter((r) => (r.score ?? 0) >= cfg.minScore);
          if (base.length > 0) baseLanes.push({ results: base, weight: 1.0 });
        }
      } else {
        // Single-lane fallback (search-only adapter). search()->hybridSearch applies BOTH the
        // slice(0, limit=maxResults) cap and the minScore filter internally, so searched.value
        // is ALREADY the capped+filtered base — wrap it verbatim (no second cap/filter here).
        const searched = await deps.memoryPort.search(sessionKey, query, { limit, minScore: cfg.minScore, agentId });
        if (!searched.ok) return searched;
        ftsCandidates = searched.value.length;
        // WR-04: the split is NOT observable on this path (search() returns ONE merged list),
        // so vectorCandidates stays its honest initial value — the recall layer cannot break
        // out a true vector count here. The searchLanes path above sets the real count.
        if (searched.value.length > 0) baseLanes.push({ results: searched.value, weight: 1.0 });
      }

      let entityCandidates = 0;
      let temporalCandidates = 0;
      let causalCandidates = 0;
      let graphSpreadCandidates = 0;

      // OBS-03 vec→FTS-only gap: the operator-facing degradation signal. We derive it from
      // the recall-layer-observable precondition: a query with no embeddable text
      // (empty/whitespace — the documented zero-length-embedding → FTS-only case), OR the
      // searchLanes split reporting an empty vector lane. When candidates exist but the
      // vector lane could not contribute, log ONE WARN + record a vec_unavailable
      // degradation. Fires only for a degenerate query, never as per-recall noise.
      const vectorLaneActive = vectorLaneCouldContribute(query);
      if (ftsCandidates > 0 && !vectorLaneActive) {
        const hint = "vector lane unavailable; recall used FTS only";
        deps.logger.warn(
          { agentId, errorKind: "dependency" as const, hint },
          "recall vector-lane fallback",
        );
        degradations.push({ kind: "vec_unavailable", errorKind: "dependency", hint });
      }

      // 2. FUSE (N-lane RRF). The base lanes (the un-fused fts+vector split, or the single
      // search lane on the fallback) are always present. The entity-associative lane
      // (ENT-02) is composed LAZILY: only when an entity store is injected, the lane is
      // enabled, AND the search produced seeds. The store's scoped self-join returns OTHER
      // memories sharing >= 1 entity (hydrated, most-shared-first), which fuse() rebases onto
      // the shared RRF rank scale so a shared-entity memory can outrank a non-sharing one.
      //
      // Every no-op path leaves the fused output identical to the no-entity-lane result
      // (ENT-04): no store / disabled / no seeds / empty lane all fall through. A lane err is
      // NON-FATAL — recall never fails because the entity lane failed; we WARN and fall back
      // to the base lanes only. The lane SQL lives in the memory package behind the injected
      // MemoryEntityStore port — this file imports the TYPE only (the agent↛memory build cut).
      const lanes: FusionLane[] = baseLanes;
      // Entity/temporal-lane seeds: the top hits of the capped+filtered base lane — i.e. the
      // SAME pool v2.6 seeded on (`searched.value`, which was the maxResults-capped, minScore-
      // filtered fused result). On the searchLanes path baseLanes[0] is now that capped base
      // (fts+vector fused, sliced, filtered above); on the fallback path it is search()'s
      // already-capped result. Either way the seeds are byte-identical to v2.6's.
      const seedPool = baseLanes[0]?.results ?? [];
      const el = cfg.entityLane;
      if (el?.enabled === true && deps.entityStore !== undefined && seedPool.length > 0) {
        const seedIds = seedPool.slice(0, el.seedCount).map((r) => r.entry.id);
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

      // 2b. TEMPORAL-SPREAD lane (LANES-02) — the 4th fused lane, APPENDED after the
      // fts/vector base lanes + the entity lane (order: fts, vector, entity, temporal).
      // Composed LAZILY, exactly like the entity lane: only when a temporal store is
      // injected, the lane is enabled, AND the top base hits carry `occurredAt` event times
      // (the seeds). The store's windowed occurred_at read returns OTHER memories near those
      // times (hydrated, nearest-first), which fuse() rebases onto the shared RRF rank scale.
      //
      // DEFAULT-OFF BYTE-IDENTITY (T-95-07): with `enabled:false` (the default) this block is
      // SKIPPED — spreadLane is NEVER called, no 4th lane is pushed, and the fused output is
      // byte-identical to the pre-temporal-lane path (the ENT-04 no-op reused). Every other
      // no-op path (no store / no seed times / empty lane) falls through identically. A lane
      // err is NON-FATAL — recall never fails because the temporal lane failed; we WARN and
      // rank WITHOUT it. The lane SQL lives in the memory package behind the injected
      // MemoryTemporalStore port — this file imports the TYPE only (the agent↛memory build cut).
      const tl = cfg.lanes?.temporal;
      if (tl?.enabled === true && deps.temporalStore !== undefined && seedPool.length > 0) {
        // Seeds are the top hits' event TIMES (Pitfall 6: many memories lack occurredAt — they
        // contribute no seed). Gate on a non-empty seed-time set so a query whose top hits all
        // lack an event time skips the lane (no query) rather than windowing on nothing.
        const seedTimes = seedPool
          .slice(0, cfg.entityLane?.seedCount ?? 5)
          .map((r) => r.entry.occurredAt)
          .filter((t): t is number => typeof t === "number");
        if (seedTimes.length > 0) {
          // Scope mirrors the entity lane / memoryPort.search: tenant from the session key,
          // agent from the recall arg (else the session key's agent, else "default"). The
          // lane's WHERE enforces this in SQL — the load-bearing isolation (T-95-05).
          const scope = {
            tenantId: sessionKey.tenantId,
            agentId: agentId ?? sessionKey.agentId ?? "default",
          };
          const windowMs = tl.windowDays * 86_400_000;
          const laneRes = await deps.temporalStore.spreadLane(seedTimes, scope, windowMs, cfg.maxResults);
          if (laneRes.ok) {
            // The ENT-04 no-op: an empty lane pushes nothing -> fuse() ranking unchanged.
            if (laneRes.value.length > 0) {
              lanes.push({ results: laneRes.value, weight: tl.weight });
              temporalCandidates = laneRes.value.length; // stage-1 lane-count snapshot
            }
          } else {
            deps.logger.warn(
              {
                agentId,
                seedCount: seedTimes.length,
                errorKind: "internal" as const,
                hint: "temporal lane failed; using other lanes only",
              },
              "temporal lane fallback",
            );
          }
        }
      }

      // 2c. CAUSAL lane (EXTRACT-03) — the 5th fused lane (fts, vector, entity, temporal, causal),
      // in appendCausalLane (full contract + DEFAULT-OFF byte-identity T-96-10 there). The
      // precondition gate is HERE so the off path stays synchronous (no extra microtask).
      const cl = cfg.lanes?.causal;
      if (cl?.enabled === true && deps.causalStore !== undefined && seedPool.length > 0) {
        const seedIds = seedPool.slice(0, cfg.entityLane?.seedCount ?? 5).map((r) => r.entry.id);
        causalCandidates = await appendCausalLane(lanes, deps.causalStore, cl.weight, cfg.maxResults, seedIds, sessionKey, agentId, deps.logger);
      }

      // 2d. GRAPH-SPREAD lane (KG-04) — the 6th fused lane (…, causal, graphSpread), in
      // appendGraphSpreadLane (full contract + DEFAULT-OFF byte-identity T-100-04-06 there). The
      // precondition gate is HERE so the off path stays synchronous. Seeds = the top base hits'
      // CONTENT (the subject strings the triple store's current-truth subject→object edges walk
      // from); the bounded recursive-CTE walk returns structurally-linked memories, LLM-free.
      const gs = cfg.lanes?.graphSpread;
      if (gs?.enabled === true && deps.tripleStore !== undefined && seedPool.length > 0) {
        const seedSubjects = seedPool
          .slice(0, cfg.entityLane?.seedCount ?? 5)
          .map((r) => r.entry.content)
          .filter((s): s is string => typeof s === "string");
        graphSpreadCandidates = await appendGraphSpreadLane(lanes, deps.tripleStore, gs.weight, cfg.maxResults, gs.maxDepth, gs.fanOut, seedSubjects, sessionKey, agentId, deps.logger);
      }
      // FUSE the base lane (already capped + minScore-filtered) with any entity/temporal
      // lanes. minScore is NOT re-applied here: v2.6 filtered minScore exactly once on the
      // capped base (inside search()->hybridSearch) and never re-filtered the entity lane's
      // post-fusion contributions — reproducing that single-apply is what keeps the
      // default-config result SET byte-identical AND lets the entity/temporal lanes add
      // candidates as designed. (On the searchLanes path the base lane was fused, sliced to
      // maxResults, and minScore-filtered above; on the fallback path search() did the same
      // internally — so the base entering fuse() is identically pre-filtered on both paths.)
      let ranked = fuse(lanes);

      // Stage-2 snapshot: the post-fuse id order (the fused ranking before rerank/score).
      const fusedOrder = ranked.map((r) => r.entry.id);

      // FEED-03: read the per-memory usefulness signal (flag-gated), then fold its used-rate
      // into the usefulnessFactor in score.ts (boost proven-useful, demote recalled-but-
      // ignored). DEFAULT-OFF BYTE-IDENTITY (Pitfall 6 #2): when feedback is OFF, no store is
      // injected, or there are no candidates, this block is SKIPPED — no query runs,
      // usefulnessById stays undefined, and every usefulnessNorm(undefined) -> factor 1.0, so
      // the scoring below is byte-identical to v2.6. A FAILED read is NON-FATAL (T-93-14):
      // we WARN and rank WITHOUT the signal — recall never fails because usefulness read failed.
      // The signal rides this side map into scoreWithBreakdown (MemorySearchResult unchanged).
      // TYPE-only port (the agent↛memory cut) — the daemon injects the concrete adapter.
      let usefulnessById: ReadonlyMap<string, UsefulnessSignal> | undefined;
      if (cfg.feedback?.enabled === true && deps.usefulnessStore !== undefined && ranked.length > 0) {
        const ids = ranked.map((r) => r.entry.id);
        // Scope mirrors memoryPort.search / the entity lane: tenant from the session key,
        // agent from the recall arg (else the session key's agent, else "default").
        const scope = {
          tenantId: sessionKey.tenantId,
          agentId: agentId ?? sessionKey.agentId ?? "default",
        };
        const u = await deps.usefulnessStore.readUsefulness(ids, scope);
        if (u.ok) {
          usefulnessById = u.value;
        } else {
          deps.logger.warn(
            {
              agentId,
              errorKind: "internal" as const,
              hint: "usefulness read failed; ranking without the signal",
            },
            "usefulness read fallback",
          );
        }
      }

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
              usefulnessById,
            );
            const scoredTail = scoreWithBreakdown(tail, cfg.scoring, deps.clock.now(), usefulnessById);
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
        const scored = scoreWithBreakdown(ranked, cfg.scoring, deps.clock.now(), usefulnessById);
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
          lanes: { fts: ftsCandidates, vector: vectorCandidates, entity: entityCandidates, temporal: temporalCandidates, causal: causalCandidates },
          ftsCandidates,
          vectorCandidates,
          entityCandidates,
          temporalCandidates,
          causalCandidates,
          graphSpreadCandidates,
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

