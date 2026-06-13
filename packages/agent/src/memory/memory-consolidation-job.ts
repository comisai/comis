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
import { systemSetTimeout, systemClearTimeout, validateMemoryWrite } from "@comis/core";
import type {
  MemoryConsolidationConfig,
  MemoryConsolidationStore,
  MemoryEntry,
  MemorySource,
  TrustLevel,
  ClockPort,
} from "@comis/core";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";
import type { CapabilityClass } from "../executor/model-profile.js";
import { randomUUID } from "node:crypto";
import {
  clusterByEntityThenEmbedding,
  groupByTrustAndTagScope,
  minTrust,
  minTrustLevel,
  deterministicDedupKey,
  contentSimilarity,
} from "./memory-consolidation-clustering.js";
import { CONSOLIDATION_PROMPT, parseConsolidationResult } from "./memory-consolidation-prompt.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;

/**
 * How many existing observations to fetch for the dedup pre-check. The same
 * candidate cap is reused — a re-run's would-be duplicate is one of the recent
 * observations created by a prior run over the same sources.
 */
const DEDUP_OBSERVATION_LIMIT = 200;

/**
 * Per-member content cap (chars) fed into the merge prompt — a
 * prompt-size DoS guard. `maxConsolidationTokens` bounds only the LLM OUTPUT; the
 * INPUT was previously unbounded — every member's full `content` was
 * concatenated (`MemoryEntrySchema.content` is `z.string().min(1)`, no max), so
 * `maxClusterSize` members of arbitrary length could build an arbitrarily large
 * prompt. The merge only needs the GIST of each member, so each is sliced to
 * this cap before assembly — making the input cost bounded by
 * `maxClusterSize × MAX_MEMORY_CHARS` rather than uncontrolled member length.
 */
const MAX_MEMORY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

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

/**
 * Build the user-message text fed to the merge LLM call for one sub-cluster.
 * Each member's content is sliced to {@link MAX_MEMORY_CHARS} so the INPUT
 * prompt is bounded — not just the output (`maxTokens`).
 */
function buildClusterPrompt(cluster: MemoryEntry[]): string {
  let text = "Memories to merge:\n\n";
  for (const e of cluster) {
    text += `- (${e.id}) ${e.content.slice(0, MAX_MEMORY_CHARS)}\n`;
  }
  return text;
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
 * @returns `ok` on success (even with 0 observations); `err` only when the
 *   candidate read fails (cannot proceed safely).
 */
export async function runMemoryConsolidation(
  deps: MemoryConsolidationDeps,
): Promise<Result<void, Error>> {
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
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
    return ok(undefined);
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
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
    return ok(undefined);
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
  const existingKeys = new Set<string>();
  for (const obs of existing) {
    if (obs.sourceIds && obs.sourceIds.length > 0) {
      existingKeys.add(deterministicDedupKey(obs.sourceIds));
    }
  }

  let clustersProcessed = 0;
  let observationsCreated = 0;
  let dedupHits = 0;
  // Corroborating clusters folded into an existing observation (proof
  // accrual) instead of creating a second one. Counts only (the event field).
  let foldsApplied = 0;

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

  // APPLY stage: report what the merge/apply loop produced. O(1)/run →
  // INFO (per-cluster skip/dedup detail stays DEBUG via the step:"consolidate"
  // lines above).
  logger.info(
    { agentId, step: "apply" as const, observationsCreated, dedupHits, foldsApplied, durationMs: clock.now() - startMs },
    "consolidation applied",
  );

  eventBus.emit("memory:consolidated", {
    agentId,
    clustersProcessed,
    observationsCreated,
    dedupHits,
    foldsApplied,
    durationMs: clock.now() - startMs,
    timestamp: clock.now(),
  });

  logger.info(
    { agentId, clustersProcessed, observationsCreated, dedupHits, foldsApplied, durationMs: clock.now() - startMs },
    "Memory consolidation completed",
  );

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// LLM merge call (mirrors memory-review-job's completeSimple scaffold)
// ---------------------------------------------------------------------------

/**
 * Merge one homogeneous sub-cluster via a cheap-model LLM call. Returns the raw
 * response text, or `undefined` on any failure (model resolution, abort/timeout,
 * thrown call) — the caller treats `undefined` as a non-fatal skip (mirrors the
 * review-job posture). Bounded by `config.maxConsolidationTokens`.
 */
async function mergeCluster(
  deps: MemoryConsolidationDeps,
  cluster: MemoryEntry[],
): Promise<string | undefined> {
  const { config, agentId, clock, logger } = deps;

  let model;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
    model = getModel(deps.provider as any, deps.modelId as any);
  } catch (modelErr) {
    logger.warn(
      {
        agentId,
        err: modelErr,
        errorKind: "dependency" as const,
        hint: `could not resolve model ${deps.provider}/${deps.modelId} — skipping cluster`,
      },
      "Consolidation model resolution failed (non-fatal)",
    );
    return undefined;
  }
  if (!model) {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        hint: `model not found ${deps.provider}/${deps.modelId} — skipping cluster`,
      },
      "Consolidation model not found (non-fatal)",
    );
    return undefined;
  }

  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: CONSOLIDATION_PROMPT,
        messages: [{ role: "user" as const, content: buildClusterPrompt(cluster), timestamp: clock.now() }],
      },
      {
        apiKey: deps.apiKey,
        temperature: 0.2,
        maxTokens: config.maxConsolidationTokens,
        signal: controller.signal,
      },
    );
    return extractResponseText(response);
  } catch (llmErr) {
    logger.warn(
      {
        agentId,
        err: llmErr,
        errorKind: "dependency" as const,
        hint: "consolidation merge LLM call failed/aborted — skipping cluster",
      },
      "Consolidation merge LLM call failed (non-fatal)",
    );
    return undefined;
  } finally {
    systemClearTimeout(timer);
  }
}
