// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryEntityStore: the SOLE adapter for the segregated
 * `MemoryEntityStore` port (@comis/core). It owns ALL the
 * entity-association SQL — the write-path resolver (exact `canonical_key`
 * reuse, else `nameSimilarity >= 0.6` fuzzy reuse, else create; bump
 * `mention_count`/`last_seen`; idempotent link) and the read-path associative
 * lane (the scoped one-hop self-join over `memory_entity_links`, seeds
 * excluded, hydrated into `MemorySearchResult[]`).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema (`memory_entities`,
 * `memory_entity_links`, `memories`) with `PRAGMA foreign_keys = ON` already
 * set — that pragma is what makes the `ON DELETE CASCADE` on
 * `memory_entity_links.memory_id` fire — the entire link-maintenance
 * story; no orphan-sweep job.
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. BOTH the resolver SELECT and the lane
 * self-join filter on `(tenant_id, agent_id)` — parameterized — so two agents
 * (or tenants) NEVER collapse to one entity row and NEVER surface each other's
 * memories even when an entity name is byte-identical. This is belt-and-braces
 * with the `(tenant_id, agent_id, canonical_key)` UNIQUE index (schema.ts).
 *
 * ## Untrusted input
 *
 * Entity names derive from conversation text. Every name reaches SQL as a bound
 * `?` parameter — never concatenated — and every read parses through
 * `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`).
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MemoryEntityStore, EntityScope, EntityRow, MemorySearchResult } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { normalizeEntityKey, nameSimilarity } from "./entity-resolver.js";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import {
  MemoryEntityRowSchema,
  MemoryRowSchema,
  EntityLaneRowSchema,
  EntityListRowSchema,
} from "./row-schemas.js";

/** Dice-bigram similarity at/above which a near-duplicate name reuses an
 *  existing entity rather than minting a new one (design §6.2). */
const FUZZY_REUSE_THRESHOLD = 0.6;

/** Minimal pino-compatible logger (mirrors sqlite-memory-adapter.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryEntityStore}. */
export interface MemoryEntityStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mappers — the sanctioned read path (no `as Foo[]`).
const entityRowMapper = createRowMapper(MemoryEntityRowSchema);
const memoryRowMapper = createRowMapper(MemoryRowSchema);
const laneRowMapper = createRowMapper(EntityLaneRowSchema);
const entityListRowMapper = createRowMapper(EntityListRowSchema);

