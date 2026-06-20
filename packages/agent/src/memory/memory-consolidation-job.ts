// SPDX-License-Identifier: Apache-2.0
/**
 * Memory consolidation job handler.
 *
 * Runs as a background cron (wired in the daemon). Reads raw
 * not-yet-consolidated candidates from the segregated
 * {@link MemoryConsolidationStore} (a `consolidated_at IS NULL` STATE predicate
 * — never a time cursor, RESEARCH Pitfall 1), clusters near-duplicates, merges
 * each homogeneous sub-cluster via a cheap-model LLM call (MERGE-only contract),
 * and applies each consolidation ATOMICALLY through the store port.
 *
 * GENERAL-01/02 (design §WS6): when `generalize.enabled`, a SECOND pass over the
 * same sub-clusters ABSTRACTS any cluster that recurs across `minDistinctContexts`
 * DISTINCT (sessionKey, sender) contexts into ONE higher-order `semantic` memory
 * ("user prefers X in general") at the `minTrust` ceiling, `proofCount = |cluster|`,
 * sources KEPT (a NEW non-destructive node, `observationKind: "generalization"`).
 * The cluster input is `wrapExternalContent`-wrapped before the synthesis LLM
 * (SEC-01 new stage — see `memory-consolidation-llm.ts`). Default-OFF →
 * byte-identical consolidation when disabled. The abstain gate (small/nano →
 * skip) precedes BOTH passes, so a weak model never fabricates a generalization.
 *
 * Security posture (this is the security-critical path, design §9):
 * - Trust is computed in CODE (`minTrust`, the ceiling), NEVER chosen
 *   by the LLM. Consolidating lower-trust sources can never mint a higher-trust
 *   observation. The LLM contract has no trust field; any it smuggles is dropped
 *   by the parser.
 * - A single LLM call NEVER mixes trust levels or tag scopes
 *   (`groupByTrustAndTagScope` partitions first — anti-trust-laundering).
 * - `external` sources are excluded by default (`consolidateExternal:false`).
 * - Merged content runs through `validateMemoryWrite` (defense-in-depth on
 *   LLM-produced text, AGENTS.md §2.2): `critical` → skip; `warn` → trust
 *   downgraded to "external"; `clean` → the code-computed ceiling.
 * - Deterministic dedup pre-check (sorted source-id hash primary + content
 *   similarity secondary) prevents re-run double-create.
 * - The run is BOUNDED (maxCandidatesPerRun / maxClustersPerRun /
 *   maxConsolidationTokens) and emits a MINIMAL `memory:consolidated`
 *   event (the rich observability surface lives elsewhere).
 *
 * The agent consumes the store as a TYPE from `@comis/core` (the agent↛memory
 * build cut); the daemon injects the concrete memory-package adapter. NO
 * memory-package import here, NO wall-clock global (the injected `clock`).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { validateMemoryWrite } from "@comis/core";
import type {
  MemoryConsolidationConfig,
  MemoryConsolidationStore,
  MemoryEntry,
  MemorySource,
  TrustLevel,
  ClockPort,
} from "@comis/core";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";
import type { CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import type { CapabilityClass } from "../executor/model-profile.js";
import { randomUUID } from "node:crypto";
import {
  clusterByEntityThenEmbedding,
  groupByTrustAndTagScope,
  minTrust,
  minTrustLevel,
  deterministicDedupKey,
  contentSimilarity,
  countDistinctContexts,
} from "./memory-consolidation-clustering.js";
import { mergeCluster, synthesizeGeneralization } from "./memory-consolidation-llm.js";
import { parseConsolidationResult } from "./memory-consolidation-prompt.js";
import { emitGenerationQuality } from "./emit-generation-quality.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies injected into the memory consolidation handler. */
export interface MemoryConsolidationDeps {
  agentId: string;
  tenantId: string;
  config: MemoryConsolidationConfig;
  /**
   * The SEGREGATED consolidation store (port TYPE from `@comis/core`). The
   * concrete adapter lives in the memory package; the daemon injects
   * it. The agent cannot import that package (the agent↛memory build cut).
   */
  consolidationStore: MemoryConsolidationStore;
  eventBus: { emit(event: string, payload: unknown): void };
  provider: string;
  modelId: string;
  apiKey: string;
  /** Custom-provider model spec (resolved `/v1` baseUrl) so a keyless/local YAML provider the
   *  pi-ai catalog can't see still resolves a model — else consolidation skipped on keyless
   *  (#223/DIALECTIC-FIX). Structurally threaded into LlmClusterDeps. Optional for built-ins. */
  customModel?: CustomCompletionsModelSpec;
  /** Wall-clock reads — every timestamp + `durationMs`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  /**
   * R6: the capability class of the agent's model (from ModelProfile.capabilityClass).
   * When small/nano without a capable override, consolidation LLM calls are skipped
   * (T-153-fabricate mitigation: prevent fabricated triples from entering trusted storage).
   * Optional: defaults to "frontier" behavior (capable) when absent.
   */
  capabilityClass?: CapabilityClass;
  /**
   * R6: operator override — a stronger cheap model is configured for the memory
   * pipeline. When true, small/nano are treated as capable for consolidation.
   * Optional; defaults to false.
   */
  hasCapableModelOverride?: boolean;
}

