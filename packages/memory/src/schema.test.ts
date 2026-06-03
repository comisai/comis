// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  initSchema,
  isVecAvailable,
  ensureMemoryColumns,
  ensureEntityTables,
  ensureUsefulnessTable,
  ensureTripleTable,
} from "./schema.js";
import { createSqliteMemoryUsefulnessStore } from "./sqlite-memory-usefulness-store.js";

describe("initSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("creates the memories table with correct columns", () => {
    initSchema(db, 1536);

    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("tenant_id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("trust_level");
    expect(colNames).toContain("memory_type");
    expect(colNames).toContain("source_who");
    expect(colNames).toContain("source_channel");
    expect(colNames).toContain("source_session_key");
    expect(colNames).toContain("tags");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("occurred_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("expires_at");
    expect(colNames).toContain("has_embedding");
  });

  it("creates the sessions table", () => {
    initSchema(db, 1536);

    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("session_key");
    expect(colNames).toContain("tenant_id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("channel_id");
    expect(colNames).toContain("messages");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("metadata");
  });

  it("creates the memory_fts virtual table", () => {
    initSchema(db, 1536);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'")
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("memory_fts");
  });

  it("creates the vec_memories virtual table when vec is available", () => {
    initSchema(db, 1536);

    if (!isVecAvailable()) {
      // Skip on platforms where sqlite-vec cannot load
      return;
    }

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'")
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("vec_memories");
  });

  it("creates all memory indexes", () => {
    initSchema(db, 1536);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memories_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_memories_tenant");
    expect(indexNames).toContain("idx_memories_trust");
    expect(indexNames).toContain("idx_memories_type");
    expect(indexNames).toContain("idx_memories_created");
    expect(indexNames).toContain("idx_memories_expires");
  });

  it("creates all session indexes", () => {
    initSchema(db, 1536);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sessions_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_sessions_tenant");
    expect(indexNames).toContain("idx_sessions_updated");
  });

  it("FTS5 trigger fires on INSERT", () => {
    initSchema(db, 1536);

    db.prepare(
      `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
       VALUES ('m1', 'default', 'u1', 'the quick brown fox', 'learned', 'semantic', 'agent', '[]', 1000)`,
    ).run();

    const ftsRows = db
      .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'fox'")
      .all() as Array<{ content: string }>;

    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0]!.content).toBe("the quick brown fox");
  });

  it("FTS5 trigger fires on DELETE", () => {
    initSchema(db, 1536);

    db.prepare(
      `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
       VALUES ('m1', 'default', 'u1', 'the quick brown fox', 'learned', 'semantic', 'agent', '[]', 1000)`,
    ).run();

    // Verify it's in FTS
    let ftsRows = db.prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'fox'").all();
    expect(ftsRows).toHaveLength(1);

    // Delete from base table
    db.prepare("DELETE FROM memories WHERE id = 'm1'").run();

    // Verify removed from FTS
    ftsRows = db.prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'fox'").all();
    expect(ftsRows).toHaveLength(0);
  });

  it("FTS5 trigger fires on UPDATE of content", () => {
    initSchema(db, 1536);

    db.prepare(
      `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
       VALUES ('m1', 'default', 'u1', 'the quick brown fox', 'learned', 'semantic', 'agent', '[]', 1000)`,
    ).run();

    // Update content
    db.prepare("UPDATE memories SET content = 'lazy dog sleeps' WHERE id = 'm1'").run();

    // Old content should not match
    const oldRows = db.prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'fox'").all();
    expect(oldRows).toHaveLength(0);

    // New content should match
    const newRows = db
      .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'dog'")
      .all() as Array<{ content: string }>;
    expect(newRows).toHaveLength(1);
    expect(newRows[0]!.content).toBe("lazy dog sleeps");
  });

  it("trust_level CHECK constraint rejects invalid values", () => {
    initSchema(db, 1536);

    expect(() => {
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES ('m1', 'default', 'u1', 'test', 'invalid', 'semantic', 'agent', '[]', 1000)`,
      ).run();
    }).toThrow();
  });

  it("memory_type CHECK constraint rejects invalid values", () => {
    initSchema(db, 1536);

    expect(() => {
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES ('m1', 'default', 'u1', 'test', 'learned', 'invalid_type', 'agent', '[]', 1000)`,
      ).run();
    }).toThrow();
  });

  it("isVecAvailable() returns true after successful init", () => {
    initSchema(db, 1536);

    // On platforms with sqlite-vec support, this should be true
    // This test validates the flag is set correctly
    const available = isVecAvailable();
    expect(typeof available).toBe("boolean");

    // On this platform, sqlite-vec should load
    expect(available).toBe(true);
  });

  it("initSchema is idempotent -- calling twice does not error", () => {
    initSchema(db, 1536);
    expect(() => initSchema(db, 1536)).not.toThrow();

    // Tables still exist after second call
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories', 'sessions')",
      )
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(2);
  });

  // ── occurred_at additive column ──────────────────────────

  describe("occurred_at additive column", () => {
    /**
     * Build a `memories` table with the PRE-occurred_at column set (the
     * shape a live ~/.comis DB has before this phase). Deliberately omits
     * occurred_at so the additive path has something to add.
     */
    function createLegacyMemoriesTable(target: Database.Database): void {
      target.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          agent_id TEXT NOT NULL DEFAULT 'default',
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL DEFAULT 'semantic',
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        );
      `);
    }

    it("adds occurred_at to a pre-existing memories table WITHOUT it, non-destructively", () => {
      // Simulate a live DB created before the occurred_at feature — no occurred_at column.
      createLegacyMemoriesTable(db);
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES ('pre-1', 'default', 'u1', 'an existing fact', 'learned', 'semantic', 'agent', '[]', 1000)`,
      ).run();

      // Pre-condition: occurred_at is genuinely absent.
      const before = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(before).not.toContain("occurred_at");

      // The additive boot path must NOT throw on the live table...
      expect(() => ensureMemoryColumns(db)).not.toThrow();

      // ...and occurred_at is now present.
      const after = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(after).toContain("occurred_at");

      // The pre-existing row survives, carrying occurred_at = NULL (no backfill).
      const row = db
        .prepare("SELECT id, content, occurred_at FROM memories WHERE id = 'pre-1'")
        .get() as { id: string; content: string; occurred_at: number | null };
      expect(row.id).toBe("pre-1");
      expect(row.content).toBe("an existing fact");
      expect(row.occurred_at).toBeNull();
    });

    it("is idempotent -- a second add on a table that already has occurred_at does not error", () => {
      createLegacyMemoriesTable(db);
      ensureMemoryColumns(db); // first add
      // Second call must be a no-op (no `duplicate column name` error).
      expect(() => ensureMemoryColumns(db)).not.toThrow();
    });

    it("initSchema run twice on the same DB keeps occurred_at exactly once", () => {
      initSchema(db, 1536);
      expect(() => initSchema(db, 1536)).not.toThrow();
      const occurredCols = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).filter((c) => c.name === "occurred_at");
      expect(occurredCols).toHaveLength(1);
    });

    it("occurred_at is NULLABLE -- inserting a row without it succeeds", () => {
      initSchema(db, 1536);
      expect(() => {
        db.prepare(
          `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
           VALUES ('no-occ', 'default', 'u1', 'no event time', 'learned', 'semantic', 'agent', '[]', 1000)`,
        ).run();
      }).not.toThrow();

      const row = db
        .prepare("SELECT occurred_at FROM memories WHERE id = 'no-occ'")
        .get() as { occurred_at: number | null };
      expect(row.occurred_at).toBeNull();
    });

    it("occurred_at accepts an explicit epoch-ms event time distinct from created_at", () => {
      initSchema(db, 1536);
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, occurred_at)
         VALUES ('with-occ', 'default', 'u1', 'an event', 'learned', 'semantic', 'agent', '[]', 1700000000000, 1699000000000)`,
      ).run();

      const row = db
        .prepare("SELECT created_at, occurred_at FROM memories WHERE id = 'with-occ'")
        .get() as { created_at: number; occurred_at: number | null };
      expect(row.created_at).toBe(1700000000000);
      expect(row.occurred_at).toBe(1699000000000);
      // Distinct axes: record time != event time.
      expect(row.occurred_at).not.toBe(row.created_at);
    });
  });

  // ── observation additive columns ────────
  //
  // The column-flag data model (design §4.1): an observation is a `memories`
  // row with `proof_count IS NOT NULL` (NOT a separate table, NOT a
  // memory_type CHECK change). ensureMemoryColumns must add all 5 nullable
  // columns idempotently on a live DB that predates them (existing rows get
  // NULL), and initSchema must create the 2 partial indexes.

  describe("observation additive columns", () => {
    const OBS_COLS = ["proof_count", "source_ids", "consolidated_at", "confidence", "history"];

    /**
     * Build a `memories` table at the pre-observation shape (occurred_at present,
     * the 5 observation columns absent) — the shape a live ~/.comis DB has
     * after the occurred_at feature but before observations.
     */
    function createPreObservationTable(target: Database.Database): void {
      target.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          agent_id TEXT NOT NULL DEFAULT 'default',
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL DEFAULT 'semantic',
          source_who TEXT NOT NULL,
          source_channel TEXT,
          source_session_key TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          occurred_at INTEGER,
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        );
      `);
    }

    it("adds the five observation columns to a pre-existing table WITHOUT them, non-destructively", () => {
      createPreObservationTable(db);
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES ('pre-obs', 'default', 'u1', 'an existing raw fact', 'learned', 'semantic', 'agent', '[]', 1000)`,
      ).run();

      const before = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of OBS_COLS) expect(before).not.toContain(col);

      expect(() => ensureMemoryColumns(db)).not.toThrow();

      const after = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of OBS_COLS) expect(after).toContain(col);

      // The pre-existing row survives, all 5 observation columns NULL (no backfill).
      const row = db
        .prepare(
          "SELECT id, content, proof_count, source_ids, consolidated_at, confidence, history FROM memories WHERE id = 'pre-obs'",
        )
        .get() as Record<string, unknown>;
      expect(row.id).toBe("pre-obs");
      expect(row.content).toBe("an existing raw fact");
      expect(row.proof_count).toBeNull();
      expect(row.source_ids).toBeNull();
      expect(row.consolidated_at).toBeNull();
      expect(row.confidence).toBeNull();
      expect(row.history).toBeNull();
    });

    it("is idempotent -- a second add on a table that already has the observation columns does not error", () => {
      createPreObservationTable(db);
      ensureMemoryColumns(db); // first add
      expect(() => ensureMemoryColumns(db)).not.toThrow(); // second add is a no-op
    });

    it("initSchema run twice keeps each observation column exactly once", () => {
      initSchema(db, 1536);
      expect(() => initSchema(db, 1536)).not.toThrow();
      const cols = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of OBS_COLS) {
        expect(cols.filter((c) => c === col)).toHaveLength(1);
      }
    });

    it("creates the unconsolidated and observations partial indexes", () => {
      initSchema(db, 1536);
      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toContain("idx_memories_unconsol");
      expect(indexes).toContain("idx_memories_observations");
    });

    it("does NOT add a superseded_by column (deferred this phase)", () => {
      initSchema(db, 1536);
      const cols = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).not.toContain("superseded_by");
    });
  });

  // ── typed-observation additive columns ────────
  //
  // observation_kind / pattern_type are forward-only nullable ALTERs (the
  // occurred_at/proof_count precedent): O(1), no backfill, no CHECK. A live
  // ~/.comis DB that predates them gains the columns with existing rows NULL
  // (observation_kind NULL reads back as "merge", the default).

  describe("typed-observation additive columns", () => {
    const REASON_COLS = ["observation_kind", "pattern_type"];

    /**
     * Build a `memories` table at the pre-typed-observation shape (the
     * observation columns present, the 2 typed-observation columns absent) —
     * the shape a live ~/.comis DB has after observations but before typed observations.
     */
    function createPreReasoningTable(target: Database.Database): void {
      target.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          agent_id TEXT NOT NULL DEFAULT 'default',
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          memory_type TEXT NOT NULL DEFAULT 'semantic',
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
          updated_at INTEGER,
          expires_at INTEGER,
          has_embedding INTEGER NOT NULL DEFAULT 0
        );
      `);
    }

    it("adds observation_kind + pattern_type to a pre-existing table WITHOUT them, non-destructively (existing row -> NULL = merge)", () => {
      createPreReasoningTable(db);
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
         VALUES ('pre-reason', 'default', 'u1', 'an existing pre-typed-observation fact', 'learned', 'semantic', 'agent', '[]', 1000)`,
      ).run();

      const before = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of REASON_COLS) expect(before).not.toContain(col);

      expect(() => ensureMemoryColumns(db)).not.toThrow();

      const after = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of REASON_COLS) expect(after).toContain(col);

      // The pre-existing row survives; both new columns NULL (no backfill). A NULL
      // observation_kind is the on-disk representation of the "merge" default.
      const row = db
        .prepare("SELECT id, content, observation_kind, pattern_type FROM memories WHERE id = 'pre-reason'")
        .get() as Record<string, unknown>;
      expect(row.id).toBe("pre-reason");
      expect(row.content).toBe("an existing pre-typed-observation fact");
      expect(row.observation_kind).toBeNull();
      expect(row.pattern_type).toBeNull();
    });

    it("is idempotent -- a second ensureMemoryColumns on a table that already has the typed-observation columns does not error", () => {
      createPreReasoningTable(db);
      ensureMemoryColumns(db); // first add
      expect(() => ensureMemoryColumns(db)).not.toThrow(); // second add is a no-op
    });

    it("initSchema run twice keeps each typed-observation column exactly once", () => {
      initSchema(db, 1536);
      expect(() => initSchema(db, 1536)).not.toThrow();
      const cols = (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of REASON_COLS) {
        expect(cols.filter((c) => c === col)).toHaveLength(1);
      }
    });

    it("does NOT add a SQLite CHECK for observation_kind/pattern_type (the enum is the Zod domain type's job, no-CHECK ALTER precedent)", () => {
      initSchema(db, 1536);
      // The CREATE TABLE for `memories` is reconstructable from sqlite_master; the
      // new columns must appear WITHOUT a CHECK clause (a post-hoc ALTER CHECK is
      // unreliable across existing rows — Pattern 4).
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
          .get() as { sql: string }
      ).sql;
      // No "CHECK(observation_kind ...)" / "CHECK(pattern_type ...)" sub-clause.
      expect(/observation_kind[^,]*CHECK/i.test(sql)).toBe(false);
      expect(/pattern_type[^,]*CHECK/i.test(sql)).toBe(false);
    });
  });

  it("vec_memories dimension matches config", () => {
    initSchema(db, 384);

    if (!isVecAvailable()) return;

    // Insert a vector with correct dimensions (384)
    const float32 = new Float32Array(384);
    float32[0] = 1.0;

    expect(() => {
      db.prepare("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)").run(
        "test-id",
        float32,
      );
    }).not.toThrow();

    // Verify the entry exists
    const row = db
      .prepare("SELECT memory_id FROM vec_memories WHERE memory_id = ?")
      .get("test-id") as { memory_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.memory_id).toBe("test-id");
  });

  it("vec_memories rejects vectors with wrong dimensions", () => {
    initSchema(db, 384);

    if (!isVecAvailable()) return;

    // Try to insert a vector with wrong dimensions (1536 instead of 384)
    const wrongFloat32 = new Float32Array(1536);
    wrongFloat32[0] = 1.0;

    expect(() => {
      db.prepare("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)").run(
        "test-wrong",
        wrongFloat32,
      );
    }).toThrow();
  });

  it("accepts all valid trust_level values", () => {
    initSchema(db, 1536);

    const levels = ["system", "learned", "external"];
    for (const level of levels) {
      expect(() => {
        db.prepare(
          `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
           VALUES (?, 'default', 'u1', 'test', ?, 'semantic', 'agent', '[]', 1000)`,
        ).run(`m-${level}`, level);
      }).not.toThrow();
    }
  });

  it("accepts all valid memory_type values", () => {
    initSchema(db, 1536);

    const types = ["working", "episodic", "semantic", "procedural"];
    for (const type of types) {
      expect(() => {
        db.prepare(
          `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
           VALUES (?, 'default', 'u1', 'test', 'learned', ?, 'agent', '[]', 1000)`,
        ).run(`m-${type}`, type);
      }).not.toThrow();
    }
  });

  // ── initSchema returns per-instance vecAvailable ───────────────

  describe("initSchema return value", () => {
    it("returns { vecAvailable: boolean }", () => {
      const result = initSchema(db, 1536);
      expect(result).toBeDefined();
      expect(typeof result.vecAvailable).toBe("boolean");
    });

    it("returns vecAvailable: true when sqlite-vec loads", () => {
      const result = initSchema(db, 1536);
      // On this platform, sqlite-vec should load
      expect(result.vecAvailable).toBe(true);
    });

    it("returns consistent value across multiple calls on same db", () => {
      const result1 = initSchema(db, 1536);
      const result2 = initSchema(db, 1536);
      expect(result1.vecAvailable).toBe(result2.vecAvailable);
    });
  });

  // ── embeddingDimensions runtime assertion ───────────────────────

  describe("embeddingDimensions validation", () => {
    it("throws on embeddingDimensions = 0", () => {
      expect(() => initSchema(db, 0)).toThrow("Invalid embeddingDimensions");
    });

    it("throws on embeddingDimensions = -1", () => {
      expect(() => initSchema(db, -1)).toThrow("Invalid embeddingDimensions");
    });

    it("throws on embeddingDimensions = 1.5", () => {
      expect(() => initSchema(db, 1.5)).toThrow("Invalid embeddingDimensions");
    });

    it("throws on embeddingDimensions = NaN", () => {
      expect(() => initSchema(db, NaN)).toThrow("Invalid embeddingDimensions");
    });

    it("does not throw on valid embeddingDimensions = 1536", () => {
      expect(() => initSchema(db, 1536)).not.toThrow();
    });

    it("throws on embeddingDimensions = Infinity", () => {
      expect(() => initSchema(db, Infinity)).toThrow("Invalid embeddingDimensions");
    });
  });

  // ── system_prompt_reports table ─────────────────────────────────

  describe("system_prompt_reports table", () => {
    it("creates the system_prompt_reports table on initSchema", () => {
      initSchema(db, 1536);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='system_prompt_reports'",
        )
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe("system_prompt_reports");
    });

    it("creates the idx_spr_session index on initSchema", () => {
      initSchema(db, 1536);
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_spr_session'",
        )
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.name).toBe("idx_spr_session");
    });

    it("system_prompt_reports has the expected column shape", () => {
      initSchema(db, 1536);
      const columns = db
        .prepare("PRAGMA table_info(system_prompt_reports)")
        .all() as Array<{ name: string; notnull: number }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("agent_id");
      expect(colNames).toContain("tenant_id");
      expect(colNames).toContain("session_id");
      expect(colNames).toContain("run_id");
      expect(colNames).toContain("generated_at");
      expect(colNames).toContain("provider");
      expect(colNames).toContain("model");
      expect(colNames).toContain("system_chars");
      expect(colNames).toContain("system_sha256");
      expect(colNames).toContain("report_json");
    });
  });
});

// =====================================================================
// ensureEntityTables — the entity junction DDL
//
// Pitfall 1: a raw `new Database(":memory:")` does NOT enable FK enforcement,
// so `ON DELETE CASCADE` would silently no-op. These tests set
// `foreign_keys=ON` explicitly (production's openSqliteDatabase sets it for
// us — sqlite-adapter-base.ts:52).
// =====================================================================

describe("ensureEntityTables", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  const tableNames = (): string[] =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

  it("creates memory_entities and memory_entity_links after initSchema", () => {
    initSchema(db, 1536);
    const names = tableNames();
    expect(names).toContain("memory_entities");
    expect(names).toContain("memory_entity_links");
  });

  it("gives memory_entities the canonical_key column (the Pitfall-3 dedup key)", () => {
    initSchema(db, 1536);
    const cols = (
      db.prepare("PRAGMA table_info(memory_entities)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("canonical_name");
    expect(cols).toContain("canonical_key");
    expect(cols).toContain("mention_count");
    expect(cols).toContain("first_seen");
    expect(cols).toContain("last_seen");
  });

  it("declares ON DELETE CASCADE on memory_entity_links.memory_id -> memories(id)", () => {
    initSchema(db, 1536);
    const fks = db.prepare("PRAGMA foreign_key_list(memory_entity_links)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const memoryFk = fks.find((fk) => fk.table === "memories" && fk.from === "memory_id");
    expect(memoryFk).toBeDefined();
    expect(memoryFk!.on_delete).toBe("CASCADE");
  });

  it("UNIQUE-indexes (tenant_id, agent_id, canonical_key) so two scopes never collapse to one entity", () => {
    initSchema(db, 1536);
    db.prepare(
      `INSERT INTO memory_entities
         (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen)
       VALUES ('e1', 't1', 'a1', 'Istanbul', 'istanbul', 1, 1, 1)`,
    ).run();
    // Same (tenant, agent, canonical_key) → UNIQUE violation.
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_entities
             (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen)
           VALUES ('e2', 't1', 'a1', 'ISTANBUL', 'istanbul', 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
    // Different agent, same key → allowed (isolation: not a collision).
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_entities
             (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen)
           VALUES ('e3', 't1', 'a2', 'Istanbul', 'istanbul', 1, 1, 1)`,
        )
        .run(),
    ).not.toThrow();
  });

  it("cascades link deletion when the parent memory is deleted (no orphans)", () => {
    initSchema(db, 1536);
    db.prepare(
      `INSERT INTO memories (id, user_id, content, trust_level, source_who, created_at)
       VALUES ('m1', 'u1', 'about Istanbul', 'learned', 'agent', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_entities
         (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen)
       VALUES ('e1', 'default', 'default', 'Istanbul', 'istanbul', 1, 1, 1)`,
    ).run();
    db.prepare(`INSERT INTO memory_entity_links (memory_id, entity_id) VALUES ('m1', 'e1')`).run();

    const linkCount = (): number =>
      (db.prepare("SELECT COUNT(*) AS c FROM memory_entity_links").get() as { c: number }).c;
    expect(linkCount()).toBe(1);

    db.prepare("DELETE FROM memories WHERE id = 'm1'").run();
    expect(linkCount()).toBe(0);
    // The entity row itself survives (not cascade-deleted — RESEARCH Pitfall 7).
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_entities").get() as { c: number }).c,
    ).toBe(1);
  });

  it("is idempotent on a pre-existing DB (running it again on a populated DB is a no-op)", () => {
    initSchema(db, 1536);
    db.prepare(
      `INSERT INTO memory_entities
         (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen)
       VALUES ('e1', 't1', 'a1', 'Istanbul', 'istanbul', 1, 1, 1)`,
    ).run();
    // Re-running the DDL must not throw and must preserve existing rows.
    expect(() => ensureEntityTables(db)).not.toThrow();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_entities").get() as { c: number }).c,
    ).toBe(1);
    expect(tableNames()).toContain("memory_entity_links");
  });
});

