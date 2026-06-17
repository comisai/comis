// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryTemporalStore: the SOLE adapter for the segregated
 * `MemoryTemporalStore` port (@comis/core). It owns the
 * temporal-spread SQL — a windowed read over the EXISTING `memories.occurred_at`
 * column that, given the seed memories' event times, surfaces OTHER memories
 * near those times (the "what else happened around then" lane).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema (`memories`) with
 * `PRAGMA foreign_keys = ON` already set. Unlike the entity store
 * (`ensureEntityTables`) or the usefulness store (`ensureUsefulnessTable`), this
 * store needs NO `ensure*` DDL — the `occurred_at` column already exists
 * (added by `ensureMemoryColumns`). There is NO new table.
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. The windowed SELECT filters on
 * `(tenant_id, agent_id)` — parameterized — so two agents (or tenants) whose
 * memories share the same `occurred_at` NEVER surface each other's rows by
 * event-time coincidence. Belt-and-braces: the candidate window is scoped in
 * SQL and the result rows carry their own (tenant_id, agent_id) (the rows are
 * read from the already-scoped SELECT, so the hydrate needs no re-scope query —
 * the row IS the hydrate, parsed via the row mapper).
 *
 * ## Untrusted input
 *
 * Seed event times are numbers (typed) but every value reaching SQL — seed
 * window bounds, scope, cap — is a bound `?` parameter, never concatenated, and
 * every read parses through `createRowMapper` (no `as Foo[]` casts;
 * `untyped-sqlite.test.ts`).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { MemoryTemporalStore, MemorySearchResult } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import { MemoryRowSchema } from "./row-schemas.js";

/** Milliseconds per day — for converting windowMs / distances to a day-scaled decay. */
const MS_PER_DAY = 86_400_000;

/** Minimal pino-compatible logger (mirrors sqlite-memory-entity-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryTemporalStore}. */
export interface MemoryTemporalStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). The temporal window does a
// scoped `SELECT *` and parses each row via the EXISTING memories-row schema, so the
// full hydrate flows through `rowToEntry` (mirrors the entity lane's memoryRowMapper).
const memoryRowMapper = createRowMapper(MemoryRowSchema);

/**
 * Create the SQLite-backed {@link MemoryTemporalStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryTemporalStore(deps: MemoryTemporalStoreDeps): MemoryTemporalStore {
  const { db, logger } = deps;

  // The scoped windowed SELECT (parameterized). The `AND tenant_id = ? AND agent_id = ?`
  // is the load-bearing ISOLATION boundary — a cross-scope memory at the same
  // occurred_at is excluded here. `occurred_at IS NOT NULL` drops memories with no event
  // time (nothing to spread from). The `BETWEEN (minSeed - windowMs) AND (maxSeed +
  // windowMs)` bounds the candidate window (no unbounded scan); `LIMIT ?` is a coarse
  // cap on the SQL fetch (the final nearest-first cap is applied in TS after the exact
  // min-distance is computed, so a tighter `LIMIT` here would risk dropping a nearer row
  // that sorts after a farther one by raw occurred_at — fetch generously, cap in TS).
  // Placeholders only — no string-built SQL.
  // FORGET-01 (CR-01): the ALWAYS-ON `evicted_at IS NULL` recall exclusion. This windowed
  // read is a RECALL-side hydration (spreadLane → MemorySearchResult[] → createMemoryRecall
  // → the prompt), so a soft-evicted in-window memory MUST be omitted here exactly as on the
  // adapter's recall paths. The inspect/asOf raw reads stay UNFILTERED (eviction soft +
  // asOf-resolvable).
  const selectWindow = db.prepare(
    "SELECT * FROM memories " +
      "WHERE tenant_id = ? AND agent_id = ? " +
      "  AND occurred_at IS NOT NULL " +
      "  AND evicted_at IS NULL " +
      "  AND occurred_at BETWEEN ? AND ? " +
      "ORDER BY occurred_at",
  );

  return {
    async spreadLane(
      seedOccurredAts: number[],
      scope: { tenantId: string; agentId: string },
      windowMs: number,
      cap: number,
    ): Promise<Result<MemorySearchResult[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // No seeds -> empty lane (no query). RRF ranking is unchanged.
        if (seedOccurredAts.length === 0) {
          logger?.debug(
            { step: "temporal-lane", seedCount: 0, resultCount: 0, durationMs: 0 },
            "Temporal lane skipped (no seeds)",
          );
          return ok([]);
        }

        const minSeed = Math.min(...seedOccurredAts);
        const maxSeed = Math.max(...seedOccurredAts);
        // The candidate window: within windowMs of the seed RANGE. Per-row min-distance
        // (to the NEAREST seed) is then re-checked in TS so a row that is in the broad
        // range but > windowMs from EVERY seed is dropped.
        const lowerBound = minSeed - windowMs;
        const upperBound = maxSeed + windowMs;

        const rows = selectWindow.all(tenantId, agentId, lowerBound, upperBound);
        const parsed = memoryRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // The seed event times themselves identify the seed memories — exclude any row
        // whose occurred_at exactly equals a seed time so a seed never re-surfaces in its
        // own lane (seeds are TIMES, not ids).
        const seedSet = new Set(seedOccurredAts);
        // windowDays drives the proximity decay scale; guard a zero/sub-day window so the
        // exponent stays finite (windowMs is z.int().positive()*day at the call site, but
        // the adapter is defensive).
        const windowDays = Math.max(windowMs / MS_PER_DAY, Number.EPSILON);

        const scored: Array<{ result: MemorySearchResult; minDistance: number }> = [];
        for (const row of parsed.value) {
          const occurredAt = row.occurred_at;
          // Defensive: the SELECT filtered `occurred_at IS NOT NULL`, but the schema types
          // the column nullable — skip a NULL that somehow slips through.
          if (occurredAt === null) continue;
          // Drop the seed memories (a row whose occurred_at IS one of the seed times).
          if (seedSet.has(occurredAt)) continue;
          // min-distance over ALL seeds (a candidate near EITHER seed surfaces; no
          // cartesian product — one row contributes one result keyed by its nearest seed).
          let minDistance = Infinity;
          for (const seed of seedOccurredAts) {
            const d = Math.abs(occurredAt - seed);
            if (d < minDistance) minDistance = d;
          }
          // Re-check the per-row window against the NEAREST seed (the BETWEEN above is a
          // coarse range filter over [minSeed, maxSeed]).
          if (minDistance > windowMs) continue;
          // Monotone-in-proximity decay in (0, 1]: exp(-(distanceDays / windowDays)).
          // distance 0 -> 1.0; distance == windowMs -> exp(-1) ≈ 0.368; never <= 0.
          const distanceDays = minDistance / MS_PER_DAY;
          const score = Math.exp(-(distanceDays / windowDays));
          scored.push({ result: { entry: rowToEntry(row), score }, minDistance });
        }

        // Sort nearest-first (ascending min-distance); deterministic tie-break on id so
        // equal-distance rows have a stable order. Then bound by cap.
        scored.sort((a, b) => {
          if (a.minDistance !== b.minDistance) return a.minDistance - b.minDistance;
          return a.result.entry.id.localeCompare(b.result.entry.id);
        });
        const results = scored.slice(0, cap).map((s) => s.result);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "temporal-lane", seedCount: seedOccurredAts.length, resultCount: results.length, durationMs },
          "Temporal lane complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "temporal-lane",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "temporal spread lane query failed",
          },
          "Temporal lane failed",
        );
        return err(error);
      }
    },
  };
}
