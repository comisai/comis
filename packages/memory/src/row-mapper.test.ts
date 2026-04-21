// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry } from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rowToEntry,
  insertMemoryRow,
  storeEmbedding,
  buildFilterClause,
  countRows,
  groupCountRows,
  ALLOWED_TABLES,
  ALLOWED_GROUP_COLUMNS,
} from "./row-mapper.js";
import { initSchema, isVecAvailable } from "./schema.js";
import type { MemoryRow } from "./types.js";

const DIMS = 4;

// ── Test Fixtures ────────────────────────────────────────────────────

/** Create a complete MemoryRow with all fields populated. */
function makeRow(overrides?: Partial<MemoryRow>): MemoryRow {
  const defaults: MemoryRow = {
    id: "row-1",
    tenant_id: "default",
    agent_id: "default",
    user_id: "user-1",
    content: "test content",
    trust_level: "learned",
    memory_type: "semantic",
    source_who: "agent",
    source_channel: "telegram",
    source_session_key: "sess-123",
    tags: '["tag1","tag2"]',
    created_at: 1700000000000,
    updated_at: 1700001000000,
    expires_at: 1700090000000,
    has_embedding: 0,
  };
  return { ...defaults, ...overrides };
}

/** Create a minimal valid MemoryEntry. */
function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    tenantId: overrides?.tenantId ?? "default",
    agentId: overrides?.agentId ?? "default",
    userId: overrides?.userId ?? "user-1",
    content: overrides?.content ?? "test memory content",
    trustLevel: overrides?.trustLevel ?? "learned",
    source: overrides?.source ?? { who: "agent", channel: "telegram" },
    tags: overrides?.tags ?? [],
    createdAt: overrides?.createdAt ?? Date.now(),
    ...(overrides?.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides?.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides?.embedding ? { embedding: overrides.embedding } : {}),
  };
}

// ── rowToEntry ───────────────────────────────────────────────────────

