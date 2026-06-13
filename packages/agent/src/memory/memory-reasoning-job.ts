// SPDX-License-Identifier: Apache-2.0
/**
 * Offline reasoning job handler.
 *
 * It composes every prior layer into the offline job that
 * emits typed DEDUCTIVE + INDUCTIVE observations. Runs OFF the recall hot path (a
 * background cron seam, mirroring {@link runMemoryConsolidation} and
 * {@link runMemoryTripleExtraction}). Reads not-yet-consolidated candidates →
 * applies the surprisal novelty gate → clusters → partitions into
 * homogeneous (trust, tag) sub-clusters → for each scope calls the
 * INJECTED reasoning seam, then writes:
 *   - DEDUCTIVE knowledge-updates → the SHIPPED trust-first `tripleStore.upsertTriple`
 *     (non-destructive soft-close, NEVER a re-implemented
 *     invalidation, NEVER a DELETE). Trust is capped in CODE at the sub-cluster's
 *     own (homogeneous) source trust — the writer can never RAISE trust.
 *   - INDUCTIVE patterns → the SHIPPED `consolidationStore.applyConsolidation` with
 *     `observationKind="inductive"` + `patternType`. Trust is HARD-capped ≤ learned
 *     in CODE (`minTrustLevel(minTrust(cluster), "learned")`) — a cluster of
 *     all-`system` sources STILL yields `learned`, NEVER `system` (the
 *     binding constraint).
 *
 * Security posture (design §9 — the same anti-poisoning discipline as the
 * consolidation + triple-extraction jobs):
 * - Trust is computed in CODE on BOTH branches, NEVER chosen by the LLM (the
 *   parsers STRIP any smuggled trust field). Deductive caps at source
 *   trust; inductive floors at ≤ learned (the binding constraint).
 * - Every deductive object + inductive content runs `validateMemoryWrite` BEFORE
 *   write: `critical` → skip; `warn` → trust downgraded toward
 *   `external`; `clean` → the code-computed ceiling.
 * - `groupByTrustAndTagScope` partitions every cluster BEFORE the seam call
 *   — one reasoning call NEVER mixes trust levels or tag scopes.
 * - DEFAULT-OFF cost gate: with `config.enabled === false` the
 *   reasoning seam is NEVER called and nothing is written (no LLM spend, no write).
 * - The run is BOUNDED by the SURPRISAL GATE (which caps the scope/seam-call
 *   count — at most one `reason()` call per surprisal-selected scope) and by
 *   `maxObservationsPerRun` (which caps WRITES and short-circuits the remaining
 *   scopes once the write cap is hit, but does NOT bound the seam-call count: a
 *   0-write scope still issues its call). It emits a MINIMAL, counts-only
 *   `memory:reasoned` event + counts-only logs — NEVER the S/P/O bodies or the
 *   observation content (AGENTS.md §2.7).
 * - Every read + write is `(tenantId, agentId)`-scoped; inductive
 *   sources are marked `consolidated_at` via `applyConsolidation` so a re-run does
 *   not double-create.
 *
 * The `reason` LLM call is INJECTED (the offline seam) — the caller (the daemon)
 * builds it from a cheap model; it is NEVER invoked on the recall path.
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
  // The INDUCTIVE cap helpers (the INVERSE clustering ladder — NEVER the TripleTrust
  // ladder): `minTrust(entries)` = the cluster's least-trusted member; `minTrustLevel`
  // = the 2-arg ≤-learned floor. The deductive ladder is `minTripleTrust` (below).
  minTrust,
  minTrustLevel,
  groupByTrustAndTagScope,
  clusterByEntityThenEmbedding,
  deterministicDedupKey,
  surprisalSelect,
} from "./memory-consolidation-clustering.js";
import type { DeductiveResult, InductiveResult } from "./memory-reasoning-prompt.js";
import { emitGenerationQuality } from "./emit-generation-quality.js";

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
 * path uses the consolidation-clustering INVERSE ladder via `minTrustLevel(minTrust(
 * cluster), "learned")` (HARD ≤ learned). They are NEVER mixed.
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
 * inductive patterns. Both arrays use the parsed shapes (the parser already
 * STRIPPED any smuggled trust field; trust is computed in CODE by this job).
 */
export interface ReasoningOutput {
  /** Deductive S/P/O candidates → written via the trust-first upsertTriple. */
  deductive: DeductiveResult[];
  /** Inductive patterns → written via applyConsolidation (≤ learned). */
  inductive: InductiveResult[];
}

