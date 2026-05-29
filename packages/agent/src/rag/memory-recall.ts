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
  RerankerPort,
  TrustLevel,
  TimerPort,
  ClockPort,
  SessionKey,
  ComisLogger,
} from "@comis/core";
import { ok, withTimeout, TimeoutError, type Result } from "@comis/shared";
import { fuse } from "./fuse.js";
import { score, type ScoringAlphas } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";

/** Injected dependencies for the recall orchestrator. */
export interface MemoryRecallDeps {
  /** Tenant+agent-scoped memory search port (the candidate supply). */
  memoryPort: MemoryPort;
  /** Optional cross-encoder reranker. Absent/unavailable -> fusion order (RANK-03). */
  reranker?: RerankerPort;
  /** Timer port for the rerank wall-clock deadline. Absent -> no timeout wrap. */
  timers?: TimerPort;
  /** Wall-clock reads for the recency boost (never Date.now()). */
  clock: ClockPort;
  /** Structural logger (WARN on degrade/timeout with errorKind + hint, counts only). */
  logger: ComisLogger;
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

      // 2. FUSE (N-lane; single lane now = identity. Entity lane is a Phase-83 seam).
      let ranked = fuse([{ results: searched.value, weight: 1.0 }]);

      // 3. RERANK (opt-in, default-OFF; graceful degrade + timeout -> fused order).
      if (
        cfg.rerank.enabled &&
        deps.reranker?.isAvailable() === true &&
        ranked.length >= cfg.rerank.minResults
      ) {
        const pool = ranked.slice(0, cfg.rerank.maxCandidates);
        const tail = ranked.slice(cfg.rerank.maxCandidates);
        const docs = pool.map((r) => r.entry.content);
        const timers = deps.timers;
        const schedule = (cb: () => void, ms: number): (() => void) => {
          const handle = timers?.setTimeout(cb, ms);
          return () => handle?.cancel();
        };
        try {
          const scored = timers
            ? await withTimeout(deps.reranker.rank(query, docs), cfg.rerank.timeoutMs, schedule, "rerank")
            : await deps.reranker.rank(query, docs);
          if (scored.ok) {
            // CE score becomes PRIMARY for the reranked pool; the tail keeps fused order.
            const reranked: MemorySearchResult[] = pool
              .map((r, i) => ({ ...r, score: scored.value[i] ?? 0 }))
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            ranked = reranked.concat(tail);
          } else {
            deps.logger.warn(
              {
                agentId,
                rerankCandidates: docs.length,
                errorKind: "dependency" as const,
                hint: "reranker returned err; using fusion order",
              },
              "rerank fallback",
            );
            // ranked stays = fused order
          }
        } catch (e) {
          const kind: "timeout" | "dependency" = e instanceof TimeoutError ? "timeout" : "dependency";
          deps.logger.warn(
            {
              agentId,
              rerankCandidates: docs.length,
              timeoutMs: cfg.rerank.timeoutMs,
              errorKind: kind,
              hint: "rerank timed out/failed; using fusion order",
            },
            "rerank fallback",
          );
          // ranked stays = fused order
        }
      }

      // 4. SCORE (boosts + trust tie-break) on the reranked-or-fused order.
      ranked = score(ranked, cfg.scoring, deps.clock.now());

      // 5. TRUST-FILTER (mirrors the old inline filter). score() does not depend on the
      //    excluded entries, so filtering after scoring yields the same survivors.
      const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
      ranked = ranked.filter((r) => allowed.has(r.entry.trustLevel));

      // 6. DEDUP (reuse; kept last to match the injector's expectation).
      return ok(deduplicateResults(ranked));
    },
  };
}
