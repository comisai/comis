import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema, isVecAvailable } from "./schema.js";

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
});
