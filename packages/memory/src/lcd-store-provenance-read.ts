// SPDX-License-Identifier: Apache-2.0
/**
 * LCD→LTM distillation provenance READ surface. The read-mirror of the write-side
 * `lcd-store-provenance.ts` (buildProvenanceWrites).
 *
 * `buildProvenanceReadStore(db)` is the concrete {@link LcdProvenanceReadStore}
 * adapter the daemon injects into createMemoryRecall so the post-fusion
 * provenance down-weighting pass (packages/agent/src/rag/recall-provenance.ts)
 * can resolve the EXACT provenance-linked memoryIds a distilled summary subsumes.
 * Built as its OWN factory (NOT a method on ContextStorePort / createLcdStore) so
 * the recall pipeline's import surface stays narrow — per the port doc in
 * context-store.ts. It is threaded as a separate `provenanceStore`.
 *
 * Tenant + agent isolation is the load-bearing security property: the SELECT carries
 * `WHERE summary_id = ? AND tenant_id = ? AND agent_id = ?` (mirror the write
 * side's INSERT/UPDATE scope columns). A summary_id collision under a different
 * (tenant, agent) scope is a fail-closed no-op — a cross-scope read returns ZERO
 * rows, so another scope's provenance can never leak into the recall pass.
 *
 * Static SQL, bound params, no interpolated identifiers. Reads go
 * through `createRowMapper` (no `as Foo[]` cast — untyped-sqlite.test.ts). The
 * store NEVER logs summary/memory content (@comis/memory is infra-free per
 * AGENTS.md §2.4 — no logger import).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import type { LcdProvenanceReadStore, ContextStoreScope } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";

/**
 * Schema for the `lcd_memory_provenance` read projection — the four columns the
 * recall provenance pass needs (the scope columns are the WHERE predicate, not
 * projected). `superseded_by` is nullable (NULL until the pyramid rule sets it).
 * Declared HERE (not in row-schemas.ts) — it is file-local to the sole consumer
 * and adding it to the shared row-schemas.ts would push that file over the
 * 800-line cap (mirror the inline `countOnlySchema` precedent in row-mapper.ts).
 */
const LcdProvenanceReadRowSchema = z.strictObject({
  provenance_id: z.string(),
  memory_id: z.string(),
  source_session_key: z.string(),
  superseded_by: z.string().nullable(),
});

// Row mapper — the sanctioned read path (no `as Foo[]`).
const provenanceReadRowMapper = createRowMapper(LcdProvenanceReadRowSchema);

/**
 * Prepare the scoped `lcd_memory_provenance` read statement once and return
 * the concrete {@link LcdProvenanceReadStore}. Called once at the composition
 * root (setup-memory.ts) on the SAME db handle as createLcdStore, so the
 * prepare-once discipline holds.
 */
export function buildProvenanceReadStore(db: Database.Database): LcdProvenanceReadStore {
  // tenant_id + agent_id are load-bearing — a summary_id collision
  // under a different scope is a fail-closed no-op (mirrors the write-side
  // INSERT/UPDATE scope columns + every other LCD SQL).
  const selectBySummary = db.prepare(
    "SELECT provenance_id, memory_id, source_session_key, superseded_by" +
      " FROM lcd_memory_provenance" +
      " WHERE summary_id = ? AND tenant_id = ? AND agent_id = ?",
  );

  return {
    getProvenanceForSummary(scope: ContextStoreScope, summaryId: string) {
      const rows = selectBySummary.all(summaryId, scope.tenantId, scope.agentId);
      const parsed = provenanceReadRowMapper.parseRows(rows);
      // Degrade-on-validation-error: the provenance pass is non-fatal (the caller
      // swallows a throw to a WARN), so a malformed row yields an empty read
      // rather than a throw — recall results are NEVER affected by a bad row.
      if (!parsed.ok) return [];
      return parsed.value.map((row) => ({
        provenanceId: row.provenance_id,
        memoryId: row.memory_id,
        sourceSessionKey: row.source_session_key,
        supersededBy: row.superseded_by,
      }));
    },
  };
}
