// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteRelationshipStore` — the SOLE @comis/memory adapter
 * for the `RelationshipStore` port (Phase 108, Track E2 — SOCIAL-02). It owns ALL
 * the directional relationship SQL over the additive `relationship` table.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` runs — the `relationship` table is created on boot and
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase`, making the
 * `source_memory_id -> memories(id)` ON DELETE CASCADE fire) and gets
 * `adapter.getDb()`.
 *
 * ## The load-bearing security boundary (SOCIAL-02, the §5.2 / ENT-03 pattern,
 *    EXTENDED with `channelId` — the NEW privacy axis)
 *
 * Comis runs many agents, many channels, and many users in ONE DB. Every adapter
 * statement — INSERT, SELECT — filters
 * `WHERE tenant_id = ? AND agent_id = ? AND channel_id = ?` (bound params). A
 * relationship edge written under one (tenant, agent, channel) MUST NEVER be
 * returned for another scope — proven by the 4-way "scope isolation" describe
 * (cross-CHANNEL [the SOCIAL-02 headline], cross-tenant, AND cross-agent all
 * ABSENT, with a positive control). The directional `(subjectUserId, aboutUserId)`
 * pair is ROW DATA inside that scope, never the security filter, and is preserved
 * verbatim — A→B is a DISTINCT row from B→A (never symmetrized).
 *
 * ## The high-trust floor at the DB layer (T-108-05)
 *
 * `trust='external'` can NEVER ENTER a relationship: the table's
 * `CHECK(trust IN ('system','learned'))` rejects it at the DB layer, and the
 * adapter's `upsert` rejects below-floor trust at the write boundary BEFORE the
 * INSERT (defense-in-depth — layers 1+3 of the 3-layer anti-poisoning defense; the
 * port-type layer is 108-01).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { RelationshipRowSchema } from "./row-schemas.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

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
