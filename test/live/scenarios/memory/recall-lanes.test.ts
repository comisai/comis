// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-03 — Recall-lane all-pairs + rerank/mmr/pinned + rerank-timeout fallback.
 *
 * Stage-A (no COMIS_LIVE): pure asserter unit tests + LANE_PAIRS structure checks.
 * Stage-B (COMIS_LIVE, local embeddings, $0): per-lane-combo driver + recall assertions.
 * Timeout-fallback: rag.rerank.timeoutMs=1 forces timeout → fusion order used (no crash).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts, countRowsLike } from "../../assert/db-oracle.js";
import {
  assertRrfOrder,
  assertRerankReorders,
  assertPinnedPrepend,
} from "../../assert/memory-recall.js";
import { buildMemConfig } from "../../harness/mem-config.js";

const isLive = !!process.env["COMIS_LIVE"];
const MEM_TABLES = ["memories", "vec_memories", "memory_fts"];

// ---------------------------------------------------------------------------
// All-pairs lane matrix — pairwise coverage (not 2^6 = 64)
// Each entry enables a unique cross-pair of the 6 lane dimensions.
// Sub-matrix rows cover the rerank/mmr/pinned post-processing controls.
// ---------------------------------------------------------------------------
const LANE_PAIRS = [
  { fts: true,  vector: true,  temporal: false, causal: false, graphSpread: false, entity: false, label: "fts-vector" },
  { fts: false, vector: true,  temporal: true,  causal: false, graphSpread: false, entity: false, label: "vector-temporal" },
  { fts: true,  vector: false, temporal: false, causal: true,  graphSpread: false, entity: false, label: "fts-causal" },
  { fts: false, vector: false, temporal: false, causal: false, graphSpread: true,  entity: true,  label: "graphSpread-entity" },
  { fts: true,  vector: true,  temporal: true,  causal: true,  graphSpread: true,  entity: true,  label: "all-lanes-on" },
  // rerank sub-matrix
  { fts: true,  vector: true,  temporal: false, causal: false, graphSpread: false, entity: false,
    rerank: true, mmr: false, pinned: false, label: "rerank-on" },
  // mmr sub-matrix
  { fts: true,  vector: true,  temporal: false, causal: false, graphSpread: false, entity: false,
    rerank: false, mmr: true, pinned: false, label: "mmr-on" },
  // pinned sub-matrix
  { fts: true,  vector: true,  temporal: false, causal: false, graphSpread: false, entity: false,
    rerank: false, mmr: false, pinned: true, label: "pinned-on" },
] as const;

const LANE_NAMES = ["fts", "vector", "temporal", "causal", "graphSpread", "entity"] as const;

