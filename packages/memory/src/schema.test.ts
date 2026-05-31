// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema, isVecAvailable, ensureMemoryColumns, ensureEntityTables } from "./schema.js";

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

  // ── occurred_at additive column (TEMP-01) ──────────────────────────

  describe("occurred_at additive column (TEMP-01)", () => {
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
      // Simulate a live DB created before Phase 81 — no occurred_at column.
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

  // ── observation additive columns (Phase 84 CONS-01/04/05/08) ────────
  //
  // The column-flag data model (design §4.1): an observation is a `memories`
  // row with `proof_count IS NOT NULL` (NOT a separate table, NOT a
  // memory_type CHECK change). ensureMemoryColumns must add all 5 nullable
  // columns idempotently on a live DB that predates them (existing rows get
  // NULL), and initSchema must create the 2 partial indexes.

  describe("observation additive columns (Phase 84)", () => {
    const OBS_COLS = ["proof_count", "source_ids", "consolidated_at", "confidence", "history"];

    /**
     * Build a `memories` table at the PRE-Phase-84 shape (occurred_at present,
     * the 5 observation columns absent) — the shape a live ~/.comis DB has
     * after Phase 81 but before this phase.
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
// ensureEntityTables — the entity junction DDL (Phase 83 ENT-01/03/04/05)
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

  it("UNIQUE-indexes (tenant_id, agent_id, canonical_key) so two scopes never collapse to one entity (ENT-03)", () => {
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

  it("cascades link deletion when the parent memory is deleted (ENT-04, no orphans)", () => {
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
