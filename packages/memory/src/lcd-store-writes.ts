// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the condensed range/child tamper guard in appendCondensedSummaryTxn — a throw inside db.transaction is the rollback mechanism (atomic) and the afterTurn condense trigger's outer try/catch degrades it non-fatally.
/**
 * LCD (Lossless Context DAG) summary write-transaction builders. Extracted from
 * `lcd-store.ts` so the adapter stays under the 800-line file-size cap (mirrors
 * the prior `lcd-fts.ts` extraction) — this frees the headroom the
 * per-(agent,tenant) read-filter WHERE clauses need.
 *
 * Two responsibilities, BYTE-IDENTICAL relocations of the closures that used to
 * live inside `createLcdStore` (no SQL/column/ordering/error-handling change):
 *   1. `buildAppendLeafSummaryTxn(db, deps)` — the depth-0 leaf-compaction write:
 *      ONE `db.transaction` that persists the `lcd_summaries`
 *      row, links every covered message via `lcd_summary_messages`, and
 *      range-replaces the covered `lcd_context_items` message-refs with one
 *      summary-ref (ordinals stay dense, gap-free, ordered). NEVER deletes
 *      `lcd_messages` (FK RESTRICT enforces losslessness).
 *   2. `buildAppendCondensedSummaryTxn(db, deps)` — the depth>0 condensed-tier
 *      write: a sibling clone that persists a `condensed`-kind
 *      summary, links its CHILD SUMMARIES via `lcd_summary_parents`, and
 *      range-replaces the covered run of SUMMARY-refs (recomputing
 *      descendantCount + time-range from the child rows). NEVER deletes the
 *      child `lcd_summaries` rows (FK RESTRICT — losslessness for the multi-tier
 *      DAG).
 *
 * Each builder takes the prepared statements + row mappers + the `seedContextItems`
 * helper as an injected `deps` object so the "prepare once at createLcdStore"
 * discipline is preserved (the statements are still prepared exactly once at the
 * store's top — they are merely passed in here rather than captured by a closure
 * defined inline). The builders return the same `db.transaction(...)` closure the
 * store's `appendLeafSummary` / `appendCondensedSummary` methods call.
 *
 * `@comis/memory` is infra-free (AGENTS.md §2.4 — no logger): a degraded write
 * skips a bad row silently or rolls back via the tamper-guard throw,
 * exactly as the original did. This file reads ONLY the LCD base tables; it
 * never logs summary `content`.
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  type AppendCondensedSummaryInput,
  type AppendSummaryInput,
  type ContextStoreScope,
  type LcdContextItem,
  type LcdRefKind,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { RowMapper } from "./row-mapper.js";
import type {
  LcdContextItemRowSchema,
  LcdSummaryRowSchema,
} from "./row-schemas.js";

/**
 * The prepared statements + row mappers + seed helper each summary write
 * transaction closes over. Constructed once at `createLcdStore` top and passed
 * in — preserving the "prepare statements once" discipline (the moved closures
 * captured exactly these; passing them keeps the relocation byte-identical).
 */
export interface LcdSummaryWriteDeps {
  /** Lazy-seed context_items 1:1 from lcd_messages for a fresh (conversation, agent, tenant) — agent-scoped. */
  seedContextItems: (scope: ContextStoreScope) => void;
  /** Covered run [start,end] inclusive, ordinal-ascending. */
  selectCtxItemsInRange: Database.Statement;
  /** Seq-ordered (id, created_at) projection — the time-range source. */
  selectMsgSeed: Database.Statement;
  /** Every summary for a conversation, oldest-first — the child-recompute source. */
  selectSummaries: Database.Statement;
  /** Leaf summary insert (hardcodes kind 'leaf' / depth 0). */
  insertSummary: Database.Statement;
  /** Condensed summary insert (binds kind + depth as parameters). */
  insertCondensedSummary: Database.Statement;
  /** The leaf→message losslessness edge (INSERT OR IGNORE). */
  insertSummaryMessage: Database.Statement;
  /** The condensed→child summary edge (INSERT OR IGNORE). */
  insertSummaryParent: Database.Statement;
  /** Insert one context_items row at a vacated ordinal. */
  insertCtxItem: Database.Statement;
  /** Delete the [start,end] context_items rows (vacates those ordinals). */
  deleteCtxItemsInRange: Database.Statement;
  /** The ordinals strictly above the replaced range, ascending. */
  selectCtxOrdinalsAbove: Database.Statement;
  /** Shift one context_items row's ordinal. */
  updateCtxItemOrdinal: Database.Statement;
  /** Per-row degrade mapper for a context_items row. */
  ctxItemRowMapper: RowMapper<z.infer<typeof LcdContextItemRowSchema>>;
  /** Per-row degrade mapper for the (id, created_at) seed projection. */
  messageSeedRowMapper: RowMapper<{ id: string; created_at: number }>;
  /** Per-row degrade mapper for a summary row. */
  summaryRowMapper: RowMapper<z.infer<typeof LcdSummaryRowSchema>>;
  /** Per-row degrade mapper for a single-column ordinal projection. */
  ctxOrdinalRowMapper: RowMapper<{ ordinal: number }>;
  /**
   * Index the NORMALIZED summary twin (`lcd_summaries_fts_tri`)
   * at the summary's base rowid. Called immediately after the summary base write
   * (leaf + condensed). Applies the search fold to `rawContent` INTERNALLY (the
   * single call site lives in lcd-store-fts-populate.ts — the index side of the
   * symmetry), gated on twin availability, best-effort (a twin failure NEVER fails
   * the authoritative summary write — the throw inside this db.transaction would
   * roll it back).
   */
  insertSummaryTri: (
    summaryId: string,
    rawContent: string,
    scope: { conversationId: string; agentId: string },
  ) => void;
}

