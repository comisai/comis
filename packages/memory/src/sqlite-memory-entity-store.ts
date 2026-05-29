// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryEntityStore: the SOLE adapter for the segregated
 * `MemoryEntityStore` port (@comis/core, Phase 83). It owns ALL the
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
 * `memory_entity_links.memory_id` fire (ENT-04 — the entire link-maintenance
 * story; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary (ENT-03)
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
import type { MemoryEntityStore, EntityScope, MemorySearchResult } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { normalizeEntityKey, nameSimilarity } from "./entity-resolver.js";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import { MemoryEntityRowSchema, MemoryRowSchema, EntityLaneRowSchema } from "./row-schemas.js";

/** Dice-bigram similarity at/above which a near-duplicate name reuses an
 *  existing entity rather than minting a new one (design §6.2 / ENT-05). */
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
  const hydrateMemory = db.prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?");

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

        // The whole resolve+link is one transaction so a fuzzy-scan + create
        // + link can never interleave with a concurrent write (mirror
        // sqlite-memory-adapter.ts:85).
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
        // ENT-04: no seeds -> empty lane (no query). RRF ranking is unchanged.
        if (seedIds.length === 0) {
          logger?.debug(
            { step: "entity-lane", seedCount: 0, resultCount: 0, durationMs: 0 },
            "Entity lane skipped (no seeds)",
          );
          return ok([]);
        }

        // The scoped one-hop self-join (RESEARCH Pattern 2 — verified). The
        // `AND m.tenant_id=? AND m.agent_id=?` on the joined memories row is the
        // load-bearing ISOLATION boundary (ENT-03) — a cross-scope memory
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
          const memParsed = memoryRowMapper.parseOptionalRow(hydrateMemory.get(memory_id, tenantId));
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
  };
}
