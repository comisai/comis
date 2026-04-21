// SPDX-License-Identifier: Apache-2.0
/**
 * NamedGraphStore — server-side pipeline graph persistence with SQLite storage.
 *
 * Factory function pattern: initializes schema, prepares all SQL statements once,
 * and returns a frozen NamedGraphStore object. Maps between camelCase domain
 * fields and snake_case database columns.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { initNamedGraphSchema } from "./named-graph-schema.js";
import type { NamedGraphRow } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Full graph entry returned by load(). */
export interface NamedGraphEntry {
  id: string;
  tenantId: string;
  agentId: string;
  label: string;
  nodes: unknown[];
  edges: unknown[];
  settings: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Summary entry returned by list() — no full nodes/edges payload. */
export interface NamedGraphSummary {
  id: string;
  label: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Named graph store interface for CRUD operations. */
export interface NamedGraphStore {
  /** UPSERT a graph by id. Returns the id. */
  save(entry: {
    id: string;
    tenantId: string;
    agentId: string;
    label: string;
    nodes: unknown[];
    edges: unknown[];
    settings: unknown;
  }): string;

  /** Load a graph by id and tenantId. Returns undefined if not found or soft-deleted. */
  load(id: string, tenantId: string): NamedGraphEntry | undefined;

  /** List active graphs for a tenant with pagination. */
  list(tenantId: string, opts?: { limit?: number; offset?: number }): {
    entries: NamedGraphSummary[];
    total: number;
  };

  /** Soft-delete a graph. Returns true if a row was updated. */
  softDelete(id: string, tenantId: string): boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safely parse a JSON string, returning fallback on parse error. */
function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Safely parse a JSON string as an array and return its length. */
function safeJsonArrayLength(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Convert a snake_case database row to a camelCase NamedGraphEntry. */
function rowToEntry(row: NamedGraphRow): NamedGraphEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    label: row.label,
    nodes: safeJsonParse<unknown[]>(row.nodes, []),
    edges: safeJsonParse<unknown[]>(row.edges, []),
    settings: safeJsonParse<unknown>(row.settings, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a NamedGraphStore bound to the given database.
 *
 * Calls initNamedGraphSchema (idempotent) to ensure the named_graphs table
 * and indexes exist. Prepares all SQL statements once for performance.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns NamedGraphStore implementation
 */
export function createNamedGraphStore(db: Database.Database): NamedGraphStore {
  // Idempotent schema initialization
  initNamedGraphSchema(db);

  // Prepare all SQL statements once
  const upsertStmt = db.prepare(`
    INSERT INTO named_graphs (id, tenant_id, agent_id, label, nodes, edges, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      nodes = excluded.nodes,
      edges = excluded.edges,
      settings = excluded.settings,
      updated_at = excluded.updated_at
  `);

  const loadStmt = db.prepare(
    "SELECT * FROM named_graphs WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
  );

  const listStmt = db.prepare(
    "SELECT id, label, nodes, created_at, updated_at FROM named_graphs WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  );

  const countStmt = db.prepare(
    "SELECT COUNT(*) as total FROM named_graphs WHERE tenant_id = ? AND deleted_at IS NULL",
  );

  const softDeleteStmt = db.prepare(
    "UPDATE named_graphs SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
  );

  const store: NamedGraphStore = {
    save(entry) {
      const now = Date.now();
      upsertStmt.run(
        entry.id,
        entry.tenantId,
        entry.agentId,
        entry.label,
        JSON.stringify(entry.nodes),
        JSON.stringify(entry.edges),
        JSON.stringify(entry.settings),
        now,
        now,
      );
      return entry.id;
    },

    load(id, tenantId) {
      const row = loadStmt.get(id, tenantId) as NamedGraphRow | undefined;
      if (!row) return undefined;
      return rowToEntry(row);
    },

    list(tenantId, opts) {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;

      const rows = listStmt.all(tenantId, limit, offset) as Array<{
        id: string;
        label: string;
        nodes: string;
        created_at: number;
        updated_at: number;
      }>;

      const countRow = countStmt.get(tenantId) as { total: number };

      const entries: NamedGraphSummary[] = rows.map((row) => ({
        id: row.id,
        label: row.label,
        nodeCount: safeJsonArrayLength(row.nodes),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return { entries, total: countRow.total };
    },

    softDelete(id, tenantId) {
      const now = Date.now();
      const result = softDeleteStmt.run(now, id, tenantId);
      return result.changes > 0;
    },
  };

  return Object.freeze(store);
}
