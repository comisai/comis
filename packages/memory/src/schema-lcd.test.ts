// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the lcd_memory_provenance DDL in schema-lcd.ts.
 *
 * They verify:
 *   1. DDL creates the table with all 9 required columns (idempotent).
 *   2. ON DELETE CASCADE: deleting a memories row removes its provenance row.
 *   3. ON DELETE SET NULL: deleting the subsuming memory (superseded_by)
 *      sets superseded_by to NULL on the provenance row, not deleting it.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureLcdTables } from "./schema-lcd.js";
import { initSchema } from "./schema.js";

describe("lcd_memory_provenance DDL", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Enable foreign keys — mirrors sqlite-adapter-base.ts:52
    db.pragma("foreign_keys = ON");
    // Create the memories table (needed for FKs from lcd_memory_provenance)
    initSchema(db, 1536);
    // Create LCD tables (adds lcd_memory_provenance when patch lands)
    ensureLcdTables(db);
  });

  // ── Test 1: Column presence ──────────────────────────────────────────────

  it("creates lcd_memory_provenance with all 9 required columns", () => {
    const columns = db
      .prepare("PRAGMA table_info('lcd_memory_provenance')")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

    const names = columns.map((c) => c.name);

    expect(names, "provenance_id column must exist").toContain("provenance_id");
    expect(names, "memory_id column must exist").toContain("memory_id");
    expect(names, "summary_id column must exist").toContain("summary_id");
    expect(names, "source_session_key column must exist").toContain("source_session_key");
    expect(names, "conversation_id column must exist").toContain("conversation_id");
    expect(names, "agent_id column must exist").toContain("agent_id");
    expect(names, "tenant_id column must exist").toContain("tenant_id");
    expect(names, "created_at column must exist").toContain("created_at");
    expect(names, "superseded_by column must exist").toContain("superseded_by");

    // Exactly 9 columns
    expect(columns.length, "exactly 9 columns").toBe(9);

    // provenance_id is PRIMARY KEY
    const pkCol = columns.find((c) => c.name === "provenance_id");
    expect(pkCol?.pk, "provenance_id must be primary key").toBe(1);
  });

  // ── Test 2: ON DELETE CASCADE (memory_id FK) ────────────────────────────

  it("deletes provenance row when referenced memories row is deleted (ON DELETE CASCADE)", () => {
    // Insert a memories row with the full non-nullable column set
    db.prepare(
      `INSERT INTO memories (id, content, trust_level, memory_type, user_id, tenant_id, agent_id, source_who, created_at)
       VALUES ('m1', 'test content', 'learned', 'episodic', 'u1', 't1', 'a1', 'test', 1234567890)`,
    ).run();

    // Insert a provenance row referencing m1
    db.prepare(
      `INSERT INTO lcd_memory_provenance
         (provenance_id, memory_id, summary_id, source_session_key, conversation_id, agent_id, tenant_id, created_at)
       VALUES ('p1', 'm1', 's1', 'sk1', 'c1', 'a1', 't1', 1234567890)`,
    ).run();

    // Verify the provenance row exists before delete
    const before = db
      .prepare("SELECT * FROM lcd_memory_provenance WHERE provenance_id = 'p1'")
      .all();
    expect(before.length, "provenance row must exist before delete").toBe(1);

    // Delete the memories row — CASCADE must remove the provenance row
    db.prepare("DELETE FROM memories WHERE id = 'm1'").run();

    // Provenance row must be gone
    const after = db
      .prepare("SELECT * FROM lcd_memory_provenance WHERE provenance_id = 'p1'")
      .all();
    expect(after.length, "provenance row must be deleted by CASCADE").toBe(0);
  });

  // ── Test 3: ON DELETE SET NULL (superseded_by FK) ───────────────────────

  it("sets superseded_by to NULL when the subsuming memory is deleted (ON DELETE SET NULL)", () => {
    // Insert two memories: M_base (the one whose provenance row we track)
    // and M_subsuming (the one that supersedes it)
    db.prepare(
      `INSERT INTO memories (id, content, trust_level, memory_type, user_id, tenant_id, agent_id, source_who, created_at)
       VALUES ('m_base', 'base content', 'learned', 'episodic', 'u1', 't1', 'a1', 'test', 1234567890)`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, content, trust_level, memory_type, user_id, tenant_id, agent_id, source_who, created_at)
       VALUES ('m_subsuming', 'subsuming content', 'learned', 'episodic', 'u1', 't1', 'a1', 'test', 1234567891)`,
    ).run();

    // Insert provenance row for m_base, marked as superseded by m_subsuming
    db.prepare(
      `INSERT INTO lcd_memory_provenance
         (provenance_id, memory_id, summary_id, source_session_key, conversation_id, agent_id, tenant_id, created_at, superseded_by)
       VALUES ('p2', 'm_base', 's2', 'sk1', 'c1', 'a1', 't1', 1234567890, 'm_subsuming')`,
    ).run();

    // Verify superseded_by is set before delete
    const before = db
      .prepare("SELECT superseded_by FROM lcd_memory_provenance WHERE provenance_id = 'p2'")
      .get() as { superseded_by: string | null } | undefined;
    expect(before?.superseded_by, "superseded_by must be set before delete").toBe("m_subsuming");

    // Delete the SUBSUMING memory — SET NULL must fire on provenance.superseded_by
    db.prepare("DELETE FROM memories WHERE id = 'm_subsuming'").run();

    // Provenance row must still exist, superseded_by set to NULL
    const after = db
      .prepare("SELECT * FROM lcd_memory_provenance WHERE provenance_id = 'p2'")
      .all() as Array<{ provenance_id: string; superseded_by: string | null }>;
    expect(after.length, "provenance row must still exist (not deleted)").toBe(1);
    expect(after[0]?.superseded_by, "superseded_by must be NULL after subsuming memory delete").toBeNull();
  });

  // ── Test 4: Idempotency (CREATE IF NOT EXISTS) ───────────────────────────

  it("calling ensureLcdTables twice is idempotent (CREATE IF NOT EXISTS)", () => {
    // Should not throw on re-run
    expect(() => ensureLcdTables(db)).not.toThrow();

    // Table still exists and columns are correct
    const columns = db
      .prepare("PRAGMA table_info('lcd_memory_provenance')")
      .all() as Array<{ name: string }>;
    expect(columns.length).toBe(9);
  });

  // ── Test 5: Indexes exist ────────────────────────────────────────────────

  it("creates all 4 indexes on lcd_memory_provenance", () => {
    const indexes = db
      .prepare("PRAGMA index_list('lcd_memory_provenance')")
      .all() as Array<{ name: string; origin: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames, "idx_prov_memory must exist").toContain("idx_prov_memory");
    expect(indexNames, "idx_prov_summary must exist").toContain("idx_prov_summary");
    expect(indexNames, "idx_prov_session must exist").toContain("idx_prov_session");
    expect(indexNames, "idx_prov_superseded must exist").toContain("idx_prov_superseded");
  });
});
