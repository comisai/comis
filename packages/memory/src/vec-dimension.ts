// SPDX-License-Identifier: Apache-2.0
/**
 * vec0 dimension reconciliation shared by `schema.ts` (vec_memories) and
 * `schema-mental-models.ts` (vec_mental_models).
 *
 * A vec0 virtual table bakes its embedding dimension into the CREATE DDL, so
 * `CREATE VIRTUAL TABLE IF NOT EXISTS … float[N]` can never migrate an
 * existing table to a new N. Without reconciliation, switching the embedder
 * (e.g. a local 768-dim GGUF model for a 1536-dim API embedder) leaves the
 * stale table in place and every KNN query and INSERT at the new dimension
 * throws `SqliteError: Dimension mismatch`, killing vector recall while the
 * rest of the daemon looks healthy.
 */
import type Database from "better-sqlite3";

/** Names of the vec0 twins this module is allowed to drop (closed set — the
 *  table name is interpolated into DDL). */
export type VecTwinTable = "vec_memories" | "vec_mental_models";

/** Reported rebuild of a vec0 twin whose baked-in dimension no longer matched
 *  the configured embedder, surfaced so the boot path can log it at INFO. */
export interface VecTableRebuild {
  table: VecTwinTable;
  fromDimensions: number;
  toDimensions: number;
}

/**
 * Drop `tableName` when its vec0 DDL declares a different embedding dimension
 * than `embeddingDimensions`. Returns the stale dimension when a drop
 * happened, `undefined` when the table is absent, dimension-less, or already
 * correct. The caller recreates the table (its usual `CREATE VIRTUAL TABLE IF
 * NOT EXISTS`) and re-queues rows for embedding — vectors are derived data,
 * so dropping them loses nothing that a reindex cannot regenerate.
 */
/**
 * Classify an error as a sqlite-vec dimension mismatch (query or insert side:
 * "Dimension mismatch … Expected N dimensions but received M"). Lets the
 * failure sites log an errorKind/hint that names the real knob (the embedder
 * configuration) instead of a generic check-database-integrity pointer.
 */
export function isVecDimensionMismatch(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /dimension mismatch/i.test(message);
}

export function reconcileVecTableDimension(
  db: Database.Database,
  tableName: VecTwinTable,
  embeddingDimensions: number,
): number | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string | null } | undefined;
  if (row?.sql == null) return undefined;
  const match = /float\[(\d+)\]/.exec(row.sql);
  if (match === null) return undefined;
  const existing = Number(match[1]);
  if (existing === embeddingDimensions) return undefined;
  db.exec(`DROP TABLE ${tableName}`);
  return existing;
}