/**
 * Configuration for one offline reasoning run (the
 * `MemoryReasoningConfig` shape — re-declared structurally so the agent does not
 * depend on the config schema symbol, only its fields; the daemon passes the
 * parsed config).
 */
export interface MemoryReasoningConfig {
  /** DEFAULT-OFF cost gate. When false: no reason call, no write. */
  enabled: boolean;
  /** Candidate pool cap for the read (the first DoS bound). */
  maxCandidatesPerRun: number;
  /** Top fraction of candidates kept by the surprisal novelty gate. */
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
 * candidates (READ failure is fatal → `err`) → surprisal gate → cluster
 * → partition each cluster into homogeneous (trust, tag) sub-clusters →
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

  // The DEFAULT-OFF cost gate. No reason call, no write, no spend.
  if (!config.enabled) {
    logger.debug({ agentId, step: "reason" as const }, "Memory reasoning disabled (enabled=false) — skipping");
    emit();
    return ok(stats());
  }

  // 1. Candidates — a READ failure is fatal (we cannot safely proceed; mirrors
  //    consolidation-job.ts:193).
  const candidatesResult = await fromPromise(
    consolidationStore.listConsolidationCandidates(agentId, tenantId, config.maxCandidatesPerRun),
  );
  if (!candidatesResult.ok) return err(candidatesResult.error);
  if (!candidatesResult.value.ok) return err(candidatesResult.value.error);
  let candidates: ConsolidationCandidate[] = candidatesResult.value.value;

  // 1b. Trust hardening — exclude external-trust sources by default (mirrors
  //     consolidation's consolidateExternal gate). Done BEFORE surprisal so
  //     external candidates never even count toward the novelty denominator.
  if (!config.reasonExternal) {
    candidates = candidates.filter((c) => c.entry.trustLevel !== "external");
  }

  if (candidates.length === 0) {
    emit();
    return ok(stats());
  }

  // 2. SURPRISAL GATE — bound which raw candidates the costly reasoning
  //    seam sees. Build knnByCandidate by calling the knnDistances port per embedded
  //    candidate (the agent cannot run the SQL), then keep the top fraction by
  //    novelty. The selection math (exclude-before-score, the (surprisal desc, id
  //    asc) total order, the ceil cut) is tested separately — here it is a thin
  //    pass-through. `dim` = the embedding length of the first embedded candidate.
  const embeddedCount = candidates.filter((c) => c.embedding !== undefined).length;
  let selected: ConsolidationCandidate[];
  if (embeddedCount === 0) {
    // DEGRADE (mirrors consolidation-job.ts:222-234): when NO candidate carries an
    // embedding (sqlite-vec unavailable / not yet indexed), the surprisal gate
    // cannot rank anything — reason over the full pool rather than silently
    // selecting nothing. Counts-only WARN, non-fatal; the run proceeds.
    logger.warn(
      {
        agentId,
        step: "reason" as const,
        errorKind: "precondition" as const,
        missingEmbedding: candidates.length,
        hint: "no reasoning candidate carries an embedding — surprisal gate bypassed, reasoning over the full pool",
      },
      "Reasoning candidates missing embeddings (surprisal gate degraded)",
    );
    selected = candidates;
  } else {
    const knnByCandidate = new Map<string, number[]>();
    let dim = 0;
    for (const c of candidates) {
      if (c.embedding === undefined) continue;
      if (dim === 0) dim = c.embedding.length;
      const knn = await fromPromise(
        consolidationStore.knnDistances(c.embedding, config.knnK, agentId, tenantId),
      );
      // Non-fatal: a failed/empty k-NN read → the candidate scores as not-novel (the
      // missing-distance policy: eligible but ranks last). Never throws out.
      if (knn.ok && knn.value.ok) knnByCandidate.set(c.entry.id, knn.value.value);
    }
    // The gate EXCLUDES un-embedded candidates BEFORE scoring (surprisalSelect's
    // pre-score filter, clustering.ts). Hydration is NOT all-or-nothing: even with
    // sqlite-vec available, decodeEmbedding returns undefined for any row lacking a
    // vec_memories entry (has_embedding=0, the embedding queue not yet drained, or a
    // corrupt blob), so embeddedCount can be 0 < embeddedCount < candidates.length.
    // In that mixed case the un-embedded candidates that survived the reasonExternal
    // filter are silently excluded from reasoning here — the documented
    // missing-embedding policy (safe: they simply do not reach the seam). The
    // top-fraction cut is over the EMBEDDED subset.
    selected = surprisalSelect(candidates, knnByCandidate, dim, config.surprisalTopFraction);
  }
  surprisalSelected = selected.length;

