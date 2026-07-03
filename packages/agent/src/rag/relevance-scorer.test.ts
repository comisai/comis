// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for relevance-scorer.ts — the pure shared RelevanceScorer.
 *
 * The scorer is the SINGLE ranking primitive BOTH the recall path (memory-recall.ts)
 * and the assembly path (the margin arbiter) call. It is PURE: imports only
 * @comis/core types + in-package fuse/score (the agent↛memory architecture cut), no I/O,
 * no clock, input not mutated. The tests pin:
 *
 *  1. BM25 floor (no embeddings): a SINGLE FTS lane → order + score preserved (fuse() identity).
 *  2. RRF lift: two lanes (FTS + vector) → reordered by k=60 fused rank, never raw score.
 *  3. Low-signal fallback (deterministic): stopword-only query → degraded; recency-first
 *     (input order unchanged); same input → same output.
 *  4. Content-free degrade log: the `relevance_query_degraded` log carries a term COUNT +
 *     boolean ONLY — never the query text / any input turn string.
 *  5. GoalAnchor bias: the GoalAnchor text contributes terms to the relevance query.
 *  6. Purity: scoreRelevance does not mutate the input lanes array.
 *
 * @module
 */

import type { MemorySearchResult, ComisLogger } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import { buildRelevanceQuery, scoreRelevance } from "./relevance-scorer.js";
import type { FusionLane } from "./fuse.js";

/** A neutral content-free logger; individual tests swap in a spy where they assert. */
const noopLogger: ComisLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

/** Build a minimal MemorySearchResult (only the fields the scorer touches: entry.id, score). */
function makeResult(id: string, score: number): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      content: `content for ${id}`,
      trustLevel: "learned",
      source: { who: "agent" },
      tags: [],
      createdAt: 0,
    } as unknown as MemorySearchResult["entry"],
    score,
  };
}

describe("buildRelevanceQuery — rolling ~3-user-turn window + GoalAnchor bias", () => {
  it("tokenizes + stopwords the last user turns into content terms (not degraded)", () => {
    const q = buildRelevanceQuery(["where is the kubernetes deployment config stored"]);
    expect(q.degraded).toBe(false);
    // content terms survive; common stopwords (is, the) are removed.
    expect(q.terms).toContain("kubernetes");
    expect(q.terms).toContain("deployment");
    expect(q.terms).not.toContain("is");
    expect(q.terms).not.toContain("the");
  });

  it("uses only the NEWEST ~3 user turns (an older 4th turn does not contribute terms)", () => {
    const turns = [
      "antediluvian", // oldest — must be dropped (window is ~3)
      "deploy the database",
      "restart the gateway",
      "check the scheduler heartbeat",
    ];
    const q = buildRelevanceQuery(turns);
    expect(q.terms).not.toContain("antediluvian");
    expect(q.terms).toContain("scheduler"); // newest turn present
    expect(q.terms).toContain("gateway");
    expect(q.terms).toContain("database");
  });

  it("DEGRADED: a stopword-only turn yields < 2 content terms → degraded === true", () => {
    const q = buildRelevanceQuery(["yes do that"]);
    expect(q.degraded).toBe(true);
    expect(q.terms.length).toBeLessThan(2);
  });

  it("GoalAnchor bias: the GoalAnchor text contributes terms to the relevance query", () => {
    // A low-signal turn alone would degrade; the GoalAnchor lifts it with focus terms.
    const q = buildRelevanceQuery(["yes do that"], "[GoalAnchor: migrate billing invoices to stripe]");
    expect(q.terms).toContain("billing");
    expect(q.terms).toContain("invoices");
    expect(q.terms).toContain("stripe");
    // The GoalAnchor literal scaffolding ("GoalAnchor") is itself a stopword-like token,
    // but the real focus terms make the query non-degraded.
    expect(q.degraded).toBe(false);
  });

  it("is deterministic — the same turns + anchor produce the same terms every call", () => {
    const a = buildRelevanceQuery(["restart the gateway now"], "[GoalAnchor: fix the deploy]");
    const b = buildRelevanceQuery(["restart the gateway now"], "[GoalAnchor: fix the deploy]");
    expect(a).toEqual(b);
  });
});

