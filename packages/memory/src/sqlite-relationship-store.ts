// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteRelationshipStore: the SOLE adapter for the segregated `RelationshipStore`
 * port (@comis/core, Phase 108, Track E2 — SOCIAL-02). It owns ALL the directional
 * relationship SQL over the additive `relationship` table — the only place SQL is
 * written for this capability.
 *
 * ## Method status
 *
 * - `upsert(entry, scope)` writes one DIRECTIONAL, HIGH-TRUST relationship edge
 *   (`subjectUser`'s representation OF `aboutUser`) under the caller's (tenant,
 *   agent, channel) scope. Layer 3 of the 3-layer anti-poisoning defense: it
 *   REJECTS a below-floor `trust` at the write boundary (returns `err` — never
 *   stores it at a reduced weight), BEFORE the INSERT, as defense-in-depth with the
 *   DB `CHECK(trust IN ('system','learned'))` (layer 1) and the port-type floor
 *   (layer 2, 108-01). `content` is untrusted relationship text — it runs through
 *   `validateMemoryWrite` (redaction firewall) and is bound as a `?` parameter,
 *   never concatenated. The row id is a `randomUUID()` (imported from `node:crypto`,
 *   mirror the user-representation store); `created_at` is the injected clock
 *   `scope.now`, NEVER `Date.now()`. The directional `(subjectUserId, aboutUserId)`
 *   pair is bound ROW DATA — A→B is a distinct row from B→A, never symmetrized.
 * - `read(scope, cap)` is the LLM-free relationship read: the edges for the
 *   caller's (tenant, agent, channel) scope ONLY, capped. This is the deterministic
 *   read an (optional) prompt-assembly injection block (later plan) consumes with
 *   NO model call. Returns an empty array when the channel has no edges (the
 *   default-OFF no-op).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in via
 * `getDb()`), so it runs against the same schema with `PRAGMA foreign_keys = ON`
 * already set — that pragma is what makes the `source_memory_id -> memories(id)`
 * `ON DELETE CASCADE` fire.
 *
 * ## Isolation is the load-bearing security boundary (SOCIAL-02, the §5.2 / ENT-03
 *    pattern, EXTENDED with `channel_id` — the NEW privacy axis)
 *
 * Comis runs many agents, many channels, and many users in one DB. BOTH the write
 * (the INSERT) and the read (the scoped SELECT) filter on
 * `(tenant_id, agent_id, channel_id)` — parameterized — so a relationship edge
 * written under one (tenant, agent, channel) is NEVER returned for another scope by
 * content coincidence. A cross-channel OR cross-tenant OR cross-agent read is
 * STRUCTURALLY impossible. The directional `(subject_user_id, about_user_id)` pair
 * is ROW DATA inside that scope, NOT part of the security filter.
 *
 * ## Untrusted input
 *
 * `content` derives from conversation content. It is DATA, never SQL — every value
 * reaching SQL is a bound `?` parameter, never concatenated. Every read parses
 * through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`). The
 * adapter logs counts/metadata only — NEVER the `content` body OR the directional
 * user-id pair (AGENTS.md §2.7 — relationship content + user PII stay out of logs).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  RelationshipStore,
  RelationshipScope,
  RelationshipInput,
  RelationshipEntry,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { systemNowMs, validateMemoryWrite } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { RelationshipRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-user-representation-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteRelationshipStore}. */
export interface MemoryRelationshipStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). Parses the scoped-read
// projection into the typed snake_case row before the camelCase map.
const relationshipRowMapper = createRowMapper(RelationshipRowSchema);

/**
 * Default cap for {@link createSqliteRelationshipStore}'s `read` — a sane bound so
 * a relationship read can never return an unbounded row set. Callers pass an
 * explicit `cap` to override (mirror the user-representation store's
 * DEFAULT_READ_CAP).
 */
const DEFAULT_READ_CAP = 256;

/** Map a parsed snake_case `relationship` row to the camelCase entry. */
function rowToEntry(row: {
  id: string;
  subject_user_id: string;
  about_user_id: string;
  content: string;
  trust: "system" | "learned";
  source_memory_id?: string | null;
  created_at: number;
  updated_at?: number | null;
}): RelationshipEntry {
  return {
    id: row.id,
    subjectUserId: row.subject_user_id,
    aboutUserId: row.about_user_id,
    content: row.content,
    trust: row.trust,
    createdAt: row.created_at,
    ...(row.source_memory_id != null ? { sourceMemoryId: row.source_memory_id } : {}),
    ...(row.updated_at != null ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * Create the SQLite-backed {@link RelationshipStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller (the
 * memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteRelationshipStore(
  deps: MemoryRelationshipStoreDeps,
): RelationshipStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // INSERT one directional relationship edge. Every value a bound `?` (NEVER
  // concatenated). created_at = scope.now (injected clock, NEVER Date.now());
  // updated_at NULL on first write. The DB CHECK(trust IN ('system','learned')) is
  // the DB-layer high-trust floor.
  const insertEntry = db.prepare(
    "INSERT INTO relationship " +
      "(id, tenant_id, agent_id, channel_id, subject_user_id, about_user_id, content, trust, source_memory_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // The scoped read (SOCIAL-02). The `tenant_id = ? AND agent_id = ? AND
  // channel_id = ?` filter is the load-bearing 4-way ISOLATION boundary: an edge
  // written under one scope can NEVER be read under any differing tenant/agent/
  // channel. The subject/about pair is projected ROW DATA, NOT part of the security
  // WHERE. Newest-first within each directional pair, capped (the cap is a bound
  // `?`). Bound params only.
  const readScoped = db.prepare(
    "SELECT id, subject_user_id, about_user_id, content, trust, source_memory_id, created_at, updated_at " +
      "FROM relationship " +
      "WHERE tenant_id = ? AND agent_id = ? AND channel_id = ? " +
      "ORDER BY subject_user_id, about_user_id, created_at DESC LIMIT ?",
  );

  return {
    async upsert(
      entry: RelationshipInput,
      scope: RelationshipScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, channelId, now } = scope;
      try {
        // LAYER 3 (write-boundary) of the 3-layer anti-poisoning defense: reject a
        // below-floor trust BEFORE the INSERT — return err, NEVER store it at a
        // reduced weight (defense-in-depth with the DB CHECK). The port type makes
        // this unreachable for honest callers; a cast-past value is rejected here.
        if (entry.trust !== "system" && entry.trust !== "learned") {
          logger?.warn(
            {
              step: "relationship-upsert",
              errorKind: "validation" as const,
              hint: "trust below the high-trust floor — edge rejected, not stored",
              durationMs: systemNowMs() - startMs,
            },
            "Relationship upsert rejected (trust below high-trust floor)",
          );
          return err(new Error("relationship: trust below high-trust floor"));
        }

        // The redaction firewall on the untrusted relationship text (the port's
        // validateMemoryWrite boundary). The relationship is HIGH-TRUST-ONLY —
        // there is no `external` tier to down-store a `warn` into — so ANYTHING not
        // `clean` (a secret-egress hit OR a suspicious-pattern hit) is REJECTED,
        // never persisted.
        const verdict = validateMemoryWrite(entry.content);
        if (verdict.severity !== "clean") {
          logger?.warn(
            {
              step: "relationship-upsert",
              errorKind: "validation" as const,
              severity: verdict.severity,
              criticalPatterns: verdict.criticalPatterns,
              hint: "content failed validateMemoryWrite (redaction firewall) — edge not persisted",
              durationMs: systemNowMs() - startMs,
            },
            "Relationship upsert rejected (redaction firewall)",
          );
          return err(new Error("relationship: content failed redaction validation"));
        }

        insertEntry.run(
          randomUUID(),
          tenantId,
          agentId,
          channelId,
          entry.subjectUserId,
          entry.aboutUserId,
          entry.content,
          entry.trust,
          entry.sourceMemoryId ?? null,
          now, // created_at (injected clock)
        );

        // Counts/metadata ONLY — NEVER the content body OR the directional user
        // pair (§2.7). trust is a bounded enum tag, not relationship text or PII.
        logger?.debug(
          {
            step: "relationship-upsert",
            trust: entry.trust,
            durationMs: systemNowMs() - startMs,
          },
          "Relationship upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "relationship-upsert",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "relationship write failed — edge not persisted",
          },
          "Relationship upsert failed",
        );
        return err(error);
      }
    },

    async read(
      scope: Omit<RelationshipScope, "now">,
      cap: number = DEFAULT_READ_CAP,
    ): Promise<Result<RelationshipEntry[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, channelId } = scope;
      try {
        // The 4-way scoped read — the (tenant, agent, channel) filter is the
        // load-bearing isolation boundary; the cap is a bound `?` param.
        const rows = readScoped.all(tenantId, agentId, channelId, cap);
        const parsed = relationshipRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const entries = parsed.value.map(rowToEntry);

        logger?.debug(
          { step: "relationship-read", count: entries.length, cap, durationMs: systemNowMs() - startMs },
          "Relationship read complete",
        );
        return ok(entries);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "relationship-read",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "relationship read failed — relationships unavailable",
          },
          "Relationship read failed",
        );
        return err(error);
      }
    },
  };
}
