// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry } from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  rowToEntry,
  insertMemoryRow,
  storeEmbedding,
  buildFilterClause,
  countRows,
  groupCountRows,
  ALLOWED_TABLES,
  ALLOWED_GROUP_COLUMNS,
  createRowMapper,
} from "./row-mapper.js";
import { initSchema, isVecAvailable } from "./schema.js";
import { MemoryRowSchema } from "./row-schemas.js";
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
    occurred_at: 1699000000000,
    proof_count: null,
    source_ids: null,
    consolidated_at: null,
    confidence: null,
    history: null,
    observation_kind: null,
    pattern_type: null,
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
    ...(overrides?.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
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
    expect(entry.occurredAt).toBe(1699000000000);
    expect(entry.updatedAt).toBe(1700001000000);
    expect(entry.expiresAt).toBe(1700090000000);
  });

  it("converts a MemoryRow with null optional fields", () => {
    const row = makeRow({
      source_channel: null,
      source_session_key: null,
      occurred_at: null,
      updated_at: null,
      expires_at: null,
    });
    const entry = rowToEntry(row);

    expect(entry.source.channel).toBeUndefined();
    expect(entry.source.sessionKey).toBeUndefined();
    expect(entry.occurredAt).toBeUndefined();
    expect(entry.updatedAt).toBeUndefined();
    expect(entry.expiresAt).toBeUndefined();
  });

  it("omits occurredAt entirely when occurred_at is null (conditional spread, not undefined)", () => {
    const row = makeRow({ occurred_at: null });
    const entry = rowToEntry(row);

    // Mirror the updatedAt/expiresAt pattern: the key must be ABSENT, not
    // present-with-undefined (so MemoryEntrySchema's .optional() stays clean).
    expect("occurredAt" in entry).toBe(false);
  });

  it("maps occurred_at -> occurredAt when present", () => {
    const row = makeRow({ created_at: 1700000000000, occurred_at: 1650000000000 });
    const entry = rowToEntry(row);

    expect(entry.occurredAt).toBe(1650000000000);
    // Distinct axes: event time != record time.
    expect(entry.occurredAt).not.toBe(entry.createdAt);
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
      occurredAt: 1699000000000,
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
    expect(row.occurred_at).toBe(1699000000000);
    expect(row.updated_at).toBe(1700001000000);
    expect(row.expires_at).toBe(1700090000000);
    expect(row.has_embedding).toBe(0);
  });

  it("writes occurred_at = NULL when the entry has no occurredAt", () => {
    const entry = makeEntry({ id: "mem-no-occ" });
    // makeEntry omits occurredAt unless explicitly overridden.
    expect("occurredAt" in entry).toBe(false);

    insertMemoryRow(db, entry, "semantic");

    const row = db
      .prepare("SELECT occurred_at FROM memories WHERE id = ?")
      .get("mem-no-occ") as { occurred_at: number | null };
    expect(row.occurred_at).toBeNull();
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

// ── occurred_at full round-trip through the strict schema ──
//
// This is the lockstep guard: domain MemoryEntry -> insertMemoryRow ->
// SELECT * -> MemoryRowSchema (z.strictObject) -> rowToEntry. If occurred_at
// were added to the table but NOT to MemoryRowSchema, the strict
// parse below would FAIL -> the adapter would skip every row -> recall would
// silently return []. These tests fail loudly instead.

describe("occurred_at round-trip (domain -> INSERT -> SELECT * -> rowToEntry)", () => {
  let db: Database.Database;
  const memoryRowMapper = createRowMapper(MemoryRowSchema);

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  function selectAndParse(id: string): MemoryRow {
    const raw = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    const parsed = memoryRowMapper.parseOptionalRow(raw);
    // The strict schema MUST accept the SELECT * shape (incl. occurred_at).
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`row parse failed: ${parsed.error.message}`);
    expect(parsed.value).toBeDefined();
    return parsed.value!;
  }

  it("preserves occurredAt when present (distinct from createdAt)", () => {
    const entry = makeEntry({
      id: "rt-present",
      createdAt: 1700000000000,
      occurredAt: 1699000000000,
    });
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse("rt-present");
    const back = rowToEntry(row);

    expect(back.occurredAt).toBe(1699000000000);
    expect(back.occurredAt).toBe(entry.occurredAt);
    expect(back.occurredAt).not.toBe(back.createdAt);
  });

  it("omits occurredAt after a round-trip when absent (occurred_at NULL)", () => {
    const entry = makeEntry({ id: "rt-absent" });
    expect("occurredAt" in entry).toBe(false);
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse("rt-absent");
    expect(row.occurred_at).toBeNull();

    const back = rowToEntry(row);
    expect("occurredAt" in back).toBe(false);
  });
});

// ── Observation columns full round-trip ────
//
// THE 4-WAY LOCKSTEP guard for the 5 observation columns: domain
// MemoryEntry -> insertMemoryRow -> SELECT * -> MemoryRowSchema
// (z.strictObject) -> rowToEntry. If proof_count/source_ids/
// consolidated_at/confidence/history are added to the table but NOT to
// MemoryRowSchema, the strict parse below FAILS -> the adapter skips the
// row -> recall silently returns []. These fail loudly instead. A column
// shift in insertMemoryRow's INSERT/VALUES/run triplet also surfaces here
// as a wrong-value mismatch.

describe("observation columns round-trip (domain -> INSERT -> SELECT * -> rowToEntry)", () => {
  let db: Database.Database;
  const memoryRowMapper = createRowMapper(MemoryRowSchema);

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  function selectAndParse(id: string): MemoryRow {
    const raw = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    const parsed = memoryRowMapper.parseOptionalRow(raw);
    // The strict schema MUST accept the SELECT * shape (incl. all 5 obs cols).
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`row parse failed: ${parsed.error.message}`);
    expect(parsed.value).toBeDefined();
    return parsed.value!;
  }

  it("preserves all five observation fields through a store/read cycle", () => {
    const src1 = crypto.randomUUID();
    const src2 = crypto.randomUUID();
    const entry: MemoryEntry = {
      ...makeEntry({ id: crypto.randomUUID(), createdAt: 1700000000000 }),
      proofCount: 3,
      sourceIds: [src1, src2],
      confidence: 0.8,
      consolidatedAt: 1700500000000,
      history: [{ previousContent: "x", changedAt: 1699000000000 }],
    };
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse(entry.id);
    const back = rowToEntry(row);

    expect(back.proofCount).toBe(3);
    expect(back.sourceIds).toEqual([src1, src2]);
    expect(back.confidence).toBe(0.8);
    expect(back.consolidatedAt).toBe(1700500000000);
    expect(back.history).toEqual([{ previousContent: "x", changedAt: 1699000000000 }]);
  });

  it("omits every observation key after a round-trip when all columns are NULL (raw memory)", () => {
    const entry = makeEntry({ id: "rt-raw" });
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse("rt-raw");
    expect(row.proof_count).toBeNull();
    expect(row.source_ids).toBeNull();
    expect(row.consolidated_at).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.history).toBeNull();

    const back = rowToEntry(row);
    expect("proofCount" in back).toBe(false);
    expect("sourceIds" in back).toBe(false);
    expect("consolidatedAt" in back).toBe(false);
    expect("confidence" in back).toBe(false);
    expect("history" in back).toBe(false);
  });

  it("degrades a corrupt source_ids JSON column to an absent field (never throws)", () => {
    const entry = makeEntry({ id: "rt-corrupt" });
    insertMemoryRow(db, entry, "semantic");
    // Simulate on-disk corruption of the JSON TEXT column.
    db.prepare("UPDATE memories SET source_ids = ? WHERE id = ?").run("{not-json", "rt-corrupt");

    const row = selectAndParse("rt-corrupt");
    expect(() => rowToEntry(row)).not.toThrow();
    const back = rowToEntry(row);
    expect("sourceIds" in back).toBe(false);
  });

  it("rejects an unknown extra column so the strict-reject guard stays intact", () => {
    // After adding 5 keys, MemoryRowSchema must still reject unknown columns
    // (z.strictObject) — proves we did not loosen the schema to strip extras.
    const base = makeRow();
    const withBogus = { ...base, bogus_col: "surprise" } as unknown;
    const parsed = MemoryRowSchema.safeParse(withBogus);
    expect(parsed.success).toBe(false);
  });
});

