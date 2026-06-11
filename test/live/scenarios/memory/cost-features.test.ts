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
 * Stage-B (COMIS_LIVE, $0): storeDelta >= 1 AND <= 2 when costFeatures disabled.
 *   The lower bound >= 1 catches a "0 rows written" false-pass (WARNING-1).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
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
        {
        const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
        const storeDelta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
        // Lower bound: at least 1 fact stored (catches "0 rows written" false-pass — WARNING-1)
        expect(storeDelta).toBeGreaterThanOrEqual(1);
        // Upper bound: no consolidation observation (costFeatures disabled → LLM-bearing cron off)
        expect(storeDelta).toBeLessThanOrEqual(2);
        await runDbOracle(dbPath, { beforeCounts });
      }
    } finally {
      await driver.close().catch(() => {});
      try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    }
  }, 3 * 60_000);
});
