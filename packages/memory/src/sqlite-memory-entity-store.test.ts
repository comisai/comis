// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryEntityStore` — the @comis/memory adapter
 * for the `MemoryEntityStore` port (Phase 83, ENT-01/02/03/04/05).
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB so
 * that `PRAGMA foreign_keys = ON` is set (via `openSqliteDatabase`) — a raw
 * `new Database(":memory:")` would have FKs OFF and the ON DELETE CASCADE
 * (ENT-04) would silently no-op (RESEARCH Pitfall 1). Memories are seeded via
 * `adapter.store(...)` so the `memories(id)` rows exist for the link FK, the
 * lane JOIN, and CASCADE-on-delete.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryEntityStore } from "./sqlite-memory-entity-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fixtures (mirrors test/integration/security/trust-partitioned-rag.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: overrides.tenantId ?? "tenant_a",
    agentId: overrides.agentId ?? "agent_a",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
  };
}

const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_a", now: 1_000 } as const;

describe("createSqliteMemoryEntityStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteMemoryEntityStore>;

  /** Count memory_entities rows (reuse-vs-create assertion). */
  function entityCount(): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_entities")
      .get() as { c: number };
    return row.c;
  }

  /** Read a single entity row by id (mention_count / last_seen assertions). */
  function entityRow(
    id: string,
  ): { mention_count: number; last_seen: number; canonical_name: string } | undefined {
    return db
      .prepare(
        "SELECT mention_count, last_seen, canonical_name FROM memory_entities WHERE id = ?",
      )
      .get(id) as
      | { mention_count: number; last_seen: number; canonical_name: string }
      | undefined;
  }

  /** Count link rows for a memory id (CASCADE assertion). */
  function linkCount(memoryId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memory_entity_links WHERE memory_id = ?")
      .get(memoryId) as { c: number };
    return row.c;
  }

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteMemoryEntityStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // Task 1 — resolveAndLink
  // =====================================================================

  describe("resolveAndLink", () => {
    it("creates an entity + a link row on first mention (scoped to tenant+agent)", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const res = await store.resolveAndLink(m1, "Alice", SCOPE_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(entityCount()).toBe(1);
      expect(linkCount(m1)).toBe(1);

      const row = entityRow(res.value);
      expect(row).toBeDefined();
      expect(row?.mention_count).toBe(1);
      expect(row?.last_seen).toBe(SCOPE_A.now);
      expect(row?.canonical_name).toBe("Alice"); // display form preserved
    });

    it("REUSES the same entity for a case/accent/script variant — no duplicate row, bumps mention_count + last_seen", async () => {
      const m1 = await seedMemory({ id: "m1" });
      const m2 = await seedMemory({ id: "m2" });

      const first = await store.resolveAndLink(m1, "İSTANBUL", SCOPE_A);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // "istanbul" folds to the SAME canonical_key as "İSTANBUL" (Unicode NFKD,
      // not sqlite lower()). Use a LATER `now` to prove last_seen is bumped.
      const second = await store.resolveAndLink(m2, "istanbul", {
        ...SCOPE_A,
        now: 2_000,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      // Same entity reused, NOT a new row.
      expect(second.value).toBe(first.value);
      expect(entityCount()).toBe(1);

      const row = entityRow(first.value);
      expect(row?.mention_count).toBe(2); // bumped
      expect(row?.last_seen).toBe(2_000); // updated to the latest mention
    });

    it("reuses on a near-duplicate typo (Dice >= 0.6); creates a new entity for an unrelated name", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const base = await store.resolveAndLink(m1, "Jonathan", SCOPE_A);
      expect(base.ok).toBe(true);
      if (!base.ok) return;

      // "Jonathon" vs "Jonathan" — a one-char typo, Dice bigram well above 0.6.
      const typo = await store.resolveAndLink(m1, "Jonathon", SCOPE_A);
      expect(typo.ok).toBe(true);
      if (!typo.ok) return;
      expect(typo.value).toBe(base.value); // fuzzy-reused
      expect(entityCount()).toBe(1);

      // An unrelated name — well below 0.6 — mints a new entity.
      const other = await store.resolveAndLink(m1, "Wolfgang", SCOPE_A);
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.value).not.toBe(base.value);
      expect(entityCount()).toBe(2);
    });

    it("isolates by scope — the SAME name in a DIFFERENT (tenant or agent) is a SEPARATE entity row", async () => {
      const mA = await seedMemory({ id: "mA", tenantId: "tenant_a", agentId: "agent_a" });
      const mB = await seedMemory({ id: "mB", tenantId: "tenant_b", agentId: "agent_a" });
      const mC = await seedMemory({ id: "mC", tenantId: "tenant_a", agentId: "agent_z" });

      const a = await store.resolveAndLink(mA, "Acme Corp", SCOPE_A);
      const b = await store.resolveAndLink(mB, "Acme Corp", {
        tenantId: "tenant_b",
        agentId: "agent_a",
        now: 1_000,
      });
      const c = await store.resolveAndLink(mC, "Acme Corp", {
        tenantId: "tenant_a",
        agentId: "agent_z",
        now: 1_000,
      });
      expect(a.ok && b.ok && c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;

      // Three distinct scopes -> three distinct entity rows for the same name.
      expect(new Set([a.value, b.value, c.value]).size).toBe(3);
      expect(entityCount()).toBe(3);
    });

    it("is idempotent on a repeated (memoryId, entityId) link — one link row", async () => {
      const m1 = await seedMemory({ id: "m1" });

      const first = await store.resolveAndLink(m1, "Repeated", SCOPE_A);
      const again = await store.resolveAndLink(m1, "Repeated", { ...SCOPE_A, now: 3_000 });
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;

      expect(again.value).toBe(first.value);
      // The link (m1, entity) is inserted twice but INSERT OR IGNORE keeps one.
      expect(linkCount(m1)).toBe(1);
      // mention_count still bumps even though the link was a no-op.
      expect(entityRow(first.value)?.mention_count).toBe(2);
    });
  });
});
