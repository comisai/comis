// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, deterministic clustering + trust helpers for the memory-consolidation
 * job (Phase 84 — CONS-01/02/04/06). No IO, no clock, no nondeterministic RNG,
 * and — critically — NO cross-package memory-adapter import (the agent↛memory
 * build cut; the job consumes the store as a TYPE from `@comis/core`, the daemon
 * injects the adapter). Split out of `memory-consolidation-job.ts` so this math gets
 * no-mock RED→GREEN unit coverage and the job file stays under the 800-line cap.
 *
 * Contents:
 * - {@link minTrust}: the SECURITY-critical trust CEILING (CONS-02). An
 *   observation NEVER outranks its least-trusted source — consolidating
 *   lower-trust memories can never mint a higher-trust observation (the
 *   privilege-escalation guard). Trust is computed HERE in code, never chosen
 *   by the LLM.
 * - {@link groupByTrustAndTagScope}: the anti-trust-laundering partition
 *   (CONS-06). A cluster is split into sub-clusters homogeneous in
 *   (trustLevel, sorted-tags) BEFORE the LLM call, so one prompt never mixes
 *   trust levels or tag scopes.
 * - {@link clusterByEntityThenEmbedding}: greedy single-link clustering
 *   (CONS-01) — entity-share (Phase-83 links) OR embedding cosine ≥ threshold,
 *   oldest-first seed, deterministic tie-break by candidate index, capped at
 *   maxClusterSize. Degrades to entity-only grouping when embeddings are absent.
 * - {@link deterministicDedupKey}: the PRIMARY dedup key (CONS-04) — a stable
 *   sha256 of the SORTED source-id set (order-independent), so a re-run over the
 *   same cluster yields the identical key and a dedup hit.
 * - {@link contentSimilarity}: a small pure Dice-bigram SECONDARY signal (used
 *   to catch a DIFFERENT source set expressing the SAME fact). Inline — NOT the
 *   memory package's `nameSimilarity` (that import is forbidden by the cut).
 * - {@link cosine}: pure vector proximity.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { MemoryEntry, TrustLevel } from "@comis/core";
import type { ConsolidationCandidate } from "@comis/core";

// ---------------------------------------------------------------------------
// Trust ceiling (CONS-02 — the privilege-escalation guard)
// ---------------------------------------------------------------------------

/**
 * Inverse-rank trust ladder for the CEILING: lower index = MORE trusted.
 *
 * `score.ts` ranks trust for the recall BOOST (system 1.0 > learned 0.5 >
 * external 0.0 — higher = more trusted). For the consolidation ceiling we want
 * the LEAST-trusted member, so we invert: the least-trusted member is the one
 * with the MAX rank index here.
 */
const TRUST_RANK = { system: 0, learned: 1, external: 2 } as const;

/**
 * Rank a trust level on the inverse ladder. Closed-union exhaustive (AGENTS.md
 * §2.8) — a new {@link TrustLevel} member fails the build here until ranked.
 */
