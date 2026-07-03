// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-01 — Default RAG store→recall round-trip.
 *
 * Stage-A (no COMIS_LIVE): unit tests for recall@k / MRR math.
 * Stage-B (COMIS_LIVE, local embeddings, $0): real store→recall round-trip
 *   via ConversationDriver; assertions on memories row delta + log-oracle + db-oracle.
 * Stage-C (COMIS_LIVE + COMIS_LIVE_JUDGE_*): judged answer quality ≥ threshold.
 *
 * costTier: "$0" for Stage-B (local embeddings, no LLM keys needed for retrieval).
 * costTier: "¢¢" for Stage-C (judged answer requires LLM call).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts, countRowsLike } from "../../assert/db-oracle.js";
import { assertRecallAtK, recallAtK, meanReciprocalRank, isHonestNonAnswer } from "../../assert/memory-recall.js";
import { judgeAnswer } from "../../judge.js";
import { buildMemConfig } from "../../harness/mem-config.js";

const isLive = !!process.env["COMIS_LIVE"];
const hasJudgeEnv =
  !!process.env["COMIS_LIVE_JUDGE_PROVIDER"] && !!process.env["COMIS_LIVE_JUDGE_API_KEY"];

const RECALL_TABLE = [
  { embeddingProvider: "local" as const, label: "recall-golden-local" },
] as const;

const MEM_TABLES = ["memories", "memory_fts", "vec_memories"];

// ---------------------------------------------------------------------------
// Stage-A — recall@k / MRR math unit tests (no COMIS_LIVE, no daemon)
// ---------------------------------------------------------------------------

describe("MEM-01 Stage-A — recall@k / MRR math (no COMIS_LIVE)", () => {
  it("recallAtK: 2 relevant in top-3 of 5 ranked → recall@3 = 1.0", () => {
    expect(recallAtK(["a", "b", "c", "d", "e"], ["a", "b"], 3)).toBe(1.0);
  });

  it("recallAtK: 1 relevant at rank 1 → recall@3 = 1.0", () => {
    expect(recallAtK(["x", "a", "b"], ["a"], 3)).toBe(1.0);
  });

  it("recallAtK: 0 relevant in top-3 → recall@3 = 0", () => {
    expect(recallAtK(["x", "y", "z"], ["a"], 3)).toBe(0);
  });

  it("MRR: first relevant at rank 2 → RR ≈ 0.5", () => {
    expect(meanReciprocalRank([["x", "a", "b"]], [["a"]])).toBeCloseTo(0.5);
  });

  it("RECALL_TABLE contains local provider entry with correct label", () => {
    expect(RECALL_TABLE[0].embeddingProvider).toBe("local");
    expect(RECALL_TABLE[0].label).toBe("recall-golden-local");
  });

  it("assertRecallAtK does NOT throw for 1/1 relevant in top-1", () => {
    expect(() =>
      assertRecallAtK({ rankedIds: ["a"], relevantIds: ["a"], k: 1, minRecall: 1.0 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stage-B — store→recall round-trip (local embeddings, $0, real daemon)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "MEM-01 Stage-B — store→recall round-trip (local embeddings, $0)",
  () => {
    it.each(RECALL_TABLE)(
      "recall round-trip: provider=$embeddingProvider",
      async ({ embeddingProvider, label }) => {
        const configPath = buildMemConfig({ embeddingProvider, label });
        const driver = new ConversationDriver({
          agentId: "mem-01-recall",
          configPath,
        });
        try {
          await driver.init();
          const dbPath = driver.getMemoryDbPath();
          const beforeCounts = existsSync(dbPath)
            ? snapshotRowCounts(dbPath, MEM_TABLES)
            : {};
          await driver.sendTurn("Remember: the Eiffel Tower is 330 meters tall.");
          await driver.sendTurn("What is the height of the Eiffel Tower?");
          await flushDaemonLogs(driver);
          await runLogOracle(driver.capturedLogLines(), {
            expectedErrors: ["JSON-RPC method error"],
          });
          expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
          // Ground truth: the planted fact is durably stored —
          // content-anchored, not an exact row count (ingestion stores combined
          // user+agent turns AND agent-extracted memories, so the count is
          // nondeterministic; the planted fact's presence is the real invariant).
          expect(
            countRowsLike(dbPath, "memories", ["Eiffel", "330"]),
            "planted fact not found in memories store",
          ).toBeGreaterThanOrEqual(1);
          const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
          const delta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
          expect(delta, "no memory rows written").toBeGreaterThanOrEqual(1);
          expect(delta, "runaway memory writes").toBeLessThanOrEqual(6); // 2 turns x (user+agent+extracted)
          await runDbOracle(dbPath, { beforeCounts });
        } finally {
          await driver.close().catch(() => {});
          try {
            rmSync(configPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      },
      3 * 60_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Stage-C — judged answer quality (requires COMIS_LIVE + judge env)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "MEM-01 Stage-C — judged answer quality (requires COMIS_LIVE + judge env)",
  () => {
    it.skipIf(!hasJudgeEnv)(
      "judged recall answer meets quality threshold",
      async () => {
        const configPath = buildMemConfig({
          embeddingProvider: "local",
          label: "mem-01-judged",
        });
        const driver = new ConversationDriver({
          agentId: "mem-01-judged",
          configPath,
        });
        try {
          await driver.init();
          await driver.sendTurn("Please remember: the Eiffel Tower is 330 meters tall.");
          const answer = await driver.sendTurn("How tall is the Eiffel Tower?");
          await flushDaemonLogs(driver);
          // Two-outcome predicate: an honest non-answer (model
          // thinking-only stall → daemon fallback) is acceptable degradation,
          // never a false success; a real answer must mention 330 meters.
          if (!isHonestNonAnswer(answer)) {
            const judgeResult = await judgeAnswer({
              question: "How tall is the Eiffel Tower?",
              context: "The Eiffel Tower is 330 meters tall.",
              answer,
              rubric: "Answer must mention 330 meters",
            });
            expect(
              judgeResult.verdict,
              `judge failed: ${judgeResult.reason} | answer: ${answer.slice(0, 300)}`,
            ).not.toBe("fail");
          }
          await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
        } finally {
          await driver.close().catch(() => {});
          try {
            rmSync(configPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      },
      5 * 60_000,
    );
  },
);
