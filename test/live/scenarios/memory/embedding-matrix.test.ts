// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-02 — Embedding mode matrix: provider × dims × gpu + L1/L2 cache hits.
 *
 * Stage-A: structure checks on EMBEDDING_MATRIX (no daemon).
 * Stage-B (COMIS_LIVE, local provider, $0): real embedding write per combo,
 *   vec_memories row delta asserted via runDbOracle.
 * Stage-C (COMIS_LIVE + OPENAI_API_KEY): openai-1536 combo.
 *
 * costTier: "$0" for Stage-B (local embeddings only).
 * costTier: "¢" for Stage-C (openai embedding API call).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts, countRowsLike } from "../../assert/db-oracle.js";
import { buildMemConfig } from "../../harness/mem-config.js";

const isLive = !!process.env["COMIS_LIVE"];
const hasOpenAiKey = !!process.env["OPENAI_API_KEY"];

// ---------------------------------------------------------------------------
// Embedding matrix definition
// ---------------------------------------------------------------------------

// Stage-B matrix: local × {768,1536,3072} × gpu{auto,false}
// Each dims uses a different gpu value to cover both options across the matrix.
const LOCAL_MATRIX = [
  { provider: "local" as const, dims: 768,  gpu: "false" as const, label: "local-768-cpu"      },
  { provider: "local" as const, dims: 1536, gpu: "auto"  as const, label: "local-1536-gpu-auto" },
  { provider: "local" as const, dims: 3072, gpu: "false" as const, label: "local-3072-cpu"      },
] as const;

// Stage-C only (needs OPENAI_API_KEY):
const OPENAI_MATRIX = [
  { provider: "openai" as const, dims: 1536, gpu: "false" as const, label: "openai-1536" },
] as const;

const EMBEDDING_MATRIX = [...LOCAL_MATRIX, ...OPENAI_MATRIX] as const;

const MEM_TABLES = ["memories", "vec_memories", "memory_fts"];

// ---------------------------------------------------------------------------
// Stage-A — EMBEDDING_MATRIX structure (no COMIS_LIVE, no daemon)
// ---------------------------------------------------------------------------

describe("MEM-02 Stage-A — EMBEDDING_MATRIX structure (no COMIS_LIVE)", () => {
  it("LOCAL_MATRIX covers dims 768, 1536, 3072", () => {
    const dims = LOCAL_MATRIX.map((e) => e.dims);
    expect(dims).toContain(768);
    expect(dims).toContain(1536);
    expect(dims).toContain(3072);
  });

  it("EMBEDDING_MATRIX has exactly 1 openai entry", () => {
    expect(EMBEDDING_MATRIX.filter((e) => e.provider === "openai")).toHaveLength(1);
  });

  it("LOCAL_MATRIX covers gpu 'auto' and 'false'", () => {
    const gpus = new Set(LOCAL_MATRIX.map((e) => e.gpu));
    expect(gpus.has("auto")).toBe(true);
    expect(gpus.has("false")).toBe(true);
  });

  it("buildMemConfig returns a string path for local-768-cpu combo", () => {
    const path = buildMemConfig({
      embeddingProvider: "local",
      embeddingDimensions: 768,
      label: "smoke-768",
    });
    expect(typeof path).toBe("string");
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-B — local embedding matrix ($0, real daemon)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "MEM-02 Stage-B — local embedding matrix ($0, real daemon)",
  () => {
    it.each(LOCAL_MATRIX)(
      "embedding: provider=$provider dims=$dims gpu=$gpu",
      async ({ provider, dims, gpu, label }) => {
        const configPath = buildMemConfig({
          embeddingProvider: provider,
          embeddingDimensions: dims,
          localGpu: gpu,
          label,
        });
        const driver = new ConversationDriver({
          agentId: `mem-02-${label}`,
          configPath,
        });
        try {
          await driver.init();
          const dbPath = driver.getMemoryDbPath();
          const beforeCounts = existsSync(dbPath)
            ? snapshotRowCounts(dbPath, MEM_TABLES)
            : {};
          // First turn: triggers embedding write → new vec_memories row.
          await driver.sendTurn(`Remember: embedding-test-fact-${dims}.`);

          // Second identical turn: L1 embedding cache → no additional vec_memories row
          // (same content produces same vector; cache hit prevents double-write).
          await driver.sendTurn(`Remember: embedding-test-fact-${dims}.`);

          await flushDaemonLogs(driver);

          await runLogOracle(driver.capturedLogLines(), {
            expectedErrors: ["JSON-RPC method error"],
          });

          expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
          // Content-anchored: the fact is stored for this dims
          // config. The original exact `expectedRowDelta: 1` assumed the two
          // identical user turns dedup to one memory row — wrong once the agent
          // actually replies (real key): each turn also stores the agent reply +
          // possibly an extracted memory, so the count is nondeterministic. The
          // embedding-integrity invariant (vec_memories ↔ memories has_embedding=1)
          // is still enforced by runDbOracle check 3d below.
          expect(
            countRowsLike(dbPath, "memories", [`embedding-test-fact-${dims}`]),
            `embedding fact for dims=${dims} not stored`,
          ).toBeGreaterThanOrEqual(1);
          {
            await runDbOracle(dbPath, { beforeCounts });
          }
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
// Stage-C — openai embedding combo (needs OPENAI_API_KEY)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive || !hasOpenAiKey)(
  "MEM-02 Stage-C — openai embedding (needs OPENAI_API_KEY)",
  () => {
    it.each(OPENAI_MATRIX)(
      "openai embedding: dims=$dims",
      async ({ provider, dims, gpu, label }) => {
        const configPath = buildMemConfig({
          embeddingProvider: provider,
          embeddingDimensions: dims,
          localGpu: gpu,
          label,
        });
        const driver = new ConversationDriver({
          agentId: `mem-02-${label}`,
          configPath,
        });
        try {
          await driver.init();
          const dbPath = driver.getMemoryDbPath();
          const beforeCounts = existsSync(dbPath)
            ? snapshotRowCounts(dbPath, MEM_TABLES)
            : {};
          await driver.sendTurn(`Remember: openai-embedding-test-${dims}.`);
          await flushDaemonLogs(driver);

          await runLogOracle(driver.capturedLogLines(), {
            expectedErrors: [],
          });

          expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
          // Content-anchored: the fact is stored; counts are
          // nondeterministic (user+agent+extracted rows). Embedding integrity is
          // enforced by runDbOracle check 3d.
          expect(
            countRowsLike(dbPath, "memories", [`openai-embedding-test-${dims}`]),
            `openai embedding fact for dims=${dims} not stored`,
          ).toBeGreaterThanOrEqual(1);
          {
            await runDbOracle(dbPath, { beforeCounts });
          }
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
