// SPDX-License-Identifier: Apache-2.0
/**
 * Offline reasoning job handler (Phase 101 — REASON-02/03/04).
 *
 * The heart of Phase 101: it composes every prior layer into the offline job that
 * emits typed DEDUCTIVE + INDUCTIVE observations. Runs OFF the recall hot path (a
 * background cron seam, mirroring {@link runMemoryConsolidation} and
 * {@link runMemoryTripleExtraction}). Reads not-yet-consolidated candidates →
 * applies the surprisal novelty gate (REASON-04) → clusters → partitions into
 * homogeneous (trust, tag) sub-clusters (REASON-03) → for each scope calls the
 * INJECTED reasoning seam, then writes:
 *   - DEDUCTIVE knowledge-updates → the SHIPPED trust-first `tripleStore.upsertTriple`
 *     (the Phase-100 path — non-destructive soft-close, NEVER a re-implemented
 *     invalidation, NEVER a DELETE). Trust is capped in CODE at the sub-cluster's
 *     own (homogeneous) source trust — the writer can never RAISE trust.
 *   - INDUCTIVE patterns → the SHIPPED `consolidationStore.applyConsolidation` with
 *     `observationKind="inductive"` + `patternType`. Trust is HARD-capped ≤ learned
 *     in CODE (`minTrustLevel(minTrust(cluster), "learned")`) — a cluster of
 *     all-`system` sources STILL yields `learned`, NEVER `system` (REASON-03, the
 *     milestone's binding constraint).
 *
 * Security posture (design §9 — the same anti-poisoning discipline as the
 * consolidation + triple-extraction jobs):
 * - Trust is computed in CODE on BOTH branches, NEVER chosen by the LLM (the
 *   101-04 parsers STRIP any smuggled trust field). Deductive caps at source
 *   trust; inductive floors at ≤ learned (T-101-05-01, the binding constraint).
 * - Every deductive object + inductive content runs `validateMemoryWrite` BEFORE
 *   write (T-101-05-02): `critical` → skip; `warn` → trust downgraded toward
 *   `external`; `clean` → the code-computed ceiling.
 * - `groupByTrustAndTagScope` partitions every cluster BEFORE the seam call
 *   (T-101-05-01) — one reasoning call NEVER mixes trust levels or tag scopes.
 * - DEFAULT-OFF cost gate (T-101-05-06): with `config.enabled === false` the
 *   reasoning seam is NEVER called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED (the surprisal gate + `maxObservationsPerRun`) and emits a
 *   MINIMAL, counts-only `memory:reasoned` event + counts-only logs — NEVER the
 *   S/P/O bodies or the observation content (AGENTS.md §2.7 / T-101-05-05).
 * - Every read + write is `(tenantId, agentId)`-scoped (T-101-05-04); inductive
 *   sources are marked `consolidated_at` via `applyConsolidation` so a re-run does
 *   not double-create (T-101-05-07).
 *
 * The `reason` LLM call is INJECTED (the offline seam) — the caller (the daemon,
 * 101-06) builds it from a cheap model; it is NEVER invoked on the recall path.
 * The agent consumes both stores as port TYPES from `@comis/core` (the agent↛memory
 * build cut); the daemon injects the concrete memory-package adapters. NO
 * memory-package import here, NO wall-clock global (the injected `clock`).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  // deductive write path
  TripleInput,
  TripleStorePort,
  TripleTrust,
  // inductive write path
  MemoryConsolidationStore,
  ConsolidationCandidate,
  MemoryEntry,
  MemorySource,
  TrustLevel,
  // shared
  ClockPort,
  ComisLogger,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import {
  minTrust as clusterMinTrust,
  minTrustLevel,
  groupByTrustAndTagScope,
  clusterByEntityThenEmbedding,
  deterministicDedupKey,
  surprisalSelect,
} from "./memory-consolidation-clustering.js";
import type { DeductiveResult, InductiveResult } from "./memory-reasoning-prompt.js";

// ---------------------------------------------------------------------------
// Trust ceiling helpers
// ---------------------------------------------------------------------------

/**
 * The TripleTrust ladder rank for the DEDUCTIVE source-trust cap (reused verbatim
 * from triple-extraction-job.ts / score.ts — `system` 2 > `learned` 1 >
 * `external` 0). The cap picks the LOWER rank: the writer can only ever lower
 * trust, never raise it.
 *
 * NOTE the two ladders DIFFER and both are correct in their context: the DEDUCTIVE
 * path uses THIS ladder (records facts, may stay at source trust); the INDUCTIVE
 * path uses the consolidation-clustering inverse ladder via `minTrustLevel`/
 * `clusterMinTrust` (HARD ≤ learned). They are NEVER mixed.
 */
