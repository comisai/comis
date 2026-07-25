// SPDX-License-Identifier: Apache-2.0
/**
 * Migration tests for `ensureOutcomeEventsTable` — the guarded additive
 * `procedure_descriptor` column must appear on BOTH a fresh DB (via the CREATE)
 * AND a pre-existing DB a prior build created WITHOUT the column (via a
 * PRAGMA-guarded `ALTER TABLE … ADD COLUMN`), forward-only + re-run-safe. The
 * pre-existing-DB path is the one that regresses SILENTLY: `CREATE TABLE IF NOT
 * EXISTS` is a no-op on an already-created table, so a CREATE-only column is
 * missing on every live `~/.comis/memory.db` — only the guarded ALTER adds it.
 *
 * The sha256 id tuple `(tenant_id, agent_id, trajectory_id, source, observed_at)`
 * that keys the ledger is UNTOUCHED — the descriptor is a content-free attribution
 * column, never part of any key/index.
 *
 * `outcome_events` has no FK, so a bare `new Database(":memory:")` is sufficient
 * (the sqlite-outcome-store.test.ts harness precedent — no seeded memories needed).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { ensureOutcomeEventsTable } from "./schema-outcome-events.js";

/** The column set of outcome_events (a one-off PRAGMA projection; test-file exempt from untyped-sqlite). */
function columns(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(outcome_events)`).all() as { name: string }[]).map((r) => r.name),
  );
}

/**
 * The PRE-migration outcome_events DDL — the exact shape a prior build created,
 * WITHOUT the `procedure_descriptor` column. `CREATE TABLE IF NOT EXISTS` is a
 * no-op against this table, so ONLY the guarded ALTER can add the column — this
 * is the path that regresses silently if the ALTER is missing.
 */
function createPreMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE outcome_events (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      trajectory_id   TEXT NOT NULL,
      outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','corrected','unknown')),
      source          TEXT NOT NULL CHECK (source IN ('tool','pipeline','correction','judge','reaction','explicit')),
      confidence      REAL NOT NULL DEFAULT 0.5,
      sender_trust    TEXT,
      recalled_ids    TEXT,
      used_skill_ids  TEXT,
      observed_at     INTEGER NOT NULL,
      UNIQUE (tenant_id, agent_id, trajectory_id, source, observed_at)
    );
  `);
}

describe("ensureOutcomeEventsTable — guarded additive procedure_descriptor column", () => {
  it("adds procedure_descriptor to a FRESH DB via the CREATE", () => {
    const db = new Database(":memory:");
    ensureOutcomeEventsTable(db);
    expect(columns(db).has("procedure_descriptor")).toBe(true);
    expect(columns(db).has("sender_trust_explicit")).toBe(true);
    db.close();
  });

  it("migrates a PRE-EXISTING (column-less) DB via the guarded ALTER — and is idempotent on re-run", () => {
    const db = new Database(":memory:");
    // A DB a prior build created WITHOUT the column — CREATE IF NOT EXISTS won't touch it.
    createPreMigrationTable(db);
    expect(columns(db).has("procedure_descriptor")).toBe(false);
    expect(columns(db).has("sender_trust_explicit")).toBe(false);

    // The migration adds the column (guarded ALTER) — no throw.
    expect(() => ensureOutcomeEventsTable(db)).not.toThrow();
    expect(columns(db).has("procedure_descriptor")).toBe(true);
    expect(columns(db).has("sender_trust_explicit")).toBe(true);

    // Re-running is a no-op: the PRAGMA guard skips the duplicate ADD COLUMN
    // (a bare re-ALTER would throw "duplicate column name").
    expect(() => ensureOutcomeEventsTable(db)).not.toThrow();
    expect(columns(db).has("procedure_descriptor")).toBe(true);
    expect(columns(db).has("sender_trust_explicit")).toBe(true);
    db.close();
  });

  it("leaves the sha256 id tuple UNIQUE (tenant_id, agent_id, trajectory_id, source, observed_at) intact", () => {
    const db = new Database(":memory:");
    ensureOutcomeEventsTable(db);
    const insert = db.prepare(
      "INSERT INTO outcome_events (id, tenant_id, agent_id, session_id, trajectory_id, outcome, source, confidence, observed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("id-1", "t", "a", "s", "traj", "success", "tool", 0.9, 1000);
    // A second row on the SAME (tenant, agent, trajectory, source, observed_at) tuple
    // (a different id) must STILL violate the UNIQUE backstop — the tuple is unchanged
    // by the additive descriptor column. A raw INSERT (no ON CONFLICT) throws SQLITE_CONSTRAINT.
    expect(() =>
      insert.run("id-2", "t", "a", "s", "traj", "failure", "tool", 0.9, 1000),
    ).toThrow(/UNIQUE/i);
    db.close();
  });
});
