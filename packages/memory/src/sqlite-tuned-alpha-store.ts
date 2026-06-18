// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteTunedAlphaStore: the SOLE adapter for the segregated `TunedAlphaStore`
 * port (@comis/core). It owns ALL the
 * per-(tenant, agent) tuned-alpha SQL over the additive `tuned_alpha` table — the
 * only place SQL is written for this capability.
 *
 * ## Method status
 *
 * - `upsert(vector, scope)` writes the caller's (tenant, agent) tuned 4-alpha
 *   vector (recency/temporal/proof/usefulness). Idempotent: `INSERT ... ON CONFLICT
 *   (tenant_id, agent_id) DO UPDATE` — exactly ONE row per scope, never duplicated.
 *   Every value is a bound `?` parameter (no SQL injection surface; the alphas are
 *   numeric config state, not conversation-derived TEXT — so unlike the
 *   user-representation / relationship adapters there is NO redaction firewall and
 *   NO write-boundary reject). `updated_at` is the injected clock `scope.now`,
 *   never a wall-clock read in src (globals.test.ts bans the wall clock).
 *   Called ONLY by the offline bandit job — never on the recall hot path.
 * - `read(scope)` is the deterministic, LLM-free apply-site read: the
 *   tuned vector for the caller's (tenant, agent) scope ONLY. Returns `undefined`
 *   when no tuned row exists — the apply site then falls back to the static
 *   `rag.scoring` config alphas (the default-OFF byte-identity no-op). It does NOT
 *   return a zero-vector for absent (that would zero out every boost).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in via
 * `getDb()`); the handle's lifecycle (open/close, pragmas) is owned by the caller
 * — this factory neither opens nor closes it.
 *
 * ## Isolation is the load-bearing security boundary (the §5.2 invariant)
 *
 * Comis runs many agents and many tenants in ONE DB. The UPSERT keys on the
 * `(tenant_id, agent_id)` PRIMARY KEY and the read filters
 * `WHERE tenant_id = ? AND agent_id = ?` (bound params), so a tuned vector written
 * under one (tenant, agent) is NEVER returned for another scope. The 2-way filter
 * is load-bearing, not a nicety (RED-proven: dropping either column leaks).
 *
 * ## The frozen weight (the OD2 ship-gate, structural belt #3)
 *
 * The `tuned_alpha` table carries ONLY the 4 tunable boost alphas + `updated_at` —
 * there is no fifth weight column, and this file deliberately never names that
 * fifth `ScoringAlphas` weight (the grep-0 belt — its literal field name is never
 * written here, asserted in the contract test). The bandit can never move that
 * fifth weight; it is sourced ONLY from static config at the apply site.
 * This is belt #3, alongside the port type (belt #1) and the pure
 * `computeTunedAlphas` step (belt #2).
 *
 * ## Untyped-SQLite discipline
 *
 * Every read parses through `createRowMapper` (no untyped-row casts;
 * `untyped-sqlite.test.ts`). The adapter logs counts/ids/metadata only — NEVER an
 * alpha VALUE (AGENTS.md §2.7); the alphas are not secrets, but the log stays
 * ids-only for consistency with the sibling adapters.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { TunedAlphaStore, TunedAlphaScope, TunedAlphaVector } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { TunedAlphaRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-usefulness-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteTunedAlphaStore}. */
export interface MemoryTunedAlphaStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no untyped-row casts). Parses the
// scoped-read projection (the 4 alphas + updated_at) before the camelCase map.
const tunedRowMapper = createRowMapper(TunedAlphaRowSchema);

/**
 * Create the SQLite-backed {@link TunedAlphaStore} adapter over a shared db handle.
 * The handle's lifecycle (open/close, pragmas) is owned by the caller (the memory
 * adapter) — this factory neither opens nor closes it.
 */