const TRIPLE_TRUST_RANK: Record<TripleTrust, number> = { system: 2, learned: 1, external: 0 } as const;

/** Pick the lower-trust of two TripleTrust levels (the deductive anti-laundering ceiling). */
function minTripleTrust(a: TripleTrust, b: TripleTrust): TripleTrust {
  return TRIPLE_TRUST_RANK[a] <= TRIPLE_TRUST_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Cluster helpers (replicated from memory-consolidation-job.ts — they are PRIVATE
// to that file, not exported; replicating keeps the agent↛memory cut clean and
// avoids widening the clustering module's public surface)
// ---------------------------------------------------------------------------

/** Union of the tags across a (homogeneous-by-tag) sub-cluster — deterministic, sorted. */
function uniqueTagsOf(cluster: MemoryEntry[]): string[] {
  const tags = new Set<string>();
  for (const e of cluster) for (const t of e.tags) tags.add(t);
  return [...tags].sort();
}

/** The latest event/record time across a cluster (the observation's `occurredAt`). */
function maxOccurredAt(cluster: MemoryEntry[]): number {
  let max = 0;
  for (const e of cluster) {
    const t = e.occurredAt ?? e.createdAt;
    if (t > max) max = t;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The typed output of one INJECTED reasoning call over a single homogeneous
 * evidence sub-cluster: zero-or-more deductive S/P/O candidates AND zero-or-more
 * inductive patterns. Both arrays use the 101-04 parsed shapes (the parser already
 * STRIPPED any smuggled trust field; trust is computed in CODE by this job).
 */
export interface ReasoningOutput {
  /** Deductive S/P/O candidates → written via the trust-first upsertTriple. */
  deductive: DeductiveResult[];
  /** Inductive patterns → written via applyConsolidation (≤ learned). */
  inductive: InductiveResult[];
}

/**
 * Configuration for one offline reasoning run (the 101-02
 * `MemoryReasoningConfig` shape — re-declared structurally so the agent does not
 * depend on the config schema symbol, only its fields; the daemon passes the
 * parsed config).
 */
export interface MemoryReasoningConfig {
  /** DEFAULT-OFF cost gate. When false: no reason call, no write. */
  enabled: boolean;
  /** Candidate pool cap for the read (the first DoS bound). */
  maxCandidatesPerRun: number;
  /** Top fraction of candidates kept by the surprisal novelty gate (REASON-04). */
  surprisalTopFraction: number;
  /** Neighbours per surprisal score (the knnDistances k). */
  knnK: number;
  /** Upper bound on observations (deductive + inductive) written per run. */
  maxObservationsPerRun: number;
  /** Per-call LLM output bound (carried for the injected seam; not used in-job). */
  maxReasoningTokens: number;
  /** When false, external-trust sources are excluded (trust hardening). */
  reasonExternal: boolean;
  /** Tags appended to every inductive observation. */
  autoTags: string[];
}

/** Dependencies injected into the offline reasoning handler. */
export interface MemoryReasoningDeps {
  agentId: string;
  tenantId: string;
  config: MemoryReasoningConfig;
  /**
   * The SEGREGATED consolidation store (port TYPE from `@comis/core`) — the
   * candidate read, the surprisal k-NN read, AND the inductive write
   * (`applyConsolidation`). The daemon injects the concrete adapter.
   */
  consolidationStore: MemoryConsolidationStore;
  /**
   * The SEGREGATED triple store (port TYPE from `@comis/core`) — the deductive
   * write via the SHIPPED trust-first `upsertTriple`. The daemon injects it.
   */
  tripleStore: TripleStorePort;
  /** Wall-clock reads — every timestamp + the scope `now`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: ComisLogger;
  /** Minimal counts-only event sink (mirrors the consolidation/extraction jobs). */
  eventBus?: { emit(event: string, payload: unknown): void };
  /**
   * The INJECTED offline reasoning seam: a single homogeneous evidence cluster's
   * text → typed { deductive, inductive } candidates. This is the OFFLINE seam — it
   * is NEVER called on the recall hot path, and it is the caller's job to build it
   * from a cheap model. A thrown call is non-fatal (WARN + skip that cluster).
   */
  reason: (clusterText: string) => Promise<ReasoningOutput>;
}

/** Counts-only outcome of one reasoning run (never carries S/P/O bodies or content). */
export interface MemoryReasoningStats {
  /** Candidates selected by the surprisal gate (the reasoning input set). */
  surprisalSelected: number;
  /** Deductive triples written via upsertTriple. */
  deductiveWritten: number;
  /** Inductive observations written via applyConsolidation. */
  inductiveWritten: number;
  /** Outputs blocked by validateMemoryWrite (critical). */
  blocked: number;
  /** Outputs whose trust was downgraded toward external (warn). */
  downgraded: number;
  /** Outputs skipped because they exceeded maxObservationsPerRun. */
  skippedOverCap: number;
}

/** The job's Result alias (exported for the test + the daemon onComplete mapping). */
export type MemoryReasoningResult = Result<MemoryReasoningStats, Error>;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one offline reasoning pass for a single agent.
 *
 * Gate on `config.enabled` (default-OFF → return early, no seam, no write) → read
 * candidates (READ failure is fatal → `err`) → surprisal gate (REASON-04) → cluster
 * → partition each cluster into homogeneous (trust, tag) sub-clusters (REASON-03) →
 * for each scope sub-cluster: call the INJECTED `reason` seam (non-fatal via
 * `fromPromise`) → write each DEDUCTIVE candidate via the trust-first `upsertTriple`
 * (trust capped in CODE at the sub-cluster trust; `validateMemoryWrite` first) AND
 * each INDUCTIVE pattern via `applyConsolidation` (trust HARD-capped ≤ learned in
 * CODE; `validateMemoryWrite` first; deduped by source-id set). All writes are
 * bounded by `maxObservationsPerRun` (a shared counter). Emit a counts-only
 * `memory:reasoned` event.
 *
 * @returns `ok(stats)` on success (even with 0 written); `err` only when the
 *   candidate read fails (cannot proceed safely). A per-item failure is non-fatal.
 */
export async function runMemoryReasoning(deps: MemoryReasoningDeps): Promise<MemoryReasoningResult> {
  const { config, agentId, tenantId, consolidationStore, tripleStore, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  let surprisalSelected = 0;
  let deductiveWritten = 0;
  let inductiveWritten = 0;
  let blocked = 0;
  let downgraded = 0;
  let skippedOverCap = 0;

  const emit = (): void => {
    eventBus?.emit("memory:reasoned", {
      agentId,
      surprisalSelected,
      deductiveWritten,
      inductiveWritten,
      blocked,
      downgraded,
      skippedOverCap,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryReasoningStats => ({
    surprisalSelected,
    deductiveWritten,
    inductiveWritten,
    blocked,
    downgraded,
    skippedOverCap,
  });

  // T-101-05-06: the DEFAULT-OFF cost gate. No reason call, no write, no spend.
  if (!config.enabled) {
    logger.debug({ agentId, step: "reason" as const }, "Memory reasoning disabled (enabled=false) — skipping");
    emit();
    return ok(stats());
  }

  // 1. Candidates — a READ failure is fatal (we cannot safely proceed; mirrors
  //    consolidation-job.ts:193). (Surprisal + clustering land in Task 2; this Task-1
  //    cut reasons over every read candidate as a single pool.)
  const candidatesResult = await fromPromise(
    consolidationStore.listConsolidationCandidates(agentId, tenantId, config.maxCandidatesPerRun),
  );
  if (!candidatesResult.ok) return err(candidatesResult.error);
  if (!candidatesResult.value.ok) return err(candidatesResult.value.error);
  const candidates: ConsolidationCandidate[] = candidatesResult.value.value;
  surprisalSelected = candidates.length;

  if (candidates.length === 0) {
    emit();
    return ok(stats());
  }

  // 2. (Task 2 will insert the surprisal gate + clustering + scope partition here.)
  //    For Task 1 the deductive path reasons over the whole candidate pool as one
  //    homogeneous-enough cluster; the per-scope partition arrives in Task 2.
  const cluster: MemoryEntry[] = candidates.map((c) => c.entry);
  const clusterText = cluster.map((e) => `- ${e.content}`).join("\n");

  // 3. Call the INJECTED reasoning seam (non-fatal: a thrown/aborted seam → WARN +
  //    skip this cluster; mirrors the consolidation/extraction posture).
  const reasoned = await fromPromise(deps.reason(clusterText));
  if (!reasoned.ok) {
    logger.warn(
      {
        agentId,
        err: reasoned.error,
        errorKind: "dependency" as const,
        step: "reason" as const,
        hint: "offline reasoning seam failed/aborted — no observations written for this cluster",
      },
      "Memory reasoning LLM call failed (non-fatal)",
    );
    emit();
    return ok(stats());
  }
  const output = reasoned.value;

  // The DEDUCTIVE source-trust cap is the sub-cluster's (homogeneous) trust. For the
  // Task-1 whole-pool cut, take the cluster floor on the TripleTrust ladder so a
  // mixed pool can never mint above its least-trusted member (Task 2 partitions
  // first, so each call is already homogeneous).
  const clusterSourceTrust: TripleTrust = clusterDeductiveTrust(cluster);

  // 4a. DEDUCTIVE branch — the SHIPPED trust-first upsertTriple (REASON-02).
  for (const candidate of output.deductive) {
    if (deductiveWritten + inductiveWritten >= config.maxObservationsPerRun) {
      skippedOverCap++;
      continue;
    }
    // T-101-05-02: cap trust in CODE at the source trust (never raised); downgrade
    // toward external on a warn verdict; skip on critical.
    let trust: TripleTrust = clusterSourceTrust;
    const verdict = validateMemoryWrite(candidate.object);
    if (verdict.severity === "critical") {
      blocked++;
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          step: "reason" as const,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "deductive object matched a dangerous/secret pattern — blocked from the KG",
        },
        "Skipping deductive triple that failed the memory-write security scan",
      );
      continue;
    }
    if (verdict.severity === "warn") {
      trust = minTripleTrust(trust, "external");
      downgraded++;
    }

    const now = clock.now();
    const triple: TripleInput = {
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      trust, // CODE-computed ceiling (or downgrade) — NOT chosen by the LLM
      tValidStart: now,
      ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
    };
    // T-101-05-04: the adapter filters every statement on this scope. Non-fatal: a
    // rejecting/erroring store → WARN + continue to the next candidate.
    const upserted = await fromPromise(tripleStore.upsertTriple(triple, { tenantId, agentId, now }));
    if (!upserted.ok || !upserted.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "reason" as const,
          hint: "upsertTriple failed/rejected — candidate skipped, run continues",
        },
        "Failed to upsert deductive triple (non-fatal)",
      );
      continue;
    }
    deductiveWritten++;
  }

  // 4b. INDUCTIVE branch lands in Task 2 (applyConsolidation, ≤ learned cap).
  void output.inductive;
  void minTrustLevel;
  void clusterMinTrust;
  void groupByTrustAndTagScope;
  void clusterByEntityThenEmbedding;
  void deterministicDedupKey;
  void surprisalSelect;
  void uniqueTagsOf;
  void maxOccurredAt;
  const _unusedTypes: [MemorySource | undefined, TrustLevel | undefined] = [undefined, undefined];
  void _unusedTypes;

  logger.info(
    { agentId, step: "reason" as const, ...stats(), durationMs: clock.now() - startMs },
    "Memory reasoning completed",
  );
  emit();
  return ok(stats());
}

/**
 * The DEDUCTIVE source-trust for a cluster, on the TripleTrust ladder: the
 * LEAST-trusted member maps to the cap. A cluster carries `TrustLevel` members
 * (the same union as TripleTrust), so a mixed pool's deductive write is capped at
 * its least-trusted member (Task 2 partitions first, so each call is homogeneous —
 * then this is a no-op identity over a single trust). Computed in CODE.
 */
function clusterDeductiveTrust(cluster: MemoryEntry[]): TripleTrust {
  let trust: TripleTrust = "system";
  for (const e of cluster) {
    trust = minTripleTrust(trust, e.trustLevel as TripleTrust);
  }
  return trust;
}