/**
 * The counts-only stats a consolidation pass returns (Phase 203 Plan 05): the
 * GENERAL- generalization counters the daemon-side `learning:memory_generalized`
 * emit reads. COUNTS ONLY — no memory body / source ids cross this surface
 * (SEC-01). The same numbers also ride the `memory:consolidated` event; surfacing
 * them on the result lets the daemon cron handler emit the learning event
 * directly (mirrors the user-rep / lifecycle jobs' returned stats — OBS-01).
 */
export interface MemoryConsolidationStats {
  /** Higher-order generalizations written this run (GENERAL-01). */
  generalized: number;
  /** Cross-context clusters the generalization pass considered (GENERAL-02 gate input). */
  clustersConsidered: number;
  /** Wall-clock duration of the pass (ms; from the injected clock). */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many existing observations to fetch for the dedup pre-check. The same
 * candidate cap is reused — a re-run's would-be duplicate is one of the recent
 * observations created by a prior run over the same sources.
 */
const DEDUP_OBSERVATION_LIMIT = 200;

// ---------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------

/** Union of the tags across a (homogeneous-by-tag) sub-cluster — deterministic, sorted. */
function uniqueTagsOf(cluster: MemoryEntry[]): string[] {
  const tags = new Set<string>();
  for (const e of cluster) for (const t of e.tags) tags.add(t);
  return [...tags].sort();
}

/** The latest event/record time across a cluster (observation's `occurredAt`). */
function maxOccurredAt(cluster: MemoryEntry[]): number {
  let max = 0;
  for (const e of cluster) {
    const t = e.occurredAt ?? e.createdAt;
    if (t > max) max = t;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one consolidation pass for a single agent.
 *
 * Reads candidates → clusters → partitions into homogeneous sub-clusters
 * → for each (bounded by `maxClustersPerRun`): compute the trust
 * ceiling, gate `external`, dedup pre-check,
 * (mocked-in-test) LLM merge, `validateMemoryWrite`, then `applyConsolidation`
 * atomically (the store owns the transaction). Emits a minimal
 * `memory:consolidated` event. Non-fatal posture (mirrors `runMemoryReview`): a
 * bad LLM parse / a failed cluster → WARN + continue; the run returns `ok` even
 * with 0 observations. Only an inability to READ candidates is fatal.
 *
 * @returns `ok` with the counts-only `MemoryConsolidationStats` on success (even
 *   with 0 observations); `err` only when the candidate read fails (cannot
 *   proceed safely). The returned `generalized`/`clustersConsidered` are what the
 *   daemon cron handler emits as `learning:memory_generalized` (OBS-01).
 */
export async function runMemoryConsolidation(
  deps: MemoryConsolidationDeps,
): Promise<Result<MemoryConsolidationStats, Error>> {
  const { config, agentId, tenantId, consolidationStore, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  // R6 capability routing: skip consolidation LLM calls for small/nano without a
  // capable-model override (T-153-fabricate mitigation: prevent fabricated triples
  // from entering trusted storage via the merge LLM call). The 0-observation event
  // is emitted to maintain the heartbeat; the run is non-fatal.
  const capabilityClass = deps.capabilityClass ?? "frontier";
  const hasCapableModelOverride = deps.hasCapableModelOverride ?? false;
  const memStrategy = resolveMemoryOpsStrategy(capabilityClass, hasCapableModelOverride);
  if (memStrategy === "abstain") {
    logger.warn(
      {
        agentId,
        submodule: "memory-consolidation-job",
        errorKind: "precondition" as const,
        hint: "extraction skipped: capabilityClass requires a capableModel override",
      },
      "memory extraction skipped",
    );
    eventBus.emit("memory:consolidated", {
      agentId,
      clustersProcessed: 0,
      observationsCreated: 0,
      dedupHits: 0,
      foldsApplied: 0,
      generalized: 0,
      clustersConsidered: 0,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
    return ok({ generalized: 0, clustersConsidered: 0, durationMs: clock.now() - startMs });
  }

  // 1. Candidates — a READ failure is fatal (we cannot safely proceed).
  const candidatesResult = await fromPromise(
    consolidationStore.listConsolidationCandidates(agentId, tenantId, config.maxCandidatesPerRun),
  );
  if (!candidatesResult.ok) return err(candidatesResult.error);
  if (!candidatesResult.value.ok) return err(candidatesResult.value.error);
  const candidates = candidatesResult.value.value;

  if (candidates.length === 0) {
    eventBus.emit("memory:consolidated", {
      agentId,
      clustersProcessed: 0,
      observationsCreated: 0,
      dedupHits: 0,
      foldsApplied: 0,
      generalized: 0,
      clustersConsidered: 0,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
    return ok({ generalized: 0, clustersConsidered: 0, durationMs: clock.now() - startMs });
  }

  // The last degradation gap: a candidate arrives with
  // `embedding === undefined` when sqlite-vec is unavailable (the adapter's
  // LEFT JOIN found no vec row). The clusterer then SILENTLY degrades that
  // candidate to entity/FTS overlap. Surface a queryable, operator-facing
  // signal — errorKind:"precondition" (an unmet precondition for VECTOR
  // clustering) + a COUNT + a hint naming the fallback. Counts only — never
  // candidate content (AGENTS.md §2.7). Non-fatal: the run proceeds (the
  // clusterer's entity/FTS fallback still produces clusters).
  const missingEmbedding = candidates.filter((c) => c.embedding === undefined).length;
  if (missingEmbedding > 0) {
    logger.warn(
      {
        agentId,
        step: "cluster" as const,
        errorKind: "precondition" as const,
        missingEmbedding,
        hint: `${missingEmbedding} consolidation candidate(s) missing embedding; clustering degraded to entity/FTS overlap`,
      },
      "Consolidation candidates missing embedding",
    );
  }

  // 2. Greedy clustering, then 3. partition into homogeneous sub-clusters.
  // Singletons carry nothing to merge → dropped (left for a future
  // run; SAFE because selection is a state predicate, not a cursor).
  const clusters = clusterByEntityThenEmbedding(candidates, {
    similarityThreshold: config.similarityThreshold,
    maxClusterSize: config.maxClusterSize,
  });
  const subClusters = clusters
    .flatMap((c) => groupByTrustAndTagScope(c))
    .filter((c) => c.length >= 2);

  // CLUSTER stage: report the funnel (candidates → clusters →
  // mergeable sub-clusters). O(1)/run → INFO.
  logger.info(
    {
      agentId,
      step: "cluster" as const,
      candidates: candidates.length,
      clusters: clusters.length,
      subClusters: subClusters.length,
      durationMs: clock.now() - startMs,
    },
    "consolidation clustered",
  );

  // 4. Existing observations for the deterministic dedup pre-check.
  // A read failure is NON-FATAL: degrade to "no known duplicates" (we may
  // re-create, but the next run's predicate re-converges). Log + continue.
  let existing: MemoryEntry[] = [];
  const obsResult = await fromPromise(
    consolidationStore.listObservations(agentId, tenantId, DEDUP_OBSERVATION_LIMIT),
  );
  if (obsResult.ok && obsResult.value.ok) {
    existing = obsResult.value.value;
  } else {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        hint: "could not list existing observations for dedup — proceeding without the pre-check",
      },
      "Consolidation dedup pre-check unavailable",
    );
  }
  // The PRIOR-RUN observations (loaded above) — the stable snapshot the
  // SECONDARY content-similarity dedup compares against. NOT mutated with
  // same-run mints (that would collapse two distinct trust scopes).
  const priorObservations = existing;
  // Pre-index existing observations by their source-id dedup key (primary, O(1)
  // lookup). Same-run mints ARE added here so a later sub-cluster with the SAME
  // source set in this run still dedups (exact-source double-create guard).
  //
  // GENERALIZATIONS use a SEPARATE namespace: a merge observation and a
  // higher-order generalization over the SAME source set are DISTINCT artifacts
  // (different observationKind), so they must NOT collide on the shared
  // source-id key — otherwise the merge that runs first would block the
  // generalization. Prior-run generalizations index here so a re-run is still a
  // dedup hit (Pitfall 3); merge-kind observations index in `existingKeys`.
  const existingKeys = new Set<string>();
  const existingGeneralizationKeys = new Set<string>();
  for (const obs of existing) {
    if (obs.sourceIds && obs.sourceIds.length > 0) {
      const k = deterministicDedupKey(obs.sourceIds);
      if (obs.observationKind === "generalization") existingGeneralizationKeys.add(k);
      else existingKeys.add(k);
    }
  }

  let clustersProcessed = 0;
  let observationsCreated = 0;
  let dedupHits = 0;
  // Corroborating clusters folded into an existing observation (proof
  // accrual) instead of creating a second one. Counts only (the event field).
  let foldsApplied = 0;
  // GENERAL-01/02 counts (the daemon-side learning:memory_generalized event,
  // Plan 05): higher-order memories created this run + the diversity-clearing
  // clusters considered. Counts ONLY — never the synthesized content (§2.7).
  let generalized = 0;
  let clustersConsidered = 0;

  for (const cluster of subClusters) {
    // The trust CEILING — computed in CODE, never the LLM.
    const trust = minTrust(cluster);

    // External excluded by default (no observation, no LLM call/spend).
    // A skip here consumes NO budget (it never reaches the LLM).
    if (trust === "external" && !config.consolidateExternal) {
      logger.debug({ agentId, step: "consolidate" }, "Skipping external-trust cluster (consolidateExternal=false)");
      continue;
    }

    const sourceIds = cluster.map((e) => e.id);

    // PRIMARY dedup: identical source set → an equivalent observation
    // already exists. Skip (leave sources consolidated_at IS NULL; the existing
    // observation already covers them — the next run re-hits this dedup, no
    // double-create). This keeps the port at exactly 3 methods (no markOnly).
    //
    // This dedup check (and the external gate above) runs BEFORE the
    // maxClustersPerRun budget gate, because a dedup hit needs NO LLM call and
    // does NO merge work — it must NOT consume the per-run cluster budget.
    // Counting dedup skips against the budget let a churny steady state (many
    // recurring already-consolidated source sets) burn the whole budget on skips
    // and `break` before reaching the clusters that actually need merging,
    // indefinitely starving genuinely-new observations. dedupHits still counts.
    const key = deterministicDedupKey(sourceIds);
    if (existingKeys.has(key)) {
      dedupHits++;
      logger.debug({ agentId, step: "consolidate" }, "Dedup hit (existing observation covers this source set) — skipping");
      continue;
    }

    // Per-run cluster bound — gate ONLY clusters that will actually do merge work (reach
    // the LLM + apply). Incrementing here (after the eligibility + primary-dedup
    // skips) ensures the budget funds real merges, never skipped work.
    if (clustersProcessed >= config.maxClustersPerRun) break;
    clustersProcessed++;

    // 5. (Mocked-in-test) LLM merge of the homogeneous sub-cluster. Non-fatal:
    // a thrown/aborted call WARNs + continues (the run still returns ok).
    const mergeText = await mergeCluster(deps, cluster);
    if (mergeText === undefined) {
      // mergeCluster already logged the WARN with errorKind + hint.
      continue;
    }
    const parsed = parseConsolidationResult(mergeText);
    if (!parsed) {
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          hint: "consolidation merge output failed schema validation — skipping cluster",
        },
        "Consolidation merge returned invalid output, skipping",
      );
      // GENQ-01: the produced merge text failed the schema parse — a format
      // violation. Classify the raw output too (a non-Latin cluster whose merge
      // came back Latin also surfaces here). Content-free, guarded, no gating.
      emitGenerationQuality(eventBus, logger, {
        agentId,
        pass: "consolidation",
        sourceText: cluster.map((entry) => entry.content).join("\n"),
        outputText: mergeText,
        formatViolation: true,
        nowMs: clock.now(),
      });
      continue;
    }
    // GENQ-01: the merged observation parsed — classify the cluster source vs the
    // observation content (the F-ML1 class: a non-Latin cluster merged into a Latin
    // observation, or an empty merge). Fires only on an issue; VISIBILITY ONLY.
    emitGenerationQuality(eventBus, logger, {
      agentId,
      pass: "consolidation",
      sourceText: cluster.map((entry) => entry.content).join("\n"),
      outputText: parsed.content,
      nowMs: clock.now(),
    });

    // The injected-clock epoch ms shared by BOTH the fold branch and the create
    // path below (one read per cluster — never Date.now). Used for the fold
    // plan's `now` (consolidated_at on the new sources + history.changedAt) and
    // for the created observation's `createdAt`.
    const now = clock.now();

    // The fold-vs-create decision (the converted SECONDARY content
    // dedup). A DIFFERENT source set expressing the SAME fact as a PRIOR-RUN
    // observation of the SAME trust level: instead of skipping or
    // creating a duplicate, FOLD the truly-new sources into that observation so
    // proof accrues across runs. We match ONLY same-trust prior observations
    // (`priorObservations`, never same-run mints): cross-trust content collapse
    // would launder trust / violate the scope separation — a
    // cross-trust corroboration falls through to CREATE a distinct observation.
    // Same-run exact-source re-hits are already caught by the PRIMARY source-id
    // key above (so a fully-folded source set is idempotent by construction).
    const foldTarget = priorObservations.find(
      (obs) =>
        obs.trustLevel === trust &&
        contentSimilarity(parsed.content, obs.content) >= config.dedupThreshold,
    );
    if (foldTarget) {
      // Idempotency pre-filter: only ids NOT already in the target's source set.
      // An empty diff means this corroboration is already folded → SKIP (the
      // adapter's UNION-cardinality is the authoritative backstop, but the job
      // avoids the redundant round-trip). Counts as a dedup hit.
      const existingSet = new Set(foldTarget.sourceIds ?? []);
      const trulyNew = sourceIds.filter((id) => !existingSet.has(id));
      if (trulyNew.length === 0) {
        dedupHits++;
        logger.debug({ agentId, step: "consolidate" }, "Dedup hit (content match, no truly-new sources) — skipping");
        continue;
      }
      // Trust ceiling carried forward in CODE (anti-laundering): the fold can
      // only LOWER trust. Same-trust target → a no-op (defense-in-depth).
      const foldTrust = minTrustLevel(foldTarget.trustLevel, trust);
      // Half-life refresh: restart the decay clock so the new proof actually
      // moves ranking (RESEARCH Pitfall 3) — occurredAt = max(existing, cluster).
      const refreshedOccurredAt = Math.max(
        foldTarget.occurredAt ?? foldTarget.createdAt,
        maxOccurredAt(cluster),
      );
      const folded = await fromPromise(
        consolidationStore.foldIntoExisting({
          targetObservationId: foldTarget.id,
          newSourceIds: trulyNew,
          trustLevel: foldTrust,
          confidence: 1,
          occurredAt: refreshedOccurredAt,
          content: parsed.content,
          tenantId,
          now,
        }),
      );
      if (!folded.ok || !folded.value.ok) {
        logger.warn(
          {
            agentId,
            errorKind: "dependency" as const,
            hint: "foldIntoExisting failed/rejected — sources left unconsolidated for retry next run",
          },
          "Failed to fold consolidation (non-fatal)",
        );
        continue;
      }
      foldsApplied++;
      // Index the GROWN source-id key so a later same-run cluster with that exact
      // (now-unioned) source set dedups via the primary key (exact-source guard).
      existingKeys.add(deterministicDedupKey([...(foldTarget.sourceIds ?? []), ...trulyNew]));
      logger.debug({ agentId, step: "consolidate" }, "Folded corroboration into existing observation");
      continue;
    }
    // else: fall through to the UNCHANGED CREATE path below.

    // Defense-in-depth on the LLM-produced text (AGENTS.md §2.2): scan BEFORE
    // store. `critical` → skip; `warn` → downgrade trust toward external (never
    // ABOVE the code-computed ceiling); `clean` → the ceiling.
    const verdict = validateMemoryWrite(parsed.content);
    if (verdict.severity === "critical") {
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "merged observation matched a dangerous/secret pattern — blocked from store",
        },
        "Skipping merged observation that failed the memory-write security scan",
      );
      continue;
    }
    // `warn` downgrades toward external, but NEVER raises trust above the ceiling.
    const effectiveTrust: TrustLevel = verdict.severity === "warn" ? "external" : trust;

    const source: MemorySource = { who: "system", channel: "memory-consolidation" };
    const observation: MemoryEntry = {
      id: randomUUID(),
      tenantId,
      agentId,
      userId: "system",
      content: parsed.content,
      trustLevel: effectiveTrust, // CODE-computed ceiling (or downgrade) — NOT the LLM
      source,
      tags: [...uniqueTagsOf(cluster), ...config.autoTags],
      proofCount: cluster.length,
      sourceIds,
      confidence: parsed.confidence ?? 1,
      occurredAt: maxOccurredAt(cluster),
      createdAt: now,
      sourceType: "conversation",
    };

    // 6. Apply atomically (the store owns the transaction). Non-fatal:
    // a rejecting/erroring store WARNs + continues; sources stay
    // consolidated_at IS NULL and are retried next run (idempotent).
    const applied = await fromPromise(
      consolidationStore.applyConsolidation({ observation, markConsolidated: sourceIds, tenantId, now }),
    );
    if (!applied.ok || !applied.value.ok) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          hint: "applyConsolidation failed/rejected — sources left unconsolidated for retry next run",
        },
        "Failed to apply consolidation (non-fatal)",
      );
      continue;
    }
    observationsCreated++;
    // Index the just-created observation's source-id key so a later sub-cluster
    // with the SAME source set in THIS run also dedups (exact-source guard).
    // Deliberately NOT added to `priorObservations` — see the secondary-dedup
    // note above (no same-run cross-trust content collapse).
    existingKeys.add(key);
  }

  // 7. GENERAL-01/02: the diversity-gated, wrapExternalContent-wrapped
  // generalization synthesis pass — abstract a cluster that recurs across MANY
  // distinct contexts into ONE higher-order `semantic` memory ("user prefers X
  // in general") instead of copying near-dups verbatim. Behind
  // `generalize.enabled` → byte-identical consolidation when off. The abstain
  // early-return (above) PRECEDES this pass, so small/nano never reach it. The
  // higher-order memory is a NEW non-destructive node at the `minTrust(cluster)`
  // ceiling (NEVER raised), `proofCount = |cluster|`, sources KEPT — written via
  // the EXISTING applyConsolidation (no new adapter method).
  if (config.generalize.enabled) {
    for (const cluster of subClusters) {
      // Anti-domination: only a cluster spanning >= minDistinctContexts DISTINCT
      // (sessionKey, sender) contexts generalizes — one chatty session cannot
      // forge a "general" preference.
      if (countDistinctContexts(cluster) < config.generalize.minDistinctContexts) continue;

      // Re-run double-create guard (Pitfall 3): the same source set yields the
      // same key — a prior-run generalization over this cluster is a dedup hit.
      // Checked against the SEPARATE generalization namespace so the merge that
      // ran first over the same sources does NOT block this generalization.
      const genKey = deterministicDedupKey(cluster.map((e) => e.id));
      if (existingGeneralizationKeys.has(genKey)) {
        dedupHits++;
        continue;
      }

      logger.debug(
        { agentId, step: "memory-generalization" as const },
        "Generalizing a cross-context cluster (diversity threshold met)",
      );

      // Synthesize the higher-order content (LLM; the cluster input is
      // wrapExternalContent-wrapped INSIDE synthesizeGeneralization — SEC-01).
      // A model failure / empty parse is undefined = a non-fatal skip.
      const higherOrder = await synthesizeGeneralization(deps, cluster);
      if (higherOrder === undefined) continue;

      // Defense-in-depth (AGENTS.md §2.2): scan the synthesized content BEFORE
      // store. A non-clean generalization is skipped (counts-only), never stored
      // (the profile/observation store has no external down-tier for a higher-order
      // memory). The cluster WAS considered (it cleared the diversity gate).
      const verdict = validateMemoryWrite(higherOrder.content);
      if (verdict.severity !== "clean") {
        logger.warn(
          {
            agentId,
            step: "memory-generalization" as const,
            errorKind: "validation" as const,
            hint: "synthesized generalization matched a non-clean pattern — blocked from store",
          },
          "Skipping generalization that failed the memory-write security scan",
        );
        clustersConsidered++;
        continue;
      }

      const genNow = clock.now();
      const genSourceIds = cluster.map((e) => e.id);
      const genSource: MemorySource = { who: "system", channel: "memory-generalization" };
      const generalization: MemoryEntry = {
        id: randomUUID(),
        tenantId,
        agentId,
        userId: "system",
        content: higherOrder.content,
        trustLevel: minTrust(cluster), // the learned ceiling — NEVER raised
        source: genSource,
        tags: [...uniqueTagsOf(cluster), ...config.autoTags],
        proofCount: cluster.length,
        sourceIds: genSourceIds,
        confidence: higherOrder.confidence ?? 1,
        occurredAt: maxOccurredAt(cluster),
        createdAt: genNow,
        sourceType: "conversation",
        memoryType: "semantic",
        observationKind: "generalization",
      };

      const applied = await fromPromise(
        consolidationStore.applyConsolidation({
          observation: generalization,
          markConsolidated: genSourceIds,
          tenantId,
          now: genNow,
        }),
      );
      if (applied.ok && applied.value.ok) {
        generalized++;
        existingGeneralizationKeys.add(genKey);
      } else {
        logger.warn(
          {
            agentId,
            step: "memory-generalization" as const,
            errorKind: "dependency" as const,
            hint: "applyConsolidation failed/rejected for the generalization — sources unchanged, retried next run",
          },
          "Failed to write generalization (non-fatal)",
        );
      }
      clustersConsidered++;
    }
  }

  // APPLY stage: report what the merge/apply loop produced. O(1)/run →
  // INFO (per-cluster skip/dedup detail stays DEBUG via the step:"consolidate"
  // lines above).
  logger.info(
    {
      agentId,
      step: "apply" as const,
      observationsCreated,
      dedupHits,
      foldsApplied,
      generalized,
      clustersConsidered,
      durationMs: clock.now() - startMs,
    },
    "consolidation applied",
  );

  eventBus.emit("memory:consolidated", {
    agentId,
    clustersProcessed,
    observationsCreated,
    dedupHits,
    foldsApplied,
    generalized,
    clustersConsidered,
    durationMs: clock.now() - startMs,
    timestamp: clock.now(),
  });

  logger.info(
    {
      agentId,
      clustersProcessed,
      observationsCreated,
      dedupHits,
      foldsApplied,
      generalized,
      clustersConsidered,
      durationMs: clock.now() - startMs,
    },
    "Memory consolidation completed",
  );

  return ok({ generalized, clustersConsidered, durationMs: clock.now() - startMs });
}
