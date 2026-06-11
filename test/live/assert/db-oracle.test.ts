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
// Check 3c: memory_fts ↔ memories (ALL rows) sync
// Check 3d: vec_memories ↔ memories(has_embedding=1) sync
//
// Corrected semantics (CR-01): memory_fts triggers fire on EVERY INSERT INTO
// memories with no has_embedding filter (schema.ts lines 553-565). The correct
// invariant is COUNT(*) memory_fts == COUNT(*) memories (total), NOT has_embedding=1.
// vec_memories is the has_embedding=1 invariant (check 3d).
// ---------------------------------------------------------------------------

/** Shared DDL for memories table used in check 3c/3d tests. */
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

describe("runDbOracle — check 3c: in-sync counts (total) → passes", () => {
  it("resolves when memory_fts count equals total memories count (including non-embedded rows)", async () => {
    // Correct 3c semantics: FTS triggers fire on ALL inserts regardless of
    // has_embedding. memory_fts count == memories total count (2 rows).
    // memory_fts has 2 entries to match the 2 total memories rows.
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

      // memory_fts (standard FTS5) with 2 rows — matches memories total=2
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "embedded");
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(2, "not-embedded");
    });
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — check 3c: desynced counts → throws with check 3c message", () => {
  it("throws '[db-oracle check 3c] memory_fts desynced' when fts count differs from total memories", async () => {
    // memory_fts has 1 entry but memories has 2 total rows → desynced.
    // (Previous wrong semantics would have passed if both rows had has_embedding=0,
    //  since memories(has_embedding=1)==0 == fts==0. The corrected check uses
    //  total memories count, so 2 total rows vs 1 fts entry → throws.)
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      // 2 rows total — FTS should have 2 but only has 1
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-13", "tenant-1", "agent-1", "user-1", "first", "high", "episodic", "user", "[]", Date.now(), 0);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-14", "tenant-1", "agent-1", "user-1", "second", "high", "episodic", "user", "[]", Date.now(), 0);

      // memory_fts (standard FTS5) with only 1 entry — desynced (should be 2)
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "first");
    });
    await expect(runDbOracle(dbPath)).rejects.toThrow("[db-oracle check 3c]");
  });
});