export function createSqliteTunedAlphaStore(
  deps: MemoryTunedAlphaStoreDeps,
): TunedAlphaStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Idempotent per-intent UPSERT keyed on the 3-col (tenant_id, agent_id, intent)
  // PK (RANK-05). Every value a bound `?` (NEVER concatenated). ON CONFLICT DO
  // UPDATE keeps exactly ONE row per (scope, intent) — a per-intent write touches
  // ONLY its bucket (the global '' row and other intents are never clobbered). The
  // RESERVED posterior-slot columns (outcome_reward_sum/outcome_n) are written 0 here
  // and read by nobody (WR-04: INERT in v1 — the bandit derives its posterior LIVE
  // from the memory_usefulness feed, not these columns; they are a forward-compat
  // slot). updated_at = scope.now (injected clock, never a wall-clock read).
  const upsertVec = db.prepare(
    "INSERT INTO tuned_alpha " +
      "(tenant_id, agent_id, intent, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, outcome_reward_sum, outcome_n, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?) " +
      "ON CONFLICT(tenant_id, agent_id, intent) DO UPDATE SET " +
      "recency_alpha = excluded.recency_alpha, " +
      "temporal_alpha = excluded.temporal_alpha, " +
      "proof_alpha = excluded.proof_alpha, " +
      "usefulness_alpha = excluded.usefulness_alpha, " +
      "updated_at = excluded.updated_at",
  );
  // The scoped per-intent read. The `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing 2-way ISOLATION boundary (a vector written under one scope can
  // NEVER be read under any differing tenant/agent); `intent = ?` is an ADDITIONAL
  // key (omitted intent → the global '' bucket), never a relaxation of isolation.
  // The projection omits the posterior columns (the recall hot path reads only the
  // 4 alphas + updated_at — belt #3: the fifth weight is never read). Bound params only.
  const readScoped = db.prepare(
    "SELECT recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, updated_at " +
      "FROM tuned_alpha " +
      "WHERE tenant_id = ? AND agent_id = ? AND intent = ?",
  );

  return {
    async upsert(
      vector: TunedAlphaVector,
      scope: TunedAlphaScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      // Default to the GLOBAL bucket when no intent is supplied (omitted intent
      // === '' === byte-identical to the pre-intent behaviour). intent is an
      // ADDITIONAL key, never a relaxation of the (tenant, agent) isolation scope.
      const intent = scope.intent ?? "";
      try {
        upsertVec.run(
          tenantId,
          agentId,
          intent,
          vector.recencyAlpha,
          vector.temporalAlpha,
          vector.proofAlpha,
          vector.usefulnessAlpha,
          now, // updated_at (injected clock)
        );

        // ids/counts/metadata ONLY — NEVER an alpha VALUE (§2.7).
        logger?.debug(
          {
            step: "tuned-alpha-upsert",
            submodule: "tuned-alpha",
            tenantId,
            agentId,
            durationMs: systemNowMs() - startMs,
          },
          "Tuned alpha upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "tuned-alpha-upsert",
            submodule: "tuned-alpha",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "tuned-alpha write failed — vector not persisted",
          },
          "Tuned alpha upsert failed",
        );
        return err(error);
      }
    },

    async read(
      scope: Omit<TunedAlphaScope, "now">,
    ): Promise<Result<TunedAlphaVector | undefined, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      // The requested per-intent bucket; '' = global (omitted → byte-identical to
      // the pre-intent read). intent EXTENDS the isolation key, never relaxes it.
      const intent = scope.intent ?? "";
      try {
        // The 2-way scoped read — the (tenant, agent) filter is the load-bearing
        // isolation boundary; intent is the additional per-intent key.
        // parseOptionalRow → ok(undefined) when no row matched.
        const raw = readScoped.get(tenantId, agentId, intent);
        const parsed = tunedRowMapper.parseOptionalRow(raw);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Absent → undefined (the apply site falls back to the static config
        // alphas — the default-OFF byte-identity no-op). NOT a zero-vector.
        if (parsed.value === undefined) {
          logger?.debug(
            { step: "tuned-alpha-read", submodule: "tuned-alpha", found: 0, durationMs: systemNowMs() - startMs },
            "Tuned alpha read miss",
          );
          return ok(undefined);
        }

        const row = parsed.value;
        const vector: TunedAlphaVector = {
          recencyAlpha: row.recency_alpha,
          temporalAlpha: row.temporal_alpha,
          proofAlpha: row.proof_alpha,
          usefulnessAlpha: row.usefulness_alpha,
        };
        logger?.debug(
          { step: "tuned-alpha-read", submodule: "tuned-alpha", found: 1, durationMs: systemNowMs() - startMs },
          "Tuned alpha read complete",
        );
        return ok(vector);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "tuned-alpha-read",
            submodule: "tuned-alpha",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "tuned-alpha read failed — vector unavailable",
          },
          "Tuned alpha read failed",
        );
        return err(error);
      }
    },
  };
}
