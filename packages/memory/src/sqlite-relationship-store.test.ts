// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteRelationshipStore` — the SOLE @comis/memory adapter
 * for the `RelationshipStore` port. It owns ALL
 * the directional relationship SQL over the additive `relationship` table.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` runs — the `relationship` table is created on boot and
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase`, making the
 * `source_memory_id -> memories(id)` ON DELETE CASCADE fire) and gets
 * `adapter.getDb()`.
 *
 * ## The load-bearing security boundary (the §5.2 pattern,
 *    EXTENDED with `channelId` — the NEW privacy axis)
 *
 * Comis runs many agents, many channels, and many users in ONE DB. Every adapter
 * statement — INSERT, SELECT — filters
 * `WHERE tenant_id = ? AND agent_id = ? AND channel_id = ?` (bound params). A
 * relationship edge written under one (tenant, agent, channel) MUST NEVER be
 * returned for another scope — proven by the 4-way "scope isolation" describe
 * (cross-CHANNEL [the headline cross-channel axis], cross-tenant, AND cross-agent all
 * ABSENT, with a positive control). The directional `(subjectUserId, aboutUserId)`
 * pair is ROW DATA inside that scope, never the security filter, and is preserved
 * verbatim — A→B is a DISTINCT row from B→A (never symmetrized).
 *
 * ## The high-trust floor at the DB layer
 *
 * `trust='external'` can NEVER ENTER a relationship: the table's
 * `CHECK(trust IN ('system','learned'))` rejects it at the DB layer, and the
 * adapter's `upsert` rejects below-floor trust at the write boundary BEFORE the
 * INSERT (defense-in-depth — layers 1+3 of the 3-layer anti-poisoning defense; the
 * port-type layer is layer 2).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryConfig, RelationshipTrust } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { RelationshipRowSchema } from "./row-schemas.js";
import { createSqliteRelationshipStore } from "./sqlite-relationship-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // Phase 226: the recall keepers nest under memory.recall (design §5).
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

const T0 = 1_700_000_000_000;
// The in-scope write/read scopes (the positive control + the isolation baseline).
const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_x", channelId: "channel_x", now: T0 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_x", channelId: "channel_x" } as const;
// The THREE foreign read scopes — each differs from SCOPE_A on EXACTLY one axis.
// READ_FOREIGN_CHANNEL is THE headline cross-channel proof (the new axis).
const READ_FOREIGN_CHANNEL = { tenantId: "tenant_a", agentId: "agent_x", channelId: "channel_y" } as const;
const READ_FOREIGN_TENANT = { tenantId: "tenant_b", agentId: "agent_x", channelId: "channel_x" } as const;
const READ_FOREIGN_AGENT = { tenantId: "tenant_a", agentId: "agent_y", channelId: "channel_x" } as const;

