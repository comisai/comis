// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryCausalStore: the SOLE adapter for the segregated
 * `MemoryCausalStore` port (@comis/core). It owns ALL the
 * causal-edge SQL — the write-path edge link (resolve `effectText` → a stored
 * memory id via the scoped FTS, then `INSERT OR IGNORE` a directed cause→effect
 * edge) and the read-path causal lane (the scoped one-hop UNION over
 * `memory_causal_edges`, seeds excluded, hydrated into `MemorySearchResult[]`
 * ordered by edge confidence).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema (`memories`,
 * `memory_causal_edges`, `memory_fts`) with `PRAGMA foreign_keys = ON` already
 * set — that pragma is what makes the `ON DELETE CASCADE` on BOTH
 * `memory_causal_edges.source_memory_id` and `.target_memory_id` fire (the
 * entire edge-maintenance story; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary (the entity-link pattern)
 *
 * Comis runs many agents in one DB. BOTH the write (the effectText id-resolution
 * AND the edge INSERT) and the read lane filter on `(tenant_id, agent_id)` —
 * parameterized — so an edge written under one (tenant, agent) is NEVER returned
 * for another scope by memory-id coincidence, and effectText can only resolve to
 * a memory within the caller's OWN scope. This is belt-and-braces with the
 * `(tenant_id, agent_id, source_memory_id, target_memory_id)` PRIMARY KEY.
 *
 * ## Untrusted input
 *
 * `effectText` derives from conversation content. It is DATA, never SQL — it is
 * passed to the FTS sanitizer (`searchByText` / `buildFtsQuery`, which strips
 * FTS metacharacters) and every value reaching SQL is a bound `?` parameter,
 * never concatenated. Every read parses through `createRowMapper` (no `as Foo[]`
 * casts; `untyped-sqlite.test.ts`). The adapter logs counts/metadata only —
 * NEVER the effectText/content body (AGENTS.md §2.7).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { MemoryCausalStore, CausalScope, MemorySearchResult } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { searchByText } from "./hybrid-search.js";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import { CausalLaneRowSchema, MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";

/**
 * How many FTS candidates to over-fetch when resolving `effectText` → a stored
 * memory id. `searchByText` is NOT scope-filtered (it joins memory_fts +
 * memories globally), so we fetch a small ranked window and pick the FIRST
 * candidate that is BOTH in the caller's (tenant, agent) scope AND not the
 * source memory itself (no self-edge). A handful is plenty — the top BM25 match
 * within scope is almost always at or near rank 1.
 */
const FTS_RESOLVE_OVERFETCH = 5;

/** Minimal pino-compatible logger (mirrors sqlite-memory-entity-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryCausalStore}. */
export interface MemoryCausalStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mappers — the sanctioned read path (no `as Foo[]`).
const causalLaneRowMapper = createRowMapper(CausalLaneRowSchema);
const memoryRowMapper = createRowMapper(MemoryRowSchema);
// Id-only projection mapper for the scoped effectText-resolution probe
// (`SELECT id FROM memories WHERE id=? AND tenant_id=? AND agent_id=?`). Parsed
// via createRowMapper — never `as { id: string }`.
const memoryInScopeRowMapper = createRowMapper(IdProjectionRowSchema);

/**
 * Create the SQLite-backed {@link MemoryCausalStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryCausalStore(deps: MemoryCausalStoreDeps): MemoryCausalStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Scope-check a single candidate id (the FTS resolver re-asserts the FULL
  // (tenant, agent) scope on the matched memory — effectText must NOT resolve
  // cross-scope). Bound params only.
  const memoryInScope = db.prepare(
    "SELECT id FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ?",
  );
  // Idempotent edge write (the PK is the conflict target). Bound params only.
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO memory_causal_edges " +
      "(tenant_id, agent_id, source_memory_id, target_memory_id, confidence, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Hydrate a linked memory, re-asserting the FULL (tenant, agent) scope so the
  // hydrate is self-sufficient (no fail-open if the lane query is ever
  // refactored). Bound params only.
  // The ALWAYS-ON `evicted_at IS NULL` recall exclusion. This is the
  // RECALL-side hydration (causalLane → MemorySearchResult[] → createMemoryRecall → the
  // prompt), so a soft-evicted causal counterpart MUST be omitted here. NB: the WRITE-path
  // `memoryInScope` scope-check above is deliberately NOT filtered — a causal edge may
  // legitimately target a soft-evicted memory at link time; only the recall hydration
  // excludes it. The inspect/asOf raw reads stay UNFILTERED (eviction soft + asOf-resolvable).
  const hydrateMemory = db.prepare(
    "SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ? AND evicted_at IS NULL",
  );

  return {
    async linkCausal(
      sourceMemoryId: string,
      effectText: string,
      scope: CausalScope,
      confidence: number,
    ): Promise<Result<number, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      try {
        // Resolve effectText -> a stored memory id via the scoped FTS top match.
        // `searchByText` sanitizes the raw text (FTS injection prevention) and
        // returns BM25-ranked {id, rank}; it is NOT scope-filtered, so we scan
        // the ranked window for the FIRST candidate that is BOTH in scope AND not
        // the source itself (no self-edge — a memory cannot cause itself).
        const candidates = searchByText(db, effectText, FTS_RESOLVE_OVERFETCH);
        let targetId: string | undefined;
        for (const cand of candidates) {
          if (cand.id === sourceMemoryId) continue; // never self-link
          // Re-assert the FULL (tenant, agent) scope on the matched memory — parsed
          // via the id-only mapper (no `as { id: string }`). effectText must NOT
          // resolve cross-scope.
          const probe = memoryInScopeRowMapper.parseOptionalRow(
            memoryInScope.get(cand.id, tenantId, agentId),
          );
          if (probe.ok && probe.value !== undefined) {
            targetId = cand.id;
            break;
          }
        }

        // No counterpart resolved -> write NO edge, return ok(0) (non-fatal; the
        // effect referenced a fact not yet stored, or only the source matched).
        // NEVER log the effectText body (AGENTS.md §2.7) — metadata only.
        if (targetId === undefined) {
          logger?.debug(
            { step: "causal-link", skipped: "no-counterpart", durationMs: systemNowMs() - startMs },
            "Causal link skipped (no in-scope counterpart resolved)",
          );
          return ok(0);
        }

        const res = insertEdge.run(tenantId, agentId, sourceMemoryId, targetId, confidence, now);
        const written = res.changes; // 1 on insert, 0 on INSERT OR IGNORE no-op (idempotent)

        logger?.debug(
          { step: "causal-link", written, durationMs: systemNowMs() - startMs },
          "Causal link complete",
        );
        return ok(written);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "causal-link",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "causal edge write failed — memory stored, edge skipped",
          },
          "Causal link failed",
        );
        return err(error);
      }
    },

    async causalLane(
      seedMemoryIds: string[],
      scope: Omit<CausalScope, "now">,
      cap: number,
    ): Promise<Result<MemorySearchResult[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // No seeds -> empty lane (no query). RRF ranking is unchanged.
        if (seedMemoryIds.length === 0) {
          logger?.debug(
            { step: "causal-lane", seedCount: 0, resultCount: 0, durationMs: 0 },
            "Causal lane skipped (no seeds)",
          );
          return ok([]);
        }

        // The scoped one-hop UNION (RESEARCH Pattern 3 — verified). The
        // `tenant_id = ? AND agent_id = ?` on BOTH arms is the load-bearing
        // ISOLATION boundary — a cross-scope edge sharing a memory id is
        // excluded. The first arm walks source→effect (PK prefix); the second walks
        // effect→cause (idx_causal_target) so causal influence reads bidirectionally.
        // Placeholders only — no string-built SQL.
        const seedPlaceholders = seedMemoryIds.map(() => "?").join(", ");
        const laneSql =
          "SELECT target_memory_id AS linked, confidence FROM memory_causal_edges " +
          `WHERE tenant_id = ? AND agent_id = ? AND source_memory_id IN (${seedPlaceholders}) ` +
          "UNION " +
          "SELECT source_memory_id AS linked, confidence FROM memory_causal_edges " +
          `WHERE tenant_id = ? AND agent_id = ? AND target_memory_id IN (${seedPlaceholders})`;
        const laneRows = db
          .prepare(laneSql)
          .all(tenantId, agentId, ...seedMemoryIds, tenantId, agentId, ...seedMemoryIds);

        const parsed = causalLaneRowMapper.parseRows(laneRows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Drop the seeds themselves and dedup linked ids keeping MAX confidence
        // (a memory linked to two seeds, or both directions, surfaces once at its
        // strongest edge).
        const seedSet = new Set(seedMemoryIds);
        const bestConfidence = new Map<string, number>();
        for (const { linked, confidence } of parsed.value) {
          if (seedSet.has(linked)) continue; // seed excluded
          const prior = bestConfidence.get(linked);
          if (prior === undefined || confidence > prior) bestConfidence.set(linked, confidence);
        }

        // Hydrate each linked memory (scoped) into a MemorySearchResult; score =
        // edge confidence (RESEARCH Pattern 3 intra-lane order).
        const scored: Array<{ result: MemorySearchResult; score: number }> = [];
        for (const [linkedId, score] of bestConfidence) {
          const memParsed = memoryRowMapper.parseOptionalRow(
            hydrateMemory.get(linkedId, tenantId, agentId),
          );
          if (!memParsed.ok) return err(new Error(memParsed.error.message));
          const row = memParsed.value;
          if (!row) continue; // defensive: hydrate miss -> skip
          scored.push({ result: { entry: rowToEntry(row), score }, score });
        }

        // Sort confidence-desc; deterministic tie-break on id so equal-confidence
        // rows have a stable order. Then bound by cap.
        scored.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.result.entry.id.localeCompare(b.result.entry.id);
        });
        const results = scored.slice(0, cap).map((s) => s.result);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "causal-lane", seedCount: seedMemoryIds.length, resultCount: results.length, durationMs },
          "Causal lane complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "causal-lane",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "causal lane query failed",
          },
          "Causal lane failed",
        );
        return err(error);
      }
    },
  };
}
