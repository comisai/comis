// SPDX-License-Identifier: Apache-2.0
/**
 * createMemoryRecall — the single recall orchestrator.
 *
 * Composes the full recall pipeline as one function, REPLACING the inline
 * search/filter/dedup block that lived in executor/prompt-assembly.ts:
 *
 *   1. SEARCH      memoryPort.search (tenant+agent scoped; overfetch only when reranking)
 *   2. FUSE        N-lane RRF (single lane now = identity; entity lane is a future seam)
 *   3. RERANK      opt-in cross-encoder (default-OFF); graceful degrade +
 *                  timeout -> fused order
 *   4. SCORE       multiplicative recency/temporal/proof/trust boosts + trust tie-break
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
import type { UsefulnessSignal, TrustLevel, ContextStoreScope } from "@comis/core";
import { ok, withTimeout, TimeoutError } from "@comis/shared";
import { fuse, type FusionLane } from "./fuse.js";
import { scoreWithBreakdown, type ScoreBreakdown } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";
import {
  classifyIntent,
  intentMultiplier,
  expandSynonyms,
  parseTemporalRange,
  type ReweightLane,
} from "./query-understanding.js";
import { mmrRerank } from "./mmr.js";
import { appendCausalLane } from "./recall-causal-lane.js";
import { appendGraphSpreadLane } from "./recall-graph-spread-lane.js";
import { captureRecallObservability } from "./recall-observability.js";
import { applyProvenanceDownweighting } from "./recall-provenance.js";
import { gateLanes, resolveEffectiveBaseFloor, logPrefilterDrops, passesBaseFloor, type PrefilterAccumulator } from "./recall-security-prefilter.js";
import {
  vectorLaneCouldContribute,
  type RecallDegradation,
  type RecallRerankOutcome,
} from "./recall-record.js";

// The recall public types (deps + config + surface) live in recall-types.ts so the
// extracted observability tail (recall-observability.ts) can share them WITHOUT a
// source-level import cycle. Re-exported here so existing consumers
// (the daemon composition, prompt-assembly, the index barrel) import them unchanged.
export type { MemoryRecallDeps, MemoryRecallConfig, MemoryRecall } from "./recall-types.js";
import type { MemoryRecallDeps, MemoryRecallConfig, MemoryRecall } from "./recall-types.js";

// The R3 base-score floor predicate (FAIL-CLOSED, WR-02) lives in
// recall-security-prefilter.ts (the module that owns the security floor); re-exported here
// so existing consumers (memory-recall-floor.test.ts) import it from ./memory-recall.js unchanged.
export { passesBaseFloor } from "./recall-security-prefilter.js";

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
      // never read (the default-off path is byte-identical to the pre-observability
      // path — proven by the default-off characterization test). recordRecall + emit are
      // wrapped non-fatal at the end so observability NEVER fails the recall hot path.
      const recallStart = deps.clock.now();
      const degradations: RecallDegradation[] = [];

      // 0. PINNED-FIRST LANE — fetch pinned entries for this scope BEFORE fused search.
      //    DEFAULT-OFF BYTE-IDENTITY: with pinned.enabled=false, no pinnedStore, or no
      //    pinned entries, this block is SKIPPED — no query runs, pinnedResults stays [].
      //    Bounded by cfg.pinned.maxPinnedInjection (cap from config, never exceeded).
      //    Pinned IDs are removed from the fused candidate set BEFORE mmrRerank (Step 5b-pre)
      //    to prevent double-injection. WARN-on-failure never errors the recall hot path.
      //    TYPE-only pinnedStore from @comis/core (the agent↛memory build cut).
      const pinnedResults: ReturnType<typeof deduplicateResults> = [];
      const cfg_pinned = cfg.pinned;
      if (cfg_pinned?.enabled === true && deps.pinnedStore !== undefined) {
        const pinnedStart = deps.clock.now();
        const scope = {
          tenantId: sessionKey.tenantId,
          agentId: agentId ?? sessionKey.agentId ?? "default",
        };
        const p = await deps.pinnedStore.listPinned(scope, cfg_pinned.maxPinnedInjection);
        if (p.ok && p.value.length > 0) {
          pinnedResults.push(...p.value);
        } else if (!p.ok) {
          deps.logger.warn(
            {
              agentId,
              // WR-03: durationMs required per AGENTS.md §2.7 on every WARN at a boundary crossing.
              durationMs: deps.clock.now() - pinnedStart,
              errorKind: "internal" as const,
              hint: "pinned lane read failed; proceeding without pinned memories",
            },
            "pinned lane fallback",
          );
        }
      }
      const pinnedIds = new Set(pinnedResults.map((r) => r.entry.id));

      // Query understanding (DEFAULT-OFF byte-identity per knob). All three are pure
      // fns over the query string + the injected clock — NO LLM, NO globals (Date.now()).
      const qu = cfg.queryUnderstanding;
      // Classify ONCE (a pure fn over `query`); the per-lane multiplier is applied at the
      // lane-push sites below via laneWeight(). When off, `intent` stays undefined → laneWeight
      // returns the base weight unchanged → byte-identity. A factual/unmatched intent also yields
      // multiplier 1.0 on every lane (intentMultiplier), so an ON-but-factual query is byte-identical.
      const intent = qu?.intentReweight === true ? classifyIntent(query) : undefined;
      // Expand the query string (whole-query) when synonyms on; else the ORIGINAL.
      // expandSynonyms returns the input verbatim when no token maps, so this is the identity off.
      const searchQuery = qu?.synonyms === true ? expandSynonyms(query) : query;
      // Parse an occurred_at range from the (ORIGINAL) query when temporalParse on; nowMs is
      // the injected clock's recallStart (never Date.now()). Unparseable → undefined → no filter.
      const occurredAtRange = qu?.temporalParse === true ? parseTemporalRange(query, recallStart) : undefined;
      // The lane-reweight closure: OFF (intent === undefined) → returns `base` unchanged (byte-
      // identity); ON → base × intentMultiplier(intent, lane) (1.0 for any unboosted pair).
      const laneWeight = (base: number, lane: ReweightLane): number =>
        intent !== undefined ? base * intentMultiplier(intent, lane) : base;

      // RETR-04 (Phase 173): resolve the security-gate inputs ONCE so gateLanes() can
      //   pre-filter EVERY candidate supply (trust + arbiter-scoped baseFloor) BEFORE any fusion
      //   touches it, accumulating content-free dropped ids into prefilterAcc. effectiveBaseFloor:
      //   explicit floor wins; else 0.15 when relevanceFirst; else 0 → frontier/mid byte-identical
      //   (LOCKED #2). Why baseFloor must be pre-fusion: recall-security-prefilter.ts doc; §17 S6.
      const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
      const effectiveBaseFloor = resolveEffectiveBaseFloor(cfg.baseFloor, cfg.relevanceFirst);
      const prefilterAcc: PrefilterAccumulator = { trustDroppedIds: [], floorDroppedIds: [] };

      // 1. SEARCH — overfetch only when rerank is enabled (default pool size unchanged).
      const limit = cfg.rerank.enabled
        ? Math.max(cfg.maxResults, cfg.rerank.maxCandidates)
        : cfg.maxResults;

      // When the MemoryPort exposes the un-fused split (searchLanes), build the
      // FTS + vector lanes SEPARATELY so fuse() applies the operator-tunable weights and the
      // recall-trace reports TRUE per-lane counts. When it is ABSENT (an older / search-only
      // adapter), fall back to the single-lane search() path VERBATIM — a graceful degrade,
      // NOT a compat toggle (mirrors the absent-reranker / absent-entityStore degrade).
      //
      // BOTH paths produce ONE base lane that is CAPPED to cfg.maxResults and minScore-filtered:
      // on the fallback path search()->hybridSearch already does this internally
      // (filteredIds.slice(0, limit) then the adapter's minScore filter); on the searchLanes
      // path the lanes are PRE-filter candidate pools, so recall reproduces that here — fuse
      // the fts+vector lanes (operator weights applied), slice the fused union to maxResults
      // (mirroring hybridSearch's slice), then minScore-filter. The result is the single
      // pre-fused base lane the prior path carried, so the downstream entity/temporal append + final
      // fuse() is byte-identical to that path at default config (count AND id order), and the
      // entity/temporal lanes still legitimately add candidates ON TOP of the capped base.
      const baseLanes: FusionLane[] = [];
      // ftsCandidates is assigned on BOTH reachable paths below (the searchLanes branch and
      // the search() fallback) before any read, so a `= 0` initializer is provably dead
      // (no-useless-assignment). vectorCandidates KEEPS its `0` initializer: on the search()
      // fallback the split is not observable so it stays 0 (the honest stub).
      let ftsCandidates: number;
      let vectorCandidates = 0;
      // minScore is applied exactly ONCE on the capped base on BOTH paths now (the searchLanes
      // branch applies it below after the cap; the fallback's search() applies it internally),
      // so the post-fuse re-application is fully retired — the base lane is already filtered,
      // and the prior path never minScore-filtered the entity/temporal lane contributions post-fuse.
      if (typeof deps.memoryPort.searchLanes === "function") {
        // Two-lane path. NB: no minScore passed — the lanes are pre-filter candidate pools.
        // searchQuery is the synonym-expanded query (or the original when off); the spread
        // adds occurredAtRange ONLY when temporalParse parsed one (so OFF ⇒ the options object is
        // byte-identical to today — byte-identity by construction, never `occurredAtRange: undefined`).
        const laneRes = await deps.memoryPort.searchLanes(sessionKey, searchQuery, {
          limit,
          agentId,
          ...(occurredAtRange !== undefined ? { occurredAtRange } : {}),
        });
        if (!laneRes.ok) return laneRes;
        // Each lane's RRF weight is multiplied by intentMultiplier(intent, lane) (1.0 off).
        const ftsWeight = laneWeight(cfg.lanes?.fts.weight ?? 1.0, "fts");
        const vectorWeight = laneWeight(cfg.lanes?.vector.weight ?? 1.5, "vector");
        ftsCandidates = laneRes.value.fts.length;
        vectorCandidates = laneRes.value.vector.length;
        // RETR-04 (Phase 173): gate the RAW fts/vector lanes BEFORE the within-recall fuse()
        //   below — the load-bearing placement (fuse() inflates a rank-1 sub-floor candidate's
        //   score past any later floor; gating raw lanes uses the TRUE pre-fusion relevance).
        //   Byte-identity preserved by gateLanes when floor 0 + all-allowed. See module doc.
        const gatedRaw = gateLanes(
          [{ results: laneRes.value.fts, weight: ftsWeight }, { results: laneRes.value.vector, weight: vectorWeight }],
          allowed, effectiveBaseFloor, prefilterAcc,
        );
        const gatedFts = gatedRaw[0]?.results ?? [];
        const gatedVector = gatedRaw[1]?.results ?? [];
        // DROP EMPTY LANES before fuse(): a lone non-empty FTS lane
        // MUST hit fuse()'s single-lane pass-through (order + score preserved) rather than
        // the multi-lane rank-ramp, so the FTS-only degrade keeps today's BM25-distributed
        // scores. fuse() of [ftsLane, emptyVectorLane] would otherwise run the 2-lane RRF.
        const ftsVecLanes: FusionLane[] = [];
        if (gatedFts.length > 0) ftsVecLanes.push({ results: gatedFts, weight: ftsWeight });
        if (gatedVector.length > 0) ftsVecLanes.push({ results: gatedVector, weight: vectorWeight });
        // Cap: fuse the fts+vector lanes, slice the fused union to cfg.maxResults
        // (mirroring hybridSearch.ts's `filteredIds.slice(0, options.limit)` — the cap the
        // un-fused lane split dropped), then minScore-filter. This single pre-fused base lane is
        // exactly what the prior search() returned, so the entity/temporal append + final fuse
        // reproduce that default-config result SET (not merely its head ordering). RRF
        // depends only on per-lane ranks, so the slice drops only tail items — ranking parity
        // (the proven lane-split guard) is untouched. An empty fts+vector union pushes nothing.
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
        // Same searchQuery + spread-guarded occurredAtRange as the searchLanes path above.
        const searched = await deps.memoryPort.search(sessionKey, searchQuery, {
          limit,
          minScore: cfg.minScore,
          agentId,
          ...(occurredAtRange !== undefined ? { occurredAtRange } : {}),
        });
        if (!searched.ok) return searched;
        ftsCandidates = searched.value.length;
        // The split is NOT observable on this path (search() returns ONE merged list),
        // so vectorCandidates stays its honest initial value — the recall layer cannot break
        // out a true vector count here. The searchLanes path above sets the real count.
        // RETR-04 (Phase 173): gate the single merged search lane (its `score` is the genuine
        //   per-result relevance — search()->hybridSearch fused internally but returns one list
        //   with no second inflation). Byte-identity preserved when floor 0 + all-allowed.
        const gatedSearchLanes = gateLanes([{ results: searched.value, weight: 1.0 }], allowed, effectiveBaseFloor, prefilterAcc);
        const gatedSearch = gatedSearchLanes[0]?.results ?? [];
        if (gatedSearch.length > 0) baseLanes.push({ results: gatedSearch, weight: 1.0 });
      }

      let entityCandidates = 0;
      let temporalCandidates = 0;
      let causalCandidates = 0;
      let graphSpreadCandidates = 0;

      // vec→FTS-only gap: the operator-facing degradation signal. We derive it from
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
      // is composed LAZILY: only when an entity store is injected, the lane is
      // enabled, AND the search produced seeds. The store's scoped self-join returns OTHER
      // memories sharing >= 1 entity (hydrated, most-shared-first), which fuse() rebases onto
      // the shared RRF rank scale so a shared-entity memory can outrank a non-sharing one.
      //
      // Every no-op path leaves the fused output identical to the no-entity-lane result:
      // no store / disabled / no seeds / empty lane all fall through. A lane err is
      // NON-FATAL — recall never fails because the entity lane failed; we WARN and fall back
      // to the base lanes only. The lane SQL lives in the memory package behind the injected
      // MemoryEntityStore port — this file imports the TYPE only (the agent↛memory build cut).
      const lanes: FusionLane[] = baseLanes;
      // Entity/temporal-lane seeds: the top hits of the capped+filtered base lane — i.e. the
      // SAME pool the prior path seeded on (`searched.value`, which was the maxResults-capped, minScore-
      // filtered fused result). On the searchLanes path baseLanes[0] is now that capped base
      // (fts+vector fused, sliced, filtered above); on the fallback path it is search()'s
      // already-capped result. Either way the seeds are byte-identical to that path's.
      const seedPool = baseLanes[0]?.results ?? [];
      const el = cfg.entityLane;
      if (el?.enabled === true && deps.entityStore !== undefined && seedPool.length > 0) {
        const seedIds = seedPool.slice(0, el.seedCount).map((r) => r.entry.id);
        if (seedIds.length > 0) {
          // Scope mirrors memoryPort.search above: tenant from the session key, agent
          // from the recall arg (else the session key's agent, else "default"). The
          // lane's WHERE enforces this in SQL — the load-bearing isolation.
          const scope = {
            tenantId: sessionKey.tenantId,
            agentId: agentId ?? sessionKey.agentId ?? "default",
          };
          const laneRes = await deps.entityStore.associativeLane(seedIds, scope, el.perEntityCap);
          if (laneRes.ok) {
            // An empty lane pushes nothing -> fuse() stays single-lane, unchanged.
            if (laneRes.value.length > 0) {
              // Reweight the entity lane (1.0 off; ×1.5 for a "preference" intent).
              lanes.push({ results: laneRes.value, weight: laneWeight(el.weight, "entity") });
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

      // 2b. TEMPORAL-SPREAD lane — the 4th fused lane, APPENDED after the
      // fts/vector base lanes + the entity lane (order: fts, vector, entity, temporal).
      // Composed LAZILY, exactly like the entity lane: only when a temporal store is
      // injected, the lane is enabled, AND the top base hits carry `occurredAt` event times
      // (the seeds). The store's windowed occurred_at read returns OTHER memories near those
      // times (hydrated, nearest-first), which fuse() rebases onto the shared RRF rank scale.
      //
      // DEFAULT-OFF BYTE-IDENTITY: with `enabled:false` (the default) this block is
      // SKIPPED — spreadLane is NEVER called, no 4th lane is pushed, and the fused output is
      // byte-identical to the pre-temporal-lane path (the entity-lane no-op reused). Every other
      // no-op path (no store / no seed times / empty lane) falls through identically. A lane
      // err is NON-FATAL — recall never fails because the temporal lane failed; we WARN and
      // rank WITHOUT it. The lane SQL lives in the memory package behind the injected
      // MemoryTemporalStore port — this file imports the TYPE only (the agent↛memory build cut).
      const tl = cfg.lanes?.temporal;
      if (tl?.enabled === true && deps.temporalStore !== undefined && seedPool.length > 0) {
        // Seeds are the top hits' event TIMES (many memories lack occurredAt — they
        // contribute no seed). Gate on a non-empty seed-time set so a query whose top hits all
        // lack an event time skips the lane (no query) rather than windowing on nothing.
        const seedTimes = seedPool
          .slice(0, cfg.entityLane?.seedCount ?? 5)
          .map((r) => r.entry.occurredAt)
          .filter((t): t is number => typeof t === "number");
        if (seedTimes.length > 0) {
          // Scope mirrors the entity lane / memoryPort.search: tenant from the session key,
          // agent from the recall arg (else the session key's agent, else "default"). The
          // lane's WHERE enforces this in SQL — the load-bearing isolation.
          const scope = {
            tenantId: sessionKey.tenantId,
            agentId: agentId ?? sessionKey.agentId ?? "default",
          };
          const windowMs = tl.windowDays * 86_400_000;
          const laneRes = await deps.temporalStore.spreadLane(seedTimes, scope, windowMs, cfg.maxResults);
          if (laneRes.ok) {
            // The no-op case: an empty lane pushes nothing -> fuse() ranking unchanged.
            if (laneRes.value.length > 0) {
              // Reweight the temporal lane (1.0 off; ×1.5 for a "temporal" intent).
              lanes.push({ results: laneRes.value, weight: laneWeight(tl.weight, "temporal") });
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

      // 2c. CAUSAL lane — the 5th fused lane (fts, vector, entity, temporal, causal),
      // in appendCausalLane (full contract + DEFAULT-OFF byte-identity there). The
      // precondition gate is HERE so the off path stays synchronous (no extra microtask).
      const cl = cfg.lanes?.causal;
      if (cl?.enabled === true && deps.causalStore !== undefined && seedPool.length > 0) {
        const seedIds = seedPool.slice(0, cfg.entityLane?.seedCount ?? 5).map((r) => r.entry.id);
        // Reweight the causal lane (1.0 off; no boosted intent today → 1.0 by construction).
        causalCandidates = await appendCausalLane(lanes, deps.causalStore, laneWeight(cl.weight, "causal"), cfg.maxResults, seedIds, sessionKey, agentId, deps.logger);
      }

      // 2d. GRAPH-SPREAD lane — the 6th fused lane (…, causal, graphSpread), in
      // appendGraphSpreadLane (full contract + DEFAULT-OFF byte-identity there). The
      // precondition gate is HERE so the off path stays synchronous. Seeds = the top base hits'
      // CONTENT (the subject strings the triple store's current-truth subject→object edges walk
      // from); the bounded recursive-CTE walk returns structurally-linked memories, LLM-free.
      const gs = cfg.lanes?.graphSpread;
      if (gs?.enabled === true && deps.tripleStore !== undefined && seedPool.length > 0) {
        const seedSubjects = seedPool
          .slice(0, cfg.entityLane?.seedCount ?? 5)
          .map((r) => r.entry.content)
          .filter((s): s is string => typeof s === "string");
        // Reweight the graph-spread lane (1.0 off; no boosted intent today → 1.0).
        graphSpreadCandidates = await appendGraphSpreadLane(lanes, deps.tripleStore, laneWeight(gs.weight, "graphSpread"), cfg.maxResults, gs.maxDepth, gs.fanOut, seedSubjects, sessionKey, agentId, deps.logger);
      }
      // RETR-04 (Phase 173): gate upstream of the FINAL fuse() — the appended entity/temporal/
      //   causal/graph-spread (T4 KG) lanes against trust + baseFloor, so a high fused rank can
      //   never resurrect a dropped KG candidate (design §17 S6). The base lane is already gated
      //   → re-gating it is a no-op. The downstream trust filter (Step 5) + baseFloor (Step 4b)
      //   are RETAINED as defense in depth. Full rationale: recall-security-prefilter.ts doc.
      const gatedLanes = gateLanes(lanes, allowed, effectiveBaseFloor, prefilterAcc);
      logPrefilterDrops(deps.logger, prefilterAcc, { agentId, relevanceFirst: cfg.relevanceFirst === true });

      // FUSE the (security-pre-filtered) base lane (already capped + minScore-filtered) with any
      // entity/temporal lanes. minScore is NOT re-applied here: the prior path filtered minScore
      // exactly once on the capped base (inside search()->hybridSearch) and never re-filtered the
      // entity lane's post-fusion contributions — reproducing that single-apply is what keeps the
      // default-config result SET byte-identical AND lets the entity/temporal lanes add
      // candidates as designed. (On the searchLanes path the base lane was fused, sliced to
      // maxResults, and minScore-filtered above; on the fallback path search() did the same
      // internally — so the base entering fuse() is identically pre-filtered on both paths.)
      let ranked = fuse(gatedLanes);

      // Stage-2 snapshot: the post-fuse id order (the fused ranking before rerank/score).
      const fusedOrder = ranked.map((r) => r.entry.id);

      // Read the per-memory usefulness signal (flag-gated), then fold its used-rate
      // into the usefulnessFactor in score.ts (boost proven-useful, demote recalled-but-
      // ignored). DEFAULT-OFF BYTE-IDENTITY: when feedback is OFF, no store is
      // injected, or there are no candidates, this block is SKIPPED — no query runs,
      // usefulnessById stays undefined, and every usefulnessNorm(undefined) -> factor 1.0, so
      // the scoring below is byte-identical to the prior path. A FAILED read is NON-FATAL:
      // we WARN and rank WITHOUT the signal — recall never fails because usefulness read failed.
      // The signal rides this side map into scoreWithBreakdown (MemorySearchResult unchanged).
      // TYPE-only port (the agent↛memory cut) — the daemon injects the concrete adapter.
      //
      // Per-intent bucket (LLM-FREE): when intentReweight is ON the read scope carries
      // the ALREADY-computed `intent` (the SAME pure classifyIntent done above for lane
      // reweighting — NO second classify, NO model call on this read path), so the adapter fetches
      // that intent's usefulness bucket and a memory used-for-X ranks higher for an X-query. When
      // `intent` is undefined (intentReweight off) the scope OMITS it and the adapter reads the
      // global ('') bucket — DEGRADE-TO-GLOBAL is the same omitted-intent path that keeps the OFF
      // case byte-identical to the global-only path. An absent per-intent (and global) row falls through the
      // UNCHANGED score.ts fold (usefulnessNorm(undefined) -> 0.5 -> factor 1.0), so recall never
      // crashes on a missing bucket — it simply degrades to neutral.
      let usefulnessById: ReadonlyMap<string, UsefulnessSignal> | undefined;
      if (cfg.feedback?.enabled === true && deps.usefulnessStore !== undefined && ranked.length > 0) {
        const ids = ranked.map((r) => r.entry.id);
        // Scope mirrors memoryPort.search / the entity lane: tenant from the session key,
        // agent from the recall arg (else the session key's agent, else "default").
        // The spread adds the per-intent bucket ONLY when `intent` is defined (intentReweight
        // on); omitted -> the adapter's global ('') bucket (degrade-to-global, byte-identity off).
        const scope = {
          tenantId: sessionKey.tenantId,
          agentId: agentId ?? sessionKey.agentId ?? "default",
          ...(intent !== undefined ? { intent } : {}),
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

      // Per-memory score breakdowns, keyed by memory id, populated at whichever
      // scoring path runs (rerank-success per-segment, or the global fused-order pass).
      // Consumed by the final-ranked-set explanation in the trace record.
      const breakdownById = new Map<string, ScoreBreakdown>();

      // Set once the rerank-SUCCESS path has already applied score() boosts
      // per-segment (pool, then tail). When false, the global score() pass below
      // boosts the fused/degraded order. This split is what prevents the scale-mixing
      // bug: a single global score() over [CE-scored pool ++ RRF-scored tail] mixes two
      // scales and lets a high-RRF tail item leapfrog a low-absolute-CE pool item, undoing the
      // rerank. Scoring each segment independently keeps the pool-before-tail
      // partition intact (the cross-encoder's verdict is authoritative for the pool).
      let rerankApplied = false;

      // 3. RERANK (opt-in, default-OFF; graceful degrade + timeout -> fused order).
      // A reranker rank() that never settles would hang recall forever when no
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
            // Apply boosts to each segment SEPARATELY on its own scale, then
            // concat pool-before-tail. No global re-sort across scales runs afterward.
            // The reranked pool's base score becomes the cross-encoder probability.
            //
            // score() sorts by boosted score, then by trust for equal
            // relevance. For pool docs with EQUAL CE *and* equal trust, the final
            // tie-break is the fused (pre-rerank) index: score() uses a stable sort and
            // we hand it the pool in fused order, so equal-on-both-keys ties resolve to
            // that order deterministically (not to sort happenstance).
            const rerankedPool = scoreWithBreakdown(
              pool.map((r, i) => ({ ...r, score: scored.value[i] ?? 0 })),
              cfg.scoring,
              deps.clock.now(),
              usefulnessById,
              cfg.forget,
            );
            const scoredTail = scoreWithBreakdown(
              tail,
              cfg.scoring,
              deps.clock.now(),
              usefulnessById,
              cfg.forget,
            );
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
                // §2.7: carry the underlying reranker cause so a real outage is
                // diagnosable (was dropped — only errorKind+hint were logged).
                err: scored.error,
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
      //    re-running a global score() here would re-mix the CE and RRF scales.
      //    scoreWithBreakdown produces the SAME ordering + scores as score() (proven by
      //    the characterization test), so using it here is behavior-preserving — it just
      //    additionally yields the per-memory breakdowns the trace records.
      if (!rerankApplied) {
        const scored = scoreWithBreakdown(
          ranked,
          cfg.scoring,
          deps.clock.now(),
          usefulnessById,
          cfg.forget,
        );
        for (const r of scored) breakdownById.set(r.entry.id, r.breakdown);
        ranked = scored;
      }

      // 4b. R3 BASE-SCORE FLOOR — drop memories whose pre-boost base score is below the
      //     effective floor. Runs AFTER scoreWithBreakdown() (breakdownById populated)
      //     so the filter accesses the EXACT breakdown.base — not the boosted r.score.
      //     Boosts (recency/temporal/proof/trust/usefulness) CANNOT resurrect a memory
      //     whose raw cosine/RRF base sits below the floor (T-153-poison mitigation).
      //     FAIL-CLOSED-ON-MISSING-BASE (WR-02): a memory with no recorded breakdown.base
      //     cannot be proven above the floor, so it is DROPPED (passesBaseFloor takes no
      //     r.score fallback — on the rerank path r.score is the CE probability, a higher
      //     scale that would let an inflated low-base poison survive). This is a security gate.
      //
      //     RETR-04 / WR-02 ARBITER-SCOPED FAIL-CLOSED (Phase 173) — DEFENSE IN DEPTH: the
      //     baseFloor already ran UPSTREAM of fuse() against each candidate's genuine
      //     pre-fusion relevance (the RETR-04 pre-filter), so for the fused list this gate is
      //     normally a no-op. It is RETAINED unchanged as defense in depth (a future lane that
      //     bypasses the pre-filter is still floored here). Reuses the arbiter-scoped
      //     `effectiveBaseFloor` resolved before fuse(); 0 → skipped (frontier/mid, LOCKED #2).
      if (effectiveBaseFloor > 0) {
        ranked = ranked.filter((r) => passesBaseFloor(breakdownById.get(r.entry.id), effectiveBaseFloor));
      }

      // 5. TRUST-FILTER (DEFENSE IN DEPTH). The trust gate already ran upstream of fuse() (the
      //    pre-filter), so this is normally a no-op; retained unchanged for any candidate that
      //    re-enters post-fuse. Reuses the `allowed` Set built before fuse(). Capture the ids
      //    BEFORE the filter (trace reason "trust_filtered"); merge the upstream-dropped ids so
      //    the obs DROP set is complete (content-free, ids only).
      const downstreamTrustFilteredIds = ranked.filter((r) => !allowed.has(r.entry.trustLevel)).map((r) => r.entry.id);
      const trustFilteredIds = prefilterAcc.trustDroppedIds.length > 0
        ? [...prefilterAcc.trustDroppedIds, ...downstreamTrustFilteredIds]
        : downstreamTrustFilteredIds;
      ranked = ranked.filter((r) => allowed.has(r.entry.trustLevel));

      // 5b-pre. Remove pinned IDs from fused ranked BEFORE MMR to prevent double-injection.
      //         Pinned entries will be prepended to the final set AFTER dedup (Step 6).
      //         DEFAULT-OFF: when pinnedIds is empty (no pinned lane or no pins) this is a no-op.
      if (pinnedIds.size > 0) {
        ranked = ranked.filter((r) => !pinnedIds.has(r.entry.id));
      }

      // 5b. MMR — diversity re-rank over the post-trust-filter candidates' embeddings.
      //     DEFAULT-OFF BYTE-IDENTITY: with mmr.enabled=false, no embeddingStore, or <2 candidates,
      //     this block is SKIPPED — readEmbeddings is NEVER called (the spy proves it) and `ranked`
      //     is unchanged. The read is SCOPED (tenant, agent) — the adapter returns this scope's
      //     vectors only (the load-bearing isolation, mirror the usefulness read above). A FAILED
      //     read is NON-FATAL: WARN + rank WITHOUT MMR (recall never fails because the read failed).
      //     λ=1 / <2 embedded → mmrRerank returns the input order (byte-identity). Placed AFTER the
      //     trust-filter so MMR diversifies EXACTLY the set that will be injected and can
      //     never re-surface a candidate the trust filter excluded; BEFORE dedup's exact-prefix
      //     collapse, which stays the final pass. TYPE-only embeddingStore port (the agent↛memory cut).
      if (cfg.mmr?.enabled === true && deps.embeddingStore !== undefined && ranked.length >= 2) {
        const ids = ranked.map((r) => r.entry.id);
        const scope = {
          tenantId: sessionKey.tenantId,
          agentId: agentId ?? sessionKey.agentId ?? "default",
        };
        const e = await deps.embeddingStore.readEmbeddings(ids, scope);
        if (e.ok) {
          ranked = mmrRerank(ranked, e.value, cfg.mmr.lambda);
        } else {
          deps.logger.warn(
            {
              agentId,
              errorKind: "internal" as const,
              hint: "embedding read failed; ranking without MMR diversity",
            },
            "mmr embedding read fallback",
          );
        }
      }

      // 5c. POST-FUSION PROVENANCE PASS (DIST-03). Optional, NON-FATAL, DEFAULT-OFF.
      //     Runs AFTER mmrRerank (the rerank order has committed) and BEFORE dedup +
      //     observability capture. When a distilled summary (tag "lcd_distilled") is in
      //     the ranked set, down-weight same-conversation paired memories whose covered
      //     range overlaps — score multiplier ×0.5, NEVER delete (the memory stays
      //     accessible, just demoted so the lossy summary doesn't double-count with its
      //     own paired source rows). BYTE-IDENTITY: with provenanceStore absent OR no
      //     lcd_distilled result, applyProvenanceDownweighting returns `ranked` unchanged
      //     and getProvenanceForSummary is never called. A pass failure is swallowed to a
      //     WARN — recall results are NEVER affected. TYPE-only provenanceStore port
      //     (the agent↛memory build cut).
      //
      //     ⚠ NOT WIRED IN PRODUCTION AS OF PHASE 172 (C1). This pass is BUILT and
      //     test-pinned here, but `provenanceStore` is INTENTIONALLY not injected at the
      //     composition root — Phase 172 (C1) is write-side-only with a HARD
      //     zero-assembly-path-diff guarantee, so activating a recall-altering pass here
      //     would violate it. Per design `design/lcd-v3-unified-substrate.md` §6.2 + the
      //     Phase-C split, activation — provenanceStore injection + a concrete
      //     LcdProvenanceReadStore adapter (getProvenanceForSummary) + stamping the
      //     `summary:<id>` tag on distilled memories + the formatSessionKey fix on the
      //     scope below (currently String(sessionKey) → "[object Object]", harmless only
      //     while dormant) — is DEFERRED TO PHASE 173 (C2), which owns the assembly risk.
      //     Until then this `if` is dead in production (provenanceStore == null).
      if (deps.provenanceStore != null) {
        try {
          const provenanceScope: ContextStoreScope = {
            tenantId: sessionKey.tenantId,
            agentId: agentId ?? sessionKey.agentId ?? "default",
            // conversationId/sessionKey are not load-bearing for the (tenant, agent)-scoped
            // getProvenanceForSummary read, but the port takes a full scope — fill them from
            // the session key so the adapter's R4 filter has the complete context.
            conversationId: sessionKey.channelId ?? "",
            sessionKey: String(sessionKey),
          };
          ranked = applyProvenanceDownweighting(ranked, deps.provenanceStore, provenanceScope);
        } catch (err) {
          // Non-fatal: the provenance pass must NEVER fail the recall hot path.
          deps.logger.warn(
            {
              agentId,
              err: err instanceof Error ? err.message : String(err),
              errorKind: "dependency" as const,
              hint: "provenance down-weighting failed; recall results returned unaffected",
            },
            "provenance pass fallback",
          );
        }
      }

      // 6. DEDUP (reuse; kept last to match the injector's expectation). Diff pre/post to
      //    recover the deduped ids (reason "deduped") for the trace.
      const preDedupIds = ranked.map((r) => r.entry.id);
      const finalRanked = deduplicateResults(ranked);
      const finalIdSet = new Set(finalRanked.map((r) => r.entry.id));
      const dedupedIds = preDedupIds.filter((id) => !finalIdSet.has(id));

      // PREPEND pinned entries — bounded, already fetched at Step 0.
      // Pinned entries are ALWAYS returned first, regardless of fused score.
      // They were excluded from the MMR/dedup pipeline above (Step 5b-pre).
      // CR-04: filter pinned entries through the trust allowlist BEFORE prepending.
      // A pinned entry with a trustLevel outside cfg.includeTrustLevels must NOT inject.
      // DEFAULT-OFF: when pinnedResults is empty this is a no-op (no prepend).
      const filteredPinnedResults = pinnedResults.length > 0
        ? pinnedResults.filter((r) => allowed.has(r.entry.trustLevel))
        : pinnedResults;
      const finalRankedWithPins = filteredPinnedResults.length > 0
        ? [...filteredPinnedResults, ...finalRanked]
        : finalRanked;

      // Observability tail. ADDITIVE + NON-FATAL: assemble ONE trace record
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
          finalRanked: finalRankedWithPins,
          trustFilteredIds,
          dedupedIds,
          breakdownById,
          degradations,
          durationMs: deps.clock.now() - recallStart,
        });
      }

      return ok(finalRankedWithPins);
    },
  };
}