describe("scoreRelevance — BM25 floor, RRF lift, deterministic low-signal fallback", () => {
  it("BM25 FLOOR (no embeddings): a single FTS lane passes through fuse() identity — order + score preserved", () => {
    const fts = [makeResult("a", 0.9), makeResult("b", 0.7), makeResult("c", 0.5)];
    const lanes: FusionLane[] = [{ results: fts, weight: 1.0 }];
    const query = buildRelevanceQuery(["where is the deployment config stored"]);

    const out = scoreRelevance(lanes, query, { logger: noopLogger });

    // fuse() single-lane is the identity on BOTH order and score (the BM25-only floor).
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
    expect(out.map((r) => r.score)).toEqual([0.9, 0.7, 0.5]);
  });

  it("RRF LIFT: two lanes reorder by k=60 fused rank, never raw score", () => {
    // FTS ranks: a(1), b(2). Vector ranks: c(1), b(2), a(3). RRF (equal weight, k=60):
    //   a: 1/(60+1) + 1/(60+3) = 0.0163934 + 0.0158730 = 0.0322664
    //   b: 1/(60+2) + 1/(60+2) = 0.0161290 + 0.0161290 = 0.0322580
    //   c: 1/(60+1)            = 0.0163934
    // → fused order a > b > c. The decisive proof: c has the HIGHEST raw score (0.99)
    //   yet RRF demotes it BELOW b (which appears in both lanes) — rank fusion, not raw.
    const fts = [makeResult("a", 0.95), makeResult("b", 0.10)];
    const vector = [makeResult("c", 0.99), makeResult("b", 0.50), makeResult("a", 0.40)];
    const lanes: FusionLane[] = [
      { results: fts, weight: 1.0 },
      { results: vector, weight: 1.0 },
    ];
    const query = buildRelevanceQuery(["where is the deployment config stored"]);

    const out = scoreRelevance(lanes, query, { logger: noopLogger });
    const order = out.map((r) => r.entry.id);

    // Fused rank order (a just edges b on the k=60 math; both beat c).
    expect(order).toEqual(["a", "b", "c"]);
    // b appears in BOTH lanes → its fused rank LIFTS it above c despite c's higher raw score.
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    // It is NOT the raw-score order (raw would be c(0.99) > a(0.95) > b...): fused rank wins.
    expect(order).not.toEqual(["c", "a", "b"]);
    // Scores are RRF-normalized to (0,1], not the raw input scores.
    expect(out.every((r) => (r.score ?? 0) > 0 && (r.score ?? 0) <= 1)).toBe(true);
    expect(out.map((r) => r.score)).not.toEqual([0.95, 0.10, 0.99]);
  });

  it("LOW-SIGNAL FALLBACK: a degraded query returns recency-first (input order unchanged), deterministic", () => {
    const fts = [makeResult("a", 0.9), makeResult("b", 0.7), makeResult("c", 0.5)];
    const lanes: FusionLane[] = [{ results: fts, weight: 1.0 }];
    const degradedQuery = buildRelevanceQuery(["yes do that"]); // degraded === true

    const out1 = scoreRelevance(lanes, degradedQuery, { logger: noopLogger });
    const out2 = scoreRelevance(lanes, degradedQuery, { logger: noopLogger });

    // Recency-first signal = the caller's input order, UNCHANGED (no relevance reorder on noise).
    expect(out1.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
    // Deterministic: same input → same output.
    expect(out1).toEqual(out2);
  });

  it("CONTENT-FREE DEGRADE LOG: relevance_query_degraded carries a term COUNT + boolean only — no query text", () => {
    const fts = [makeResult("a", 0.9)];
    const lanes: FusionLane[] = [{ results: fts, weight: 1.0 }];
    const secretTurn = "supersecretpassword hunter2"; // 2 tokens but both content → NOT degraded normally
    // Force a degraded (stopword-only) query whose RAW turn still carries a sensitive marker.
    const sensitiveTurn = "is it the";
    const degradedQuery = buildRelevanceQuery([sensitiveTurn]);
    expect(degradedQuery.degraded).toBe(true);

    const debug = vi.fn();
    const logger = { ...noopLogger, debug } as unknown as ComisLogger;

    scoreRelevance(lanes, degradedQuery, { logger, agentId: "agent-x" });

    expect(debug).toHaveBeenCalledTimes(1);
    const [fields, msg] = debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toContain("relevance_query_degraded");
    // The logged object contains a count + booleans/ids only — assert NO content leaks.
    expect(fields).toMatchObject({ degraded: true });
    expect(typeof fields.contentTermCount).toBe("number");
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(sensitiveTurn);
    expect(serialized).not.toContain(secretTurn);
    expect(serialized).not.toContain("hunter2");
    // No raw token from the turn should appear in the log payload.
    expect(serialized).not.toContain("\"is\"");
    expect(serialized).not.toContain("\"the\"");
  });

  it("does NOT log relevance_query_degraded on a healthy (non-degraded) query", () => {
    const fts = [makeResult("a", 0.9)];
    const lanes: FusionLane[] = [{ results: fts, weight: 1.0 }];
    const query = buildRelevanceQuery(["where is the deployment config stored"]);

    const debug = vi.fn();
    const logger = { ...noopLogger, debug } as unknown as ComisLogger;

    scoreRelevance(lanes, query, { logger });
    // Clean query → the degrade log never fires (a silent healthy path).
    const degradeCalls = debug.mock.calls.filter(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("relevance_query_degraded"),
    );
    expect(degradeCalls).toHaveLength(0);
  });

  it("PURITY: scoreRelevance does not mutate the input lanes array (or its results)", () => {
    const fts = [makeResult("a", 0.9), makeResult("b", 0.7)];
    const vector = [makeResult("b", 0.8), makeResult("a", 0.6)];
    const lanes: FusionLane[] = [
      { results: fts, weight: 1.0 },
      { results: vector, weight: 1.0 },
    ];
    const before = structuredClone(lanes);

    scoreRelevance(lanes, buildRelevanceQuery(["where is the deployment"]), { logger: noopLogger });

    expect(lanes).toEqual(before); // input untouched — pure
  });

  it("works with NO logger injected (pure-by-default, no-op on the degraded path)", () => {
    const fts = [makeResult("a", 0.9), makeResult("b", 0.7)];
    const lanes: FusionLane[] = [{ results: fts, weight: 1.0 }];
    const degradedQuery = buildRelevanceQuery(["yes do that"]);

    // No opts at all → must not throw, returns recency-first.
    const out = scoreRelevance(lanes, degradedQuery);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b"]);
  });
});