  if (selected.length === 0) {
    emit();
    return ok(stats());
  }

  // 3. Cluster the selected subset (greedy single-link by cosine), then
  //    partition each cluster into homogeneous (trust, tag) sub-clusters
  //    — one seam call NEVER mixes trust levels or tag scopes. When embeddings are
  //    present, cosine clustering groups the co-located evidence; when ABSENT
  //    (the degrade path), cosine cannot group, so each in-scope evidence set is
  //    treated as ONE cluster (group-by-scope directly — mirrors consolidation's
  //    entity/FTS degrade so a same-scope evidence set still reasons jointly rather
  //    than fragmenting into singletons).
  const clusters: MemoryEntry[][] =
    embeddedCount === 0
      ? [selected.map((c) => c.entry)]
      : clusterByEntityThenEmbedding(selected, { similarityThreshold: 0.5, maxClusterSize: 50 });
  // Unlike runMemoryConsolidation (which drops singletons via
  // `.filter((c) => c.length >= 2)` — there is nothing to MERGE in a lone memory),
  // this job INTENTIONALLY keeps singleton scopes: a single memory can still yield
  // a deductive fact ("alice located_in Berlin") or an inductive tendency, so it is
  // a valid reasoning unit. The cost of reasoning singletons is bounded by the same
  // surprisal gate + maxObservationsPerRun, and deductive-only singletons drain via
  // markReasoned so they are not re-reasoned. Do NOT add the >= 2 filter.
  const scopes: MemoryEntry[][] = [];
  for (const cluster of clusters) {
    for (const scope of groupByTrustAndTagScope(cluster)) scopes.push(scope);
  }

  // 4. Per homogeneous scope sub-cluster: ONE injected reasoning call (non-fatal),
  //    then the deductive + inductive write branches. A same-run dedup guard
  //    (deterministicDedupKey over the source-id set) prevents a re-selected scope
  //    from writing the same inductive observation twice within ONE run.
  const writtenInductiveKeys = new Set<string>();
  const now0 = clock.now();

