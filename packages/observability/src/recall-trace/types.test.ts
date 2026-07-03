// SPDX-License-Identifier: Apache-2.0
/**
 * RecallTraceEventSchema tests — schema-versioned closed-union envelope.
 *
 * The recall trace is ONE rich per-recall record (Assumption A1 — NOT a
 * per-stage stage enum like cache-trace). The schema parses a well-formed
 * record, fences the `traceSchema` literal + `schemaVersion` literal, and
 * closes the rerank-outcome + include/exclude-reason unions.
 *
 * @module
 */
import { describe, it, expect, expectTypeOf } from "vitest";

import {
  RecallTraceEventSchema,
  RECALL_RERANK_OUTCOMES,
  RECALL_INCLUDE_REASONS,
  type RecallTraceEvent,
} from "./types.js";

function makeValidRecord(): Record<string, unknown> {
  return {
    traceSchema: "comis-recall-trace",
    schemaVersion: 1,
    ts: "2026-05-30T00:00:00.000Z",
    seq: 0,
    agentId: "agent-1",
    sessionId: "sid-1",
    traceId: "sid-1",
    queryDigest: "a".repeat(64),
    lanes: { fts: 5, vector: 3, entity: 2, temporal: 1 },
    vectorLaneActive: true,
    fusedOrder: ["m-1", "m-2", "m-3"],
    rerank: {
      outcome: "ran",
      candidateCount: 3,
      preScores: [0.9, 0.5, 0.1],
      postScores: [0.95, 0.4, 0.05],
    },
    ranked: [
      {
        id: "m-1",
        reason: "included",
        breakdown: {
          base: 1,
          recency: 1.1,
          temporal: 1.0,
          proof: 1.2,
          trust: 1.0,
          usefulness: 1.0,
          final: 1.32,
        },
        preview: "a short safe preview",
      },
      { id: "m-2", reason: "trust_filtered" },
      { id: "m-3", reason: "deduped" },
    ],
    durationMs: 12,
  };
}

describe("RecallTraceEventSchema -- well-formed record", () => {
  it("parses a well-formed recall record with the full envelope + recall fields", () => {
    const parsed = RecallTraceEventSchema.safeParse(makeValidRecord());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.traceSchema).toBe("comis-recall-trace");
      expect(parsed.data.schemaVersion).toBe(1);
      expect(parsed.data.lanes.vector).toBe(3);
      // The lanes cluster carries the temporal candidate count (append-only).
      expect(parsed.data.lanes.temporal).toBe(1);
      expect(parsed.data.rerank.outcome).toBe("ran");
      expect(parsed.data.ranked[0]!.reason).toBe("included");
    }
  });

  it("requires the temporal lane count on the lanes cluster (the 4th lane)", () => {
    // The lanes cluster gained `temporal` (append-only). A record carrying it parses; one
    // MISSING `temporal` must FAIL — proving the schema was extended (before the temporal
    // lane the field was absent and a record omitting it would have passed).
    const withTemporal = makeValidRecord();
    expect(RecallTraceEventSchema.safeParse(withTemporal).success).toBe(true);

    const missingTemporal = makeValidRecord();
    const lanes = missingTemporal.lanes as Record<string, unknown>;
    delete lanes.temporal;
    expect(RecallTraceEventSchema.safeParse(missingTemporal).success).toBe(false);
  });

  it("parses an optional envelope cluster (sessionKey, tenantId, runId)", () => {
    const record = {
      ...makeValidRecord(),
      sessionKey: "sk-1",
      tenantId: "tenant-1",
      runId: "run-1",
    };
    const parsed = RecallTraceEventSchema.safeParse(record);
    expect(parsed.success).toBe(true);
  });

  it("requires the usefulness factor on the score breakdown (the 5th factor)", () => {
    // The breakdown is the FIVE multiplicative factors now. A breakdown carrying
    // `usefulness: number` parses; one MISSING `usefulness` must FAIL — proving the
    // schema was extended (before the usefulness factor the field was absent and this would pass).
    const withUsefulness = makeValidRecord();
    expect(RecallTraceEventSchema.safeParse(withUsefulness).success).toBe(true);
    expect(
      (
        (withUsefulness.ranked as Array<Record<string, unknown>>)[0]!.breakdown as Record<
          string,
          unknown
        >
      ).usefulness,
    ).toBe(1.0);

    const missingUsefulness = makeValidRecord();
    const b = (missingUsefulness.ranked as Array<Record<string, unknown>>)[0]!
      .breakdown as Record<string, unknown>;
    delete b.usefulness;
    expect(RecallTraceEventSchema.safeParse(missingUsefulness).success).toBe(false);
  });

  it("carries the usefulnessOutcomeShare annotation through the round-trip (and tolerates its absence)", () => {
    // The outcome-attributed usefulness contribution surfaced on score.ts's breakdown must
    // SURVIVE the persistence parse so `comis explain` can read it — a z.object would otherwise
    // strip it. It is OPTIONAL: an older trace line without it still parses (back-compat), and a
    // line carrying it preserves the value (forget likewise optional).
    const withShare = makeValidRecord();
    const b = (withShare.ranked as Array<Record<string, unknown>>)[0]!.breakdown as Record<
      string,
      unknown
    >;
    b.usefulnessOutcomeShare = 0.05; // a proven-useful memory's positive outcome contribution
    b.forget = 1.0;
    const parsed = RecallTraceEventSchema.safeParse(withShare);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ranked[0]!.breakdown?.usefulnessOutcomeShare).toBe(0.05); // not stripped
      expect(parsed.data.ranked[0]!.breakdown?.forget).toBe(1.0);
    }
    // Absent → still valid (the annotation is optional; older lines predate it).
    const withoutShare = makeValidRecord();
    expect(RecallTraceEventSchema.safeParse(withoutShare).success).toBe(true);
  });
});

