// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryUsefulnessStore: the SOLE adapter for the segregated
 * `MemoryUsefulnessStore` port (@comis/core). It owns ALL the recall-utility SQL — the write-path
 * upsert (increment used/ignored counts + set last_useful_at, idempotent on the
 * (tenant, agent, memory_id, intent) bucket) and the read-path bulk fetch (scoped
 * `IN (...)` lookup with a per-intent/global-`''`-fallback, returning an
 * absent-id-omitted Map).
 *
 * ## The intent bucket
 *
 * `UsefulnessScope.intent` partitions the signal per query-intent; the GLOBAL
 * bucket is `''` (an omitted intent → `''` → byte-identical to the prior behaviour). A write
 * targets ONLY its `(…, intent)` bucket (no-clobber across buckets);
 * a read PREFERS the requested per-intent row and falls back to the global `''`
 * row per id. intent is an ADDITIONAL key — the `(tenant, agent)` filter below is
 * STILL the load-bearing isolation boundary, never relaxed by intent.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema (`memory_usefulness`,
 * `memories`) with `PRAGMA foreign_keys = ON` already set — that pragma is what
 * makes the `ON DELETE CASCADE` on `memory_usefulness.memory_id` fire (a memory
 * delete drops its usefulness row; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. EVERY statement (both upserts and the bulk
 * read) filters on `(tenant_id, agent_id)` — parameterized — and the PRIMARY
 * KEY keys on `(tenant_id, agent_id, memory_id, intent)`, so a write under one
 * (tenant, agent) is NEVER visible to a read under another even when the
 * `memory_id` is byte-identical.
 *
 * ## Untrusted input
 *
 * Memory ids are uuids that originate at the recall caller. Every id reaches SQL
 * as a bound `?` parameter — never concatenated (the bulk read builds a dynamic
 * `?`-placeholder list, the values stay parameters) — and every read parses
 * through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`).
 * Logs carry counts + metadata only — never ids-as-bodies or query text.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { MemoryUsefulnessStore, UsefulnessScope, UsefulnessSignal } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { MemoryUsefulnessRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-entity-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryUsefulnessStore}. */
export interface MemoryUsefulnessStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`).
const usefulnessRowMapper = createRowMapper(MemoryUsefulnessRowSchema);

