/**
 * Named graph SQLite schema DDL.
 *
 * Creates the `named_graphs` table that stores serialized pipeline graph
 * definitions for server-side persistence. Supports soft delete via
 * `deleted_at` column (NULL = active).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `named_graphs` table if it does not already exist.
 *
 * Includes:
 * - Partial index on (tenant_id, label) for active graphs only
 * - Index on tenant_id for list queries
 * - Soft delete via deleted_at column (NULL = active)
 *
 * Safe to call multiple times (idempotent via IF NOT EXISTS).
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function initNamedGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS named_graphs (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      agent_id    TEXT NOT NULL DEFAULT 'default',
      label       TEXT NOT NULL,
      nodes       TEXT NOT NULL,
      edges       TEXT NOT NULL,
      settings    TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_named_graphs_tenant
      ON named_graphs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_named_graphs_tenant_label
      ON named_graphs(tenant_id, label) WHERE deleted_at IS NULL;
  `);
}
