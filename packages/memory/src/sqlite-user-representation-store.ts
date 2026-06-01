// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteUserRepresentationStore: the SOLE adapter for the segregated
 * `UserRepresentationStore` port (@comis/core, Phase 107, Track E1 — USER-01).
 * It owns ALL the per-user-representation SQL over the additive
 * `user_representation` table — the only place SQL is written for this capability.
 *
 * ## Method status
 *
 * - `upsert(entry, scope)` writes one PREFIX-TYPED, HIGH-TRUST representation
 *   entry under the caller's (tenant, agent, user) scope. Layer 3 of the 3-layer
 *   anti-poisoning defense: it REJECTS a below-floor `trust` at the write boundary
 *   (returns `err` — never stores it at a reduced weight), BEFORE the INSERT, as
 *   defense-in-depth with the DB `CHECK(trust IN ('system','learned'))` (layer 1)
 *   and the port-type floor (layer 2, 107-01). `content` is untrusted profile
 *   text — it runs through `validateMemoryWrite` (redaction firewall) and is bound
 *   as a `?` parameter, never concatenated. The row id is a `crypto.randomUUID()`
 *   (mirror the triple store); `created_at` is the injected clock `scope.now`,
 *   NEVER `Date.now()`.
 * - `read(scope, cap)` is the LLM-free profile read: the entries for the caller's
 *   (tenant, agent, user) scope ONLY, capped. This is the deterministic read the
 *   prompt-assembly injection block (Plan 107-04) consumes with NO model call.
 *   Returns an empty array when the user has no profile (the default-OFF no-op).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema with `PRAGMA foreign_keys =
 * ON` already set — that pragma is what makes the `source_memory_id ->
 * memories(id)` `ON DELETE CASCADE` fire (deleting a source memory drops its
 * derived representation entries; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary (T-107-02-01, the §5.2 /
 *    ENT-03 pattern, EXTENDED with `user_id`)
 *
 * Comis runs many agents and many users in one DB. BOTH the write (the INSERT)
 * and the read (the scoped SELECT) filter on `(tenant_id, agent_id, user_id)` —
 * parameterized — so a representation entry written under one (tenant, agent,
 * user) is NEVER returned for another scope by content coincidence.
 *
 * ## Untrusted input
 *
 * `content` derives from conversation content. It is DATA, never SQL — every value
 * reaching SQL is a bound `?` parameter, never concatenated. Every read parses
 * through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`). The
 * adapter logs counts/metadata only — NEVER the `content` body (AGENTS.md §2.7).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  UserRepresentationStore,
  UserRepresentationScope,
  UserRepresentationInput,
  UserRepresentationEntry,
} from "@comis/core";
import { systemNowMs, validateMemoryWrite } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { UserRepresentationRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-triple-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteUserRepresentationStore}. */
export interface MemoryUserRepresentationStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). Parses the scoped-read
// projection into the typed snake_case row before the camelCase map.
const reprRowMapper = createRowMapper(UserRepresentationRowSchema);

/**
 * Default cap for {@link createSqliteUserRepresentationStore}'s `read` — a sane
 * bound so a profile read can never return an unbounded row set. Callers pass an
 * explicit `cap` to override (mirror the triple store's DEFAULT_CURRENT_TRUTH_CAP).
 */
const DEFAULT_READ_CAP = 256;

/** Map a parsed snake_case `user_representation` row to the camelCase entry. */
function rowToEntry(row: {
  id: string;
  entry_type: "identity" | "preference" | "relationship" | "instruction";
  content: string;
  trust: "system" | "learned";
  source_memory_id?: string | null;
  created_at: number;
  updated_at?: number | null;
}): UserRepresentationEntry {
  return {
    id: row.id,
    entryType: row.entry_type,
    content: row.content,
    trust: row.trust,
    createdAt: row.created_at,
    ...(row.source_memory_id != null ? { sourceMemoryId: row.source_memory_id } : {}),
    ...(row.updated_at != null ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * Create the SQLite-backed {@link UserRepresentationStore} adapter over a shared
 * db handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteUserRepresentationStore(
  deps: MemoryUserRepresentationStoreDeps,
): UserRepresentationStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // INSERT one representation entry. Every value a bound `?` (NEVER concatenated).
  // created_at = scope.now (injected clock, NEVER Date.now()); updated_at NULL on
  // first write. The DB CHECK(trust IN ('system','learned')) is the DB-layer floor.
  const insertEntry = db.prepare(
    "INSERT INTO user_representation " +
      "(id, tenant_id, agent_id, user_id, entry_type, content, trust, source_memory_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // The scoped read (T-107-02-01). The `tenant_id = ? AND agent_id = ? AND
  // user_id = ?` filter is the load-bearing 3-way ISOLATION boundary: a row
  // written under one scope can NEVER be read under any differing tenant/agent/
  // user. Newest-first, capped (the cap is a bound `?`). Bound params only.
  const readScoped = db.prepare(
    "SELECT id, entry_type, content, trust, source_memory_id, created_at, updated_at " +
      "FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? " +
      "ORDER BY entry_type, created_at DESC LIMIT ?",
  );

  return {
    async upsert(
      entry: UserRepresentationInput,
      scope: UserRepresentationScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId, now } = scope;
      try {
        // LAYER 3 (write-boundary) of the 3-layer anti-poisoning defense: reject a
        // below-floor trust BEFORE the INSERT — return err, NEVER store it at a
        // reduced weight (defense-in-depth with the DB CHECK). The port type makes
        // this unreachable for honest callers; a cast-past value is rejected here.
        if (entry.trust !== "system" && entry.trust !== "learned") {
          logger?.warn(
            {
              step: "user-repr-upsert",
              errorKind: "validation" as const,
              hint: "trust below the high-trust floor — entry rejected, not stored",
              durationMs: systemNowMs() - startMs,
            },
            "User-representation upsert rejected (trust below high-trust floor)",
          );
          return err(new Error("user-representation: trust below high-trust floor"));
        }

        // The redaction firewall on the untrusted profile text (T-107-02-04 /
        // the port's validateMemoryWrite boundary). The profile is HIGH-TRUST-ONLY
        // — there is no `external` tier to down-store a `warn` into (unlike
        // memory-review-job, which downgrades warn→external) — so ANYTHING not
        // `clean` (a secret-egress hit OR a suspicious-pattern hit) is REJECTED,
        // never persisted.
        const verdict = validateMemoryWrite(entry.content);
        if (verdict.severity !== "clean") {
          logger?.warn(
            {
              step: "user-repr-upsert",
              errorKind: "validation" as const,
              severity: verdict.severity,
              criticalPatterns: verdict.criticalPatterns,
              hint: "content failed validateMemoryWrite (redaction firewall) — entry not persisted",
              durationMs: systemNowMs() - startMs,
            },
            "User-representation upsert rejected (redaction firewall)",
          );
          return err(new Error("user-representation: content failed redaction validation"));
        }

        insertEntry.run(
          crypto.randomUUID(),
          tenantId,
          agentId,
          userId,
          entry.entryType,
          entry.content,
          entry.trust,
          entry.sourceMemoryId ?? null,
          now, // created_at (injected clock)
        );

        // Counts/metadata ONLY — NEVER the content body (§2.7). entryType is a
        // bounded enum tag, not the profile text.
        logger?.debug(
          {
            step: "user-repr-upsert",
            entryType: entry.entryType,
            durationMs: systemNowMs() - startMs,
          },
          "User-representation upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-upsert",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation write failed — entry not persisted",
          },
          "User-representation upsert failed",
        );
        return err(error);
      }
    },

    async read(
      scope: Omit<UserRepresentationScope, "now">,
      cap: number = DEFAULT_READ_CAP,
    ): Promise<Result<UserRepresentationEntry[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId } = scope;
      try {
        // The 3-way scoped read — the (tenant, agent, user) filter is the
        // load-bearing isolation boundary; the cap is a bound `?` param.
        const rows = readScoped.all(tenantId, agentId, userId, cap);
        const parsed = reprRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const entries = parsed.value.map(rowToEntry);

        logger?.debug(
          { step: "user-repr-read", count: entries.length, cap, durationMs: systemNowMs() - startMs },
          "User-representation read complete",
        );
        return ok(entries);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-read",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation read failed — profile unavailable",
          },
          "User-representation read failed",
        );
        return err(error);
      }
    },
  };
}