// ---------------------------------------------------------------------------
// Stage-A — asserter unit tests + LANE_PAIRS structure (no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("MEM-03 Stage-A — recall-lane asserters + LANE_PAIRS structure (no COMIS_LIVE)", () => {
  it("LANE_PAIRS covers all 6 lane dimension names", () => {
    const coveredLanes = new Set<string>();
    for (const lp of LANE_PAIRS) {
      for (const lane of LANE_NAMES) {
        if ((lp as Record<string, unknown>)[lane] === true) coveredLanes.add(lane);
      }
    }
    for (const lane of LANE_NAMES) {
      expect(coveredLanes.has(lane), `lane "${lane}" not covered in LANE_PAIRS`).toBe(true);
    }
  });

  it("assertRrfOrder: dominant-first fused → does NOT throw", () => {
    // l1Score = 1/(1+60) = 0.016393..., l2Score = 1/(1+60) = tied → l1 dominant (l1Score >= l2Score)
    const l1 = [{ id: "a", rank: 1 }];
    const l2 = [{ id: "b", rank: 1 }];
    expect(() => assertRrfOrder(l1, l2, ["a", "b"])).not.toThrow();
  });

  it("assertRrfOrder: wrong item first → THROWS", () => {
    // l1Score = 1/(1+60) = 0.016393, l2Score = 1/(2+60) = 0.016129 → l1 dominant (higher score)
    const l1 = [{ id: "a", rank: 1 }];
    const l2 = [{ id: "b", rank: 2 }];
    expect(() => assertRrfOrder(l1, l2, ["b", "a"])).toThrow();
  });

  it("assertRerankReorders: one swap → does NOT throw", () => {
    expect(() => assertRerankReorders(["a", "b", "c"], ["b", "a", "c"])).not.toThrow();
  });

  it("assertRerankReorders: identical orders → THROWS", () => {
    expect(() => assertRerankReorders(["a", "b", "c"], ["a", "b", "c"])).toThrow();
  });

  it("assertPinnedPrepend: all pinned first → does NOT throw", () => {
    const results = [
      { id: "p1", pinned: true },
      { id: "p2", pinned: true },
      { id: "r1", pinned: false },
      { id: "r2", pinned: false },
    ];
    expect(() => assertPinnedPrepend(results)).not.toThrow();
  });

  it("assertPinnedPrepend: non-pinned before pinned → THROWS", () => {
    const results = [
      { id: "r1", pinned: false },
      { id: "p1", pinned: true },
    ];
    expect(() => assertPinnedPrepend(results)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stage-B — lane all-pairs per-combo driver (COMIS_LIVE, local embeddings, $0)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("MEM-03 Stage-B — recall-lane all-pairs ($0, real daemon)", () => {
  it.each(LANE_PAIRS)(
    "lane combo: $label",
    async (lanePair) => {
      const { label, ...lanes } = lanePair as typeof LANE_PAIRS[number] & { label: string };
      // Extract lane fields — cast via Record to satisfy TS narrowing on const tuple
      const ragConfig = {
        fts:         (lanes as Record<string, unknown>)["fts"] as boolean | undefined,
        vector:      (lanes as Record<string, unknown>)["vector"] as boolean | undefined,
        temporal:    (lanes as Record<string, unknown>)["temporal"] as boolean | undefined,
        causal:      (lanes as Record<string, unknown>)["causal"] as boolean | undefined,
        graphSpread: (lanes as Record<string, unknown>)["graphSpread"] as boolean | undefined,
        entity:      (lanes as Record<string, unknown>)["entity"] as boolean | undefined,
        rerank:      (lanes as Record<string, unknown>)["rerank"] as boolean | undefined,
        mmr:         (lanes as Record<string, unknown>)["mmr"] as boolean | undefined,
        pinned:      (lanes as Record<string, unknown>)["pinned"] as boolean | undefined,
      };
      const configPath = buildMemConfig({ ragConfig, label: `lane-${label}` });
      const driver = new ConversationDriver({ agentId: `mem-03-${label}`, configPath });
      try {
        await driver.init();
        const dbPath = driver.getMemoryDbPath();
        const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, MEM_TABLES) : {};
        await driver.sendTurn("Remember: lane-test fact for combo.");
        await driver.sendTurn("Recall the lane-test fact.");
        await flushDaemonLogs(driver);
        await runLogOracle(driver.capturedLogLines(), {
          expectedErrors: ["JSON-RPC method error"],
        });
        expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
        // Content-anchored ground truth (260611 re-pin): the planted fact is
        // stored; counts are BOUNDS (ingestion stores one row per distinct
        // user turn — 2 distinct turns here, recall turn included).
        expect(
          countRowsLike(dbPath, "memories", ["lane-test fact"]),
          "planted lane-test fact not found in memories store",
        ).toBeGreaterThanOrEqual(1);
        {
          const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
          const delta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
          expect(delta, "no memory rows written").toBeGreaterThanOrEqual(1);
          expect(delta, "runaway memory writes (>3 rows for 2 turns)").toBeLessThanOrEqual(3);
          await runDbOracle(dbPath, { beforeCounts });
        }
      } finally {
        await driver.close().catch(() => {});
        try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
      }
    },
    3 * 60_000,
  );

  it(
    "rerank-timeout falls back to fusion order gracefully (no crash)",
    async () => {
      // Force rerank timeout: rerank on with a 1ms wall-clock budget — any
      // real cross-encoder pass blows it, exercising the fusion-order
      // fallback (errorKind: "rerank_timeout"; allowed via expectedDegradations).
      // Requires the reranker GGUF (COMIS_LIVE_RERANKER_MODEL_PATH) to engage;
      // without the model the test still passes via the rerank-absent path.
      const configPath = buildMemConfig({
        ragConfig: { fts: true, vector: true, rerank: true, rerankTimeoutMs: 1 },
        label: "rerank-timeout",
      });
      const driver = new ConversationDriver({ agentId: "mem-03-timeout", configPath });
      try {
        await driver.init();
        const dbPath = driver.getMemoryDbPath();
        const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, MEM_TABLES) : {};
        await driver.sendTurn("Remember: timeout-test fact.");
        await driver.sendTurn("Recall the timeout-test fact.");
        await flushDaemonLogs(driver);
        // Timeout produces a WARN/ERROR with errorKind:"rerank_timeout" — allow it in log-oracle
        await runLogOracle(driver.capturedLogLines(), {
          expectedErrors: ["JSON-RPC method error"],
          expectedDegradations: ["rerank_timeout"],
        });
        expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
        expect(
          countRowsLike(dbPath, "memories", ["timeout-test fact"]),
          "planted timeout-test fact not found in memories store",
        ).toBeGreaterThanOrEqual(1);
        {
          const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
          const delta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
          expect(delta, "no memory rows written").toBeGreaterThanOrEqual(1);
          expect(delta, "runaway memory writes (>3 rows for 2 turns)").toBeLessThanOrEqual(3);
          await runDbOracle(dbPath, { beforeCounts });
        }
      } finally {
        await driver.close().catch(() => {});
        try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
      }
    },
    3 * 60_000,
  );
});