/**
 * Build the leaf-summary write transaction. One atomic write: persist the
 * leaf summary, link every covered message, and range-replace the covered
 * context_items message-refs with one summary-ref — ordinals stay dense,
 * gap-free, ordered. NEVER deletes lcd_messages (FK RESTRICT
 * enforces losslessness; expansion recovers the underlying rows).
 */
export function buildAppendLeafSummaryTxn(
  db: Database.Database,
  deps: LcdSummaryWriteDeps,
): (input: AppendSummaryInput) => string {
  const {
    seedContextItems,
    selectCtxItemsInRange,
    selectMsgSeed,
    insertSummary,
    insertSummaryMessage,
    insertCtxItem,
    deleteCtxItemsInRange,
    selectCtxOrdinalsAbove,
    updateCtxItemOrdinal,
    ctxItemRowMapper,
    messageSeedRowMapper,
    ctxOrdinalRowMapper,
    insertSummaryTri,
  } = deps;

  return db.transaction((input: AppendSummaryInput): string => {
    const conversationId = input.scope.conversationId;
    // The model-facing view + the seed source are per (conversation,
    // agent, tenant), so every range op below binds the agentId+tenantId from the
    // input scope — a leaf pass touches ONLY the acting agent's view.
    const agentId = input.scope.agentId;
    const tenantId = input.scope.tenantId;
    // Ensure the model-facing view exists before range-replacing it (auto-seed
    // so a leaf pass works even if getContextItems was never called first).
    seedContextItems(input.scope);

    // The covered run [start,end]: gather the message refIds it covers (only
    // `message`-refs link to lcd_messages — a `summary`-ref over a prior leaf is
    // possible in other configurations, but the leaf eviction here selects a message run).
    const coveredItems: LcdContextItem[] = [];
    for (const raw of selectCtxItemsInRange.all(conversationId, agentId, tenantId, input.startOrdinal, input.endOrdinal)) {
      const parsed = ctxItemRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row
      coveredItems.push({
        ordinal: parsed.value.ordinal,
        refKind: parsed.value.ref_kind as LcdRefKind,
        refId: parsed.value.ref_id,
      });
    }
    const coveredMessageIds = coveredItems
      .filter((it) => it.refKind === "message")
      .map((it) => it.refId);

    // Recompute descendantCount + time-range from the COVERED messages (the
    // store is the authority — the input's descendantCount/earliest/latest are
    // advisory; C3 correctness requires they match the actual covered run).
    const coveredSet = new Set(coveredMessageIds);
    let earliestAt = Number.POSITIVE_INFINITY;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const rawMsg of selectMsgSeed.all(conversationId, agentId, tenantId)) {
      const parsed = messageSeedRowMapper.parseOptionalRow(rawMsg);
      if (!parsed.ok || !parsed.value) continue;
      if (!coveredSet.has(parsed.value.id)) continue;
      if (parsed.value.created_at < earliestAt) earliestAt = parsed.value.created_at;
      if (parsed.value.created_at > latestAt) latestAt = parsed.value.created_at;
    }
    const descendantCount = coveredMessageIds.length;
    // Degrade to the caller-supplied range when nothing matched (defensive; an
    // empty covered run yields a zero-descendant summary, never NaN bounds).
    const resolvedEarliest = Number.isFinite(earliestAt) ? earliestAt : input.earliestAt;
    const resolvedLatest = Number.isFinite(latestAt) ? latestAt : input.latestAt;

    // 1. Persist the leaf summary row (depth 0, kind 'leaf', taint/fallback 0/1).
    const summaryId = randomUUID();
    insertSummary.run(
      summaryId,
      conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      resolvedEarliest,
      resolvedLatest,
      descendantCount,
      input.tokenCount,
      input.content,
      JSON.stringify(input.fileIds),
      input.taint ? 1 : 0,
      input.fallback ? 1 : 0,
      input.createdAt,
    );

    // 1b. Index the NORMALIZED summary twin at this summary's
    // base rowid (resolved by summary_id inside the helper). The base row exists
    // now (just inserted). The search fold is applied inside insertSummaryTri (the
    // single call site); the FTS tables carry no tenant_id, so only the
    // (conversationId, agentId) scope is passed. Best-effort (de-indexed on
    // failure, never a rolled-back summary write).
    insertSummaryTri(summaryId, input.content, {
      conversationId,
      agentId: input.scope.agentId,
    });

    // 2. Link one row per covered message id (losslessness ledger).
    for (const messageId of coveredMessageIds) {
      insertSummaryMessage.run(summaryId, messageId);
    }

    // 3. Delete the [start,end] context_items rows (vacates those ordinals).
    deleteCtxItemsInRange.run(conversationId, agentId, tenantId, input.startOrdinal, input.endOrdinal);

    // 4. Insert the summary-ref at ordinal = startOrdinal (a now-vacated slot).
    insertCtxItem.run(
      randomUUID(),
      conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      input.startOrdinal,
      "summary" satisfies LcdRefKind,
      summaryId,
    );

    // 5. Shift every ordinal strictly above the replaced range DOWN by
    //    (endOrdinal - startOrdinal), one row at a time in ascending order so
    //    each target slot is already vacated (no transient UNIQUE-index dup).
    const shift = input.endOrdinal - input.startOrdinal;
    if (shift > 0) {
      for (const raw of selectCtxOrdinalsAbove.all(conversationId, agentId, tenantId, input.endOrdinal)) {
        const parsed = ctxOrdinalRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const ordinal = parsed.value.ordinal;
        updateCtxItemOrdinal.run(ordinal - shift, conversationId, agentId, tenantId, ordinal);
      }
    }

    return summaryId;
  });
}