describe("rowToEntry", () => {
  it("converts a complete MemoryRow with all fields populated", () => {
    const row = makeRow();
    const entry = rowToEntry(row);

    expect(entry.id).toBe("row-1");
    expect(entry.tenantId).toBe("default");
    expect(entry.agentId).toBe("default");
    expect(entry.userId).toBe("user-1");
    expect(entry.content).toBe("test content");
    expect(entry.trustLevel).toBe("learned");
    expect(entry.source.who).toBe("agent");
    expect(entry.source.channel).toBe("telegram");
    expect(entry.source.sessionKey).toBe("sess-123");
    expect(entry.tags).toEqual(["tag1", "tag2"]);
    expect(entry.createdAt).toBe(1700000000000);
    expect(entry.updatedAt).toBe(1700001000000);
    expect(entry.expiresAt).toBe(1700090000000);
  });

  it("converts a MemoryRow with null optional fields", () => {
    const row = makeRow({
      source_channel: null,
      source_session_key: null,
      updated_at: null,
      expires_at: null,
    });
    const entry = rowToEntry(row);

    expect(entry.source.channel).toBeUndefined();
    expect(entry.source.sessionKey).toBeUndefined();
    expect(entry.updatedAt).toBeUndefined();
    expect(entry.expiresAt).toBeUndefined();
  });

  it("includes embedding when provided", () => {
    const row = makeRow();
    const embedding = [0.1, 0.2, 0.3, 0.4];
    const entry = rowToEntry(row, embedding);

    expect(entry.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("omits embedding when not provided", () => {
    const row = makeRow();
    const entry = rowToEntry(row);

    expect(entry.embedding).toBeUndefined();
  });

  it("correctly parses JSON tags", () => {
    const row = makeRow({ tags: '["important","project-x","review"]' });
    const entry = rowToEntry(row);

    expect(entry.tags).toEqual(["important", "project-x", "review"]);
  });

  it("parses empty JSON tags array", () => {
    const row = makeRow({ tags: "[]" });
    const entry = rowToEntry(row);

    expect(entry.tags).toEqual([]);
  });
});

// ── insertMemoryRow ──────────────────────────────────────────────────

describe("insertMemoryRow", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a row with all fields", () => {
    const entry = makeEntry({
      id: "mem-1",
      tenantId: "tenant-a",
      agentId: "coder",
      userId: "user-42",
      content: "important fact",
      trustLevel: "system",
      source: { who: "admin", channel: "cli", sessionKey: "sk-1" },
      tags: ["critical"],
      createdAt: 1700000000000,
      updatedAt: 1700001000000,
      expiresAt: 1700090000000,
    });

    insertMemoryRow(db, entry, "semantic");

    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("mem-1") as MemoryRow;
    expect(row.id).toBe("mem-1");
    expect(row.tenant_id).toBe("tenant-a");
    expect(row.agent_id).toBe("coder");
    expect(row.user_id).toBe("user-42");
    expect(row.content).toBe("important fact");
    expect(row.trust_level).toBe("system");
    expect(row.memory_type).toBe("semantic");
    expect(row.source_who).toBe("admin");
    expect(row.source_channel).toBe("cli");
    expect(row.source_session_key).toBe("sk-1");
    expect(JSON.parse(row.tags)).toEqual(["critical"]);
    expect(row.created_at).toBe(1700000000000);
    expect(row.updated_at).toBe(1700001000000);
    expect(row.expires_at).toBe(1700090000000);
    expect(row.has_embedding).toBe(0);
  });

  it("defaults agentId to 'default' when undefined", () => {
    const entry = makeEntry({ id: "mem-2" });
    // Force agentId to undefined to test default path
    (entry as { agentId?: string }).agentId = undefined;

    insertMemoryRow(db, entry, "working");

    const row = db.prepare("SELECT agent_id FROM memories WHERE id = ?").get("mem-2") as {
      agent_id: string;
    };
    expect(row.agent_id).toBe("default");
  });

  it("handles null optional fields (source_channel, source_session_key, expires_at)", () => {
    const entry = makeEntry({
      id: "mem-3",
      source: { who: "agent" },
    });

    insertMemoryRow(db, entry, "episodic");

    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("mem-3") as MemoryRow;
    expect(row.source_channel).toBeNull();
    expect(row.source_session_key).toBeNull();
    expect(row.expires_at).toBeNull();
  });

  it("stores correct memory_type", () => {
    const entry = makeEntry({ id: "mem-4" });
    insertMemoryRow(db, entry, "procedural");

    const row = db.prepare("SELECT memory_type FROM memories WHERE id = ?").get("mem-4") as {
      memory_type: string;
    };
    expect(row.memory_type).toBe("procedural");
  });
});

// ── storeEmbedding ───────────────────────────────────────────────────

describe("storeEmbedding", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts embedding and sets has_embedding=1", () => {
    if (!isVecAvailable()) return;

    // First insert a memory row
    const entry = makeEntry({ id: "mem-embed-1" });
    insertMemoryRow(db, entry, "semantic");

    // Store embedding
    storeEmbedding(db, "mem-embed-1", [0.1, 0.2, 0.3, 0.4]);

    // Verify has_embedding flag
    const row = db.prepare("SELECT has_embedding FROM memories WHERE id = ?").get("mem-embed-1") as {
      has_embedding: number;
    };
    expect(row.has_embedding).toBe(1);

    // Verify vec_memories entry exists
    const vecRow = db
      .prepare("SELECT memory_id FROM vec_memories WHERE memory_id = ?")
      .get("mem-embed-1") as { memory_id: string } | undefined;
    expect(vecRow).toBeDefined();
    expect(vecRow!.memory_id).toBe("mem-embed-1");
  });

  it("stores correct float values in vec_memories", () => {
    if (!isVecAvailable()) return;

    const entry = makeEntry({ id: "mem-embed-2" });
    insertMemoryRow(db, entry, "semantic");
    storeEmbedding(db, "mem-embed-2", [0.5, 0.25, 0.75, 1.0]);

    const vecRow = db
      .prepare("SELECT embedding FROM vec_memories WHERE memory_id = ?")
      .get("mem-embed-2") as { embedding: Buffer } | undefined;
    expect(vecRow).toBeDefined();

    const float32 = new Float32Array(
      vecRow!.embedding.buffer,
      vecRow!.embedding.byteOffset,
      vecRow!.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    expect(float32[0]).toBeCloseTo(0.5, 4);
    expect(float32[1]).toBeCloseTo(0.25, 4);
    expect(float32[2]).toBeCloseTo(0.75, 4);
    expect(float32[3]).toBeCloseTo(1.0, 4);
  });

  it("no-ops when sqlite-vec is unavailable", () => {
    // This test verifies the function doesn't throw when vec is unavailable.
    // We can't easily mock isVecAvailable, but we verify it's called
    // by passing through without error. If vec IS available, this test
    // exercises the normal path instead.
    const entry = makeEntry({ id: "mem-embed-3" });
    insertMemoryRow(db, entry, "semantic");

    // Should not throw regardless of vec availability
    expect(() => storeEmbedding(db, "mem-embed-3", [0.1, 0.2, 0.3, 0.4])).not.toThrow();
  });
});

