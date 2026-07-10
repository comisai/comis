// SPDX-License-Identifier: Apache-2.0
/**
 * Recall observability tail, extracted from memory-recall.ts (which
 * crossed the 800-line cap when the 6th graph-spread lane landed). PURE
 * side-effect helper: it assembles ONE recall-trace record and emits the counts-only
 * `memory:recalled` / `memory:reranked` events from the recall stage snapshots.
 *
 * ALL of this is observability: a recorder or emit failure is caught and logged at
 * DEBUG so it NEVER fails the recall hot path (degrade, never error). The query is
 * recorded as a sha256 DIGEST, never raw text. Event payloads are counts/booleans/ids
 * ONLY — never query text or memory bodies. The agent↛memory cut is untouched: this file imports @comis/core types +
 * the in-package recall-record builder + @comis/observability (an EXISTING agent dep)
 * via the RecallTrace recorder type only.
 *
 * @module
 */

import type { MemorySearchResult, SessionKey } from "@comis/core";
import { tryGetContext, formatSessionKey } from "@comis/core";
import type { MemoryRecallDeps, MemoryRecallConfig } from "./recall-types.js";
import type { ScoreBreakdown } from "./score.js";
import {
  buildRecallRecord,
  recallQueryDigest,
  type RecallDegradation,
  type RecallRankedEntry,
  type RecallRerankOutcome,
} from "./recall-record.js";

/** Internal capture context handed to {@link captureRecallObservability}. */
export interface RecallCaptureCtx {
  query: string;
  agentId: string | undefined;
  sessionKey: SessionKey;
  lanes: { fts: number; vector: number; entity: number; temporal: number; causal: number };
  ftsCandidates: number;
  vectorCandidates: number;
  entityCandidates: number;
  temporalCandidates: number;
  causalCandidates: number;
  graphSpreadCandidates: number;
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
 * caught and logged at DEBUG so it NEVER fails the recall hot path (degrade, never
 * error). The query is recorded as a sha256 DIGEST, never raw text. Event payloads are
 * counts/booleans only — never query text or memory bodies.
 */
export function captureRecallObservability(
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
    // A failing recall-trace recorder silently BLINDS the recall lens (the recall
    // diagnostics read this trace). It is a failure branch
    // carrying hint+errorKind, so it belongs at WARN — diagnosable at the DEFAULT
    // level, not contingent on logLevel:debug having been set before the incident.
    deps.logger.warn(
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
    (ctx.entityCandidates > 0 ? 1 : 0) +
    // Include the temporal lane so the counts-only memory:recalled event no longer
    // under-reports the active lane count by one when the temporal lane contributes. The
    // rich recall-trace record already counts lanes.temporal; this aligns the event.
    (ctx.temporalCandidates > 0 ? 1 : 0) +
    // Likewise include the causal lane so the event's lane count counts the 5th
    // lane when it contributes (the rich trace record already counts lanes.causal).
    (ctx.causalCandidates > 0 ? 1 : 0) +
    // Include the graph-spread lane so the counts-only event reflects the 6th lane (the
    // trace's RecallLaneCounts stays the 5-lane shape — extending it is a deferred obs change).
    (ctx.graphSpreadCandidates > 0 ? 1 : 0);
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
    // A failing memory:recalled/reranked emit blinds the trajectory + fleet recall
    // signals. Failure branch with hint+errorKind → WARN, visible at the default level.
    deps.logger.warn(
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
 * Emit the counts-only `memory:recall_degraded` event — one retrieval lane (or
 * the whole lane split) failed and recall degraded instead of silently
 * vanishing. Wrapped non-fatal like the recalled/reranked emits: observability
 * degrades, never errors the recall hot path. Payload is a closed scope tag +
 * the closed ErrorKind string only (§2.7).
 */
export function emitRecallDegraded(
  deps: MemoryRecallDeps,
  sessionKey: SessionKey,
  agentId: string | undefined,
  scope: "vector_lane" | "lanes",
  errorKind: string,
): void {
  if (deps.eventBus === undefined) return;
  try {
    deps.eventBus.emit("memory:recall_degraded", {
      agentId: agentId ?? "default",
      sessionKey: formatTenantSessionKey(sessionKey),
      traceId: tryGetContext()?.traceId ?? sessionKey.tenantId ?? agentId ?? "default",
      scope,
      errorKind,
      timestamp: deps.clock.now(),
    });
  } catch (e) {
    deps.logger.warn(
      {
        agentId,
        err: e instanceof Error ? e : new Error(String(e)),
        errorKind: "internal" as const,
        hint: "memory:recall_degraded emit failed; the recall itself is unaffected",
      },
      "recall event emit failed (non-fatal)",
    );
  }
}

/**
 * Format a SessionKey into the event-envelope sessionKey string — the
 * CANONICAL `formatSessionKey` form, byte-identical to the per-session
 * trajectory bridge's `ownerSessionKey`. This must never drift: the bridge
 * DROPS any payload whose sessionKey does not equal the owner recorder's key,
 * and the previous home-grown "tenant:channel:user" approximation (wrong
 * field order, no peer/guild/thread parts) meant memory:recalled /
 * memory:reranked were silently filtered from EVERY per-session trajectory
 * (observed live: recall invisible to `comis explain` on every turn).
 * Best-effort: a degenerate key falls back to the tenant id so the emit
 * never throws.
 */
function formatTenantSessionKey(key: SessionKey): string {
  try {
    const formatted = formatSessionKey(key);
    if (!formatted.includes("undefined")) return formatted;
  } catch {
    // fall through to the tenant-id fallback
  }
  const k = key as unknown as { tenantId?: string };
  return typeof k.tenantId === "string" ? k.tenantId : "default";
}
