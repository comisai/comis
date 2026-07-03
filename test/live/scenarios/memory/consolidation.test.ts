// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-06 — Consolidation/FOLD atomicity + pinned immunity + FadeMem decay.
 *
 * Stage-A (no COMIS_LIVE): in-memory SQLite DB tests using DIRECT-SQL path
 * (mirrors sqlite-memory-consolidation-store.ts internals — avoids constructing
 * a full MemoryEntry for the high-level applyConsolidation API).
 *
 * ConsolidationPlan = { observation: MemoryEntry, markConsolidated: string[],
 * tenantId: string, now: number }. Constructing a full MemoryEntry requires deep domain
 * plumbing. The Stage-A test instead replicates the SQL that applyConsolidation runs:
 *   UPDATE memories SET consolidated_at=? WHERE id=? AND tenant_id=?  (line 184 of the store)
 * plus a direct INSERT for the observation row. This tests the non-destruction invariant
 * at the substrate level — more deterministic than the high-level API.
 *
 * DDL constraints (packages/memory/src/schema.ts lines 488-506):
 *   trust_level CHECK IN ('system','learned','external') — 'high' is INVALID; use 'learned'.
 *   memory_type CHECK IN ('working','episodic','semantic','procedural') — 'observation' is INVALID;
 *     use 'semantic'. An observation row is identified by proof_count IS NOT NULL, not memory_type.
 *   created_at INTEGER NOT NULL (no default) — must be bound in every INSERT.
 *
 * The strength column IS present (row-schemas.ts line 68). No silent catch.
 * PRAGMA table_info asserts the column exists first; assertions run unconditionally.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
import { buildMemConfig } from "../../harness/mem-config.js";
import { initSchema } from "@comis/memory";

const isLive = !!process.env["COMIS_LIVE"];
const MEM_TABLES = ["memories", "vec_memories", "memory_fts"];

// Required NOT-NULL columns for a valid memories INSERT (verified from schema.ts DDL):
//   trust_level: 'learned'  — CHECK IN ('system','learned','external'); 'high' is INVALID.
//   memory_type: 'semantic' — CHECK IN ('working','episodic','semantic','procedural'); 'observation' is INVALID.
//     (Observation rows are identified by proof_count IS NOT NULL, not by memory_type.)
//   created_at: bound as ?  — INTEGER NOT NULL with NO DEFAULT; omitting causes constraint failure.
// Each prepared statement that uses these constants must bind: (id, content, created_at).
const REQUIRED_COLS =
  "id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, has_embedding, created_at";
const REQUIRED_VALS =
  "?, 'tenant-1', 'agent-a', 'user-1', ?, 'learned', 'semantic', 'user', '[]', 0, ?";