describe("relationship DDL + RelationshipRowSchema", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;

  /** Count ALL rows in relationship (DDL assertions). */
  function relCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM relationship").get() as { c: number }).c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =====================================================================
  // DDL — the additive table + the high-trust CHECK (no 'external')
  // =====================================================================

  describe("DDL (relationship table + CHECK constraint)", () => {
    it("creates the relationship table on boot (initSchema ran, after ensureUserRepresentationTable)", () => {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationship'")
        .get();
      expect(row).toBeDefined();
    });

    it("creates the lead scope index idx_relationship_scope (tenant_id, agent_id, channel_id)", () => {
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_relationship_scope'")
        .get();
      expect(idx).toBeDefined();
    });

    it("REJECTS trust='external' at the DB layer (the high-trust floor — CHECK constraint failed)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO relationship (id, tenant_id, agent_id, channel_id, subject_user_id, about_user_id, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run("r1", "t", "a", "c", "u_subj", "u_about", "x", "external", 1),
      ).toThrow(/CHECK constraint failed/);
    });

    it("ACCEPTS a high-trust directional row (trust='learned', subject≠about)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO relationship (id, tenant_id, agent_id, channel_id, subject_user_id, about_user_id, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run("r2", "t", "a", "c", "u_subj", "u_about", "x", "learned", 1),
      ).not.toThrow();
      expect(relCount()).toBe(1);
    });

    it("ACCEPTS trust='system' (the other high-trust-floor value)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO relationship (id, tenant_id, agent_id, channel_id, subject_user_id, about_user_id, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run("r3", "t", "a", "c", "u_subj", "u_about", "x", "system", 1),
      ).not.toThrow();
      expect(relCount()).toBe(1);
    });
  });

  // =====================================================================
  // RelationshipRowSchema — the strictObject parse-projection guard
  // =====================================================================

  describe("RelationshipRowSchema (z.strictObject projection)", () => {
    it("ACCEPTS a well-formed scoped-read projection row", () => {
      const parsed = RelationshipRowSchema.safeParse({
        id: "r1",
        subject_user_id: "u_subj",
        about_user_id: "u_about",
        content: "A trusts B",
        trust: "learned",
        source_memory_id: null,
        created_at: 1,
        updated_at: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("REJECTS an unknown extra key (strictObject — no column drift)", () => {
      const parsed = RelationshipRowSchema.safeParse({
        id: "r1",
        subject_user_id: "u_subj",
        about_user_id: "u_about",
        content: "A trusts B",
        trust: "learned",
        source_memory_id: null,
        created_at: 1,
        updated_at: null,
        tenant_id: "leaked-scope-column", // not in the projection — must be rejected
      });
      expect(parsed.success).toBe(false);
    });

    it("REJECTS trust='external' (the row-schema enum mirrors the DB CHECK floor)", () => {
      const parsed = RelationshipRowSchema.safeParse({
        id: "r1",
        subject_user_id: "u_subj",
        about_user_id: "u_about",
        content: "A trusts B",
        trust: "external",
        source_memory_id: null,
        created_at: 1,
        updated_at: null,
      });
      expect(parsed.success).toBe(false);
    });
  });
});

describe("createSqliteRelationshipStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteRelationshipStore>;

  /** Count ALL rows in relationship (insert + isolation assertions). */
  function relCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM relationship").get() as { c: number }).c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteRelationshipStore({ db });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =====================================================================
  // CRUD — scoped directional round-trip + provenance + clock + row-mapper
  // =====================================================================

  describe("CRUD (scoped upsert/read)", () => {
    it("round-trips a directional edge: upsert(A→B) then read returns it with the typed shape", async () => {
      const r = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "A trusts B", trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(true);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(1);
      const e = res.value[0];
      expect(e?.subjectUserId).toBe("user_a");
      expect(e?.aboutUserId).toBe("user_b");
      expect(e?.content).toBe("A trusts B");
      expect(e?.trust).toBe("learned");
      expect(typeof e?.id).toBe("string");
      expect((e?.id ?? "").length).toBeGreaterThan(0);
      expect(e?.createdAt).toBe(T0); // the injected-clock now, NOT Date.now()
    });

    it("persists sourceMemoryId provenance when supplied (and omits it when absent)", async () => {
      // Seed a real memory so the source_memory_id FK target exists.
      const memId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, source_who, created_at) " +
          "VALUES (?,?,?,?,?,?,?,?)",
      ).run(memId, SCOPE_A.tenantId, SCOPE_A.agentId, "user_a", "src", "learned", "agent", T0);

      const withSrc = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "from-memory", trust: "learned", sourceMemoryId: memId },
        SCOPE_A,
      );
      expect(withSrc.ok).toBe(true);
      const noSrc = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_c", content: "no-source", trust: "learned" },
        SCOPE_A,
      );
      expect(noSrc.ok).toBe(true);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const a = res.value.find((e) => e.aboutUserId === "user_b");
      const b = res.value.find((e) => e.aboutUserId === "user_c");
      expect(a?.sourceMemoryId).toBe(memId);
      expect(b?.sourceMemoryId).toBeUndefined();
    });

    it("parses rows through createRowMapper — a returned entry has the exact typed shape (no drift)", async () => {
      await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "be concise", trust: "system" },
        SCOPE_A,
      );
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const entry = res.value[0];
      expect(entry).toBeDefined();
      // The exact mapped (camelCase) shape — strictObject rejected any extra column.
      expect(Object.keys(entry ?? {}).sort()).toEqual(
        ["aboutUserId", "content", "createdAt", "id", "subjectUserId", "trust"].sort(),
      );
    });

    it("never throws on a forced fault — a read after db.close() returns err", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteRelationshipStore({ db: localDb });
      localDb.close(); // force the prepared statement to fault

      const res = await localStore.read(READ_A);
      expect(res.ok).toBe(false);
    });

    it("never throws on a forced upsert fault — an upsert after db.close() returns err + WARNs counts-only", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const localStore = createSqliteRelationshipStore({ db: localDb, logger });
      localDb.close(); // force the prepared INSERT to fault inside the try/catch

      const r = await localStore.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "x", trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(false); // the outer try/catch caught it -> err, never a throw
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "relationship-upsert");
      expect(warn?.[0]).toMatchObject({ step: "relationship-upsert", errorKind: "internal" });
    });

    it("logs counts/metadata ONLY on a successful read — never the relationship content or user PII", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteRelationshipStore({ db, logger });
      await loggingStore.upsert(
        { subjectUserId: "SECRET-SUBJECT", aboutUserId: "SECRET-ABOUT", content: "SECRET-RELATIONSHIP-BODY", trust: "learned" },
        SCOPE_A,
      );
      logger.debug.mockClear();
      await loggingStore.read(READ_A);
      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "relationship-read");
      expect(call?.[0]).toMatchObject({ step: "relationship-read", count: 1 });
      expect(typeof call?.[0]?.durationMs).toBe("number");
      // Counts-only: the payload must NOT carry the content body OR the directional user pair.
      const payload = JSON.stringify(call?.[0] ?? {});
      expect(payload).not.toContain("SECRET-RELATIONSHIP-BODY");
      expect(payload).not.toContain("SECRET-SUBJECT");
      expect(payload).not.toContain("SECRET-ABOUT");
    });
  });

  // =====================================================================
  // Directional integrity — A→B and B→A are DISTINCT rows (never symmetrized)
  // =====================================================================

  describe("directional integrity (A→B ≠ B→A)", () => {
    it("seeds BOTH directions under one scope and reads BOTH back as distinct rows", async () => {
      const ab = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "A's view of B", trust: "learned" },
        SCOPE_A,
      );
      expect(ab.ok).toBe(true);
      const ba = await store.upsert(
        { subjectUserId: "user_b", aboutUserId: "user_a", content: "B's view of A", trust: "learned" },
        SCOPE_A,
      );
      expect(ba.ok).toBe(true);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // BOTH directions present, NOT collapsed/symmetrized into one row.
      expect(res.value).toHaveLength(2);
      const forward = res.value.find((e) => e.subjectUserId === "user_a" && e.aboutUserId === "user_b");
      const reverse = res.value.find((e) => e.subjectUserId === "user_b" && e.aboutUserId === "user_a");
      expect(forward?.content).toBe("A's view of B");
      expect(reverse?.content).toBe("B's view of A");
      // The contents are NOT swapped/merged — the pair is preserved verbatim.
      expect(forward?.content).not.toBe(reverse?.content);
    });
  });

  // =====================================================================
  // Write-boundary rejects — the high-trust floor (layer 3) + redaction firewall
  // =====================================================================

  describe("write-boundary rejects", () => {
    it("REJECTS a below-floor trust at the WRITE boundary (returns err, never throws; nothing persisted)", async () => {
      // Cast the forbidden value past the compile-time guard to exercise the
      // runtime reject (the port layer makes this unreachable in real callers).
      const r = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "x", trust: "external" as unknown as RelationshipTrust },
        SCOPE_A,
      );
      expect(r.ok).toBe(false);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0); // the reject ran BEFORE the INSERT
      expect(relCount()).toBe(0);
    });

    it("REJECTS a redaction-firewall hit at the WRITE boundary (a secret-shaped body returns err; nothing persisted; WARN logged)", async () => {
      // The adapter's OWN validateMemoryWrite belt — separate from the offline
      // builder's. A non-`clean` verdict is REJECTED (no `external` tier to
      // down-store into); the WARN branch (counts-only) fires with a logger present.
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteRelationshipStore({ db, logger });
      // A synthetic secret-shaped body the redaction firewall flags (NOT a real key).
      const SECRET_SHAPED = "token sk-abcdefghijklmnop1234 and AKIAIOSFODNN7EXAMPLE";
      const r = await loggingStore.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: SECRET_SHAPED, trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(false);

      // Nothing persisted (the reject ran BEFORE the INSERT).
      const res = await loggingStore.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
      expect(relCount()).toBe(0);

      // The WARN branch fired counts-only — and NEVER carries the secret-shaped body.
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "relationship-upsert");
      expect(warn?.[0]).toMatchObject({ step: "relationship-upsert", errorKind: "validation" });
      expect(JSON.stringify(warn?.[0] ?? {})).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });
  });

  // =====================================================================
  // Scope isolation — THE 4-way structural-impossibility proof
  // =====================================================================

  describe("(tenant, agent, channel) scope isolation — the cross-channel headline", () => {
    async function seedUnderScopeA(): Promise<void> {
      const r = await store.upsert(
        { subjectUserId: "user_a", aboutUserId: "user_b", content: "in-scope", trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(true);
    }

    it("a cross-CHANNEL read is ABSENT — an edge written under channel_x is not returned for channel_y (THE cross-channel proof)", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_CHANNEL);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("a cross-TENANT read is ABSENT — same (agent, channel), different tenant", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_TENANT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("a cross-AGENT read is ABSENT — same (tenant, channel), different agent (the A2 superset axis)", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_AGENT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("the in-scope read returns the edge (the positive control — isolation is not just 'always empty')", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.content).toBe("in-scope");
      expect(res.value[0]?.subjectUserId).toBe("user_a");
      expect(res.value[0]?.aboutUserId).toBe("user_b");
    });
  });
});