/**
 * Create the SQLite-backed {@link MemoryUsefulnessStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryUsefulnessStore(
  deps: MemoryUsefulnessStoreDeps,
): MemoryUsefulnessStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Idempotent per-intent upsert keyed on the (tenant_id, agent_id, memory_id,
  // intent) bucket: first touch INSERTs (used_count=1),
  // later touches bump used_count and refresh last_useful_at to the latest "used"
  // now. The 4-col ON CONFLICT target resolves on the genuine 4-col PRIMARY KEY,
  // which `ensureUsefulnessTable` guarantees on BOTH a fresh DB (CREATE TABLE) and
  // a pre-intent-column DB (a transactional table REBUILD widens the surviving
  // 3-col PK — `ADD COLUMN` cannot; schema.ts). So a per-intent write touches ONLY
  // its bucket — the global ('') row and other intents' rows are never clobbered.
  const upsertUsed = db.prepare(
    "INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at) " +
      "VALUES (?, ?, ?, ?, 1, 0, ?) " +
      "ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET " +
      "used_count = used_count + 1, last_useful_at = excluded.last_useful_at",
  );
  // Ignored per-intent upsert: first touch INSERTs (ignored_count=1,
  // last_useful_at NULL — an ignored recall is NOT a "use"), later touches bump
  // ignored_count within the SAME (…, intent) bucket and intentionally leave
  // last_useful_at untouched.
  const upsertIgnored = db.prepare(
    "INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at) " +
      "VALUES (?, ?, ?, ?, 0, 1, NULL) " +
      "ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET ignored_count = ignored_count + 1",
  );
  // Failure per-intent upsert: first touch INSERTs failure_count=1
  // (used/ignored=0, last_useful_at NULL — a failure is NEITHER a use NOR an
  // ignore), later touches bump failure_count within the SAME (…, intent) bucket.
  // failure_count is a DISTINCT signal from ignored_count (outcome-attributed task
  // failure vs recalled-but-not-cited) — they never touch each other's column.
  const upsertFailure = db.prepare(
    "INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at, failure_count) " +
      "VALUES (?, ?, ?, ?, 0, 0, NULL, 1) " +
      "ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET failure_count = failure_count + 1",
  );

  return {
    async recordUsage(
      usedIds: string[],
      ignoredIds: string[],
      scope: UsefulnessScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      // Default to the GLOBAL bucket when no intent is
      // supplied (omitted intent === '' === byte-identical to the prior behaviour). intent is an
      // ADDITIONAL key, never a relaxation of the (tenant, agent) isolation scope.
      const intent = scope.intent ?? "";
      try {
        // Nothing to record -> no-op, no transaction. (Counts only — no
        // content ever logged, AGENTS.md §2.7.)
        if (usedIds.length === 0 && ignoredIds.length === 0) {
          logger?.debug(
            { step: "usefulness-record", usedCount: 0, ignoredCount: 0, durationMs: 0 },
            "Usefulness record skipped (no ids)",
          );
          return ok(undefined);
        }

        // Both loops run in ONE transaction (mirror sqlite-memory-entity-store.ts
        // :163). better-sqlite3 is synchronous + the daemon memory write path is
        // single-threaded, so two recordUsage calls cannot interleave mid-write.
        // NOTE: the caller (the attribution step) produces DISJOINT
        // used/ignored sets; a stray id in BOTH would double-touch the row —
        // used runs FIRST so such a duplicate biases toward "used" (acceptable).
        // Every write targets the (…, intent) bucket — no-clobber across buckets.
        const run = db.transaction(() => {
          for (const id of usedIds) upsertUsed.run(tenantId, agentId, id, intent, now);
          for (const id of ignoredIds) upsertIgnored.run(tenantId, agentId, id, intent);
        });
        run();

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          {
            step: "usefulness-record",
            usedCount: usedIds.length,
            ignoredCount: ignoredIds.length,
            durationMs,
          },
          "Usefulness record complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "usefulness-record",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "usefulness recordUsage failed — check DB integrity",
          },
          "Usefulness record failed",
        );
        return err(error);
      }
    },

    async recordFailure(
      memoryId: string,
      scope: UsefulnessScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      // GLOBAL bucket when no intent supplied (omitted === '' === byte-identical).
      // intent is an ADDITIONAL key, never a relaxation of the (tenant, agent)
      // isolation scope.
      const intent = scope.intent ?? "";
      try {
        upsertFailure.run(tenantId, agentId, memoryId, intent);
        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "usefulness-failure", failureCount: 1, durationMs },
          "Usefulness recordFailure complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "usefulness-failure",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "usefulness recordFailure failed — failure_count not accrued",
          },
          "Usefulness recordFailure failed",
        );
        return err(error);
      }
    },

    async readUsefulness(
      memoryIds: string[],
      scope: Omit<UsefulnessScope, "now">,
    ): Promise<Result<Map<string, UsefulnessSignal>, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      // The requested per-intent bucket; '' = global. When
      // omitted, `IN (?, '')` collapses to `IN ('', '')` → the global bucket only
      // (byte-identical to the prior behaviour). intent EXTENDS the isolation key, never relaxes it.
      const intent = scope.intent ?? "";
      try {
        // No ids -> empty map (no query). (Mirror the entity-store
        // seedIds.length===0 short-circuit.)
        if (memoryIds.length === 0) {
          logger?.debug(
            { step: "usefulness-read", count: 0, durationMs: 0 },
            "Usefulness read skipped (no ids)",
          );
          return ok(new Map());
        }

        // Scoped bulk read. The `tenant_id = ? AND agent_id = ?` filter is the
        // load-bearing isolation boundary; the dynamic placeholder list
        // keeps every id a bound `?` param (never string-built SQL). `intent IN
        // (?, '')` fetches BOTH the requested per-intent bucket AND the global
        // fallback row per id; the per-id preference is resolved below.
        const ph = memoryIds.map(() => "?").join(", ");
        // `failure_count` is PROJECTED (the bandit feed's negative-reward
        // signal). It is surfaced onto the signal ONLY when > 0 below, so a clean
        // memory's signal shape is byte-identical and the recall hot-path usefulnessNorm
        // (used/ignored only) is unaffected.
        const rows = db
          .prepare(
            "SELECT memory_id, intent, used_count, ignored_count, last_useful_at, failure_count FROM memory_usefulness " +
              `WHERE tenant_id = ? AND agent_id = ? AND intent IN (?, '') AND memory_id IN (${ph})`,
          )
          .all(tenantId, agentId, intent, ...memoryIds);

        const parsed = usefulnessRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Build the Map — PREFER the requested per-intent row over the global
        // ('') row per id (degrade-to-global per id). ids with NEITHER bucket are
        // simply absent (a neutral factor in score.ts); spread last_useful_at only
        // when non-NULL so an unused memory surfaces with no `lastUsefulAt` key
        // rather than a 0/NULL timestamp.
        const map = new Map<string, UsefulnessSignal>();
        // Track which ids are already filled by the requested per-intent bucket so
        // a later global ('') row never overwrites the preferred per-intent row
        // (row order from SQLite is not guaranteed).
        const filledByIntent = new Set<string>();
        for (const row of parsed.value) {
          const isRequestedBucket = row.intent === intent;
          if (!isRequestedBucket && filledByIntent.has(row.memory_id)) continue; // keep per-intent
          if (isRequestedBucket) filledByIntent.add(row.memory_id);
          map.set(row.memory_id, {
            usedCount: row.used_count,
            ignoredCount: row.ignored_count,
            ...(row.last_useful_at !== null ? { lastUsefulAt: row.last_useful_at } : {}),
            // Surface failure_count ONLY when > 0 (spread-conditional, like
            // lastUsefulAt) so a clean memory's signal is byte-identical — the recall
            // hot path ignores it; the bandit feed reads it as the negative-reward term.
            ...(row.failure_count !== undefined && row.failure_count > 0
              ? { failureCount: row.failure_count }
              : {}),
          });
        }

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "usefulness-read", count: map.size, durationMs },
          "Usefulness read complete",
        );
        return ok(map);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "usefulness-read",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "usefulness readUsefulness query failed",
          },
          "Usefulness read failed",
        );
        return err(error);
      }
    },
  };
}
