// SPDX-License-Identifier: Apache-2.0
// @allow-throw: MemoryApi.clear() requires non-empty scope to prevent accidental blanket wipe; throw is a guard rail consumed by the daemon RPC handler boundary (memory-handlers is @allow-throw).
// @allow-throw: MemoryApi.pin/unpin — fromPromise wraps the synchronous SQLite update; throw within the async wrapper is caught and returned as err().
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

import type { MemoryEntry, MemorySearchResult, MemoryConfig, SessionKey, SessionStorePort } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import type Database from "better-sqlite3";
import type { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { rowToEntry, buildFilterClause, countRows, groupCountRows, createRowMapper } from "./row-mapper.js";
import { MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";
import { systemNowMs } from "@comis/core";

// Row mappers
const memoryRowMapper = createRowMapper(MemoryRowSchema);
const idProjectionMapper = createRowMapper(IdProjectionRowSchema);

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

// ── MemoryApi Interface ──────────────────────────────────────────────

/** Programmatic interface for memory management. */
export interface MemoryApi {
  /** Inspect memory entries with filtering. */
  inspect(filters?: InspectFilters): MemoryEntry[];

  /**
   * Count ALL entries matching `filters`, IGNORING `limit` / `offset` — the
   * unpaginated total for a filtered browse. Applies the same trust/type/
   * tenant/agent/date filters (and the same expiry exclusion) as `inspect`, and
   * the same in-JS tag-intersection post-filter when `tags` is set. Callers use
   * it to drive pagination ("showing 1-25 of TOTAL") so the page length is never
   * mistaken for the total (the memory.browse Next-button bug).
   */
  count(filters?: InspectFilters): number;

  /** Search memory using hybrid search (delegates to adapter). */
  search(
    query: string,
    options?: { limit?: number; tenantId?: string; agentId?: string },
  ): Promise<MemorySearchResult[]>;

  /** Clear memory entries within a scoped range. Throws on empty scope. */
  clear(scope: ClearScope): number;

  /** Get aggregate statistics about the memory system. */
  stats(tenantId?: string, agentId?: string): MemoryStats;

  /** Pin a memory entry (always-inject in recall). Idempotent.
   *  Returns ok(true) if row found, ok(false) if not found (not an error).
   *  tenantId + agentId scope the update — cross-scope IDs are a no-op (fail-closed). */
  pin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>>;

  /** Unpin a memory entry. Idempotent.
   *  Returns ok(true) if row found, ok(false) if not found.
   *  tenantId + agentId scope the update — cross-scope IDs are a no-op (fail-closed). */
  unpin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>>;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a MemoryApi bound to the given database, adapter, session store,
 * and memory config.
 *
 * The factory function pattern is consistent with createSessionStore and
 * createSecretManager.
 */
export function createMemoryApi(
  db: Database.Database,
  adapter: SqliteMemoryAdapter,
  _sessionStore: SessionStorePort,
  _config: MemoryConfig,
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
      params.push(systemNowMs());

      const sql = `SELECT * FROM memories ${fullClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const parsed = memoryRowMapper.parseRows(db.prepare(sql).all(...params));
      // Degrade-on-validation-error: inspection query → empty result.
      const rows = parsed.ok ? parsed.value : [];
      let entries = rows.map((row) => rowToEntry(row));

      // Post-filter by tags if specified (tags are JSON-encoded in DB).
      // Pin the narrowed value to drop the non-null assertion. TypeScript
      // can't carry the `filters?.tags && ...` narrowing into the filter
      // callback's closure scope; the pinned local does.
      if (filters?.tags && filters.tags.length > 0) {
        const requiredTags = filters.tags;
        entries = entries.filter((entry) => requiredTags.every((tag) => entry.tags.includes(tag)));
      }

      return entries;
    },

    // ── count ───────────────────────────────────────────────────

    count(filters?: InspectFilters): number {
      const { clause, params } = buildFilterClause({
        memoryType: filters?.memoryType,
        trustLevel: filters?.trustLevel,
        tenantId: filters?.tenantId,
        agentId: filters?.agentId,
        createdAfter: filters?.createdAfter,
        createdBefore: filters?.createdBefore,
      });

      // Same expiry exclusion as inspect.
      const expiryCondition = "(expires_at IS NULL OR expires_at > ?)";
      const fullClause = clause ? `${clause} AND ${expiryCondition}` : `WHERE ${expiryCondition}`;
      const countParams = [...params, systemNowMs()];

      // Tags are JSON-encoded and intersection-matched in JS (inspect does the
      // same), so a SQL COUNT cannot express them. When tags are set, count the
      // tag-filtered rows directly (bounded by the same WHERE so it is the
      // matching set, not the whole table); otherwise COUNT(*) is exact + cheap.
      if (filters?.tags && filters.tags.length > 0) {
        const requiredTags = filters.tags;
        const sql = `SELECT * FROM memories ${fullClause} ORDER BY created_at DESC`;
        const parsed = memoryRowMapper.parseRows(db.prepare(sql).all(...countParams));
        const rows = parsed.ok ? parsed.value : [];
        return rows
          .map((row) => rowToEntry(row))
          .filter((entry) => requiredTags.every((tag) => entry.tags.includes(tag)))
          .length;
      }

      return countRows(db, "memories", fullClause, countParams);
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
            "Pass tenantId or sessionKey to scope the wipe " +
            "(adapter.clear was removed in a prior port-trim cleanup).",
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
      // Pin immunity is UNCONDITIONAL — pinned entries survive any scoped clear,
      // regardless of whether a trustLevel filter is active. An operator explicitly
      // clearing by trustLevel (e.g. "flush all external") must not inadvertently
      // delete a pinned standing instruction.
      conditions.push("pinned != 1");

      const whereClause = conditions.join(" AND ");

      // First get IDs for vec_memories cleanup
      const idsParsed = idProjectionMapper.parseRows(
        db
          .prepare(`SELECT id FROM memories WHERE ${whereClause}`)
          .all(...params),
      );
      // Degrade-on-validation-error: clear scope → no rows to delete.
      const ids = idsParsed.ok ? idsParsed.value : [];

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

    // ── pin ─────────────────────────────────────────────────────

    async pin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>> {
      return fromPromise((async () => {
        const sql =
          tenantId !== undefined && agentId !== undefined
            ? "UPDATE memories SET pinned = 1 WHERE id = ? AND tenant_id = ? AND agent_id = ?"
            : tenantId !== undefined
            ? "UPDATE memories SET pinned = 1 WHERE id = ? AND tenant_id = ?"
            : "UPDATE memories SET pinned = 1 WHERE id = ?";
        const info =
          tenantId !== undefined && agentId !== undefined
            ? db.prepare(sql).run(id, tenantId, agentId)
            : tenantId !== undefined
            ? db.prepare(sql).run(id, tenantId)
            : db.prepare(sql).run(id);
        return info.changes > 0;
      })());
    },

    // ── unpin ────────────────────────────────────────────────────

    async unpin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>> {
      return fromPromise((async () => {
        const sql =
          tenantId !== undefined && agentId !== undefined
            ? "UPDATE memories SET pinned = 0 WHERE id = ? AND tenant_id = ? AND agent_id = ?"
            : tenantId !== undefined
            ? "UPDATE memories SET pinned = 0 WHERE id = ? AND tenant_id = ?"
            : "UPDATE memories SET pinned = 0 WHERE id = ?";
        const info =
          tenantId !== undefined && agentId !== undefined
            ? db.prepare(sql).run(id, tenantId, agentId)
            : tenantId !== undefined
            ? db.prepare(sql).run(id, tenantId)
            : db.prepare(sql).run(id);
        return info.changes > 0;
      })());
    },

  };
}