// ── buildFilterClause ────────────────────────────────────────────────

describe("buildFilterClause", () => {
  it("empty filters produce empty clause", () => {
    const result = buildFilterClause({});

    expect(result.clause).toBe("");
    expect(result.params).toEqual([]);
  });

  it("single filter produces correct WHERE clause", () => {
    const result = buildFilterClause({ tenantId: "t1" });

    expect(result.clause).toBe("WHERE tenant_id = ?");
    expect(result.params).toEqual(["t1"]);
  });

  it("multiple filters combine with AND", () => {
    const result = buildFilterClause({
      memoryType: "semantic",
      trustLevel: "learned",
      tenantId: "t1",
    });

    expect(result.clause).toBe("WHERE memory_type = ? AND trust_level = ? AND tenant_id = ?");
    expect(result.params).toEqual(["semantic", "learned", "t1"]);
  });

  it("params array matches clause placeholders", () => {
    const result = buildFilterClause({
      agentId: "coder",
      createdAfter: 1000,
      createdBefore: 2000,
    });

    const placeholderCount = (result.clause.match(/\?/g) ?? []).length;
    expect(placeholderCount).toBe(result.params.length);
    expect(result.params).toEqual(["coder", 1000, 2000]);
  });

  it("handles all filter types together", () => {
    const result = buildFilterClause({
      memoryType: "episodic",
      trustLevel: "system",
      tenantId: "t1",
      agentId: "bot",
      createdAfter: 100,
      createdBefore: 900,
      olderThan: 800,
    });

    expect(result.clause).toContain("WHERE");
    expect(result.clause).toContain("memory_type = ?");
    expect(result.clause).toContain("trust_level = ?");
    expect(result.clause).toContain("tenant_id = ?");
    expect(result.clause).toContain("agent_id = ?");
    expect(result.clause).toContain("created_at > ?");
    // createdBefore and olderThan both produce "created_at < ?"
    expect((result.clause.match(/created_at < \?/g) ?? []).length).toBe(2);
    expect(result.params).toHaveLength(7);
  });

  it("undefined values are skipped", () => {
    const result = buildFilterClause({
      memoryType: undefined,
      trustLevel: "external",
      tenantId: undefined,
    });

    expect(result.clause).toBe("WHERE trust_level = ?");
    expect(result.params).toEqual(["external"]);
  });
});

// ── countRows ───────────────────────────────────────────────────────

describe("countRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 for an empty table", () => {
    const count = countRows(db, "memories", "", []);
    expect(count).toBe(0);
  });

  it("returns correct count with entries", () => {
    insertMemoryRow(db, makeEntry({ id: "cr-1" }), "semantic");
    insertMemoryRow(db, makeEntry({ id: "cr-2" }), "episodic");
    insertMemoryRow(db, makeEntry({ id: "cr-3" }), "semantic");

    const count = countRows(db, "memories", "", []);
    expect(count).toBe(3);
  });

  it("filters correctly with WHERE clause", () => {
    insertMemoryRow(db, makeEntry({ id: "cr-4", tenantId: "t1" }), "semantic");
    insertMemoryRow(db, makeEntry({ id: "cr-5", tenantId: "t1" }), "episodic");
    insertMemoryRow(db, makeEntry({ id: "cr-6", tenantId: "t2" }), "semantic");

    const count = countRows(db, "memories", "WHERE tenant_id = ?", ["t1"]);
    expect(count).toBe(2);
  });
});

