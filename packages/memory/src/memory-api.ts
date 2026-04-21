// SPDX-License-Identifier: Apache-2.0
/**
 * MemoryApi: Programmatic interface for memory inspection, search,
 * management, and guardrail enforcement.
 *
 * Provides programmatic access to memory with guardrail enforcement for
 * maxEntriesPerType and maxTotalEntries.
 *
 * This is the surface the CLI consumes for memory
 * inspection, search, and management operations.
 */

import type { MemoryEntry, MemorySearchResult, MemoryConfig, SessionKey } from "@comis/core";
import type Database from "better-sqlite3";
import type { SessionStore } from "./session-store.js";
import type { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import type { MemoryRow } from "./types.js";
import { rowToEntry, buildFilterClause, countRows, groupCountRows } from "./row-mapper.js";

// ── Filter & Scope Types ─────────────────────────────────────────────

/** Filters for inspecting memory entries. */
export interface InspectFilters {
  memoryType?: "working" | "episodic" | "semantic" | "procedural";
  trustLevel?: "system" | "learned" | "external";
  tags?: string[];
  createdAfter?: number;
  createdBefore?: number;
  tenantId?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Scope for bulk memory clearing.
 *
 * At least one scope field must be provided -- empty scope throws
 * a safety error to prevent accidental blanket wipes.
 *
 * Only 'external' trust level is allowed for bulk trust-based clearing.
 * System and learned entries require per-ID deletion.
 */
export interface ClearScope {
  sessionKey?: SessionKey;
  memoryType?: "working" | "episodic" | "semantic" | "procedural";
  trustLevel?: "external"; // Only external allowed for bulk clear
  olderThan?: number;
  tenantId?: string;
  agentId?: string;
}

/** Aggregate statistics about the memory system. */
export interface MemoryStats {
  totalEntries: number;
  byType: Record<string, number>;
  byTrustLevel: Record<string, number>;
  byAgent: Record<string, number>;
  totalSessions: number;
  embeddedEntries: number;
  dbSizeBytes: number;
  /** Epoch-ms timestamp of the oldest entry, or null if store is empty. */
  oldestCreatedAt: number | null;
}

/** Result returned by enforceGuardrails when entries are removed. */
export interface GuardrailResult {
  entriesRemoved: number;
  reason: string;
}

// ── MemoryApi Interface ──────────────────────────────────────────────

/** Programmatic interface for memory management. */
export interface MemoryApi {
  /** Inspect memory entries with filtering. */
  inspect(filters?: InspectFilters): MemoryEntry[];

  /** Search memory using hybrid search (delegates to adapter). */
  search(
    query: string,
    options?: { limit?: number; tenantId?: string; agentId?: string },
  ): Promise<MemorySearchResult[]>;

  /** Clear memory entries within a scoped range. Throws on empty scope. */
  clear(scope: ClearScope): number;

  /** Get aggregate statistics about the memory system. */
  stats(tenantId?: string, agentId?: string): MemoryStats;

  /** Enforce entry limits. Returns null if no action needed. */
  enforceGuardrails(tenantId?: string): GuardrailResult | null;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a MemoryApi bound to the given database, adapter, session store,
 * and memory config.
 *
 * The factory function pattern is consistent with createSessionStore and
 * createSecretManager from Phase 1.
 */
export function createMemoryApi(
  db: Database.Database,
  adapter: SqliteMemoryAdapter,
  sessionStore: SessionStore,
  config: MemoryConfig,
): MemoryApi {
  return {
    // ── inspect ─────────────────────────────────────────────────

    inspect(filters?: InspectFilters): MemoryEntry[] {
      const { clause, params } = buildFilterClause({
        memoryType: filters?.memoryType,
        trustLevel: filters?.trustLevel,
        tenantId: filters?.tenantId,
        agentId: filters?.agentId,
        createdAfter: filters?.createdAfter,
        createdBefore: filters?.createdBefore,
      });

      const limit = filters?.limit ?? 100;
      const offset = filters?.offset ?? 0;

      // Filter expired entries at query time
      const expiryCondition = "(expires_at IS NULL OR expires_at > ?)";
      let fullClause: string;
      if (clause) {
        // clause is "WHERE cond1 AND cond2 ..." -- append expiry filter
        fullClause = `${clause} AND ${expiryCondition}`;
      } else {
        fullClause = `WHERE ${expiryCondition}`;
      }
      params.push(Date.now());

      const sql = `SELECT * FROM memories ${fullClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as MemoryRow[];
      let entries = rows.map((row) => rowToEntry(row));

      // Post-filter by tags if specified (tags are JSON-encoded in DB)
      if (filters?.tags && filters.tags.length > 0) {
        entries = entries.filter((entry) => filters.tags!.every((tag) => entry.tags.includes(tag)));
      }

      return entries;
    },

    // ── search ──────────────────────────────────────────────────

    async search(
      query: string,
      options?: { limit?: number; tenantId?: string; agentId?: string },
    ): Promise<MemorySearchResult[]> {
      const tenantId = options?.tenantId ?? "default";
      const limit = options?.limit ?? 10;
      const agentId = options?.agentId;

      const sessionKey: SessionKey = {
        tenantId,
        userId: "api",
        channelId: "api",
      };

      const result = await adapter.search(sessionKey, query, { limit, agentId });

      if (!result.ok) {
        return [];
      }

      return result.value;
    },

    // ── clear ───────────────────────────────────────────────────

    clear(scope: ClearScope): number {
      // Safety: require at least one scope field to prevent accidental blanket wipe
      const hasScope =
        scope.sessionKey !== undefined ||
        scope.memoryType !== undefined ||
        scope.trustLevel !== undefined ||
        scope.olderThan !== undefined ||
        scope.tenantId !== undefined ||
        scope.agentId !== undefined;

      if (!hasScope) {
        throw new Error(
          "MemoryApi.clear() requires at least one scope field. " +
            "Use adapter.clear(sessionKey) for blanket tenant wipe.",
        );
      }

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (scope.tenantId) {
        conditions.push("tenant_id = ?");
        params.push(scope.tenantId);
      }

      if (scope.agentId) {
        conditions.push("agent_id = ?");
        params.push(scope.agentId);
      }

      if (scope.sessionKey) {
        conditions.push("tenant_id = ?");
        params.push(scope.sessionKey.tenantId);
      }

      if (scope.memoryType) {
        conditions.push("memory_type = ?");
        params.push(scope.memoryType);
      }

      if (scope.trustLevel) {
        conditions.push("trust_level = ?");
        params.push(scope.trustLevel);
      }

      if (scope.olderThan !== undefined) {
        conditions.push("created_at < ?");
        params.push(scope.olderThan);
      }

      // Protect system-trust entries from bulk clearing
      // (unless specifically scoped to a non-system trust level)
      if (!scope.trustLevel) {
        conditions.push("trust_level != 'system'");
      }

      const whereClause = conditions.join(" AND ");

      // First get IDs for vec_memories cleanup
      const ids = db
        .prepare(`SELECT id FROM memories WHERE ${whereClause}`)
        .all(...params) as Array<{ id: string }>;

      if (ids.length === 0) return 0;

      // Delete from vec_memories (no cascade on virtual tables)
      try {
        for (const { id } of ids) {
          db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
        }
      } catch {
        // vec_memories may not exist if sqlite-vec unavailable
      }

      // Delete from memories (FTS5 trigger handles memory_fts cleanup)
      const result = db.prepare(`DELETE FROM memories WHERE ${whereClause}`).run(...params);

      return result.changes;
    },

    // ── stats ───────────────────────────────────────────────────

    stats(tenantId?: string, agentId?: string): MemoryStats {
      const { clause: filterClause, params: filterParams } = buildFilterClause({
        tenantId,
        agentId,
      });
      const hasFilters = filterParams.length > 0;

      const total = countRows(db, "memories", filterClause, filterParams);
      const byType = groupCountRows(db, "memories", "memory_type", filterClause, filterParams);
      const byTrustLevel = groupCountRows(db, "memories", "trust_level", filterClause, filterParams);
      const byAgent = groupCountRows(db, "memories", "agent_id", filterClause, filterParams);

      // Sessions are not agent-scoped, only tenant-scoped
      const tenantOnlyClause = tenantId !== undefined ? "WHERE tenant_id = ?" : "";
      const tenantOnlyParams: unknown[] = tenantId !== undefined ? [tenantId] : [];
      const totalSessions = countRows(db, "sessions", tenantOnlyClause, tenantOnlyParams);

      // Oldest entry timestamp
      const oldestClause = hasFilters
        ? `SELECT MIN(created_at) as oldest FROM memories ${filterClause}`
        : "SELECT MIN(created_at) as oldest FROM memories";
      const oldestRow = db.prepare(oldestClause).get(...(hasFilters ? filterParams : [])) as { oldest: number | null };

      // Embedded entries
      const embeddedClause = hasFilters
        ? `${filterClause} AND has_embedding = 1`
        : "WHERE has_embedding = 1";
      const embeddedEntries = countRows(db, "memories", embeddedClause, filterParams);

      // Database size (page_count * page_size)
      const pageCount = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };

      return {
        totalEntries: total,
        byType,
        byTrustLevel,
        byAgent,
        totalSessions,
        embeddedEntries,
        dbSizeBytes: pageCount.page_count * pageSize.page_size,
        oldestCreatedAt: oldestRow.oldest,
      };
    },

    // ── enforceGuardrails ───────────────────────────────────────

    enforceGuardrails(tenantId?: string): GuardrailResult | null {
      const maxTotal = config.retention.maxEntries;

      // If no limits configured, nothing to enforce
      if (maxTotal <= 0) {
        return null;
      }

      const tenantFilter = tenantId !== undefined;
      const tenantClause = tenantFilter ? "WHERE tenant_id = ?" : "";
      const tenantParams: unknown[] = tenantFilter ? [tenantId] : [];

      // Check total entry count
      const totalRow = db
        .prepare(`SELECT COUNT(*) as count FROM memories ${tenantClause}`)
        .get(...tenantParams) as { count: number };

      if (totalRow.count <= maxTotal) {
        return null; // Within limits
      }

      const excess = totalRow.count - maxTotal;

      // Remove oldest non-system entries (system entries are protected)
      const tenantAndSystem = tenantFilter
        ? "WHERE tenant_id = ? AND trust_level != 'system'"
        : "WHERE trust_level != 'system'";

      // Get IDs of entries to remove (oldest first)
      const idsToRemove = db
        .prepare(`SELECT id FROM memories ${tenantAndSystem} ORDER BY created_at ASC LIMIT ?`)
        .all(...tenantParams, excess) as Array<{ id: string }>;

      if (idsToRemove.length === 0) {
        return null; // Only system entries remain, can't remove
      }

      // Delete from vec_memories first
      try {
        for (const { id } of idsToRemove) {
          db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
        }
      } catch {
        // vec_memories may not exist
      }

      // Delete from memories
      const placeholders = idsToRemove.map(() => "?").join(",");
      const deleteIds = idsToRemove.map((r) => r.id);

      const result = db
        .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
        .run(...deleteIds);

      return {
        entriesRemoved: result.changes,
        reason: `Total entries (${totalRow.count}) exceeded maxEntries limit (${maxTotal}). Removed ${result.changes} oldest non-system entries.`,
      };
    },
  };
}