describe("runDbOracle — check 3d: vec_memories ↔ memories(has_embedding=1) in-sync → passes", () => {
  it("resolves when vec_memories count equals memories(has_embedding=1) count", async () => {
    // Check 3d: vec_memories tracks embedded rows only. Set up:
    // - memories: 2 total rows (1 embedded, 1 not)
    // - memory_fts: 2 entries (matches total memories = 2) → check 3c passes
    // - vec_memories: 1 entry (matches has_embedding=1 = 1) → check 3d passes
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-20", "tenant-1", "agent-1", "user-1", "embedded-row", "high", "episodic", "user", "[]", Date.now(), 1);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-21", "tenant-1", "agent-1", "user-1", "plain-row", "high", "episodic", "user", "[]", Date.now(), 0);

      // memory_fts: 2 entries (all rows) → check 3c passes
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "embedded-row");
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(2, "plain-row");

      // vec_memories: 1 entry (embedded rows only)
      db.exec(`CREATE TABLE vec_memories (rowid INTEGER PRIMARY KEY)`);
      db.prepare(`INSERT INTO vec_memories(rowid) VALUES (?)`).run(1);
    });
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("runDbOracle — check 3d: vec_memories desynced → throws with check 3d message", () => {
  it("throws '[db-oracle check 3d] vec_memories desynced' when vec count differs from has_embedding=1 count", async () => {
    // Check 3d: memories has 2 embedded rows but vec_memories has only 1 → desynced.
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-22", "tenant-1", "agent-1", "user-1", "first-emb", "high", "episodic", "user", "[]", Date.now(), 1);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("mem-23", "tenant-1", "agent-1", "user-1", "second-emb", "high", "episodic", "user", "[]", Date.now(), 1);

      // memory_fts: 2 entries (all rows) → check 3c passes
      db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content)`);
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(1, "first-emb");
      db.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(2, "second-emb");

      // vec_memories: only 1 entry — desynced (should be 2 to match has_embedding=1 count)
      db.exec(`CREATE TABLE vec_memories (rowid INTEGER PRIMARY KEY)`);
      db.prepare(`INSERT INTO vec_memories(rowid) VALUES (?)`).run(1);
    });
    await expect(runDbOracle(dbPath)).rejects.toThrow("[db-oracle check 3d]");
  });
});

// ---------------------------------------------------------------------------
// 260611 live-fire fix: the oracle connections must load sqlite-vec.
// MEM Stage-B daemons create vec_memories as a REAL vec0 virtual table; the
// oracle/snapshot reader opening its own connection without the extension threw
// "SqliteError: no such module: vec0" (snapshotRowCounts) and silently skipped
// check 3d (runDbOracle). The reader now loads sqlite-vec like the product does
// (packages/memory schema.ts initSchema), so vec tables are first-class ground
// truth in both functions.
// ---------------------------------------------------------------------------

describe("snapshotRowCounts — real vec0 virtual table (sqlite-vec loaded in reader)", () => {
  it("counts vec_memories rows in a product-shaped DB instead of throwing 'no such module: vec0'", async () => {
    const { initSchema } = await import("@comis/memory");
    const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-vec-"));
    const dbPath = join(dir, "vec.db");
    const writer = new Database(dbPath);
    try {
      initSchema(writer, 8); // loads sqlite-vec + creates vec_memories as vec0
    } finally {
      writer.close();
    }

    const { snapshotRowCounts } = await import("./db-oracle.js");
    const counts = snapshotRowCounts(dbPath, ["memories", "vec_memories"]);
    expect(counts["memories"]).toBe(0);
    expect(counts["vec_memories"]).toBe(0);
  });

  it("runDbOracle on a product-shaped vec DB passes (check 3d actually executes)", async () => {
    const { initSchema } = await import("@comis/memory");
    const dir = mkdtempSync(join(tmpdir(), "comis-db-oracle-vec2-"));
    const dbPath = join(dir, "vec2.db");
    const writer = new Database(dbPath);
    try {
      initSchema(writer, 8);
    } finally {
      writer.close();
    }
    await expect(runDbOracle(dbPath)).resolves.toBeUndefined();
  });
});

describe("countRowsLike — content-anchored ground truth (260611 predicate re-pin)", () => {
  it("counts rows whose content contains ALL given substrings (AND semantics)", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      const ins = db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      ins.run("m1", "t", "a", "u", "the Eiffel Tower is 330 meters tall", "high", "episodic", "user", "[]", Date.now(), 0);
      ins.run("m2", "t", "a", "u", "what is the height of the Eiffel Tower?", "high", "episodic", "user", "[]", Date.now(), 0);
    });
    const { countRowsLike } = await import("./db-oracle.js");
    expect(countRowsLike(dbPath, "memories", ["Eiffel", "330"])).toBe(1);
    expect(countRowsLike(dbPath, "memories", ["Eiffel"])).toBe(2);
    expect(countRowsLike(dbPath, "memories", ["nonexistent-fact"])).toBe(0);
  });

  it("matching is case-insensitive (LIKE semantics)", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
      db.prepare(
        `INSERT INTO memories
         (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("m1", "t", "a", "u", "Lane-Test fact for combo", "high", "episodic", "user", "[]", Date.now(), 0);
    });
    const { countRowsLike } = await import("./db-oracle.js");
    expect(countRowsLike(dbPath, "memories", ["lane-test"])).toBe(1);
  });

  it("rejects a table name not present in the DB (allowlist guard)", async () => {
    const dbPath = await writeMemoryDbToFile((db) => {
      db.exec(MEMORIES_DDL);
    });
    const { countRowsLike } = await import("./db-oracle.js");
    expect(() => countRowsLike(dbPath, "evil; DROP TABLE memories", ["x"])).toThrow(/not present/);
  });
});