/**
 * Create the SQLite-backed {@link MemoryEntityStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryEntityStore(deps: MemoryEntityStoreDeps): MemoryEntityStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  const selectExact = db.prepare(
    "SELECT id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen " +
      "FROM memory_entities WHERE tenant_id = ? AND agent_id = ? AND canonical_key = ?",
  );
  const selectScope = db.prepare(
    "SELECT id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen " +
      "FROM memory_entities WHERE tenant_id = ? AND agent_id = ?",
  );
  const insertEntity = db.prepare(
    "INSERT INTO memory_entities (id, tenant_id, agent_id, canonical_name, canonical_key, mention_count, first_seen, last_seen) " +
      "VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  );
  const bumpEntity = db.prepare(
    "UPDATE memory_entities SET mention_count = mention_count + 1, last_seen = ? WHERE id = ?",
  );
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO memory_entity_links (memory_id, entity_id) VALUES (?, ?)",
  );
  // Scope the per-row hydrate on BOTH (tenant_id, agent_id), not tenant
  // alone. Today this is redundant — the lane self-join already filtered
  // `m.agent_id = ?`, so every id reaching here is agent-scoped — but the
  // isolation boundary then depends on two statements agreeing, with the agent
  // dimension enforced in only one. Re-asserting the full scope here makes the
  // hydrate self-sufficient (no fail-open if the lane query is ever refactored).
  // FORGET-01 (CR-01): the ALWAYS-ON `evicted_at IS NULL` recall exclusion. This is a
  // RECALL-side hydration (associativeLane → MemorySearchResult[] → createMemoryRecall →
  // the prompt), so a soft-evicted shared-entity memory MUST be omitted here exactly as on
  // the adapter's recall paths. The inspect/asOf raw reads stay UNFILTERED (eviction soft +
  // asOf-resolvable). The entity LINK rows survive (CASCADE only on a hard delete).
  const hydrateMemory = db.prepare(
    "SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ? AND evicted_at IS NULL",
  );
  // Diagnostic read: the scoped entity list, most-mentioned-first. The
  // `WHERE tenant_id = ? AND agent_id = ?` is the SAME load-bearing isolation
  // boundary as the resolver SELECT and the lane self-join — two
  // scopes never surface each other's rows. `canonical_key` is intentionally
  // NOT projected (DB-internal dedup key). Tie-break on `last_seen DESC`
  // then `id` so equal mention_count rows have a deterministic order. `LIMIT ?`
  // bounds the result. Placeholders only — no string-built SQL.
  const selectEntityList = db.prepare(
    "SELECT id, canonical_name, mention_count, first_seen, last_seen " +
      "FROM memory_entities WHERE tenant_id = ? AND agent_id = ? " +
      "ORDER BY mention_count DESC, last_seen DESC, id LIMIT ?",
  );

  return {
    async resolveAndLink(
      memoryId: string,
      name: string,
      scope: EntityScope,
    ): Promise<Result<string, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      try {
        const key = normalizeEntityKey(name);

        // ExtractedEntitySchema.name is `z.string().min(1)` — that checks
        // LENGTH, not non-whitespace, so a whitespace/punctuation/combining-mark-
        // only name (e.g. "   ", "---", a lone combining acute) passes the schema
        // yet `normalizeEntityKey` folds it to "". With no guard, every such junk
        // name in a scope collapses into ONE empty-`canonical_key` entity (the
        // `(tenant_id, agent_id, canonical_key)` UNIQUE index), spuriously
        // associating unrelated memories. Refuse it here — the resolver is the
        // sole writer — and return `err`. The memory-review-job treats this
        // as NON-FATAL: the memory is still stored, only the content-free
        // association is dropped (WARN + continue, watermark advances).
        if (key === "") {
          // NEVER log the entity name body (AGENTS.md §2.7) — metadata only.
          logger?.debug(
            { step: "entity-resolve", skipped: "empty-key" },
            "Entity resolve skipped (name normalizes to empty canonical key)",
          );
          return err(new Error("entity name normalizes to empty canonical key"));
        }

        // The whole resolve+link runs in ONE transaction (mirror
        // sqlite-memory-adapter.ts:85) so the selectExact-miss -> fuzzy-scan ->
        // create -> link sequence is atomic. NOTE: better-sqlite3 transactions
        // are DEFERRED (no up-front write lock), so atomicity here does NOT by
        // itself serialize two *concurrent* writers; what guarantees no
        // interleave is that the daemon memory write path is SINGLE-THREADED
        // and better-sqlite3 is synchronous — two resolveAndLink calls cannot
        // run mid-transaction. The create branch below leans on that assumption
        // (see its note); were this path ever made concurrent, the plain INSERT
        // would need INSERT OR IGNORE + re-resolve.
        const resolution = db.transaction((): { entityId: string; reused: boolean; fuzzyScore?: number } => {
          // 1) Exact reuse on the normalized canonical_key (scoped).
          const exactParsed = entityRowMapper.parseOptionalRow(selectExact.get(tenantId, agentId, key));
          if (!exactParsed.ok) throw new Error(exactParsed.error.message);
          if (exactParsed.value) {
            const entityId = exactParsed.value.id;
            bumpEntity.run(now, entityId);
            insertLink.run(memoryId, entityId);
            return { entityId, reused: true };
          }

          // 2) Fuzzy reuse — scan candidates in scope, pick best >= threshold
          //    (tie -> highest score).
          const scopedParsed = entityRowMapper.parseRows(selectScope.all(tenantId, agentId));
          if (!scopedParsed.ok) throw new Error(scopedParsed.error.message);
          let best: { id: string; score: number } | undefined;
          for (const cand of scopedParsed.value) {
            const score = nameSimilarity(name, cand.canonical_name);
            if (score >= FUZZY_REUSE_THRESHOLD && (best === undefined || score > best.score)) {
              best = { id: cand.id, score };
            }
          }
          if (best) {
            bumpEntity.run(now, best.id);
            insertLink.run(memoryId, best.id);
            return { entityId: best.id, reused: true, fuzzyScore: best.score };
          }

          // 3) Create a new entity (display-cased name; normalized key).
          // This is a plain INSERT (not INSERT OR IGNORE). It is race-safe
          // ONLY because of the single-writer assumption documented on the
          // transaction above: under the single-threaded daemon write path no
          // other writer can commit a row for this `(tenant_id, agent_id,
          // canonical_key)` between the selectExact miss and this INSERT. If that
          // assumption were ever broken (a second concurrent writer), this could
          // throw SQLITE_CONSTRAINT_UNIQUE — which is NON-FATAL today (caught
          // below -> err Result -> WARN + continue, the memory is still
          // stored), not data loss. A concurrent design would make this branch
          // idempotent (INSERT OR IGNORE + re-resolve the now-existing row).
          const entityId = randomUUID();
          insertEntity.run(entityId, tenantId, agentId, name, key, now, now);
          insertLink.run(memoryId, entityId);
          return { entityId, reused: false };
        });

        const { entityId, reused, fuzzyScore } = resolution();

        const durationMs = systemNowMs() - startMs;
        // NEVER log the entity name body (AGENTS.md §2.7) — only metadata.
        logger?.debug(
          {
            step: "entity-resolve",
            durationMs,
            reused,
            ...(fuzzyScore !== undefined ? { fuzzyScore } : {}),
          },
          "Entity resolve+link complete",
        );
        return ok(entityId);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "entity-resolve",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "entity resolve/link failed — check DB integrity",
          },
          "Entity resolve+link failed",
        );
        return err(error);
      }
    },

    async associativeLane(
      seedIds: string[],
      scope: Omit<EntityScope, "now">,
      cap: number,
    ): Promise<Result<MemorySearchResult[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // No seeds -> empty lane (no query). RRF ranking is unchanged.
        if (seedIds.length === 0) {
          logger?.debug(
            { step: "entity-lane", seedCount: 0, resultCount: 0, durationMs: 0 },
            "Entity lane skipped (no seeds)",
          );
          return ok([]);
        }

        // The scoped one-hop self-join. The
        // `AND m.tenant_id=? AND m.agent_id=?` on the joined memories row is the
        // load-bearing ISOLATION boundary — a cross-scope memory
        // sharing an entity name is excluded. Seeds are excluded via
        // `l2.memory_id <> l1.memory_id`. Placeholders only — no string-built SQL.
        const seedPlaceholders = seedIds.map(() => "?").join(", ");
        const laneSql =
          "SELECT l2.memory_id, COUNT(DISTINCT l1.entity_id) AS shared " +
          "FROM memory_entity_links l1 " +
          "JOIN memory_entity_links l2 ON l2.entity_id = l1.entity_id AND l2.memory_id <> l1.memory_id " +
          "JOIN memories m ON m.id = l2.memory_id " +
          `WHERE l1.memory_id IN (${seedPlaceholders}) ` +
          "  AND m.tenant_id = ? AND m.agent_id = ? " +
          "GROUP BY l2.memory_id " +
          "ORDER BY shared DESC " +
          "LIMIT ?";
        const laneRows = db.prepare(laneSql).all(...seedIds, tenantId, agentId, cap);

        const parsed = laneRowMapper.parseRows(laneRows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Hydrate each shared-entity memory row (scoped) into a
        // MemorySearchResult; score = tanh(shared * 0.5) (design §5.2 intra-lane
        // order). Rows already arrive most-shared-first.
        const results: MemorySearchResult[] = [];
        for (const { memory_id, shared } of parsed.value) {
          const memParsed = memoryRowMapper.parseOptionalRow(
            hydrateMemory.get(memory_id, tenantId, agentId),
          );
          if (!memParsed.ok) return err(new Error(memParsed.error.message));
          const row = memParsed.value;
          if (!row) continue; // defensive: hydrate miss -> skip
          results.push({ entry: rowToEntry(row), score: Math.tanh(shared * 0.5) });
        }

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "entity-lane", seedCount: seedIds.length, resultCount: results.length, durationMs },
          "Entity lane complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "entity-lane",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "entity associative lane query failed",
          },
          "Entity lane failed",
        );
        return err(error);
      }
    },

    async listEntities(
      agentId: string,
      tenantId: string,
      limit: number,
    ): Promise<Result<EntityRow[], Error>> {
      const startMs = systemNowMs();
      try {
        // Scoped read — the `tenant_id = ? AND agent_id = ?` filter is the
        // load-bearing isolation boundary, identical in spirit to the
        // resolver SELECT and the lane self-join: a same-named entity in another
        // scope is never surfaced. Bound parameters only.
        const rows = selectEntityList.all(tenantId, agentId, limit);

        const parsed = entityListRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Map the snake_case DB projection to the camelCase `EntityRow` domain
        // shape. `first_seen`/`last_seen` are NOT NULL in the schema today, but
        // `EntityRow` models them optional — spread them only when present so a
        // future nullable migration degrades to "field absent" rather than
        // surfacing a 0/NULL as a real timestamp.
        const entities: EntityRow[] = parsed.value.map((row) => ({
          id: row.id,
          name: row.canonical_name,
          mentionCount: row.mention_count,
          ...(row.first_seen !== null ? { firstSeen: row.first_seen } : {}),
          ...(row.last_seen !== null ? { lastSeen: row.last_seen } : {}),
        }));

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "entity-list", resultCount: entities.length, durationMs },
          "Entity list complete",
        );
        return ok(entities);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "entity-list",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "entity list query failed — check DB integrity",
          },
          "Entity list failed",
        );
        return err(error);
      }
    },
  };
}