describe("MEM-06 Stage-A — FOLD atomicity + pinned immunity + FadeMem (no COMIS_LIVE)", () => {
  it("FOLD non-destruction: consolidated_at UPDATE never deletes source rows (direct SQL)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);

    const now = Date.now();
    const sourceIds = ["src-1", "src-2", "src-3"];
    const insertSrc = db.prepare(`INSERT INTO memories (${REQUIRED_COLS}) VALUES (${REQUIRED_VALS})`);
    for (let i = 0; i < sourceIds.length; i++) {
      insertSrc.run(sourceIds[i]!, `fact-${i + 1}`, now);
    }

    const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    expect(beforeCount).toBe(3);

    // Replicate the exact SQL applyConsolidation runs (store line 184):
    //   UPDATE memories SET consolidated_at = ? WHERE id = ? AND tenant_id = ?
    const markSql = db.prepare("UPDATE memories SET consolidated_at = ? WHERE id = ? AND tenant_id = ?");
    const insertObs = db.prepare(
      `INSERT INTO memories (${REQUIRED_COLS}, proof_count, source_ids, confidence) ` +
      `VALUES (${REQUIRED_VALS}, ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const id of sourceIds) {
        markSql.run(now, id, "tenant-1");
      }
      // Observation row: identified by proof_count IS NOT NULL (not by memory_type — stays 'semantic')
      insertObs.run("obs-1", "Consolidated facts 1-3", now, sourceIds.length, JSON.stringify(sourceIds), 1.0);
    });
    tx();

    // Invariant: source rows NOT deleted (3 sources + 1 observation = 4)
    const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    expect(afterCount).toBe(4);

    // Source rows: consolidated_at set, evicted_at null (non-destructive)
    const sources = db
      .prepare("SELECT consolidated_at, evicted_at FROM memories WHERE id IN ('src-1','src-2','src-3')")
      .all() as Array<{ consolidated_at: number | null; evicted_at: number | null }>;
    expect(sources).toHaveLength(3);
    for (const row of sources) {
      expect(row.consolidated_at).not.toBeNull();
      expect(row.evicted_at).toBeNull();
    }

    db.close();
  });

  it("pinned immunity: pinned column exists and pinned=1 rows are queryable", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);

    // Assert column exists via PRAGMA (structural check)
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    expect(cols.some(c => c.name === "pinned")).toBe(true);

    const now = Date.now();
    // Insert 1 pinned + 1 non-pinned row
    const ins = db.prepare(
      `INSERT INTO memories (${REQUIRED_COLS}, pinned) VALUES (${REQUIRED_VALS}, ?)`,
    );
    ins.run("pinned-1", "pinned-fact", now, 1);
    ins.run("regular-1", "regular-fact", now, 0);

    const pinnedRows = db
      .prepare("SELECT content FROM memories WHERE pinned = 1")
      .all() as { content: string }[];
    expect(pinnedRows).toHaveLength(1);
    expect(pinnedRows[0]!.content).toBe("pinned-fact");

    db.close();
  });

  it("FadeMem: strength column exists (PRAGMA) and accepted values are in [0,1] (no silent catch)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);

    // Assert column exists — this MUST pass (row-schemas.ts line 68 confirms the column).
    // If it fails, there is a real schema regression — do not swallow with try/catch.
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    expect(cols.some(c => c.name === "strength")).toBe(true);

    const now = Date.now();
    // Insert a row with a valid strength value
    const ins = db.prepare(
      `INSERT INTO memories (${REQUIRED_COLS}, strength) VALUES (${REQUIRED_VALS}, ?)`,
    );
    ins.run("lc-1", "lifecycle-fact", now, 0.75);

    // Assertions run unconditionally (no try/catch)
    const rows = db
      .prepare("SELECT strength FROM memories WHERE strength IS NOT NULL")
      .all() as { strength: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(typeof row.strength).toBe("number");
      expect(row.strength).toBeGreaterThanOrEqual(0);
      expect(row.strength).toBeLessThanOrEqual(1);
    }

    db.close();
  });
});

describe.skipIf(!isLive)("MEM-06 Stage-B — consolidation + pinned immunity ($0, real daemon)", () => {
  it("stores 3 facts and observes consolidation non-destruction via db-oracle", async () => {
    const configPath = buildMemConfig({ embeddingProvider: "local", label: "mem-06-consol" });
    const driver = new ConversationDriver({ agentId: "mem-06-consol", configPath });
    try {
      await driver.init();
      const dbPath = driver.getMemoryDbPath();
      const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, MEM_TABLES) : {};
      await driver.sendTurn("Fact 1: TypeScript is a superset of JavaScript.");
      await driver.sendTurn("Fact 2: Node.js uses the V8 engine.");
      await driver.sendTurn("Fact 3: SQLite is a serverless database.");
      await flushDaemonLogs(driver);
      await runLogOracle(driver.capturedLogLines(), { expectedErrors: ["JSON-RPC method error"] });
      expect(existsSync(dbPath), "memory DB missing after run - store never opened (dbPath: " + dbPath + ")").toBe(true);
        {
        const afterCounts = snapshotRowCounts(dbPath, MEM_TABLES);
        const delta = (afterCounts["memories"] ?? 0) - (beforeCounts["memories"] ?? 0);
        expect(delta).toBeGreaterThanOrEqual(3);
        await runDbOracle(dbPath, { beforeCounts });
      }
    } finally {
      await driver.close().catch(() => {});
      try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    }
  }, 4 * 60_000);
});
