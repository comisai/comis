// SPDX-License-Identifier: Apache-2.0
/**
 * LCD→LTM distillation provenance write surface.
 * Extracted from `lcd-store.ts` so the adapter stays under the 800-line
 * file-size cap (mirrors the `lcd-store-writes.ts` / `lcd-store-reads.ts`
 * extractions).
 *
 * `buildProvenanceWrites(db)` prepares the two `lcd_memory_provenance`
 * statements ONCE (preserving the "prepare once at createLcdStore" discipline —
 * they are prepared at store construction and returned as bound closures) and
 * returns the two synchronous ContextStorePort methods the distillation runner
 * calls via optional chaining:
 *
 *   - `appendProvenance(input)` — INSERT one row linking a distilled episodic
 *     memory (memoryId) to the LCD condensed summary (summaryId) it came from.
 *     The scope columns come straight from the DTO; the store never reads the
 *     clock (createdAt is caller-supplied). The row FKs into `memories(id)`
 *     ON DELETE CASCADE — deleting the memory drops the provenance row.
 *   - `markProvenanceSuperseded(summaryId, supersededByMemoryId, tenantId,
 *     agentId)` — the pyramid rule: set `superseded_by` on a descendant
 *     summary's row, ONLY when not already set (`superseded_by IS NULL`), so the
 *     FIRST subsumer wins and a re-run is a harmless no-op. Scoped on
 *     tenant_id + agent_id: a cross-scope summary_id collision is a
 *     fail-closed no-op.
 *
 * Static SQL, bound params, no interpolated identifiers. The store
 * NEVER logs summary/memory content (lossless store; @comis/memory is infra-free
 * per AGENTS.md §2.4).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { AppendProvenanceInput } from "@comis/core";

/** The two provenance write methods returned by {@link buildProvenanceWrites}. */
export interface ProvenanceWrites {
  appendProvenance(input: AppendProvenanceInput): void;
  markProvenanceSuperseded(
    summaryId: string,
    supersededByMemoryId: string,
    tenantId: string,
    agentId: string,
  ): void;
}

/**
 * Prepare the `lcd_memory_provenance` write statements once and return the two
 * synchronous ContextStorePort provenance methods. Called once at
 * `createLcdStore` construction so the prepare-once discipline holds.
 */
export function buildProvenanceWrites(db: Database.Database): ProvenanceWrites {
  // Column order matches the DDL in schema-lcd.ts (provenance_id, memory_id,
  // summary_id, source_session_key, conversation_id, agent_id, tenant_id,
  // created_at) — 8 placeholders, 8 args.
  const insertProvenance = db.prepare(
    "INSERT INTO lcd_memory_provenance" +
      " (provenance_id, memory_id, summary_id, source_session_key," +
      " conversation_id, agent_id, tenant_id, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  // First-subsumer-wins: only set the pointer when not already set, so re-runs
  // are no-ops and a later (different) subsumer never overwrites the first.
  // tenant_id + agent_id are load-bearing — the UPDATE runs on a
  // multi-tenant table, so a summary_id collision under a different scope is a
  // fail-closed no-op (mirrors the INSERT's scope columns + every other LCD SQL).
  const updateProvenanceSuperseded = db.prepare(
    "UPDATE lcd_memory_provenance SET superseded_by = ?" +
      " WHERE summary_id = ? AND tenant_id = ? AND agent_id = ? AND superseded_by IS NULL",
  );

  return {
    appendProvenance(input: AppendProvenanceInput): void {
      insertProvenance.run(
        input.provenanceId,
        input.memoryId,
        input.summaryId,
        input.sourceSessionKey,
        input.conversationId,
        input.agentId,
        input.tenantId,
        input.createdAt,
      );
    },

    markProvenanceSuperseded(
      summaryId: string,
      supersededByMemoryId: string,
      tenantId: string,
      agentId: string,
    ): void {
      updateProvenanceSuperseded.run(supersededByMemoryId, summaryId, tenantId, agentId);
    },
  };
}
