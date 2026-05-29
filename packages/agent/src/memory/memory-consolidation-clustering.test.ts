// SPDX-License-Identifier: Apache-2.0
//
// Pure-helper suite for the consolidation clustering math (Phase 84 — CONS-01/02/04/06).
//
// These helpers are deterministic, IO-free, and contain the SECURITY-critical
// trust ceiling (`minTrust` — the privilege-escalation guard, CONS-02) plus the
// anti-trust-laundering partition (`groupByTrustAndTagScope`, CONS-06), the
// greedy single-link clusterer (CONS-01), and the order-independent dedup key
// (`deterministicDedupKey`, CONS-04). No LLM, no clock, no SQL — pure RED→GREEN.
import { describe, it, expect } from "vitest";
import type { MemoryEntry, TrustLevel } from "@comis/core";
import type { ConsolidationCandidate } from "@comis/core";
import {
  minTrust,
  cosine,
  clusterByEntityThenEmbedding,
  groupByTrustAndTagScope,
  deterministicDedupKey,
  contentSimilarity,
} from "./memory-consolidation-clustering.js";

const NOW = 1_700_000_000_000;

/** Minimal MemoryEntry factory — only the fields the clusterer reads. */
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    tenantId: "default",
    agentId: "test-agent",
    userId: "system",
    content: overrides.content ?? "a fact",
    trustLevel: overrides.trustLevel ?? "learned",
    source: { who: "system", channel: "memory-consolidation" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

function makeCand(overrides: Partial<MemoryEntry> = {}, embedding?: number[]): ConsolidationCandidate {
  return { entry: makeEntry(overrides), ...(embedding ? { embedding } : {}) };
}

describe("minTrust — the privilege-escalation guard (CONS-02)", () => {
  it("returns the LEAST-trusted member so [learned, external] yields external", () => {
    expect(minTrust([makeEntry({ trustLevel: "learned" }), makeEntry({ trustLevel: "external" })])).toBe(
      "external",
    );
  });

  it("never escalates: [system, learned] yields learned, NOT system", () => {
    expect(minTrust([makeEntry({ trustLevel: "system" }), makeEntry({ trustLevel: "learned" })])).toBe(
      "learned",
    );
  });

  it("returns system only when every member is system", () => {
    expect(minTrust([makeEntry({ trustLevel: "system" }), makeEntry({ trustLevel: "system" })])).toBe(
      "system",
    );
  });

  it("a cluster containing ANY non-system member never returns system", () => {
    const ladders: TrustLevel[][] = [
      ["system", "learned"],
      ["system", "external"],
      ["learned", "system"],
      ["external", "system", "learned"],
    ];
    for (const levels of ladders) {
      const result = minTrust(levels.map((l) => makeEntry({ trustLevel: l })));
      expect(result).not.toBe("system");
    }
  });

  it("order-independent: [external, system] equals [system, external]", () => {
    const a = minTrust([makeEntry({ trustLevel: "external" }), makeEntry({ trustLevel: "system" })]);
    const b = minTrust([makeEntry({ trustLevel: "system" }), makeEntry({ trustLevel: "external" })]);
    expect(a).toBe("external");
    expect(b).toBe("external");
  });
});

describe("groupByTrustAndTagScope — anti-trust-laundering partition (CONS-06)", () => {
  it("splits a mixed cluster into homogeneous (trust, sorted-tags) sub-clusters", () => {
    const cluster = [
      makeEntry({ id: "00000000-0000-4000-8000-00000000000a", trustLevel: "learned", tags: ["a"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000b", trustLevel: "learned", tags: ["a"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000c", trustLevel: "system", tags: ["a"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000d", trustLevel: "learned", tags: ["b"] }),
    ];
    const groups = groupByTrustAndTagScope(cluster);
    expect(groups).toHaveLength(3);
    // The (learned, ["a"]) sub-cluster has the two members.
    const learnedA = groups.find(
      (g) => g[0].trustLevel === "learned" && g[0].tags[0] === "a",
    );
    expect(learnedA).toHaveLength(2);
  });

  it("never lets a sub-cluster mix two distinct trust levels nor two tag signatures", () => {
    const cluster = [
      makeEntry({ id: "00000000-0000-4000-8000-00000000000a", trustLevel: "learned", tags: ["x", "y"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000b", trustLevel: "learned", tags: ["y", "x"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000c", trustLevel: "external", tags: ["x", "y"] }),
    ];
    const groups = groupByTrustAndTagScope(cluster);
    for (const g of groups) {
      const trustSet = new Set(g.map((e) => e.trustLevel));
      const tagSigs = new Set(g.map((e) => [...e.tags].sort().join(",")));
      expect(trustSet.size).toBe(1);
      expect(tagSigs.size).toBe(1);
    }
    // ["x","y"] and ["y","x"] are the SAME signature → those two learned entries group together.
    const learned = groups.find((g) => g[0].trustLevel === "learned");
    expect(learned).toHaveLength(2);
  });

  it("is deterministic across repeated calls (stable key order)", () => {
    const cluster = [
      makeEntry({ id: "00000000-0000-4000-8000-00000000000a", trustLevel: "system", tags: ["b"] }),
      makeEntry({ id: "00000000-0000-4000-8000-00000000000b", trustLevel: "learned", tags: ["a"] }),
    ];
    const first = groupByTrustAndTagScope(cluster).map((g) => g.map((e) => e.id));
    const second = groupByTrustAndTagScope(cluster).map((g) => g.map((e) => e.id));
    expect(first).toEqual(second);
  });
});

describe("clusterByEntityThenEmbedding — greedy deterministic single-link (CONS-01)", () => {
  it("unions cosine-near neighbours into one cluster and leaves a far one a singleton", () => {
    const cands = [
      makeCand({ id: "00000000-0000-4000-8000-000000000001" }, [1, 0, 0]),
      makeCand({ id: "00000000-0000-4000-8000-000000000002" }, [0.99, 0.01, 0]),
      makeCand({ id: "00000000-0000-4000-8000-000000000003" }, [0, 1, 0]),
    ];
    const clusters = clusterByEntityThenEmbedding(cands, {
      similarityThreshold: 0.95,
      maxClusterSize: 12,
    });
    // The two near-parallel vectors merge; the orthogonal one is its own (singleton).
    const sizes = clusters.map((c) => c.length).sort((a, b) => b - a);
    expect(sizes[0]).toBe(2);
    expect(clusters).toHaveLength(2);
  });

  it("groups by shared entity id even when embeddings are absent (vec-unavailable fallback)", () => {
    const cands = [
      makeCand({ id: "00000000-0000-4000-8000-000000000001" }),
      makeCand({ id: "00000000-0000-4000-8000-000000000002" }),
      makeCand({ id: "00000000-0000-4000-8000-000000000003" }),
    ];
    const entityIdsByMemoryId = new Map<string, Set<string>>([
      ["00000000-0000-4000-8000-000000000001", new Set(["e1"])],
      ["00000000-0000-4000-8000-000000000002", new Set(["e1"])],
      ["00000000-0000-4000-8000-000000000003", new Set(["e2"])],
    ]);
    const clusters = clusterByEntityThenEmbedding(cands, {
      similarityThreshold: 0.95,
      maxClusterSize: 12,
      entityIdsByMemoryId,
    });
    const sizes = clusters.map((c) => c.length).sort((a, b) => b - a);
    expect(sizes[0]).toBe(2); // the two e1-sharing memories
  });

  it("is deterministic — identical cluster assignment across two runs on the same input", () => {
    const cands = [
      makeCand({ id: "00000000-0000-4000-8000-000000000001" }, [1, 0, 0]),
      makeCand({ id: "00000000-0000-4000-8000-000000000002" }, [0.99, 0.01, 0]),
      makeCand({ id: "00000000-0000-4000-8000-000000000003" }, [0.98, 0.02, 0]),
      makeCand({ id: "00000000-0000-4000-8000-000000000004" }, [0, 0, 1]),
    ];
    const opts = { similarityThreshold: 0.9, maxClusterSize: 12 };
    const first = clusterByEntityThenEmbedding(cands, opts).map((c) => c.map((e) => e.id));
    const second = clusterByEntityThenEmbedding(cands, opts).map((c) => c.map((e) => e.id));
    expect(first).toEqual(second);
  });

  it("honours maxClusterSize — a too-large neighbourhood is capped", () => {
    const cands = Array.from({ length: 6 }, (_, i) =>
      makeCand({ id: `00000000-0000-4000-8000-00000000000${i}` }, [1, 0.0001 * i, 0]),
    );
    const clusters = clusterByEntityThenEmbedding(cands, {
      similarityThreshold: 0.9,
      maxClusterSize: 3,
    });
    for (const c of clusters) {
      expect(c.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("deterministicDedupKey — order-independent source-id hash (CONS-04)", () => {
  it("is identical for the same source set regardless of order", () => {
    const a = deterministicDedupKey(["s3", "s1", "s2"]);
    const b = deterministicDedupKey(["s1", "s2", "s3"]);
    expect(a).toBe(b);
  });

  it("differs for a different source set", () => {
    const a = deterministicDedupKey(["s1", "s2", "s3"]);
    const b = deterministicDedupKey(["s1", "s2", "s4"]);
    expect(a).not.toBe(b);
  });

  it("produces a stable sha256 hex digest (64 chars)", () => {
    const key = deterministicDedupKey(["s1", "s2"]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("contentSimilarity — pure Dice-bigram secondary dedup signal", () => {
  it("scores identical strings at 1 and disjoint strings near 0", () => {
    expect(contentSimilarity("the cat sat", "the cat sat")).toBeCloseTo(1, 5);
    expect(contentSimilarity("abcdef", "uvwxyz")).toBeLessThan(0.1);
  });

  it("is symmetric", () => {
    const ab = contentSimilarity("hello world", "world hello");
    const ba = contentSimilarity("world hello", "hello world");
    expect(ab).toBeCloseTo(ba, 10);
  });
});

describe("cosine — pure vector proximity", () => {
  it("returns 1 for parallel, 0 for orthogonal, and 0 for a zero vector", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