describe("RecallTraceEventSchema -- parser fences", () => {
  it("rejects a foreign traceSchema literal (comis-cache-trace)", () => {
    const record = { ...makeValidRecord(), traceSchema: "comis-cache-trace" };
    const parsed = RecallTraceEventSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });

  it("rejects a wrong schemaVersion (2) — version fence", () => {
    const record = { ...makeValidRecord(), schemaVersion: 2 };
    const parsed = RecallTraceEventSchema.safeParse(record);
    expect(parsed.success).toBe(false);
  });
});

describe("RecallTraceEventSchema -- closed unions", () => {
  it("rerank.outcome is a CLOSED union: ran | fell_back | timed_out parse, unknown rejects", () => {
    for (const outcome of RECALL_RERANK_OUTCOMES) {
      const record = makeValidRecord();
      (record.rerank as Record<string, unknown>).outcome = outcome;
      expect(RecallTraceEventSchema.safeParse(record).success).toBe(true);
    }
    const bad = makeValidRecord();
    (bad.rerank as Record<string, unknown>).outcome = "exploded";
    expect(RecallTraceEventSchema.safeParse(bad).success).toBe(false);
  });

  it("ranked[].reason is a CLOSED union: included | trust_filtered | deduped | below_budget parse, unknown rejects", () => {
    for (const reason of RECALL_INCLUDE_REASONS) {
      const record = makeValidRecord();
      (record.ranked as Array<Record<string, unknown>>)[0]!.reason = reason;
      expect(RecallTraceEventSchema.safeParse(record).success).toBe(true);
    }
    const bad = makeValidRecord();
    (bad.ranked as Array<Record<string, unknown>>)[0]!.reason = "made_up";
    expect(RecallTraceEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe("RecallTraceEvent -- z.infer type-level invariant", () => {
  it("RecallTraceEvent is assignment-compatible with a literal record (mirror cache-trace)", () => {
    const ev: RecallTraceEvent = {
      traceSchema: "comis-recall-trace",
      schemaVersion: 1,
      ts: "2026-05-30T00:00:00.000Z",
      seq: 1,
      agentId: "a",
      sessionId: "s",
      traceId: "s",
      queryDigest: "d",
      lanes: { fts: 1, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: false,
      fusedOrder: ["m-1"],
      rerank: { outcome: "fell_back", candidateCount: 1 },
      ranked: [{ id: "m-1", reason: "included" }],
      durationMs: 1,
    };
    expect(ev.traceSchema).toBe("comis-recall-trace");
    expectTypeOf(ev).toHaveProperty("queryDigest");
    expectTypeOf(ev.rerank.outcome).toEqualTypeOf<
      "ran" | "fell_back" | "timed_out"
    >();
  });
});