// ── Typed-observation columns full round-trip ──
//
// THE LOCKSTEP guard for the 2 typed-observation columns (observation_kind,
// pattern_type): domain MemoryEntry -> insertMemoryRow -> SELECT * ->
// MemoryRowSchema (z.strictObject) -> rowToEntry. If observation_kind/
// pattern_type are added to the table but NOT to MemoryRowSchema, the strict
// parse below FAILS -> the adapter skips the row -> recall silently returns [].
// These fail loudly instead. The third test is the ARG-SHIFT guard:
// a misaligned INSERT column/placeholder/run triplet would write a kind string
// into has_embedding or expires_at (an unrelated field) — asserting those two
// are unshifted catches it.

describe("typed-observation columns round-trip (domain -> INSERT -> SELECT * -> rowToEntry)", () => {
  let db: Database.Database;
  const memoryRowMapper = createRowMapper(MemoryRowSchema);

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  afterEach(() => {
    db.close();
  });

  function selectAndParse(id: string): MemoryRow {
    const raw = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    const parsed = memoryRowMapper.parseOptionalRow(raw);
    // The strict schema MUST accept the SELECT * shape (incl. the 2 new cols).
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`row parse failed: ${parsed.error.message}`);
    expect(parsed.value).toBeDefined();
    return parsed.value!;
  }

  it("preserves observationKind='inductive' AND patternType='preference' through a store/read cycle", () => {
    const entry: MemoryEntry = {
      ...makeEntry({ id: crypto.randomUUID(), createdAt: 1700000000000 }),
      observationKind: "inductive",
      patternType: "preference",
    };
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse(entry.id);
    expect(row.observation_kind).toBe("inductive");
    expect(row.pattern_type).toBe("preference");

    const back = rowToEntry(row);
    expect(back.observationKind).toBe("inductive");
    expect(back.patternType).toBe("preference");
  });

  it("reads back observationKind='merge' (NULL default) and NO patternType when both are omitted (legacy row behavior)", () => {
    const entry = makeEntry({ id: "rt-merge-default" });
    expect("observationKind" in entry).toBe(false);
    expect("patternType" in entry).toBe(false);
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse("rt-merge-default");
    // Both columns persist NULL when the entry omits the fields.
    expect(row.observation_kind).toBeNull();
    expect(row.pattern_type).toBeNull();

    const back = rowToEntry(row);
    // NULL observation_kind -> "merge" (the forward-only default for legacy rows).
    expect(back.observationKind).toBe("merge");
    // NULL pattern_type -> the key is ABSENT (conditional spread), not present-undefined.
    expect("patternType" in back).toBe(false);
  });

  it("does NOT shift has_embedding or expires_at when an inductive observation is inserted (arg-alignment guard)", () => {
    // A misaligned INSERT column/placeholder/run triplet would write the kind
    // string ("inductive") into has_embedding (the literal 0, last) or into
    // expires_at — corrupting an unrelated column. Assert both are intact.
    const entry: MemoryEntry = {
      ...makeEntry({ id: "rt-no-shift" }),
      observationKind: "inductive",
      patternType: "behavior",
    };
    // makeEntry omits expiresAt unless overridden -> expires_at must read NULL.
    expect("expiresAt" in entry).toBe(false);
    insertMemoryRow(db, entry, "semantic");

    const row = selectAndParse("rt-no-shift");
    expect(row.has_embedding).toBe(0);
    expect(row.expires_at).toBeNull();
    // And the new columns DID land where intended (positive control).
    expect(row.observation_kind).toBe("inductive");
    expect(row.pattern_type).toBe("behavior");
  });

  it("still rejects an unknown extra column after the 2 typed-observation columns are added (strict-reject intact)", () => {
    // Adding observation_kind/pattern_type must not loosen MemoryRowSchema:
    // z.strictObject must still reject an unknown column.
    const base = makeRow();
    const withBogus = { ...base, surprise_col: "x" } as unknown;
    expect(MemoryRowSchema.safeParse(withBogus).success).toBe(false);
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

// ── createRowMapper — generic factory ───────────────────────────────

describe("createRowMapper — generic factory", () => {
  // NOTE: 2 it() tests for parseRow (singular) were removed in a prior
  // port-trim cleanup along with the method itself. parseOptionalRow and
  // parseRows cover the surviving surface; the row-validation-failed path is
  // still exercised below.

  it("createRowMapper parseRows surfaces row index in error path on per-row failures", () => {
    const schema = z.strictObject({ id: z.string() });
    const mapper = createRowMapper(schema);
    const result = mapper.parseRows([{ id: "a" }, { id: "b" }, { id: 42 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.path).toContain("row[2]");
    expect(result.error.path).toContain("id");
    expect(result.error.code).toBe("row-validation-failed");
  });

  it("createRowMapper parseOptionalRow returns ok(undefined) for missing row", () => {
    const schema = z.strictObject({ id: z.string() });
    const mapper = createRowMapper(schema);
    const result = mapper.parseOptionalRow(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it("createRowMapper parseOptionalRow returns err for malformed row even when present", () => {
    const schema = z.strictObject({ id: z.string() });
    const mapper = createRowMapper(schema);
    const result = mapper.parseOptionalRow({ id: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("row-validation-failed");
  });

  it("createRowMapper parseRows returns ok with empty array for empty input", () => {
    const schema = z.strictObject({ id: z.string() });
    const mapper = createRowMapper(schema);
    const result = mapper.parseRows([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(0);
  });

});

// ── rowToEntry maps row.pinned=1 → entry.pinned=true ────────────
describe("rowToEntry — pinned field mapping", () => {
  it("rowToEntry maps row.pinned=1 to entry.pinned=true", () => {
    // Pre-patch: rowToEntry never maps pinned → entry.pinned is undefined.
    // Post-patch: row.pinned===1 → entry.pinned===true.
    // Cast through unknown to accommodate the pinned field that MemoryRow does not yet declare.
    const row = {
      id: "pin-row-1",
      tenant_id: "t1",
      agent_id: "agent-a",
      user_id: "user-1",
      content: "pinned content",
      trust_level: "learned",
      memory_type: "semantic",
      source_who: "agent",
      source_channel: null,
      source_session_key: null,
      tags: "[]",
      created_at: 1700000000000,
      occurred_at: null,
      proof_count: null,
      source_ids: null,
      consolidated_at: null,
      confidence: null,
      history: null,
      observation_kind: null,
      pattern_type: null,
      updated_at: null,
      expires_at: null,
      has_embedding: 0,
      pinned: 1,
    } as unknown as import("./types.js").MemoryRow;
    const entry = rowToEntry(row);
    expect(entry.pinned).toBe(true);
  });

  it("rowToEntry leaves entry.pinned absent when row.pinned=0", () => {
    // row.pinned=0 (unpinned) → entry.pinned should be absent/undefined (not false).
    const row = {
      id: "pin-row-2",
      tenant_id: "t1",
      agent_id: "agent-a",
      user_id: "user-1",
      content: "unpinned content",
      trust_level: "learned",
      memory_type: "semantic",
      source_who: "agent",
      source_channel: null,
      source_session_key: null,
      tags: "[]",
      created_at: 1700000000000,
      occurred_at: null,
      proof_count: null,
      source_ids: null,
      consolidated_at: null,
      confidence: null,
      history: null,
      observation_kind: null,
      pattern_type: null,
      updated_at: null,
      expires_at: null,
      has_embedding: 0,
      pinned: 0,
    } as unknown as import("./types.js").MemoryRow;
    const entry = rowToEntry(row);
    // Unpinned: pinned field should be absent (undefined), not true or false.
    expect(entry.pinned).toBeUndefined();
  });
});
