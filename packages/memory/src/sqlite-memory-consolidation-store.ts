// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryConsolidationStore: the SOLE adapter for the segregated
 * `MemoryConsolidationStore` port (@comis/core).
 *
 * Phase 226 (SIMPLIFY-02): TRIMMED to the LIVE read + deletion-reconciliation
 * surface after the consolidation CRON (the writer) was retired in phase 225.
 * It owns ONLY the SQL behind the three live, non-cron methods:
 *   - `listObservations`             — the scoped observation listing
 *                                      (`proof_count IS NOT NULL`) behind the
 *                                      `comis memory` observation view.
 *   - `unlinkDeletedSources`         — DIST-05 deletion reconciliation: re-scan
 *                                      in-scope observations' `source_ids`,
 *                                      delete orphans / shrink multi-source rows.
 *   - `purgeConsolidatedDerivedFrom` — DIST-05 nuclear purge of observations
 *                                      derived from a reset session's ids.
 * The dead writer SQL (candidate selection / apply / fold / surprisal k-NN /
 * deductive-drain) is gone.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema — the `memories` table
 * carries the observation columns (`proof_count`, `source_ids`,
 * `consolidated_at`, `confidence`, `history`).
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents/tenants in one DB. Every SELECT, DELETE, and UPDATE
 * here filters on `(tenant_id, agent_id)` — parameterized — so a cross-scope
 * observation is never read, unlinked, or purged (a cross-scope id is a
 * fail-closed no-op).
 *
 * ## Untrusted input
 *
 * Memory content + ids derive from conversation text. Every value reaches SQL
 * as a bound `?` parameter — never concatenated — and every read parses through
 * `MemoryRowSchema` (the `createRowMapper` factory; no `as Foo[]` casts —
 * `untyped-sqlite.test.ts`).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { MemoryConsolidationStore, MemoryEntry } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import { MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-entity-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryConsolidationStore}. */
export interface MemoryConsolidationStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). The candidate SELECT
// peels the joined `embedding` column off each raw row BEFORE this strict parse,
// so the extra column never trips MemoryRowSchema's `strictObject`.
const memoryRowMapper = createRowMapper(MemoryRowSchema);

// DIST-05 id-projection mapper (sanctioned typed-read path; no `as Foo[]` cast).
const idProjectionMapper = createRowMapper(IdProjectionRowSchema);