  for (const scope of scopes) {
    if (deductiveWritten + inductiveWritten >= config.maxObservationsPerRun) {
      // Everything left in this + later scopes is over the cap.
      skippedOverCap += scope.length;
      continue;
    }

    // Per-scope write tallies: the inductive write marks its sources
    // consolidated_at via applyConsolidation, but a DEDUCTIVE-ONLY scope (a
    // deductive write, no inductive pattern) has no observation to create — its
    // sources must still be drained below, or the candidate predicate
    // (consolidated_at IS NULL AND proof_count IS NULL) re-selects them and
    // re-feeds the paid seam over unchanged evidence every run.
    let scopeDeductiveWrites = 0;
    let scopeInductiveWrites = 0;

    const clusterText = scope.map((e) => `- ${e.content}`).join("\n");
    const reasoned = await fromPromise(deps.reason(clusterText));
    if (!reasoned.ok) {
      logger.warn(
        {
          agentId,
          err: reasoned.error,
          errorKind: "dependency" as const,
          step: "reason" as const,
          hint: "offline reasoning seam failed/aborted — no observations written for this scope",
        },
        "Memory reasoning LLM call failed (non-fatal)",
      );
      continue;
    }
    const output = reasoned.value;

    // GENQ-01: classify the scope source vs the raw reasoning output (deductive
    // objects + inductive contents) BEFORE the per-write security/trust filtering —
    // this measures the MODEL's output quality (the F-ML1 class: a non-Latin scope
    // reasoned into Latin observations, or an empty reasoning). Fires only on an
    // issue; content-free, guarded, VISIBILITY ONLY (no gating).
    emitGenerationQuality(eventBus, logger, {
      agentId,
      pass: "reasoning",
      sourceText: clusterText,
      outputText: [
        ...output.deductive.map((d) => d.object),
        ...output.inductive.map((p) => p.content),
      ].join("\n"),
      nowMs: clock.now(),
    });

    // --- 4a. DEDUCTIVE branch — the SHIPPED trust-first upsertTriple.
    //     The scope is homogeneous, so its single trust level IS the source-trust cap.
    const deductiveTrust: TripleTrust = (scope[0]?.trustLevel ?? "external") as TripleTrust;
    for (const candidate of output.deductive) {
      if (deductiveWritten + inductiveWritten >= config.maxObservationsPerRun) {
        skippedOverCap++;
        continue;
      }
      let trust: TripleTrust = deductiveTrust;
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
      scopeDeductiveWrites++;
    }

    // --- 4b. INDUCTIVE branch — applyConsolidation with the HARD ≤ learned cap.
    //     The cap is computed in CODE via the IMPORTED
    //     consolidation-clustering helpers (the INVERSE ladder) — a cluster of
    //     all-system sources STILL yields "learned".
    const sourceIds = scope.map((e) => e.id);
    const dedupKey = deterministicDedupKey(sourceIds);
    const inductiveTrust: TrustLevel = minTrustLevel(minTrust(scope), "learned");

    for (const pattern of output.inductive) {
      if (deductiveWritten + inductiveWritten >= config.maxObservationsPerRun) {
        skippedOverCap++;
        continue;
      }
      // Same-run dedup guard: a re-selected identical scope never double-creates.
      if (writtenInductiveKeys.has(dedupKey)) {
        continue;
      }

      let trust: TrustLevel = inductiveTrust;
      const verdict = validateMemoryWrite(pattern.content);
      if (verdict.severity === "critical") {
        blocked++;
        logger.warn(
          {
            agentId,
            errorKind: "validation" as const,
            step: "reason" as const,
            patterns: verdict.patterns,
            criticalPatterns: verdict.criticalPatterns,
            hint: "inductive content matched a dangerous/secret pattern — blocked from the store",
          },
          "Skipping inductive observation that failed the memory-write security scan",
        );
        continue;
      }
      if (verdict.severity === "warn") {
        // The downgrade is itself a min against the ≤ learned ceiling — external is the floor.
        trust = minTrustLevel(trust, "external");
        downgraded++;
      }

      const source: MemorySource = { who: "system", channel: "memory-reasoning" };
      const observation: MemoryEntry = {
        id: randomUUID(),
        tenantId,
        agentId,
        userId: "system",
        content: pattern.content,
        trustLevel: trust, // HARD ≤ learned (or downgrade) — CODE-computed, NOT the LLM
        source,
        tags: [...uniqueTagsOf(scope), ...config.autoTags],
        proofCount: scope.length, // evidence count
        sourceIds,
        confidence: pattern.confidence ?? 1,
        occurredAt: maxOccurredAt(scope),
        createdAt: now0,
        observationKind: "inductive",
        ...(pattern.patternType !== undefined ? { patternType: pattern.patternType } : {}),
        sourceType: "conversation",
      };

      // Atomic create + mark sources consolidated_at (they leave the
      // candidate pool → idempotent re-run). Non-fatal: a rejecting store → WARN +
      // continue (sources stay unconsolidated for retry next run).
      const applied = await fromPromise(
        consolidationStore.applyConsolidation({ observation, markConsolidated: sourceIds, tenantId, now: now0 }),
      );
      if (!applied.ok || !applied.value.ok) {
        logger.warn(
          {
            agentId,
            errorKind: "dependency" as const,
            step: "reason" as const,
            hint: "applyConsolidation failed/rejected — sources left unconsolidated for retry next run",
          },
          "Failed to apply inductive observation (non-fatal)",
        );
        continue;
      }
      inductiveWritten++;
      scopeInductiveWrites++;
      writtenInductiveKeys.add(dedupKey);
    }

    // Drain a DEDUCTIVE-ONLY scope. When the scope produced ≥1 successful
    // deductive write but NO inductive write, applyConsolidation never ran, so its
    // sources are still consolidated_at IS NULL and would be re-selected +
    // re-reasoned (paid seam) every run. Mark them via the no-observation
    // markReasoned port method (non-destructive, scoped, idempotent) so the
    // candidate pool drains. The inductive path already marks via
    // applyConsolidation, so skip the redundant re-mark when it wrote.
    // Non-fatal: a rejecting store WARNs + leaves the sources for next run's retry
    // (the deductive upsert is itself idempotent — the re-run is correct, only the
    // recurring cost is undesirable, which this drains).
    if (scopeDeductiveWrites > 0 && scopeInductiveWrites === 0) {
      const marked = await fromPromise(
        consolidationStore.markReasoned(
          scope.map((e) => e.id),
          tenantId,
          now0,
        ),
      );
      if (!marked.ok || !marked.value.ok) {
        logger.warn(
          {
            agentId,
            errorKind: "dependency" as const,
            step: "reason" as const,
            hint: "markReasoned failed/rejected — deductive-only sources left unconsolidated; they will be re-reasoned next run",
          },
          "Failed to mark deductive-only sources consolidated (non-fatal)",
        );
      }
    }
  }

  logger.info(
    { agentId, step: "reason" as const, ...stats(), durationMs: clock.now() - startMs },
    "Memory reasoning completed",
  );
  emit();
  return ok(stats());
}
