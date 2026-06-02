// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure recall-record assembly helpers (Phase 86 / OBS-01/03/04).
 *
 * Load-bearing assertions:
 * - recallQueryDigest is a stable 64-char hex sha256, NEVER the raw query (OBS-02).
 * - buildRecallRecord assembles lanes/fusedOrder/rerank/ranked/durationMs and omits
 *   empty optional clusters (preScores/postScores/degradations).
 * - vectorLaneCouldContribute is conservative: false ONLY for an empty/whitespace query.
 */

import { describe, it, expect } from "vitest";
import {
  buildRecallRecord,
  recallQueryDigest,
  vectorLaneCouldContribute,
  type RecallObservations,
} from "./recall-record.js";
import type { ScoreBreakdown } from "./score.js";

const BREAKDOWN: ScoreBreakdown = {
  base: 0.5,
  recency: 1.1,
  temporal: 1.0,
  proof: 1.0,
  trust: 1.05,
  final: 0.5775,
};

function obs(overrides: Partial<RecallObservations> = {}): RecallObservations {
  return {
    query: "the raw query text",
    lanes: { fts: 2, vector: 2, entity: 0, temporal: 0, causal: 0 },
    vectorLaneActive: true,
    fusedOrder: ["a", "b"],
    rerankOutcome: "fell_back",
    rerankCandidateCount: 0,
    ranked: [{ id: "a", reason: "included", breakdown: BREAKDOWN }],
    degradations: [],
    durationMs: 12,
    ...overrides,
  };
}

describe("recallQueryDigest", () => {
  it("produces a stable 64-char hex sha256 that is NOT the raw query (OBS-02)", () => {
    const q = "my secret query about project apollo";
    const d = recallQueryDigest(q);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toBe(q);
    expect(d).not.toContain("apollo");
    // stable across calls.
    expect(recallQueryDigest(q)).toBe(d);
  });
});

describe("buildRecallRecord", () => {
  it("assembles the record with the query as a digest, never the raw text", () => {
    const rec = buildRecallRecord(obs({ query: "leak me" }));
    expect(rec.queryDigest).toBe(recallQueryDigest("leak me"));
    expect(JSON.stringify(rec)).not.toContain("leak me");
  });

  it("carries lanes, fusedOrder, rerank.outcome, ranked[] with breakdown, and durationMs", () => {
    const rec = buildRecallRecord(obs());
    expect(rec.lanes).toEqual({ fts: 2, vector: 2, entity: 0, temporal: 0, causal: 0 });
    expect(rec.fusedOrder).toEqual(["a", "b"]);
    expect((rec.rerank as { outcome: string }).outcome).toBe("fell_back");
    const ranked = rec.ranked as Array<{ id: string; reason: string; breakdown?: ScoreBreakdown }>;
    expect(ranked[0]?.id).toBe("a");
    expect(ranked[0]?.reason).toBe("included");
    expect(ranked[0]?.breakdown?.final).toBeCloseTo(0.5775, 10);
    expect(rec.durationMs).toBe(12);
  });

  it("omits empty optional clusters (no degradations / preScores / postScores keys)", () => {
    const rec = buildRecallRecord(obs());
    expect("degradations" in rec).toBe(false);
    const rerank = rec.rerank as Record<string, unknown>;
    expect("preScores" in rerank).toBe(false);
    expect("postScores" in rerank).toBe(false);
  });

  it("includes degradations + pre/post scores when present", () => {
    const rec = buildRecallRecord(
      obs({
        rerankOutcome: "ran",
        rerankCandidateCount: 2,
        preScores: [0.9, 0.6],
        postScores: [0.3, 0.7],
        degradations: [
          { kind: "vec_unavailable", errorKind: "dependency", hint: "vector lane unavailable; recall used FTS only" },
        ],
      }),
    );
    const rerank = rec.rerank as Record<string, unknown>;
    expect(rerank.preScores).toEqual([0.9, 0.6]);
    expect(rerank.postScores).toEqual([0.3, 0.7]);
    const degs = rec.degradations as Array<{ kind: string }>;
    expect(degs[0]?.kind).toBe("vec_unavailable");
  });

  it("drops an absent breakdown from a ranked entry (excluded memories have id+reason only)", () => {
    const rec = buildRecallRecord(
      obs({ ranked: [{ id: "x", reason: "trust_filtered" }] }),
    );
    const ranked = rec.ranked as Array<Record<string, unknown>>;
    expect(ranked[0]).toEqual({ id: "x", reason: "trust_filtered" });
    expect("breakdown" in (ranked[0] ?? {})).toBe(false);
  });
});

describe("buildRecallRecord — citation→sourceId chain (DIAL-03)", () => {
  it("carries the citation chain (ids only) when obs.citations is populated", () => {
    const rec = buildRecallRecord(
      obs({
        citations: [
          { citationId: "id-a", sourceIds: ["src-1", "src-2"] },
          { citationId: "id-b", sourceIds: [] },
        ],
      }),
    );
    expect(rec.citations).toEqual([
      { citationId: "id-a", sourceIds: ["src-1", "src-2"] },
      { citationId: "id-b", sourceIds: [] },
    ]);
  });

  it("OMITS the citations key entirely when obs.citations is absent (byte-identical default path)", () => {
    const rec = buildRecallRecord(obs());
    expect("citations" in rec).toBe(false);
  });

  it("OMITS the citations key when obs.citations is an empty array", () => {
    const rec = buildRecallRecord(obs({ citations: [] }));
    expect("citations" in rec).toBe(false);
  });

  it("the serialized record carries only ids/sourceIds in the chain — never a memory body", () => {
    // The chain is redaction-safe: citationId is the recalled entry.id, sourceIds are
    // the entry's sourceIds — no `content` ever reaches this field (DIAL-03 / OBS-02).
    const rec = buildRecallRecord(
      obs({
        query: "secret question about apollo",
        citations: [{ citationId: "id-a", sourceIds: ["src-1"] }],
      }),
    );
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("apollo");
    expect(serialized).not.toContain("content for");
    // The chain is present and shaped ids-only.
    expect(serialized).toContain("id-a");
    expect(serialized).toContain("src-1");
  });
});

describe("vectorLaneCouldContribute", () => {
  it("is true for a normal embeddable query", () => {
    expect(vectorLaneCouldContribute("what is the plan")).toBe(true);
  });

  it("is false for an empty or whitespace-only query (zero-length-embedding → FTS-only)", () => {
    expect(vectorLaneCouldContribute("")).toBe(false);
    expect(vectorLaneCouldContribute("   ")).toBe(false);
    expect(vectorLaneCouldContribute("\t\n ")).toBe(false);
  });
});
