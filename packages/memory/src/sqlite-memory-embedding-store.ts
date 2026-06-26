// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryEmbeddingStore: the SOLE adapter for the segregated
 * `MemoryEmbeddingStore` port (@comis/core). It
 * owns the (tenant, agent)-scoped bulk embedding read that hydrates the MMR
 * diversity re-rank — given an already-ranked candidate id set, it returns
 * id→vector for the caller's own (tenant, agent), so the agent-side `mmrRerank`
 * can run `λ·rel − (1−λ)·maxCosineToSelected` over the candidates' ACTUAL
 * embeddings (not a lexical proxy).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`); the handle's lifecycle is owned by the caller — this factory
 * neither opens nor closes it.
 *
 * ## Scope is the load-bearing security boundary
 *
 * This read returns the raw VECTORS for a CALLER-SUPPLIED id set (not
 * non-identifying distance scalars — so it cannot rely on the distances-only
 * leak argument). A vector is an
 * identifying payload, so the read MUST be scope-isolated: it JOINs `memories`
 * and filters `m.tenant_id = ? AND m.agent_id = ?` (the `MemoryUsefulnessStore`
 * / `MemoryTemporalStore` isolation precedent). An id belonging to another
 * (tenant, agent) — even if passed in by the caller — misses the scoped JOIN and
 * is ABSENT from the returned map. A cross-(tenant, agent) embedding read is a V4
 * access-control violation (memory poisoning / leak); the scoped JOIN is the fix
 * (RED-tested in sqlite-memory-embedding-store.test.ts). Do NOT copy
 * `knnDistances`'s corpus-wide read here.
 *
 * ## Untrusted input
 *
 * The candidate ids derive from recall over conversation text. Every value
 * reaches SQL as a bound `?` parameter — the `id IN (...)` placeholder list is
 * generated from `ids.length` and the values bound (`stmt.all(tenantId, agentId,
 * ...ids)`) — never concatenated. The `embedding` column is peeled off the raw
 * row BEFORE the strict id-only parse, so the joined column never trips strict
 * mode and there is no `as Foo[]` cast (the row mapper is the sanctioned read
 * path — untyped-sqlite.test.ts).
 *
 * ## Degrade discipline
 *
 * A pure read wrapped in try/catch → `err` — it NEVER throws out. When sqlite-vec
 * is unavailable there is no `vec_memories` table to JOIN, so the read returns
 * `ok(new Map())` immediately (every id absent → MMR no-ops, byte-identical
 * recall). A corrupt/misaligned vec blob degrades that ONE id to absent
 * (`decodeEmbedding` is TOTAL, never throws). The caller (recall MMR) treats a
 * failed read NON-FATALLY: it WARNs and ranks without diversity, never failing
 * recall.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import type { MemoryEmbeddingStore } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { isVecAvailable } from "./schema.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-consolidation-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryEmbeddingStore}. */
export interface MemoryEmbeddingStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Narrow id-only row mapper — the sanctioned read path (no `as Foo[]`). The
// scoped SELECT projects only `id`; the joined `embedding` column is peeled off
// each raw row BEFORE this strict parse, so the extra column never trips
// strictObject.
const idRowMapper = createRowMapper(z.strictObject({ id: z.string() }));

/**
 * Decode a sqlite-vec embedding column (a Node Buffer of packed float32s) into a
 * `number[]`. Returns `undefined` when the column is null/absent (a LEFT JOIN
 * miss, or sqlite-vec unavailable).
 *
 * Decode is TOTAL and non-throwing. A corrupt/misaligned/truncated blob degrades
 * that ONE id to "no embedding" (absent from the map) — it MUST NOT throw,
 * because the caller's outer try/catch would turn a single bad row into an `err`
 * (the whole MMR read would degrade). Two concrete hazards this guards (verbatim
 * from sqlite-memory-consolidation-store.ts:122-137):
 *   - byteOffset alignment: `new Float32Array(buf.buffer, buf.byteOffset, len)`
 *     throws `RangeError` when `byteOffset` is not a multiple of 4 (a POOLED
 *     Buffer's backing ArrayBuffer window). We copy the bytes into a fresh,
 *     0-aligned ArrayBuffer first, so the view offset is always 0.
 *   - truncation: a blob whose byteLength is not a multiple of 4 is not a clean
 *     float32 vector; viewing `floor(len/4)` floats would silently DROP the
 *     trailing bytes and feed a wrong vector into cosine. We reject it.
 */
function decodeEmbedding(raw: unknown): number[] | undefined {
  if (!Buffer.isBuffer(raw)) return undefined;
  // A clean float32 payload is a whole number of 4-byte lanes; anything else is
  // a corrupt/partial blob → degrade (never a silently-truncated vector).
  if (raw.byteLength % 4 !== 0) return undefined;
  try {
    // Copy into a fresh, 0-offset ArrayBuffer (owns its own buffer) so the
    // Float32Array view is always 4-byte aligned regardless of the source
    // Buffer's pooled byteOffset. sqlite-vec packs little-endian float32s.
    const copy = Uint8Array.prototype.slice.call(raw);
    return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
  } catch {
    // Defensive: never let one bad row abort the read.
    return undefined;
  }
}

/**
 * Create the SQLite-backed {@link MemoryEmbeddingStore} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryEmbeddingStore(
  deps: MemoryEmbeddingStoreDeps,
): MemoryEmbeddingStore {
  const { db, logger } = deps;

  return {
    async readEmbeddings(
      ids: string[],
      scope: { tenantId: string; agentId: string },
    ): Promise<Result<ReadonlyMap<string, number[]>, Error>> {
      const startMs = systemNowMs();
      try {
        // No ids → no query (the contract's empty-input fast path).
        if (ids.length === 0) {
          logger?.debug(
            { step: "embedding-read", count: 0, durationMs: systemNowMs() - startMs },
            "embedding read complete (no ids)",
          );
          return ok(new Map());
        }

        // sqlite-vec off → no vec_memories table to JOIN → every id absent. MMR
        // then no-ops (byte-identical recall). A precondition degrade, not an
        // error (mirror knnDistances:491-496).
        if (!isVecAvailable()) {
          logger?.debug(
            { step: "embedding-read", count: 0, errorKind: "precondition" as const, durationMs: systemNowMs() - startMs },
            "embedding read: sqlite-vec unavailable — degrading to empty map",
          );
          return ok(new Map());
        }

        // The scoped LEFT JOIN. The candidate set is bounded
        // (recall's post-rerank pool, ≤ a few dozen), so building the variadic
        // `id IN (?,?,...)` placeholder list + preparing per-call is fine — the
        // ids are BOUND, never concatenated.
        const placeholders = ids.map(() => "?").join(",");
        const stmt = db.prepare(
          "SELECT m.id AS id, v.embedding AS embedding FROM memories m " +
            "LEFT JOIN vec_memories v ON v.memory_id = m.id " +
            `WHERE m.tenant_id = ? AND m.agent_id = ? AND m.id IN (${placeholders})`,
        );
        const rawRows = stmt.all(scope.tenantId, scope.agentId, ...ids);

        const out = new Map<string, number[]>();
        for (const raw of rawRows) {
          // Peel the joined embedding column off the row BEFORE the strict
          // id-only parse (the consolidation-store strictObject trick). The
          // remaining columns are parsed by the narrow id mapper.
          const { embedding: rawEmbedding, ...idOnly } = raw as Record<string, unknown>;
          const parsed = idRowMapper.parseOptionalRow(idOnly);
          if (!parsed.ok) return err(new Error(parsed.error.message));
          if (!parsed.value) continue; // defensive — parseOptionalRow only nulls on undefined input

          const vector = decodeEmbedding(rawEmbedding);
          // Absent embedding (LEFT JOIN miss / corrupt blob) → skip → the id is
          // correctly absent from the map.
          if (vector !== undefined) out.set(parsed.value.id, vector);
        }

        logger?.debug(
          { step: "embedding-read", count: out.size, durationMs: systemNowMs() - startMs },
          "embedding read complete",
        );
        return ok(out);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "embedding-read",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "embedding read failed — MMR degrades to no diversity",
          },
          "embedding read failed",
        );
        return err(error);
      }
    },
  };
}