/**
 * Create the SQLite-backed {@link MemoryConsolidationStore} adapter over a
 * shared db handle. The handle's lifecycle (open/close, pragmas) is owned by the
 * caller (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryConsolidationStore(
  deps: MemoryConsolidationStoreDeps,
): MemoryConsolidationStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; built once, reused across calls) ---

  // Observation listing (the `comis memory` observation view). proof_count IS
  // NOT NULL is the column-flag for "this row is an observation" (§4.1). Scoped
  // on (tenant_id, agent_id) — a cross-scope observation is never returned.
  const selectObservations = db.prepare(
    "SELECT * FROM memories WHERE tenant_id = ? AND agent_id = ? AND proof_count IS NOT NULL " +
      "ORDER BY created_at DESC LIMIT ?",
  );

  return {
    async listObservations(
      agentId: string,
      tenantId: string,
      limit: number,
    ): Promise<Result<MemoryEntry[], Error>> {
      const startMs = systemNowMs();
      try {
        const parsed = memoryRowMapper.parseRows(selectObservations.all(tenantId, agentId, limit));
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Observations have no embedding hydration (the dedup pre-check compares
        // content/source-id sets, not vectors).
        const observations = parsed.value.map((row) => rowToEntry(row));

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "consolidation-observations", durationMs, count: observations.length },
          "Observation listing complete",
        );
        return ok(observations);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-observations",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "observation listing query failed — check DB integrity",
          },
          "Observation listing failed",
        );
        return err(error);
      }
    },

    async unlinkDeletedSources(
      _sessionKey: string,
      tenantId: string,
      agentId: string,
    ): Promise<Result<number, Error>> {
      // DIST-05: called AFTER the raw memories were deleted by
      // deleteBySessionKey, so the source rows are already gone. We re-scan each
      // in-scope observation's source_ids and treat any id no longer present in
      // `memories` (for this tenant+agent) as a deleted source. Orphan (every
      // source gone) → DELETE the observation; multi-source (some sources
      // survive) → KEEP with the reduced source_ids (unlink-only — never
      // over-delete).
      //
      // `_sessionKey` is part of the port signature for symmetry with the
      // --purge path + a future provenance-joined variant; the
      // delete-already-happened semantics mean the load-bearing predicate is
      // "source id absent from memories" — sessionKey-agnostic but
      // (tenant, agent)-SCOPED (WR-05: matches deleteBySessionKey's scope exactly,
      // fail-closed isolation), so the param is intentionally unused here.
      const startMs = systemNowMs();
      try {
        // The set of live memory ids for this tenant+agent — the membership oracle
        // for "still exists". Scoped on tenant_id AND agent_id (WR-05, fail-closed:
        // a cross-scope id is never in this set, so it can never be treated as
        // "surviving"). Typed read via the sanctioned mapper (untyped-sqlite).
        const liveIdsParsed = idProjectionMapper.parseRows(
          db.prepare("SELECT id FROM memories WHERE tenant_id = ? AND agent_id = ?").all(tenantId, agentId),
        );
        if (!liveIdsParsed.ok) return err(new Error(liveIdsParsed.error.message));
        const liveIds = new Set(liveIdsParsed.value.map((r) => r.id));

        // All observations (proof_count IS NOT NULL) in this tenant+agent carry the
        // source_ids array. Read the full rows through the existing memoryRowMapper
        // (SELECT *) so source_ids is parsed for us by rowToEntry (no new schema,
        // no manual JSON.parse). Scoped on tenant_id AND agent_id (WR-05) — mirrors
        // the agent-scoped selectObservations/selectCandidates in this file.
        const observationsParsed = memoryRowMapper.parseRows(
          db
            .prepare("SELECT * FROM memories WHERE proof_count IS NOT NULL AND tenant_id = ? AND agent_id = ?")
            .all(tenantId, agentId),
        );
        if (!observationsParsed.ok) return err(new Error(observationsParsed.error.message));
        const observations = observationsParsed.value.map((row) => rowToEntry(row));

        let orphansDeleted = 0;
        const deleteSingle = db.prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ?");
        const updateSourceIds = db.prepare(
          "UPDATE memories SET source_ids = ? WHERE id = ? AND tenant_id = ? AND agent_id = ?",
        );

        const tx = db.transaction(() => {
          for (const obs of observations) {
            const ids = obs.sourceIds ?? [];
            if (ids.length === 0) continue; // no sources to unlink
            const surviving = ids.filter((id) => liveIds.has(id));
            if (surviving.length === ids.length) continue; // no deleted sources — untouched
            if (surviving.length === 0) {
              // Orphan: every source gone → delete the observation.
              deleteSingle.run(obs.id, tenantId, agentId);
              orphansDeleted++;
            } else {
              // Multi-source: keep with reduced source_ids (unlink only).
              updateSourceIds.run(JSON.stringify(surviving), obs.id, tenantId, agentId);
            }
          }
          return orphansDeleted;
        });
        const deleted = tx();

        logger?.debug(
          { step: "consolidation-unlink", durationMs: systemNowMs() - startMs, orphansDeleted: deleted },
          "unlinkDeletedSources complete (orphans deleted, multi-source unlinked)",
        );
        return ok(deleted);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-unlink",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "unlinkDeletedSources transaction failed — rolled back; consolidated observations may still reference deleted sources",
          },
          "unlinkDeletedSources failed",
        );
        return err(error);
      }
    },

    async purgeConsolidatedDerivedFrom(
      sessionKey: string,
      tenantId: string,
      agentId: string,
      thisSessionIds: string[],
    ): Promise<Result<number, Error>> {
      // DIST-05 nuclear escalation: delete EVERY observation derived from THIS
      // session's deleted memory ids. Called via the opt-in --purge-derived flag
      // ONLY. Runs AFTER the raw memories were deleted, but the purge oracle is
      // the explicit `thisSessionIds` set (captured BEFORE the delete via
      // MemoryPort.listMemoryIdsBySessionKey), NOT "any source id now absent".
      //
      // WR-02 (session-scoped, not coarse): an observation is purged ONLY if its
      // source_ids INTERSECT thisSessionIds. A prior unrelated dangling source id
      // in an UNRELATED observation (from an earlier admin delete / TTL / another
      // session's purge) is left alone — the bug the "any absent id" oracle had.
      // It still nukes a multi-source observation when one of its sources WAS a
      // this-session id (nuclear regardless of surviving corroboration).
      //
      // WR-05: scoped on tenant_id AND agent_id (matches deleteBySessionKey).
      // `sessionKey` is retained for the audit log. An empty thisSessionIds set
      // purges nothing (fast-path).
      const startMs = systemNowMs();
      try {
        if (thisSessionIds.length === 0) {
          logger?.debug(
            { step: "consolidation-purge-derived", durationMs: systemNowMs() - startMs, observationsDeleted: 0, sessionKey },
            "purgeConsolidatedDerivedFrom: no this-session ids — nothing to purge",
          );
          return ok(0);
        }
        const sessionIdSet = new Set(thisSessionIds);

        const observationsParsed = memoryRowMapper.parseRows(
          db
            .prepare("SELECT * FROM memories WHERE proof_count IS NOT NULL AND tenant_id = ? AND agent_id = ?")
            .all(tenantId, agentId),
        );
        if (!observationsParsed.ok) return err(new Error(observationsParsed.error.message));
        const observations = observationsParsed.value.map((row) => rowToEntry(row));

        let deletedCount = 0;
        const deleteObs = db.prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ?");

        const tx = db.transaction(() => {
          for (const obs of observations) {
            const ids = obs.sourceIds ?? [];
            if (ids.length === 0) continue;
            // Purge ONLY when a source id was one of THIS session's deleted ids
            // (source_ids ∩ thisSessionIds ≠ ∅) — nuclear regardless of surviving
            // corroboration, but session-scoped (WR-02): unrelated observations
            // with a prior dangling id are untouched.
            const derivedFromThisSession = ids.some((id) => sessionIdSet.has(id));
            if (derivedFromThisSession) {
              deleteObs.run(obs.id, tenantId, agentId);
              deletedCount++;
            }
          }
          return deletedCount;
        });
        const deleted = tx();

        logger?.debug(
          {
            step: "consolidation-purge-derived",
            durationMs: systemNowMs() - startMs,
            observationsDeleted: deleted,
            sessionKey,
          },
          "purgeConsolidatedDerivedFrom complete (derived observations purged)",
        );
        return ok(deleted);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-purge-derived",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "purgeConsolidatedDerivedFrom transaction failed — rolled back; no observations purged",
          },
          "purgeConsolidatedDerivedFrom failed",
        );
        return err(error);
      }
    },
  };
}
