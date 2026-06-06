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
// join is used for temp paths in corrupt-DB and backup tests
import { runDbOracle } from "./db-oracle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a fresh in-memory DB to a temp file so db-oracle can open it by path.
 * Returns [dbPath, tempDir] — caller should clean up tempDir after the test.
 */
async function writeMemoryDbToFile(
  setupFn: (db: Database.Database) => void,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-test-"));
  const dbPath = join(dir, "test.db");

  // Create in-memory DB, set it up, then backup to file (async API)
  const memDb = new Database(":memory:");
  setupFn(memDb);

  // backup() returns a Promise — must await before closing
  await memDb.backup(dbPath);
  memDb.close();

  // Track the directory for cleanup
  tempDirs.push(dir);
  return dbPath;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDbOracle — fresh DB with valid memories row passes", () => {
  it("resolves on :memory:-backed DB with a valid memories row", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
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

    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — corrupt DB throws on integrity check", () => {
  it("throws when the SQLite file contains invalid bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-corrupt-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "corrupt.db");
    writeFileSync(dbPath, Buffer.from("this is not a sqlite database at all!!"));

    await expect(runDbOracle(dbPath)).rejects.toThrow();
  });
});

describe("runDbOracle — memories row missing required column throws", () => {
  it("throws when memories row fails zod validation (missing required column)", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
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

    await expect(runDbOracle(dbPath)).rejects.toThrow();
  });
});

describe("runDbOracle — row delta: expected +1 and got +1 passes", () => {
  it("resolves when expectedRowDelta matches actual row count change", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
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
    const dbPath = await writeMemoryDbToFile((db) => {
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

    await expect(
      runDbOracle(dbPath, {
        expectedDeltas: [{ table: "memories", expectedRowDelta: 1 }],
        beforeCounts: { memories: 0 },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Check 3c: memory_fts ↔ memories(has_embedding=1) sync
// ---------------------------------------------------------------------------

/** Shared DDL for memories table used in check 3c tests. */
const MEMORIES_DDL = `
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
`;

describe("runDbOracle — check 3c: memory_fts absent → passes (no check run)", () => {
  it("resolves when memory_fts table does not exist (LCD-only DB)", async () => {
    // Only memories table, no memory_fts → check 3c guard skips silently
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-10", "tenant-1", "agent-1", "user-1", "LCD-only", "high", "episodic", "user", "[]", Date.now(), 1);
    });
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — check 3c: memories absent → passes (no check run)", () => {
  it("resolves when memories table does not exist (FTS-only anomaly DB)", async () => {
    // No memories table, only memory_fts → check 3c guard skips silently.
    // Uses standard FTS5 (no external content) so the table is createable without
    // the memories table being present.
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
    });
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — check 3c: in-sync counts → passes", () => {
  it("resolves when memories(has_embedding=1) count equals memory_fts count", async () => {
    // Uses standard FTS5 (NOT external-content) so COUNT(*) returns the actual
    // FTS index entry count rather than the external content table row count.
    // This correctly exercises the check 3c logic: memories(has_embedding=1) == memory_fts.
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      // Insert 2 rows: 1 with has_embedding=1, 1 with has_embedding=0
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-11", "tenant-1", "agent-1", "user-1", "embedded", "high", "episodic", "user", "[]", Date.now(), 1);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-12", "tenant-1", "agent-1", "user-1", "not-embedded", "high", "episodic", "user", "[]", Date.now(), 0);

      // memory_fts (standard FTS5) with exactly 1 row — matches memories(has_embedding=1)=1
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "embedded");
    });
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — check 3c: desynced counts → throws with check 3c message", () => {
  it("throws '[db-oracle check 3c] memory_fts desynced' when counts differ", async () => {
    // Uses standard FTS5 (NOT external-content) so COUNT(*) returns 1 (one entry),
    // while memories has 2 rows with has_embedding=1 → desynced.
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      // 2 rows with has_embedding=1 — FTS should have 2 but only has 1
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-13", "tenant-1", "agent-1", "user-1", "first", "high", "episodic", "user", "[]", Date.now(), 1);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-14", "tenant-1", "agent-1", "user-1", "second", "high", "episodic", "user", "[]", Date.now(), 1);

      // memory_fts (standard FTS5) with only 1 entry — desynced (should be 2)
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "first");
    });
    await expect(runDbOracle(dbPath)).rejects.toThrow("[db-oracle check 3c]");
  });
});
