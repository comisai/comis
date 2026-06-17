// SPDX-License-Identifier: Apache-2.0
//
// Pure-helper suite for the consolidation clustering math
// + the surprisal novelty gate.
//
// These helpers are deterministic, IO-free, and contain the SECURITY-critical
// trust ceiling (`minTrust` — the privilege-escalation guard) plus the
// anti-trust-laundering partition (`groupByTrustAndTagScope`), the
// greedy single-link clusterer, the order-independent dedup key
// (`deterministicDedupKey`), and the surprisal score + top-fraction
// selector (`surprisal`/`surprisalSelect`). No LLM, no clock, no SQL —
// pure RED→GREEN.
import { describe, it, expect } from "vitest";
import type { MemoryEntry, TrustLevel } from "@comis/core";
import type { ConsolidationCandidate } from "@comis/core";
import {
  minTrust,
  minTrustLevel,
  cosine,
  clusterByEntityThenEmbedding,
  groupByTrustAndTagScope,
  deterministicDedupKey,
  contentSimilarity,
  countDistinctContexts,
  surprisal,
  surprisalSelect,
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

describe("minTrust — the privilege-escalation guard", () => {
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

describe("minTrustLevel — the 2-arg fold trust CEILING (the escalation guard on the fold path)", () => {
  it("returns the LESS-trusted of the two — a fold can only LOWER trust", () => {
    expect(minTrustLevel("system", "learned")).toBe("learned");
    expect(minTrustLevel("system", "external")).toBe("external");
    expect(minTrustLevel("learned", "external")).toBe("external");
  });

  it("is symmetric — argument order does not change the ceiling", () => {
    expect(minTrustLevel("learned", "system")).toBe("learned");
    expect(minTrustLevel("external", "system")).toBe("external");
    expect(minTrustLevel("external", "learned")).toBe("external");
  });

  it("returns the level itself when both inputs are equal", () => {
    expect(minTrustLevel("system", "system")).toBe("system");
    expect(minTrustLevel("learned", "learned")).toBe("learned");
    expect(minTrustLevel("external", "external")).toBe("external");
  });

  it("anti-laundering: NO argument order ever raises trust above the more-trusted input (all 9 pairs)", () => {
    const rank: Record<TrustLevel, number> = { system: 0, learned: 1, external: 2 };
    const levels: TrustLevel[] = ["system", "learned", "external"];
    for (const a of levels) {
      for (const b of levels) {
        const out = minTrustLevel(a, b);
        // The result is one of the two inputs.
        expect([a, b]).toContain(out);
        // And it is never MORE trusted (lower rank) than the LESS-trusted input —
        // i.e. it equals the less-trusted (higher-rank) of the pair.
        const lessTrusted = rank[a] >= rank[b] ? a : b;
        expect(out).toBe(lessTrusted);
        // Defensively: it never outranks (is never more trusted than) either input.
        expect(rank[out]).toBeGreaterThanOrEqual(Math.min(rank[a], rank[b]));
      }
    }
  });
});

describe("groupByTrustAndTagScope — anti-trust-laundering partition", () => {
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

describe("clusterByEntityThenEmbedding — greedy deterministic single-link", () => {
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

describe("deterministicDedupKey — order-independent source-id hash", () => {
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

  it("returns a symmetric score regardless of argument order", () => {
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

// ---------------------------------------------------------------------------
// Surprisal novelty gate
//
// `surprisal(distances, dim)` = dim · log(mean kNN cosine distance), guarding the
// empty + mean<=0 cases to 0 (NEVER -Infinity/NaN — a poisoned sort key). The
// score is RELATIVE: a higher value = more novel-vs-corpus; the absolute value
// (often negative for small mean distances) is immaterial.
//
// `surprisalSelect(candidates, knnByCandidate, dim, topFraction)` scores each
// candidate, DROPS those with no embedding (the documented missing-embedding
// policy, Pitfall 3 — they cannot be reasoned over until indexed), sorts by the
// TOTAL order (surprisal desc, id asc), and keeps ceil(eligible · topFraction) —
// a reproducible, bounded gate (the benchmark + the reasoning output flake if it
// is not deterministic).
// ---------------------------------------------------------------------------

describe("surprisal — the per-candidate novelty score", () => {
  it("returns 0 for an empty distance set (no neighbour → not surprising-vs-corpus)", () => {
    expect(surprisal([], 768)).toBe(0);
  });

  it("computes dim · log(mean distance) for a non-trivial neighbourhood", () => {
    // mean([0.5, 0.5]) = 0.5 → 768 · ln(0.5). A negative result is fine: higher = more novel.
    expect(surprisal([0.5, 0.5], 768)).toBe(768 * Math.log(0.5));
  });

  it("guards a mean<=0 to 0 so a zero-distance neighbour never yields -Infinity/NaN", () => {
    expect(surprisal([0], 768)).toBe(0);
    expect(Number.isFinite(surprisal([0, 0], 768))).toBe(true);
    expect(surprisal([0, 0], 768)).toBe(0);
  });

  it("guards a negative mean (corrupt distances) to 0 — never NaN from log of a negative", () => {
    const s = surprisal([-1, -1], 768);
    expect(Number.isNaN(s)).toBe(false);
    expect(s).toBe(0);
  });

  it("scores a larger mean distance ABOVE a smaller one (more novel = more surprising)", () => {
    // ln is monotincreasing → for dim>0, a larger mean distance scores strictly higher.
    expect(surprisal([0.9, 0.9], 768)).toBeGreaterThan(surprisal([0.1, 0.1], 768));
  });
});

describe("surprisalSelect — the deterministic top-fraction novelty gate", () => {
  /** A candidate id → its (constant) per-element kNN distances, for a known surprisal order. */
  function candAt(id: string, embedding?: number[]): ConsolidationCandidate {
    return makeCand({ id }, embedding);
  }

  it("keeps the top fraction sorted (surprisal desc, id asc) and drops the low-surprisal tail", () => {
    const ids = [
      "00000000-0000-4000-8000-00000000000a", // distance 0.2 → lowest surprisal
      "00000000-0000-4000-8000-00000000000b", // distance 0.9 → highest surprisal
      "00000000-0000-4000-8000-00000000000c", // distance 0.5 → middle
      "00000000-0000-4000-8000-00000000000d", // distance 0.1 → lowest
    ];
    const candidates = ids.map((id) => candAt(id, [1, 0, 0]));
    const knnByCandidate = new Map<string, number[]>([
      [ids[0], [0.2]],
      [ids[1], [0.9]],
      [ids[2], [0.5]],
      [ids[3], [0.1]],
    ]);
    // 4 eligible, topFraction 0.5 → ceil(4·0.5) = 2 kept: the two highest-surprisal (0.9, 0.5).
    const selected = surprisalSelect(candidates, knnByCandidate, 768, 0.5);
    expect(selected.map((c) => c.entry.id)).toEqual([ids[1], ids[2]]);
  });

  it("breaks a surprisal tie by id ascending (a TOTAL, reproducible order)", () => {
    // Two candidates with the SAME distance (→ same surprisal) must order by id asc.
    const idHi = "00000000-0000-4000-8000-0000000000ff";
    const idLo = "00000000-0000-4000-8000-00000000000f";
    const candidates = [candAt(idHi, [1, 0, 0]), candAt(idLo, [1, 0, 0])];
    const knnByCandidate = new Map<string, number[]>([
      [idHi, [0.7]],
      [idLo, [0.7]],
    ]);
    // topFraction 1 → keep both; the tie breaks by id asc so idLo precedes idHi.
    const selected = surprisalSelect(candidates, knnByCandidate, 768, 1);
    expect(selected.map((c) => c.entry.id)).toEqual([idLo, idHi]);
  });

  it("is reproducible — two calls on the same input return the identical selected set and order", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000033",
    ];
    const candidates = ids.map((id) => candAt(id, [1, 0, 0]));
    const knnByCandidate = new Map<string, number[]>([
      [ids[0], [0.3]],
      [ids[1], [0.8]],
      [ids[2], [0.6]],
    ]);
    const first = surprisalSelect(candidates, knnByCandidate, 768, 0.67).map((c) => c.entry.id);
    const second = surprisalSelect(candidates, knnByCandidate, 768, 0.67).map((c) => c.entry.id);
    expect(first).toEqual(second);
  });

  it("drops every candidate that has no embedding — an all-missing input yields an empty selection", () => {
    // The documented missing-embedding policy (Pitfall 3): a candidate that has not
    // been indexed cannot be reasoned over, so it is excluded BEFORE scoring.
    const candidates = [
      candAt("00000000-0000-4000-8000-000000000001"), // no embedding
      candAt("00000000-0000-4000-8000-000000000002"), // no embedding
    ];
    const knnByCandidate = new Map<string, number[]>(); // no distances either
    const selected = surprisalSelect(candidates, knnByCandidate, 768, 1);
    expect(selected).toEqual([]);
  });

  it("selects only the embedded candidates, ignoring un-embedded ones in the fraction math", () => {
    const embedded = "00000000-0000-4000-8000-0000000000e1";
    const bare = "00000000-0000-4000-8000-0000000000b1";
    const candidates = [candAt(embedded, [1, 0, 0]), candAt(bare)];
    const knnByCandidate = new Map<string, number[]>([[embedded, [0.5]]]);
    // Only 1 eligible (the embedded one) → ceil(1·1)=1 kept; the bare candidate is never selected.
    const selected = surprisalSelect(candidates, knnByCandidate, 768, 1);
    expect(selected.map((c) => c.entry.id)).toEqual([embedded]);
  });

  it("keeps at least one candidate when topFraction is tiny but eligible candidates exist (ceil, not floor)", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
    ];
    const candidates = ids.map((id) => candAt(id, [1, 0, 0]));
    const knnByCandidate = new Map<string, number[]>([
      [ids[0], [0.9]],
      [ids[1], [0.1]],
    ]);
    // ceil(2 · 0.01) = 1 → the single most-surprising candidate (distance 0.9) is kept.
    const selected = surprisalSelect(candidates, knnByCandidate, 768, 0.01);
    expect(selected.map((c) => c.entry.id)).toEqual([ids[0]]);
  });

  it("returns an empty selection when there are no candidates at all", () => {
    expect(surprisalSelect([], new Map(), 768, 0.5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countDistinctContexts — the GENERAL-02 anti-domination diversity counter.
//
// Counts the number of distinct (sessionKey, sender) CONTEXTS a cluster spans,
// NOT its raw member count. This is the discipline that stops one repeated
// session from forging a "general" preference (the WS6 below-threshold guard):
// three near-duplicate memories all minted in ONE conversation are ONE context,
// not three, so they never clear a diversity threshold of 3.
//
// The context key derives from entry.source.sessionKey (the most
// session-discriminating field on MemorySource), falling back to source.channel
// when no sessionKey is present, combined with the userId as the sender. Pure,
// deterministic, no RNG — two runs over the same cluster return the same count.
// ---------------------------------------------------------------------------
describe("countDistinctContexts — the anti-domination diversity counter (GENERAL-02)", () => {
  /** A member in a specific (sessionKey, sender) context. */
  function memberIn(sessionKey: string, sender: string, id: string): MemoryEntry {
    return makeEntry({
      id,
      userId: sender,
      source: { who: sender, channel: "telegram", sessionKey },
    });
  }

  it("counts THREE distinct contexts for three members each from a different session", () => {
    const cluster = [
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000201"),
      memberIn("session-b", "user_a", "00000000-0000-4000-8000-000000000202"),
      memberIn("session-c", "user_a", "00000000-0000-4000-8000-000000000203"),
    ];
    expect(countDistinctContexts(cluster)).toBe(3);
  });

  it("counts ONE context for three members all minted in the SAME session (anti-domination)", () => {
    const cluster = [
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000211"),
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000212"),
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000213"),
    ];
    expect(countDistinctContexts(cluster)).toBe(1);
  });

  it("treats a different SENDER in the same session as a distinct context", () => {
    const cluster = [
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000221"),
      memberIn("session-a", "user_b", "00000000-0000-4000-8000-000000000222"),
    ];
    expect(countDistinctContexts(cluster)).toBe(2);
  });

  it("falls back to source.channel when a member carries no sessionKey", () => {
    const cluster = [
      makeEntry({
        id: "00000000-0000-4000-8000-000000000231",
        userId: "user_a",
        source: { who: "user_a", channel: "discord" },
      }),
      makeEntry({
        id: "00000000-0000-4000-8000-000000000232",
        userId: "user_a",
        source: { who: "user_a", channel: "telegram" },
      }),
    ];
    // Distinct channels (discord vs telegram) → two distinct fallback contexts.
    expect(countDistinctContexts(cluster)).toBe(2);
  });

  it("is deterministic — repeated calls on the same cluster return the same count", () => {
    const cluster = [
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000241"),
      memberIn("session-b", "user_a", "00000000-0000-4000-8000-000000000242"),
      memberIn("session-a", "user_a", "00000000-0000-4000-8000-000000000243"),
    ];
    const first = countDistinctContexts(cluster);
    const second = countDistinctContexts(cluster);
    expect(first).toBe(second);
    expect(first).toBe(2); // session-a (×2 → one context) + session-b
  });
});
