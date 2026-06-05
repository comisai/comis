// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { ensurePinnedColumn } from "./schema-pinned.js";

describe("ensurePinnedColumn", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Minimal memories table — includes all columns referenced by the partial index
    // (tenant_id, agent_id, created_at DESC) so CREATE INDEX IF NOT EXISTS succeeds.
    db.exec(
      `CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
  });

  it("ensurePinnedColumn adds the pinned column to memories on first call", () => {
    ensurePinnedColumn(db);

    const cols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain("pinned");
  });

  it("ensurePinnedColumn is idempotent — second call does not throw or alter schema", () => {
    // First call adds the column + index.
    ensurePinnedColumn(db);
    // Second call must not throw (CREATE INDEX IF NOT EXISTS + PRAGMA guard).
    expect(() => ensurePinnedColumn(db)).not.toThrow();

    // Column still present after second call.
    const cols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain("pinned");
  });

  it("ensurePinnedColumn creates the partial index idx_memories_pinned where pinned=1", () => {
    ensurePinnedColumn(db);

    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_pinned'`,
      )
      .all() as { name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.name).toBe("idx_memories_pinned");
  });

  it("pinned column has a default value of 0 for newly inserted rows", () => {
    ensurePinnedColumn(db);

    db.prepare("INSERT INTO memories (id) VALUES ('test-row')").run();

    const row = db.prepare("SELECT pinned FROM memories WHERE id = 'test-row'").get() as {
      pinned: number;
    };
    expect(row.pinned).toBe(0);
  });
});
