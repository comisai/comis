// SPDX-License-Identifier: Apache-2.0
/**
 * The `memory_usefulness.failure_count` per-column migration — the
 * outcome-attributed task-failure signal read by the memory
 * lifecycle sweep's per-(tenant, agent) JOIN. DISTINCT from `ignored_count`
 * (recalled-but-not-cited, a usage proxy): a correct-but-unused memory accrues
 * `ignored_count`, never `failure_count`.
 *
 * Relocated here OUT of `schema-tuned-alpha.ts` — that file
 * is the bandit `tuned_alpha` migration and is DELETED when the bandit is cut.
 * This column is a KEEPER (the source the lifecycle JOIN reads), so it
 * lives in its own focused keeper schema module, mirroring the
 * `schema-outcome-events.ts` co-location precedent (a small schema file imported
 * + called by `schema.ts`, which is at the 800-line cap). `schema.ts` calls it as
 * the LAST statement of `ensureUsefulnessTable`, so EVERY caller that ensures the
 * usefulness table gets the column — not only `initSchema`.
 *
 * Forward-only, re-run-safe: SQLite has no `ADD COLUMN IF NOT EXISTS`, so the add
 * is guarded by a `PRAGMA table_info(memory_usefulness)` presence check, then an
 * `ADD COLUMN ... NOT NULL DEFAULT 0` (O(1), constant default — never NULL for a
 * count). The `ensureMemoryColumns` per-column-add idiom; no destructive or
 * reverse DDL, no branch on an old shape (additive).
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard is
 * needed ([[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

/**
 * Idempotently ensure `memory_usefulness` carries the `failure_count` column —
 * the outcome-attributed task-failure signal. DISTINCT from
 * `ignored_count` (recalled-but-not-cited, a usage proxy): a correct-but-unused
 * memory accrues `ignored_count`, never `failure_count`. The per-column
 * `ensureMemoryColumns` idiom: a `PRAGMA table_info` presence guard, then an
 * `ADD COLUMN ... NOT NULL DEFAULT 0` (O(1), constant default — never NULL for a
 * count). Forward-only, re-run-safe.
 *
 * @param db - An open better-sqlite3 Database whose `memory_usefulness` table
 *   already exists (call AFTER `ensureUsefulnessTable` in `initSchema`).
 */
export function ensureUsefulnessFailureColumn(db: Database.Database): void {
  const cols = new Set(
    requireTableInfoRows(
      db.prepare(`PRAGMA table_info(memory_usefulness)`).all(),
      "memory_usefulness",
    ).map(
      (row) => row.name,
    ),
  );
  if (!cols.has("failure_count")) {
    db.exec(`ALTER TABLE memory_usefulness ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`);
  }
}