// =====================================================================
// ensureTripleTable — the segregated
// bi-temporal `memory_triples` table: S/P/O + the four bi-temporal
// timestamps + occurred range + trust CHECK, tenant+agent on every row,
// created idempotently AFTER ensureCausalTables.
// =====================================================================

describe("ensureTripleTable", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  const tableNames = (): string[] =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

  const tripleCols = (): string[] =>
    (db.prepare("PRAGMA table_info(memory_triples)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );

  it("creates memory_triples after initSchema", () => {
    initSchema(db, 1536);
    expect(tableNames()).toContain("memory_triples");
  });

  it("gives memory_triples all 15 columns incl. S/P/O + the four bi-temporal timestamps + occurred range", () => {
    initSchema(db, 1536);
    const cols = tripleCols();
    // identity + scope
    expect(cols).toContain("id");
    expect(cols).toContain("tenant_id");
    expect(cols).toContain("agent_id");
    // S/P/O
    expect(cols).toContain("subject");
    expect(cols).toContain("predicate");
    expect(cols).toContain("object");
    // trust
    expect(cols).toContain("trust");
    // the FOUR bi-temporal timestamps
    expect(cols).toContain("t_valid_start");
    expect(cols).toContain("t_valid_end");
    expect(cols).toContain("t_ingested");
    expect(cols).toContain("expired_at");
    // occurred range
    expect(cols).toContain("t_occurred");
    expect(cols).toContain("t_occurred_end");
    // provenance + confidence
    expect(cols).toContain("source_memory_id");
    expect(cols).toContain("confidence");
    // id + 3 scope/identity (id, tenant_id, agent_id) + S/P/O (3) + trust (1)
    // + 4 bi-temporal stamps + 2 occurred range + source_memory_id + confidence = 15.
    expect(cols).toHaveLength(15);
  });

  it("marks tenant_id/agent_id/subject/predicate/object/trust/t_valid_start/t_ingested NOT NULL; the end-stamps nullable", () => {
    initSchema(db, 1536);
    const info = db.prepare("PRAGMA table_info(memory_triples)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const notNull = (name: string): boolean =>
      info.find((c) => c.name === name)?.notnull === 1;
    for (const required of [
      "id",
      "tenant_id",
      "agent_id",
      "subject",
      "predicate",
      "object",
      "trust",
      "t_valid_start",
      "t_ingested",
    ]) {
      expect(notNull(required), `${required} must be NOT NULL`).toBe(true);
    }
    // The "current truth"/history end-stamps + occurred range + provenance are nullable.
    for (const nullable of [
      "t_valid_end",
      "expired_at",
      "t_occurred",
      "t_occurred_end",
      "source_memory_id",
      "confidence",
    ]) {
      expect(notNull(nullable), `${nullable} must be nullable`).toBe(false);
    }
  });

  it("rejects an out-of-ladder trust via the CHECK constraint", () => {
    initSchema(db, 1536);
    // A valid trust inserts fine.
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_triples
             (id, tenant_id, agent_id, subject, predicate, object, trust, t_valid_start, t_ingested)
           VALUES ('tr1', 't1', 'a1', 's', 'p', 'o', 'learned', 1, 1)`,
        )
        .run(),
    ).not.toThrow();
    // An out-of-ladder trust is rejected at write.
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_triples
             (id, tenant_id, agent_id, subject, predicate, object, trust, t_valid_start, t_ingested)
           VALUES ('tr2', 't1', 'a1', 's', 'p', 'o', 'wildly-untrusted', 1, 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("declares ON DELETE CASCADE on source_memory_id -> memories(id)", () => {
    initSchema(db, 1536);
    const fks = db.prepare("PRAGMA foreign_key_list(memory_triples)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const memoryFk = fks.find((fk) => fk.table === "memories" && fk.from === "source_memory_id");
    expect(memoryFk).toBeDefined();
    expect(memoryFk!.on_delete).toBe("CASCADE");
  });

  it("creates the three triple indexes (current / validtime / subject)", () => {
    initSchema(db, 1536);
    const indexes = (
      db.prepare("PRAGMA index_list(memory_triples)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_triples_current");
    expect(indexes).toContain("idx_triples_validtime");
    expect(indexes).toContain("idx_triples_subject");
  });

  it("is idempotent -- initSchema twice (and a direct re-run) does not throw and preserves rows", () => {
    initSchema(db, 1536);
    db.prepare(
      `INSERT INTO memory_triples
         (id, tenant_id, agent_id, subject, predicate, object, trust, t_valid_start, t_ingested)
       VALUES ('tr1', 't1', 'a1', 's', 'p', 'o', 'system', 1, 1)`,
    ).run();
    expect(() => initSchema(db, 1536)).not.toThrow();
    expect(() => ensureTripleTable(db)).not.toThrow();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_triples").get() as { c: number }).c,
    ).toBe(1);
  });
});

// =====================================================================
// ensureUsefulnessTable — the additive `intent`
// bucket on `memory_usefulness`. Fresh DBs get the 4-col PK
// (tenant, agent, memory, intent) + an `intent TEXT NOT NULL DEFAULT ''`
// column; a pre-intent DB (the old 3-col PK + rows) gets a guarded
// ALTER ADD COLUMN (the PRAGMA table_info precedent) so existing rows
// survive AS the global ('') bucket — the headline PK-widening-on-
// existing-DB safety (RESEARCH Pitfall 3). Both paths gain the idempotent
// `idx_usefulness_intent` unique index so the adapter's 4-col ON CONFLICT
// target resolves on a pre-intent DB too.
// =====================================================================

describe("ensureUsefulnessTable intent column", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  /** Column names of `memory_usefulness`. */
  const usefulnessCols = (): string[] =>
    (
      db.prepare("PRAGMA table_info(memory_usefulness)").all() as Array<{ name: string }>
    ).map((c) => c.name);

  /** Index names on `memory_usefulness`. */
  const usefulnessIndexes = (): string[] =>
    (
      db.prepare("PRAGMA index_list(memory_usefulness)").all() as Array<{ name: string }>
    ).map((r) => r.name);

  /**
   * Hand-create the pre-intent `memory_usefulness` at the OLD 3-col-PK shape
   * (NO `intent` column) — the EXACT shape a live ~/.comis DB has from the
   * original usefulness feature but before per-intent buckets, INCLUDING the
   * `memory_id REFERENCES memories(id) ON DELETE CASCADE` FK (so the rebuild's
   * FK-preservation is exercised — not a stripped-down stand-in). Mirrors
   * `createPreReasoningTable`.
   */
  function createPre110UsefulnessTable(target: Database.Database): void {
    // The FK target. The real pre-intent `memory_usefulness.memory_id` REFERENCES
    // `memories(id)`, so the parent must exist for any usefulness
    // INSERT (FK enforced at DML under foreign_keys=ON) AND for the
    // transactional table-REBUILD to re-declare the FK. A minimal stand-in column
    // set suffices (these pre-intent tests never call initSchema, so no full-schema
    // memories row is inserted); seed the 'm1' parent every pre-intent test uses.
    target.exec(`CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '');`);
    target.prepare(`INSERT INTO memories (id, content) VALUES ('m1', 'a fact')`).run();
    target.exec(`
      CREATE TABLE memory_usefulness (
        tenant_id      TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        used_count     INTEGER NOT NULL DEFAULT 0,
        ignored_count  INTEGER NOT NULL DEFAULT 0,
        last_useful_at INTEGER,
        PRIMARY KEY (tenant_id, agent_id, memory_id)
      );
    `);
  }

  /** PK column names of `memory_usefulness` (PRAGMA table_info pk>0, in pk order). */
  const usefulnessPkColumns = (): string[] =>
    (
      db.prepare("PRAGMA table_info(memory_usefulness)").all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

  // --- FRESH DB: the 4-col PK + the intent column ---

  it("FRESH DB: adds an `intent` column (TEXT, NOT NULL, default '') after initSchema", () => {
    initSchema(db, 1536);
    const cols = usefulnessCols();
    expect(cols).toContain("intent");

    const intentCol = (
      db.prepare("PRAGMA table_info(memory_usefulness)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((c) => c.name === "intent");
    expect(intentCol).toBeDefined();
    expect(intentCol!.type).toBe("TEXT");
    expect(intentCol!.notnull).toBe(1);
    // The default is the global bucket '' (sqlite reports the literal incl. quotes).
    expect(intentCol!.dflt_value).toBe("''");
  });

  it("FRESH DB: the PRIMARY KEY is (tenant_id, agent_id, memory_id, intent) — two rows differing ONLY in intent on one (tenant,agent,memory) both persist", () => {
    initSchema(db, 1536);
    db.prepare(
      `INSERT INTO memories (id, user_id, content, trust_level, source_who, created_at)
       VALUES ('m1', 'u1', 'a fact', 'learned', 'agent', 1)`,
    ).run();

    // Two rows: same (tenant, agent, memory), DIFFERENT intent ('' global + 'temporal').
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', '', 3, 0, 100)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
           VALUES ('t1', 'a1', 'm1', 'temporal', 1, 0, 200)`,
        )
        .run(),
    ).not.toThrow(); // distinct intent → distinct PK row, not a collision

    const rows = db
      .prepare(
        "SELECT intent, used_count FROM memory_usefulness WHERE tenant_id='t1' AND agent_id='a1' AND memory_id='m1' ORDER BY intent",
      )
      .all() as Array<{ intent: string; used_count: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.intent)).toEqual(["", "temporal"]);

    // Re-inserting the SAME 4-col key DOES collide (the widened PK is still a PK).
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
           VALUES ('t1', 'a1', 'm1', 'temporal', 1, 0, 300)`,
        )
        .run(),
    ).toThrow();
  });

  it("FRESH DB: declares the idempotent idx_usefulness_intent UNIQUE index (the 4-col ON CONFLICT target for the adapter)", () => {
    initSchema(db, 1536);
    expect(usefulnessIndexes()).toContain("idx_usefulness_intent");
  });

  // --- pre-intent (existing) DB: the PK-widening-on-existing-DB safety (Pitfall 3) ---

  it("EXISTING (pre-intent) DB: a guarded ALTER adds `intent` with default '' WITHOUT corrupting the seeded row — the row survives as the GLOBAL bucket", () => {
    createPre110UsefulnessTable(db);
    // Seed a pre-intent row (intent absent — the column does not exist yet).
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', 3, 1, 555)`,
    ).run();

    // Pre-condition: no `intent` column on the pre-intent table.
    expect(usefulnessCols()).not.toContain("intent");

    expect(() => ensureUsefulnessTable(db)).not.toThrow();

    // The column was added with the '' default; the seeded row is intact and
    // reads back AS the global bucket (intent='') with its ORIGINAL counts —
    // no corruption, no row loss, no backfill of a non-'' intent.
    expect(usefulnessCols()).toContain("intent");
    const row = db
      .prepare(
        "SELECT used_count, ignored_count, last_useful_at, intent FROM memory_usefulness WHERE tenant_id='t1' AND agent_id='a1' AND memory_id='m1' AND intent=''",
      )
      .get() as
      | { used_count: number; ignored_count: number; last_useful_at: number | null; intent: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.used_count).toBe(3);
    expect(row!.ignored_count).toBe(1);
    expect(row!.last_useful_at).toBe(555);
    expect(row!.intent).toBe("");

    // Total rows unchanged — the existing row was NOT duplicated by the migration.
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_usefulness").get() as { c: number }).c,
    ).toBe(1);
  });

  it("EXISTING (pre-intent) DB: ensureUsefulnessTable genuinely WIDENS the PRIMARY KEY to 4-col (tenant,agent,memory,intent) — not just an ADD COLUMN that leaves the 3-col PK", () => {
    createPre110UsefulnessTable(db);
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', 3, 1, 555)`,
    ).run();
    // Pre-condition: the OLD 3-col PK.
    expect(usefulnessPkColumns()).toEqual(["tenant_id", "agent_id", "memory_id"]);

    ensureUsefulnessTable(db);

    // The PK is now the 4-col tuple — the table was rebuilt, not just ALTER-ADD'd.
    // (On the broken ADD-COLUMN-only code the PK stays 3-col and this FAILS.)
    expect(usefulnessPkColumns()).toEqual(["tenant_id", "agent_id", "memory_id", "intent"]);
    // The pre-intent row survives in the GLOBAL ('') bucket with its original counts.
    const row = db
      .prepare(
        "SELECT used_count, ignored_count, last_useful_at, intent FROM memory_usefulness WHERE tenant_id='t1' AND agent_id='a1' AND memory_id='m1'",
      )
      .get() as
      | { used_count: number; ignored_count: number; last_useful_at: number | null; intent: string }
      | undefined;
    expect(row).toEqual({ used_count: 3, ignored_count: 1, last_useful_at: 555, intent: "" });
  });

  it("EXISTING (pre-intent) DB: the migrated table lets the ADAPTER upsert BOTH the global '' bucket AND a per-intent bucket for the SAME memory without throwing — per-intent learning works on the existing fleet", async () => {
    // This is the regression the blocker describes: on the broken
    // ADD-COLUMN-only migration the surviving 3-col PK aborts the SECOND intent
    // bucket's upsert with `UNIQUE constraint failed`. It drives the REAL adapter
    // (createSqliteMemoryUsefulnessStore.recordUsage), the path the
    // old index-only test never exercised.
    createPre110UsefulnessTable(db);
    // A pre-intent row (no `intent` column yet) — the global signal a pre-intent DB carries.
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', 3, 0, 555)`,
    ).run();

    ensureUsefulnessTable(db); // the migration under test

    const store = createSqliteMemoryUsefulnessStore({ db });
    const scope = { tenantId: "t1", agentId: "a1", now: 1_000 } as const;

    // 1) Global ('') bucket: bumps the migrated pre-intent row (3 -> 4).
    const globalWrite = await store.recordUsage(["m1"], [], scope);
    expect(globalWrite.ok).toBe(true);

    // 2) A DIFFERENT intent bucket for the SAME memory. On the broken code this
    //    recordUsage returns err (UNIQUE constraint failed on the surviving 3-col
    //    PK) — the per-intent learning signal silently dies. After the rebuild it succeeds.
    const intentWrite = await store.recordUsage(["m1"], [], { ...scope, intent: "temporal" });
    expect(intentWrite.ok).toBe(true);

    // Both buckets coexist: the migrated global row (now used_count=4, last=1000)
    // AND a fresh 'temporal' row (used_count=1) — no clobber, no row loss.
    const rows = db
      .prepare(
        "SELECT intent, used_count, ignored_count, last_useful_at FROM memory_usefulness WHERE tenant_id='t1' AND agent_id='a1' AND memory_id='m1' ORDER BY intent",
      )
      .all() as Array<{
      intent: string;
      used_count: number;
      ignored_count: number;
      last_useful_at: number | null;
    }>;
    expect(rows).toEqual([
      { intent: "", used_count: 4, ignored_count: 0, last_useful_at: 1_000 },
      { intent: "temporal", used_count: 1, ignored_count: 0, last_useful_at: 1_000 },
    ]);
  });

  it("EXISTING (pre-intent) DB: the idx_usefulness_intent unique index is created and PRESERVES the memory_id -> memories(id) ON DELETE CASCADE FK across the rebuild", () => {
    createPre110UsefulnessTable(db);
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', 3, 1, 555)`,
    ).run();
    expect(usefulnessIndexes()).not.toContain("idx_usefulness_intent");

    ensureUsefulnessTable(db);

    expect(usefulnessIndexes()).toContain("idx_usefulness_intent");
    // The CASCADE FK survived the rebuild: deleting the parent memory drops the
    // usefulness row (foreign_keys=ON is set in beforeEach).
    db.prepare("DELETE FROM memories WHERE id='m1'").run();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_usefulness").get() as { c: number }).c,
    ).toBe(0);
  });

  // --- Idempotency on both paths ---

  it("is idempotent on a FRESH DB — running ensureUsefulnessTable twice is a no-op (the column-presence guard)", () => {
    initSchema(db, 1536);
    expect(() => ensureUsefulnessTable(db)).not.toThrow();
    // The `intent` column appears EXACTLY once.
    expect(usefulnessCols().filter((c) => c === "intent")).toHaveLength(1);
  });

  it("is idempotent on a pre-intent DB — a second ensureUsefulnessTable after the ALTER does not error and preserves the row", () => {
    createPre110UsefulnessTable(db);
    db.prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, used_count, ignored_count, last_useful_at)
       VALUES ('t1', 'a1', 'm1', 3, 1, 555)`,
    ).run();
    ensureUsefulnessTable(db); // first add (ALTER + index)
    expect(() => ensureUsefulnessTable(db)).not.toThrow(); // second is a no-op
    expect(usefulnessCols().filter((c) => c === "intent")).toHaveLength(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_usefulness").get() as { c: number }).c,
    ).toBe(1);
  });
});
