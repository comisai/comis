// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the persistence oracle.
 *
 * Uses in-memory SQLite via better-sqlite3 (Database(":memory:")) for row
 * validation tests. For the corrupt-DB integrity check, writes invalid bytes
 * to a temp file. No real daemon required.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDbOracle } from "./db-oracle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a fresh in-memory DB to a temp file so db-oracle can open it by path. */
function writeMemoryDbToFile(setupFn: (db: Database.Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-test-"));
  const dbPath = join(dir, "test.db");

  // Create in-memory DB, set it up, then copy to file
  const memDb = new Database(":memory:");
  setupFn(memDb);

  // Use SQLite backup API to persist to file
  memDb.backup(dbPath);
  memDb.close();

  return dbPath;
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    try { rmSync(p, { recursive: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDbOracle — fresh DB with valid memories row passes", () => {
  it("resolves on :memory:-backed DB with a valid memories row", async () => {
    const dbPath = writeMemoryDbToFile((db) => {
      db.exec(`
        CREATE TABLE memories (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          occurred_at INTEGER,
          proof_count INTEGER,
          source_ids TEXT,
          consolidated_at INTEGER,
          confidence REAL,
          history TEXT,
          observation_kind TEXT,
          pattern_type TEXT,
          lifecycle_demoted_at INTEGER,
          evicted_at INTEGER,
          strength REAL,
          pinned INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "mem-001", "tenant-1", "agent-1", "user-1",
        "Hello world", "high", "episodic", "user",
        "[]", Date.now(), 0,
      );
    });
    tempPaths.push(join(dbPath, ".."));

    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — corrupt DB throws on integrity check", () => {
  it("throws when the SQLite file contains invalid bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-corrupt-"));
    tempPaths.push(dir);
    const dbPath = join(dir, "corrupt.db");
    writeFileSync(dbPath, Buffer.from("this is not a sqlite database at all!!"));

    await expect(runDbOracle(dbPath)).rejects.toThrow();
  });
});

describe("runDbOracle — memories row missing required column throws", () => {
  it("throws when memories row fails zod validation (missing required column)", async () => {
    const dbPath = writeMemoryDbToFile((db) => {
      // Create table WITHOUT required `has_embedding` column → zod strictObject rejects
      db.exec(`
        CREATE TABLE memories (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "mem-002", "tenant-1", "agent-1", "user-1",
        "Incomplete row", "medium", "episodic", "user", "[]", Date.now(),
      );
    });
    tempPaths.push(join(dbPath, ".."));

    await expect(runDbOracle(dbPath)).rejects.toThrow();
  });
});

describe("runDbOracle — row delta: expected +1 and got +1 passes", () => {
  it("resolves when expectedRowDelta matches actual row count change", async () => {
    const dbPath = writeMemoryDbToFile((db) => {
      db.exec(`
        CREATE TABLE memories (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          occurred_at INTEGER,
          proof_count INTEGER,
          source_ids TEXT,
          consolidated_at INTEGER,
          confidence REAL,
          history TEXT,
          observation_kind TEXT,
          pattern_type TEXT,
          lifecycle_demoted_at INTEGER,
          evicted_at INTEGER,
          strength REAL,
          pinned INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "mem-003", "tenant-1", "agent-1", "user-1",
        "Delta test", "high", "episodic", "user", "[]", Date.now(), 0,
      );
    });
    tempPaths.push(join(dbPath, ".."));

    await expect(
      runDbOracle(dbPath, {
        expectedDeltas: [{ table: "memories", expectedRowDelta: 1 }],
        beforeCounts: { memories: 0 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runDbOracle — row delta: expected +1 but got 0 throws", () => {
  it("throws when actualRowDelta does not match expectedRowDelta", async () => {
    const dbPath = writeMemoryDbToFile((db) => {
      db.exec(`
        CREATE TABLE memories (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          occurred_at INTEGER,
          proof_count INTEGER,
          source_ids TEXT,
          consolidated_at INTEGER,
          confidence REAL,
          history TEXT,
          observation_kind TEXT,
          pattern_type TEXT,
          lifecycle_demoted_at INTEGER,
          evicted_at INTEGER,
          strength REAL,
          pinned INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Insert 0 rows — so delta from beforeCount=0 is 0, but we'll expect 1
    });
    tempPaths.push(join(dbPath, ".."));

    await expect(
      runDbOracle(dbPath, {
        expectedDeltas: [{ table: "memories", expectedRowDelta: 1 }],
        beforeCounts: { memories: 0 },
      }),
    ).rejects.toThrow();
  });
});