// ── groupCountRows ──────────────────────────────────────────────────

describe("groupCountRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty object for an empty table", () => {
    const result = groupCountRows(db, "memories", "memory_type", "", []);
    expect(result).toEqual({});
  });

  it("groups by memory_type correctly", () => {
    insertMemoryRow(db, makeEntry({ id: "gc-1" }), "semantic");
    insertMemoryRow(db, makeEntry({ id: "gc-2" }), "semantic");
    insertMemoryRow(db, makeEntry({ id: "gc-3" }), "episodic");
    insertMemoryRow(db, makeEntry({ id: "gc-4" }), "working");

    const result = groupCountRows(db, "memories", "memory_type", "", []);
    expect(result).toEqual({
      semantic: 2,
      episodic: 1,
      working: 1,
    });
  });

  it("filters groups with WHERE clause", () => {
    insertMemoryRow(db, makeEntry({ id: "gc-5", tenantId: "t1" }), "semantic");
    insertMemoryRow(db, makeEntry({ id: "gc-6", tenantId: "t1" }), "episodic");
    insertMemoryRow(db, makeEntry({ id: "gc-7", tenantId: "t2" }), "semantic");

    const result = groupCountRows(db, "memories", "memory_type", "WHERE tenant_id = ?", ["t1"]);
    expect(result).toEqual({
      semantic: 1,
      episodic: 1,
    });
  });
});

// ── Whitelist validation for table/column names ────────────────────

describe("countRows whitelist validation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("accepts 'memories' table", () => {
    expect(() => countRows(db, "memories", "", [])).not.toThrow();
  });

  it("accepts 'sessions' table", () => {
    expect(() => countRows(db, "sessions", "", [])).not.toThrow();
  });

  it("rejects invalid table name", () => {
    expect(() => countRows(db, "evil_table", "", [])).toThrow(
      'countRows: invalid table "evil_table"',
    );
  });

  it("rejects SQL injection in table name", () => {
    expect(() => countRows(db, "memories; DROP TABLE memories;--", "", [])).toThrow(
      "countRows: invalid table",
    );
  });
});

describe("groupCountRows whitelist validation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  it("accepts 'memory_type' column", () => {
    expect(() => groupCountRows(db, "memories", "memory_type", "", [])).not.toThrow();
  });

  it("accepts 'trust_level' column", () => {
    expect(() => groupCountRows(db, "memories", "trust_level", "", [])).not.toThrow();
  });

  it("accepts 'agent_id' column", () => {
    expect(() => groupCountRows(db, "memories", "agent_id", "", [])).not.toThrow();
  });

  it("rejects invalid column name", () => {
    expect(() => groupCountRows(db, "memories", "evil_column", "", [])).toThrow(
      'groupCountRows: invalid column "evil_column"',
    );
  });

  it("rejects invalid table name", () => {
    expect(() => groupCountRows(db, "evil_table", "memory_type", "", [])).toThrow(
      'groupCountRows: invalid table "evil_table"',
    );
  });
});

describe("whitelist exports", () => {
  it("ALLOWED_TABLES contains expected values", () => {
    expect(ALLOWED_TABLES.has("memories")).toBe(true);
    expect(ALLOWED_TABLES.has("sessions")).toBe(true);
    expect(ALLOWED_TABLES.size).toBe(2);
  });

  it("ALLOWED_GROUP_COLUMNS contains expected values", () => {
    expect(ALLOWED_GROUP_COLUMNS.has("memory_type")).toBe(true);
    expect(ALLOWED_GROUP_COLUMNS.has("trust_level")).toBe(true);
    expect(ALLOWED_GROUP_COLUMNS.has("agent_id")).toBe(true);
    expect(ALLOWED_GROUP_COLUMNS.size).toBe(3);
  });
});
