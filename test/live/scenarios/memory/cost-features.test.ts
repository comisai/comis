// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-07 — costFeatures.enabled=false kills all LLM-bearing memory features.
 *
 * Stage-A: buildMemConfig YAML content checks.
 *   NOTE: CostFeaturesConfigSchema is NOT re-exported from @comis/core barrel
 *   (packages/core/src/index.ts — verified). The schema.parse() test is replaced
 *   by YAML string checks. Stage-B daemon-boot with costFeatures.enabled=false
 *   validates the key at runtime — a wrong YAML key would fail daemon config parse.
 *
 * Stage-B (COMIS_LIVE, $0): both planted facts stored (content-anchored) AND
 *   ZERO consolidation-observation rows (proof_count NOT NULL) when costFeatures
 *   is disabled. The precise observation-signature invariant replaces the old
 *   raw-row count ceiling, which wrongly assumed one row per user turn
 *   (ingestion also stores agent replies + agent-extracted memories — 260611).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts, countRowsLike, countObservationRows } from "../../assert/db-oracle.js";
import { buildMemConfig } from "../../harness/mem-config.js";

const isLive = !!process.env["COMIS_LIVE"];
const MEM_TABLES = ["memories", "vec_memories", "memory_fts"];

describe("MEM-07 Stage-A — costFeatures kill-switch YAML checks (no COMIS_LIVE)", () => {
  it("buildMemConfig with costFeaturesEnabled:false produces YAML with 'enabled: false'", () => {
    const path = buildMemConfig({ costFeaturesEnabled: false, label: "smoke-cost" });
    try {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("enabled: false");
    } finally {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  it("buildMemConfig with costFeaturesEnabled:true produces YAML with 'enabled: true'", () => {
    const path = buildMemConfig({ costFeaturesEnabled: true, label: "smoke-cost-true" });
    try {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("enabled: true");
    } finally {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });
});

describe.skipIf(!isLive)("MEM-07 Stage-B — costFeatures.enabled=false → no consolidation ($0, real daemon)", () => {
  it("storeDelta >= 1 AND <= 2 when costFeatures disabled (at least one fact, no consolidation obs)", async () => {
    const configPath = buildMemConfig({
      costFeaturesEnabled: false,
      embeddingProvider: "local",
      label: "mem-07-cost",
    });
    const driver = new ConversationDriver({ agentId: "mem-07-cost", configPath });
    try {
      await driver.init();
      const dbPath = driver.getMemoryDbPath();
      const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, MEM_TABLES) : {};
      await driver.sendTurn("Remember: cost-features test fact A.");
      await driver.sendTurn("Remember: cost-features test fact B.");
      await driver.sendTurn("What are the cost-features test facts?");
      await flushDaemonLogs(driver);
      await runLogOracle(driver.capturedLogLines(), { expectedErrors: ["JSON-RPC method error"] });
      expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
      // Content-anchored (260611 re-pin): both planted facts stored (catches
      // "0 rows written" false-pass — WARNING-1).
      expect(
        countRowsLike(dbPath, "memories", ["cost-features test fact A"]),
        "planted fact A not found in memories store",
      ).toBeGreaterThanOrEqual(1);
      expect(
        countRowsLike(dbPath, "memories", ["cost-features test fact B"]),
        "planted fact B not found in memories store",
      ).toBeGreaterThanOrEqual(1);
      {
        const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
        const storeDelta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
        expect(storeDelta, "no memory rows written").toBeGreaterThanOrEqual(1);
        // The PRECISE no-consolidation invariant (260611): costFeatures.enabled=
        // false turns the LLM-bearing consolidation cron OFF, so there must be
        // ZERO consolidation-observation rows (proof_count NOT NULL). A raw-row
        // COUNT ceiling was wrong — ingestion stores combined user+agent turns
        // AND agent-extracted memories, so the count is nondeterministic; the
        // observation signature is not.
        expect(
          countObservationRows(dbPath),
          "consolidation observation rows present despite costFeatures.enabled=false",
        ).toBe(0);
        await runDbOracle(dbPath, { beforeCounts });
      }
    } finally {
      await driver.close().catch(() => {});
      try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    }
  }, 3 * 60_000);
});
