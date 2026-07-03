// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryEmbeddingStore` — the @comis/memory adapter
 * for the `MemoryEmbeddingStore` port.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` runs + the `vec_memories` vec0 table exists when sqlite-vec is
 * available) and seeds memories WITH embeddings through `adapter.store(...)`
 * (which writes the vector into `vec_memories`). `readEmbeddings(ids, scope)`
 * then LEFT JOINs `vec_memories` WITHIN the caller's (tenant, agent) scope and
 * returns id→vector.
 *
 * ## The load-bearing security boundary
 *
 * Because `readEmbeddings` returns raw VECTORS for a caller-supplied id set (an
 * identifying payload, not non-identifying distance scalars), the read MUST be
 * scope-isolated:
 * an id belonging to (tenant A, agent Y) requested under (tenant A, agent X) is
 * ABSENT from the returned Map — even though the id was passed in. The scoped
 * LEFT JOIN (`m.tenant_id = ? AND m.agent_id = ?`) is the fix, RED-tested below.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryEmbeddingStore } from "./sqlite-memory-embedding-store.js";
import * as schema from "./schema.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // The recall-related config keys nest under memory.recall.
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    rerankerModel: "hf:test/reranker.gguf",
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
  rerankerModelsDir: "models",
  rerankerGpu: "false",
  rerankerThreads: 4,
};

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? "tenant_a",
    agentId: overrides.agentId ?? "agent_x",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

const SCOPE_X = { tenantId: "tenant_a", agentId: "agent_x" } as const;
const SCOPE_Y = { tenantId: "tenant_a", agentId: "agent_y" } as const;

describe("createSqliteMemoryEmbeddingStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryEmbeddingStore>;

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryEmbeddingStore({ db });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =====================================================================
  // Scope isolation — the load-bearing security boundary
  // =====================================================================

  describe("(tenant, agent) scope isolation", () => {
    it("returns vectors for the caller's (tenant, agent) ONLY — a foreign-agent id requested is ABSENT", async () => {
      expect(schema.isVecAvailable()).toBe(true); // vec table backs the read

      const idX1 = await seedMemory({ id: "x1", agentId: "agent_x", embedding: [0.1, 0.2, 0.3, 0.4] });
      const idX2 = await seedMemory({ id: "x2", agentId: "agent_x", embedding: [0.4, 0.3, 0.2, 0.1] });
      // A DIFFERENT agent's memory in the SAME tenant, WITH an embedding.
      const idY1 = await seedMemory({
        id: "y1",
        agentId: "agent_y",
        embedding: [0.9, 0.8, 0.7, 0.6],
        content: "leak target",
      });

      // Request ALL THREE ids under (tenant_a, agent_x).
      const res = await store.readEmbeddings([idX1, idX2, idY1], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The scoped LEFT JOIN keeps the two in-scope ids, DROPS the foreign-agent
      // id — even though idY1 was explicitly passed in.
      expect(res.value.has(idX1)).toBe(true);
      expect(res.value.has(idX2)).toBe(true);
      expect(res.value.has(idY1)).toBe(false); // the leak that the scope prevents
      expect(res.value.size).toBe(2);
    });

    it("a second call under the OTHER agent returns only that agent's id", async () => {
      const idX1 = await seedMemory({ id: "x1", agentId: "agent_x", embedding: [0.1, 0.2, 0.3, 0.4] });
      const idY1 = await seedMemory({ id: "y1", agentId: "agent_y", embedding: [0.9, 0.8, 0.7, 0.6] });

      const resY = await store.readEmbeddings([idX1, idY1], SCOPE_Y);
      expect(resY.ok).toBe(true);
      if (!resY.ok) return;
      expect(resY.value.has(idY1)).toBe(true);
      expect(resY.value.has(idX1)).toBe(false); // agent_x's id is foreign to scope_Y
      expect(resY.value.size).toBe(1);
    });

    it("does NOT surface a cross-TENANT id at the SAME agent_id", async () => {
      const idX1 = await seedMemory({
        id: "x1",
        tenantId: "tenant_a",
        agentId: "agent_x",
        embedding: [0.1, 0.2, 0.3, 0.4],
      });
      const idCrossTenant = await seedMemory({
        id: "cross_tenant",
        tenantId: "tenant_b",
        agentId: "agent_x",
        embedding: [0.5, 0.5, 0.5, 0.5],
        content: "leak target",
      });

      const res = await store.readEmbeddings([idX1, idCrossTenant], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.has(idX1)).toBe(true);
      expect(res.value.has(idCrossTenant)).toBe(false); // cross-tenant → absent
      expect(res.value.size).toBe(1);
    });
  });

  // =====================================================================
  // Absent embedding (LEFT JOIN miss) — id present, no vec row → absent
  // =====================================================================

  describe("absent embedding", () => {
    it("an in-scope id with NO vec_memories row is ABSENT from the map (LEFT JOIN miss → decode undefined → skip)", async () => {
      const withEmb = await seedMemory({ id: "with_emb", embedding: [0.1, 0.2, 0.3, 0.4] });
      // No embedding → no vec_memories row (has_embedding stays 0).
      const noEmb = await seedMemory({ id: "no_emb" });

      const res = await store.readEmbeddings([withEmb, noEmb], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.has(withEmb)).toBe(true);
      expect(res.value.has(noEmb)).toBe(false); // present row, but no vector
      expect(res.value.size).toBe(1);
    });

    it("an id that does not exist at all is ABSENT (no row → not in the map)", async () => {
      const real = await seedMemory({ id: "real", embedding: [0.1, 0.2, 0.3, 0.4] });
      const res = await store.readEmbeddings([real, "does-not-exist"], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.has(real)).toBe(true);
      expect(res.value.has("does-not-exist")).toBe(false);
      expect(res.value.size).toBe(1);
    });
  });

  // =====================================================================
  // Round-trip — a stored embedding decodes back to the same float vector
  // =====================================================================

  describe("round-trip decode", () => {
    it("a stored embedding decodes back to the same float vector (within float32 tolerance)", async () => {
      const vec = [0.125, 0.25, 0.5, 0.75]; // exact float32-representable values
      const id = await seedMemory({ id: "rt", embedding: vec });

      const res = await store.readEmbeddings([id], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const got = res.value.get(id);
      expect(got).toBeDefined();
      expect(got).toHaveLength(4);
      for (let i = 0; i < vec.length; i++) {
        expect(got?.[i] ?? NaN).toBeCloseTo(vec[i]!, 6);
      }
    });
  });

  // =====================================================================
  // Empty input + vec-unavailable degrade → ok(empty Map), never throws
  // =====================================================================

  describe("empty input + vec-unavailable degrade", () => {
    it("empty id list → ok(empty Map) (no query runs)", async () => {
      const res = await store.readEmbeddings([], SCOPE_X);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.size).toBe(0);
    });

    it("when isVecAvailable() is false → ok(empty Map), never throws (no vec table → no vectors)", async () => {
      // Even with embedded rows present, a vec-off read degrades to empty.
      const id = await seedMemory({ id: "x1", embedding: [0.1, 0.2, 0.3, 0.4] });
      // Live-binding spy: the adapter imports isVecAvailable from this same module.
      vi.spyOn(schema, "isVecAvailable").mockReturnValue(false);

      const res = await store.readEmbeddings([id], SCOPE_X);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.size).toBe(0); // every id absent — MMR no-ops (byte-identity)
    });
  });

  // =====================================================================
  // Error path + structured logging (counts-only — §2.7)
  // =====================================================================

  describe("logging + error paths", () => {
    function spyLogger() {
      return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    }

    it("logs a counts-only step:'embedding-read' DEBUG on success (count + durationMs, never the vectors)", async () => {
      const logger = spyLogger();
      const loggingStore = createSqliteMemoryEmbeddingStore({ db, logger });
      const id = await seedMemory({ id: "x1", embedding: [0.1, 0.2, 0.3, 0.4] });

      logger.debug.mockClear();
      await loggingStore.readEmbeddings([id], SCOPE_X);
      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "embedding-read");
      expect(call?.[0]).toMatchObject({ step: "embedding-read", count: 1 });
      expect(typeof call?.[0]?.durationMs).toBe("number");
      // Counts-only: the payload must NOT carry vector values or the id list.
      const serialized = JSON.stringify(call?.[0] ?? {});
      expect(serialized).not.toContain("0.1");
      expect(serialized).not.toContain("x1");
    });

    it("returns err + logs a warn (errorKind + hint) when the read query throws", async () => {
      const logger = spyLogger();
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteMemoryEmbeddingStore({ db: localDb, logger });
      // Drop the memories table so the scoped JOIN throws.
      localDb.exec("DROP TABLE memories");

      const res = await localStore.readEmbeddings(["any"], SCOPE_X);
      expect(res.ok).toBe(false);
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "embedding-read");
      expect(warn).toBeDefined();
      expect(warn?.[0]).toMatchObject({ step: "embedding-read", errorKind: "internal" });
      expect(warn?.[0]?.err).toBeInstanceOf(Error);
      expect(typeof warn?.[0]?.hint).toBe("string");
      localDb.close();
    });
  });
});