function trustRank(level: TrustLevel): number {
  switch (level) {
    case "system":
      return TRUST_RANK.system;
    case "learned":
      return TRUST_RANK.learned;
    case "external":
      return TRUST_RANK.external;
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/**
 * The trust CEILING (CONS-02): the LEAST-trusted member of the cluster.
 *
 * Reduce seeded at the most-trusted level ("system"); any member that is less
 * trusted (a higher rank index) replaces it. So `[system, learned]` → "learned"
 * (NEVER "system"), `[learned, external]` → "external", `[system, system]` →
 * "system". A lower-trust source can therefore NEVER yield a higher-trust
 * observation — the anti-trust-laundering invariant. Computed in CODE; the LLM
 * has no trust field in its contract.
 *
 * An empty cluster cannot occur (callers cluster ≥1 real candidate), but the
 * "system" seed makes the empty case the safe identity rather than a throw.
 */
export function minTrust(entries: MemoryEntry[]): TrustLevel {
  return entries.reduce<TrustLevel>(
    (acc, e) => (trustRank(e.trustLevel) > trustRank(acc) ? e.trustLevel : acc),
    "system",
  );
}

// ---------------------------------------------------------------------------
// Trust/tag-scoped partition (CONS-06 — anti-trust-laundering)
// ---------------------------------------------------------------------------

/** Homogeneity key for a memory: its trust level + its sorted-tag signature. */
function scopeKey(entry: MemoryEntry): string {
  return `${entry.trustLevel}|${[...entry.tags].sort().join(",")}`;
}

/**
 * Partition a cluster into sub-clusters each homogeneous in (trustLevel,
 * sorted-tags), so a single consolidation LLM call (Task 2) sees ONE trust
 * level and ONE tag scope (CONS-06). A `learned` fact never shares a prompt
 * with a `system` fact; differently-tagged facts never co-merge. Enforced in
 * CODE, never the prompt.
 *
 * Deterministic: members keep their input order within a sub-cluster, and the
 * sub-clusters are returned in ascending `scopeKey` order (stable across runs —
 * no nondeterministic RNG, no insertion-order dependence).
 */
export function groupByTrustAndTagScope(cluster: MemoryEntry[]): MemoryEntry[][] {
  const byKey = new Map<string, MemoryEntry[]>();
  for (const entry of cluster) {
    const key = scopeKey(entry);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as MemoryEntry[]);
}

// ---------------------------------------------------------------------------
// Vector proximity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two vectors. Pure dot / (‖a‖·‖b‖). A zero-norm vector
 * (or a length mismatch) yields 0 — no neighbour, never a NaN.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Greedy single-link clustering (CONS-01)
// ---------------------------------------------------------------------------

/** Options for {@link clusterByEntityThenEmbedding}. */
export interface ClusterOptions {
  /** Cluster-neighbour cosine threshold (0-1). Pairs at/above this are unioned. */
  similarityThreshold: number;
  /** Hard cap on members per cluster (cost bound, CONS-07). */
  maxClusterSize: number;
  /**
   * Optional entity-id sets per memory id (Phase-83 `memory_entity_links`). When
   * supplied, two candidates sharing ≥1 entity id are neighbours regardless of
   * cosine — entities TIGHTEN the grouping. Absent → cosine-only (or, with no
   * embeddings either, every candidate is a singleton).
   */
  entityIdsByMemoryId?: Map<string, Set<string>>;
}

/** True when two entity-id sets intersect (≥1 shared id). */
function sharesEntity(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  if (!a || !b || a.size === 0 || b.size === 0) return false;
  // Iterate the smaller set for cheap membership checks.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) {
    if (large.has(id)) return true;
  }
  return false;
}

/**
 * Greedy single-link clustering (CONS-01), deterministic.
 *
 * Iterate candidates in array order (the store returns them oldest-first, so
 * the seed is the oldest unclustered candidate). For each not-yet-clustered
 * seed, open a cluster and union every later not-yet-clustered candidate that is
 * a NEIGHBOUR — `cosine(seedEmb, candEmb) >= similarityThreshold` OR (when an
 * entity map is supplied) sharing ≥1 entity id — up to `maxClusterSize`. Mark
 * unioned members visited. A seed with no neighbour becomes a singleton cluster
 * (the caller drops singletons — nothing to consolidate yet; SAFE because
 * candidate selection is a `consolidated_at IS NULL` state predicate, not a
 * time cursor — RESEARCH Pitfall 1).
 *
 * Determinism (AGENTS.md §2.5): no nondeterministic RNG; the seed order and the
 * neighbour-scan order are both the input array order, so ties break purely by
 * candidate index. Two runs on the same input produce identical assignment.
 *
 * When embeddings are absent (sqlite-vec unavailable) the cosine test is
 * skipped (no embedding → no cosine neighbour) and grouping falls back to
 * entity-share only — a non-fatal graceful degrade (RESEARCH Pitfall 7).
 */
export function clusterByEntityThenEmbedding(
  candidates: ConsolidationCandidate[],
  opts: ClusterOptions,
): MemoryEntry[][] {
  const { similarityThreshold, maxClusterSize, entityIdsByMemoryId } = opts;
  const visited = new Array<boolean>(candidates.length).fill(false);
  const clusters: MemoryEntry[][] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const seed = candidates[i];
    const cluster: MemoryEntry[] = [seed.entry];
    const seedEmb = seed.embedding;
    const seedEntities = entityIdsByMemoryId?.get(seed.entry.id);

    for (let j = i + 1; j < candidates.length && cluster.length < maxClusterSize; j++) {
      if (visited[j]) continue;
      const cand = candidates[j];
      const cosNeighbour =
        seedEmb !== undefined &&
        cand.embedding !== undefined &&
        cosine(seedEmb, cand.embedding) >= similarityThreshold;
      const entityNeighbour =
        entityIdsByMemoryId !== undefined &&
        sharesEntity(seedEntities, entityIdsByMemoryId.get(cand.entry.id));
      if (cosNeighbour || entityNeighbour) {
        visited[j] = true;
        cluster.push(cand.entry);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Deterministic dedup (CONS-04)
// ---------------------------------------------------------------------------

/**
 * The PRIMARY dedup key (CONS-04): a stable sha256 hex digest of the SORTED
 * source-id set. Order-independent (the ids are sorted before hashing), so two
 * runs that cluster the SAME source memories produce the SAME key — a re-run is
 * a dedup hit and never double-creates (the regression the design's
 * state-predicate selection guards against). A different source set yields a
 * different key. Uses only `node:crypto`.
 */
export function deterministicDedupKey(sourceIds: string[]): string {
  return createHash("sha256")
    .update([...sourceIds].sort().join(","))
    .digest("hex");
}

/** Lowercase character bigrams of a string (for {@link contentSimilarity}). */
function bigrams(value: string): Map<string, number> {
  const normalized = value.toLowerCase();
  const counts = new Map<string, number>();
  for (let i = 0; i < normalized.length - 1; i++) {
    const gram = normalized.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pure Sørensen–Dice bigram similarity in [0,1] — a SECONDARY dedup signal
 * (CONS-04) catching a DIFFERENT source set that expresses the SAME fact.
 * Implemented INLINE (NOT the memory package's `nameSimilarity`, which the agent
 * cannot import — the agent↛memory cut). Symmetric; identical strings → 1,
 * disjoint → 0.
 */
export function contentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  let aTotal = 0;
  for (const n of aGrams.values()) aTotal += n;
  let bTotal = 0;
  for (const n of bGrams.values()) bTotal += n;
  if (aTotal === 0 || bTotal === 0) return 0;
  let overlap = 0;
  for (const [gram, an] of aGrams) {
    const bn = bGrams.get(gram);
    if (bn !== undefined) overlap += Math.min(an, bn);
  }
  return (2 * overlap) / (aTotal + bTotal);
}
