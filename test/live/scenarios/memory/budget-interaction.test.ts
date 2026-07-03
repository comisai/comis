// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-08 — Recall injection counted in H (context), no double-count.
 *
 * Stage-A: double-count detection logic unit test.
 * Stage-B (COMIS_LIVE, $0): capturedEvents() filtered for "memory:injected" events.
 *
 * OBSERVABLE: real event key is "memory:injected" (NOT "context:memory_injected" — verified
 * from packages/core/src/event-bus/events-agent.ts). ConversationDriver._subscribeToEventBus
 * subscribes to it (conversation.ts).
 *
 * PAYLOAD NOTE: memory:injected carries { hitCount, charsInjected, trustTags, pinnedCount?, ... }
 * — NO memoryIds field. Double-count is asserted at the hitCount level (total injected memories
 * bounded by distinct stored facts). Per-ID uniqueness would require a product change
 * to add memoryIds to the event payload — deferred.
 *
 * recallEvents.length > 0 is a HARD ASSERT (not a guard). If it fails,
 * the subscription is not wired and the test gives an honest failure rather than a silent pass.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
import { buildMemConfig } from "../../harness/mem-config.js";

const isLive = !!process.env["COMIS_LIVE"];
const MEM_TABLES = ["memories", "vec_memories", "memory_fts"];

describe("MEM-08 Stage-A — double-count detection (no COMIS_LIVE)", () => {
  it("Set.size < array.length → double-count detected", () => {
    const injectedIds = ["mem-1", "mem-2", "mem-1"]; // mem-1 duplicated
    const uniqueIds = new Set(injectedIds);
    expect(uniqueIds.size).toBeLessThan(injectedIds.length);
  });

  it("Set.size === array.length → no double-count", () => {
    const injectedIds = ["mem-1", "mem-2", "mem-3"];
    const uniqueIds = new Set(injectedIds);
    expect(uniqueIds.size).toBe(injectedIds.length);
  });

  it("empty injectedIds → no double-count", () => {
    const injectedIds: string[] = [];
    const uniqueIds = new Set(injectedIds);
    expect(uniqueIds.size).toBe(injectedIds.length);
  });
});

describe.skipIf(!isLive)("MEM-08 Stage-B — recall injection in H, no double-count ($0, real daemon)", () => {
  it("memory:injected events fire and hitCount is bounded (no double-injection)", async () => {
    const configPath = buildMemConfig({
      embeddingProvider: "local",
      ragConfig: { fts: true, vector: true },
      label: "mem-08-budget",
    });
    const driver = new ConversationDriver({ agentId: "mem-08-budget", configPath });
    try {
      await driver.init();
      const dbPath = driver.getMemoryDbPath();
      const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, MEM_TABLES) : {};
      // Store 2 distinct facts
      await driver.sendTurn("Remember: budget-interaction fact Alpha.");
      await driver.sendTurn("Remember: budget-interaction fact Beta.");
      // Snapshot event count before the recall turn so we can isolate just
      // the recall turn's events (don't conflate cross-turn hits).
      const beforeRecall = driver.capturedEvents().length;
      // Trigger recall of both facts in one query
      await driver.sendTurn("What are the budget-interaction facts?");
      await flushDaemonLogs(driver);

      // Filter for "memory:injected" events emitted ONLY during the recall turn.
      // ConversationDriver._subscribeToEventBus subscribes to "memory:injected".
      const recallEvents = driver.capturedEvents()
        .slice(beforeRecall)
        .filter(e => e.name === "memory:injected");

      // MEM-08 HARD ASSERT: events must fire (not a guard that silently passes when 0)
      // If this fails, the subscription was not wired in conversation.ts
      expect(recallEvents.length).toBeGreaterThan(0);

      // Double-injection guard at hitCount level — scoped to the recall turn only.
      // (payload has no memoryIds — per-ID check requires product change)
      const totalHits = recallEvents.reduce(
        (sum, e) => sum + (((e.payload as Record<string, unknown>)["hitCount"] as number | undefined) ?? 0),
        0,
      );
      // No double-injection: total hits bounded by distinct stored facts (2)
      expect(totalHits).toBeLessThanOrEqual(2);

      await runLogOracle(driver.capturedLogLines(), { expectedErrors: ["JSON-RPC method error"] });
      expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
        {
        await runDbOracle(dbPath, { beforeCounts });
      }
    } finally {
      await driver.close().catch(() => {});
      try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    }
  }, 3 * 60_000);
});