/**
 * Build the condensed-summary write transaction. One atomic
 * write: persist ONE condensed (depth>0) summary, link it to its CHILD
 * SUMMARIES via lcd_summary_parents (NOT lcd_summary_messages), and
 * range-replace the covered contiguous run of SUMMARY-refs with one condensed
 * summary-ref — ordinals stay dense, gap-free, ordered. A SIBLING CLONE of the
 * leaf txn (steps 3-5 are IDENTICAL — delete/shift operate on ordinals
 * regardless of refKind). DIFFERENCES: the recompute reads the CHILD SUMMARY
 * rows (descendantCount = Σ child.descendantCount; earliest/latest = min/max of
 * the children — the store is the authority); depth/taint/fallback/tokenCount/
 * content are persisted from the INPUT (the agent-side condense summarizer
 * derives them); the link is to children, not messages. NEVER deletes the child
 * lcd_summaries rows (FK RESTRICT enforces losslessness for the multi-tier DAG).
 * Never logs content.
 */
export function buildAppendCondensedSummaryTxn(
  db: Database.Database,
  deps: LcdSummaryWriteDeps,
): (input: AppendCondensedSummaryInput) => string {
  const {
    seedContextItems,
    selectCtxItemsInRange,
    selectSummaries,
    insertCondensedSummary,
    insertSummaryParent,
    insertCtxItem,
    deleteCtxItemsInRange,
    selectCtxOrdinalsAbove,
    updateCtxItemOrdinal,
    ctxItemRowMapper,
    summaryRowMapper,
    ctxOrdinalRowMapper,
    insertSummaryTri,
  } = deps;

  return db.transaction((input: AppendCondensedSummaryInput): string => {
    const conversationId = input.scope.conversationId;
    // Agent-scoped range ops (per (conversation, agent, tenant)) —
    // a condense pass touches ONLY the acting agent's view.
    const agentId = input.scope.agentId;
    const tenantId = input.scope.tenantId;
    // Ensure the model-facing view exists before range-replacing it (the same
    // auto-seed guard the leaf txn uses — a condensed pass works even if
    // getContextItems was never called first).
    seedContextItems(input.scope);

    // Tamper guard — mirror the leaf path's discipline:
    // DERIVE the child set FROM the summary-refs actually living in the replaced
    // [startOrdinal,endOrdinal] range, instead of trusting `input.childSummaryIds`
    // and the range to agree (two independent inputs). Read the range rows once
    // (per-row degrade), and:
    //   (a) REJECT a range that still holds a surviving `message`-ref — a
    //       condensed run is summary-refs ONLY; collapsing a raw message into a
    //       condensed ref whose `lcd_summary_parents` links no message would break
    //       losslessness for that message. The throw rolls back the whole txn
    //       (non-fatal at the trigger).
    //   (b) LINK the range-derived summary ids (not the caller input), so a
    //       mismatched `childSummaryIds` can never corrupt the DAG edges — exactly
    //       as the leaf path links the messages it READ from the range, never the
    //       caller's intent. The `input.childSummaryIds` are therefore advisory:
    //       the range is the single authority (one source of truth).
    const inRangeChildIds: string[] = [];
    for (const raw of selectCtxItemsInRange.all(conversationId, agentId, tenantId, input.startOrdinal, input.endOrdinal)) {
      const parsed = ctxItemRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row
      if (parsed.value.ref_kind !== "summary") {
        throw new Error("condensed range/child mismatch: range contains a non-summary ref");
      }
      inRangeChildIds.push(parsed.value.ref_id);
    }
    const inRangeSet = new Set(inRangeChildIds);

    // Recompute descendantCount + time-range from the RANGE-DERIVED CHILD SUMMARY
    // rows (store is authority — the input's advisory fields are ignored). Read
    // the whole conversation's summaries once, index by id (per-row
    // degrade), filter to the derived children.
    const childSet = inRangeSet;
    let descendantCount = 0;
    let earliestAt = Number.POSITIVE_INFINITY;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const raw of selectSummaries.all(conversationId, agentId, tenantId)) {
      const parsed = summaryRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row
      if (!childSet.has(parsed.value.summary_id)) continue;
      descendantCount += parsed.value.descendant_count;
      if (parsed.value.earliest_at < earliestAt) earliestAt = parsed.value.earliest_at;
      if (parsed.value.latest_at > latestAt) latestAt = parsed.value.latest_at;
    }
    // Degrade to the caller-supplied advisory range when no child matched
    // (defensive; an empty child set yields a zero-descendant summary, never
    // NaN bounds).
    const resolvedEarliest = Number.isFinite(earliestAt) ? earliestAt : input.earliestAt;
    const resolvedLatest = Number.isFinite(latestAt) ? latestAt : input.latestAt;

    // 1. Persist the condensed summary row (kind 'condensed', depth from input).
    const summaryId = randomUUID();
    insertCondensedSummary.run(
      summaryId,
      conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      "condensed",
      input.depth,
      resolvedEarliest,
      resolvedLatest,
      descendantCount,
      input.tokenCount,
      input.content,
      JSON.stringify(input.fileIds),
      input.taint ? 1 : 0,
      input.fallback ? 1 : 0,
      input.createdAt,
    );

    // 1b. Index the NORMALIZED summary twin at this condensed
    // summary's base rowid (resolved by summary_id inside the helper). Same
    // single-call-site fold + best-effort discipline as the leaf path; the FTS
    // tables carry no tenant_id (only conversationId + agentId scope passed).
    insertSummaryTri(summaryId, input.content, {
      conversationId,
      agentId: input.scope.agentId,
    });

    // 2. Link one row per RANGE-DERIVED child summary id (losslessness ledger —
    //    children, not messages). Derived from the range, so the links and
    //    the range-replaced window can never diverge.
    for (const childId of inRangeChildIds) {
      insertSummaryParent.run(summaryId, childId);
    }

    // 3. Delete the [start,end] context_items rows (vacates those ordinals).
    deleteCtxItemsInRange.run(conversationId, agentId, tenantId, input.startOrdinal, input.endOrdinal);

    // 4. Insert the condensed summary-ref at ordinal = startOrdinal (a condensed
    //    summary is still a `summary`-ref, same as a leaf).
    insertCtxItem.run(
      randomUUID(),
      conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      input.startOrdinal,
      "summary" satisfies LcdRefKind,
      summaryId,
    );

    // 5. Shift every ordinal strictly above the replaced range DOWN by
    //    (endOrdinal - startOrdinal), ascending so each target slot is already
    //    vacated (no transient UNIQUE-index dup). Identical to the leaf txn.
    const shift = input.endOrdinal - input.startOrdinal;
    if (shift > 0) {
      for (const raw of selectCtxOrdinalsAbove.all(conversationId, agentId, tenantId, input.endOrdinal)) {
        const parsed = ctxOrdinalRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const ordinal = parsed.value.ordinal;
        updateCtxItemOrdinal.run(ordinal - shift, conversationId, agentId, tenantId, ordinal);
      }
    }

    return summaryId;
  });
}
