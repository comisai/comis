// SPDX-License-Identifier: Apache-2.0
// @allow-throw: session schema preflight rejects an authority-incomplete database before boot; initSchema is consumed at the daemon boundary.
import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

const REQUIRED_SESSION_COLUMNS = [
  "tenant_id",
  "agent_id",
  "conversation_ref",
  "canonical_scope",
  "messages",
  "created_at",
  "updated_at",
  "metadata",
] as const;

/** Create the authority-complete session table or reject an incompatible on-disk shape. */
export function ensureSessionTable(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).get() !== undefined;

  if (exists) {
    const columns = new Set(
      requireTableInfoRows(db.prepare("PRAGMA table_info(sessions)").all(), "sessions")
        .map((row) => row.name),
    );
    const missing = REQUIRED_SESSION_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `Session database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      canonical_scope TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, agent_id, conversation_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_authority_updated
      ON sessions(tenant_id, agent_id, updated_at DESC);
  `);
}
