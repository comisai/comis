// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite adapter implementing ContextStorePort — the LCD (Lossless Context DAG)
 * lossless store. Mirrors createSessionStore: prepared statements bound once,
 * a synchronous port-typed object, zod-validated graceful-degrade reads, and an
 * injected wall-clock (the caller supplies `createdAt`; the store never reads
 * the clock or computes tokens).
 *
 * The write path (`append`) persists one message + its N structured parts
 * atomically in a single `db.transaction` (F1). The read path (`getMessages`)
 * reconstructs the ordered `LcdMessage[]` DTOs; the canonical pi-ai Message
 * reconstruction delegates to @comis/core's `partsToMessage` codec (F2/F3) — the
 * single pi-ai-typed seam, consumed by Phase 128 assembly.
 *
 * Phase 129 (C3) extends the store with the depth-0 leaf-compaction surface:
 * `appendLeafSummary` (ONE `db.transaction` that persists the `lcd_summaries`
 * row, links every covered message via `lcd_summary_messages`, and
 * range-replaces the covered `lcd_context_items` message-refs with one
 * summary-ref — keeping ordinals dense, gap-free and ordered) and
 * `getContextItems` (the ordered model-facing view, lazily seeded 1:1 from
 * `lcd_messages` on first read; no migration). `lcd_messages` is NEVER deleted
 * (FK RESTRICT enforces losslessness). The store NEVER logs summary `content`.
 *
 * Phase 130 (C2) adds the condensed tier: `appendCondensedSummary` (a sibling
 * clone of `appendLeafSummary` that persists a depth>0 `condensed`-kind summary,
 * links its CHILD SUMMARIES via `lcd_summary_parents` instead of messages, and
 * range-replaces the covered run of SUMMARY-refs — recomputing descendantCount +
 * time-range from the child rows). The child summary rows are NEVER deleted (FK
 * RESTRICT — losslessness for the multi-tier DAG).
 *
 * NO module-level logger in Phase 127 (mirrors createSessionStore exactly): the
 * memory package has no infra-logging dependency and AGENTS.md §2.4 forbids
 * importing the infra logger directly (inject the logger via Deps). The boundary
 * observability line (an injected-logger INFO per append/read with
 * durationMs/err/hint) lands in Phase 128 when the live append-on-turn
 * write-path is wired. The store NEVER logs `metadata.raw` / `tool_output`
 * contents (tool I/O may carry secrets — a Phase-132 concern; Pino redaction is
 * for logs, not the DB).
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  partsToMessage,
  type AppendCondensedSummaryInput,
  type AppendMessageInput,
  type AppendSummaryInput,
  type ContextStorePort,
  type LcdContextItem,
  type LcdMessage,
  type LcdMessagePart,
  type LcdPartMetadata,
  type LcdPartKind,
  type LcdRefKind,
  type LcdRole,
  type LcdSummary,
  type LcdSummaryKind,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import {
  LcdContextItemRowSchema,
  LcdMessageRowSchema,
  LcdMessagePartRowSchema,
  LcdSummaryRowSchema,
} from "./row-schemas.js";

/**
 * The named pi-ai reconstruction entry point for the LCD store (F2/F3).
 *
 * `getMessages` returns the faithful `LcdMessage` DTO rows; turning one back
 * into a canonical pi-ai `Message` is the consumer's step — Phase-128 assembly
 * calls this. It delegates to the core `partsToMessage` codec (the single
 * pi-ai-typed seam) rather than duplicating the per-block reconstruction in the
 * store; it is exposed here so consumers reconstruct via one named function
 * co-located with the store that produced the rows.
 */
export function reconstructLcdMessage(message: LcdMessage): Message {
  return partsToMessage(message);
}

// Row mappers (createRowMapper(z.strictObject) — degrade to [] on validation
// failure, never throw; strictObject rejects extra columns = drift detection).
const messageRowMapper = createRowMapper(LcdMessageRowSchema);
const partRowMapper = createRowMapper(LcdMessagePartRowSchema);
const ctxItemRowMapper = createRowMapper(LcdContextItemRowSchema);
const summaryRowMapper = createRowMapper(LcdSummaryRowSchema);

/** Projection for the lazy-seed / range-coverage read: message id + createdAt, seq-ordered. */
const MessageSeedRowSchema = z.strictObject({ id: z.string(), created_at: z.number() });
const messageSeedRowMapper = createRowMapper(MessageSeedRowSchema);

/** Single-column ordinal projection for the dense-shift pass (no `as` cast — untyped-sqlite rule). */
const CtxOrdinalRowSchema = z.strictObject({ ordinal: z.number() });
const ctxOrdinalRowMapper = createRowMapper(CtxOrdinalRowSchema);

/** The verbatim canonical block is opaque at the row layer (F1). */
const LcdPartMetadataSchema = z.looseObject({
  raw: z.unknown(),
  rawType: z.string().optional(),
  topLevelReasoningOnly: z.boolean().optional(),
  messageEnvelope: z.unknown().optional(),
  envelopeCarrier: z.boolean().optional(),
});

/**
 * Parse the JSON `metadata` column with graceful degradation (T-127-10 /
 * ASVS V5): a corrupt/poisoned persisted block degrades `raw` to undefined and
 * NEVER throws — a malformed row can not crash reconstruction.
 */
function parseMetadata(raw: string): LcdPartMetadata {
  try {
    const result = LcdPartMetadataSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as LcdPartMetadata) : { raw: undefined };
  } catch {
    return { raw: undefined };
  }
}

/** Parse a nullable JSON column (tool_input / tool_output) — degrade to undefined. */
function parseJsonColumn(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** SQLite NULL/0/1 INTEGER -> boolean | undefined (NULL for non-tool_result parts). */
function intToBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value !== 0;
}

/** boolean | undefined -> SQLite NULL/0/1 INTEGER for the is_error column. */
function boolToInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/**
 * Create a ContextStorePort bound to the given database.
 *
 * Assumes `initSchema()` has already created the `lcd_messages` /
 * `lcd_message_parts` tables.
 */
export function createLcdStore(db: Database.Database): ContextStorePort {
  // Prepare statements once for performance. Static SQL only; bound parameters
  // for every value; no interpolated identifiers (T-127-09). Column-count ===
  // placeholder-count === arg-count (arg-shift guard — a shift surfaces in the
  // round-trip test).
  const insertMsg = db.prepare(`
    INSERT INTO lcd_messages
      (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPart = db.prepare(`
    INSERT INTO lcd_message_parts
      (id, message_id, ordinal, kind, tool_call_id, tool_name, tool_input, tool_output, is_error, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectMsgs = db.prepare(
    "SELECT * FROM lcd_messages WHERE conversation_id = ? ORDER BY seq",
  );

  const selectParts = db.prepare(
    "SELECT * FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
  );

  // ── Phase 129 (C3) statements: summaries + context_items range-replace ──
  // Static SQL, bound params, no interpolated identifiers (T-129-03).

  // The seq-ordered (id, created_at) projection — the lazy seed AND the
  // range-coverage / time-range source. (We re-select created_at by ordinal
  // range below rather than re-deriving it from getMessages, keeping it pure SQL.)
  const selectMsgSeed = db.prepare(
    "SELECT id, created_at FROM lcd_messages WHERE conversation_id = ? ORDER BY seq",
  );

  const insertSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, 'leaf', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Phase 130 (C2): the condensed-tier insert. Unlike insertSummary (which
  // hardcodes 'leaf'/0), this binds kind ('condensed') + depth as parameters —
  // 16 placeholders. insertSummary is left UNCHANGED (a SEPARATE method, no
  // regression risk to the green 129 leaf transaction; RESEARCH A3).
  const insertCondensedSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSummaryMessage = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_messages (summary_id, message_id) VALUES (?, ?)",
  );

  // Phase 130 (C2): the condensed→child summary edge (lcd_summary_parents).
  const insertSummaryParent = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_parents (parent_summary_id, child_summary_id) VALUES (?, ?)",
  );

  const insertCtxItem = db.prepare(`
    INSERT INTO lcd_context_items
      (id, conversation_id, tenant_id, agent_id, session_key, ordinal, ref_kind, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectCtxItems = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_id = ? ORDER BY ordinal",
  );

  // Every leaf summary for a conversation, oldest-first — the assembler keys the
  // result by summaryId to resolve a context_items `summary`-ref to its content.
  const selectSummaries = db.prepare(
    "SELECT * FROM lcd_summaries WHERE conversation_id = ? ORDER BY created_at, summary_id",
  );

  // The covered run [start,end] (inclusive), ordinal-ascending — used to gather
  // the message refIds the new summary links + to count descendants.
  const selectCtxItemsInRange = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ? ORDER BY ordinal",
  );

  const deleteCtxItemsInRange = db.prepare(
    "DELETE FROM lcd_context_items WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ?",
  );

  // The ordinals strictly above the replaced range, ascending — shifted DOWN
  // one row at a time (smallest source first → smallest, already-vacated target
  // first) so the UNIQUE (conversation_id, ordinal) index never sees a transient
  // duplicate (the delete above already vacated the [start,end] slots).
  const selectCtxOrdinalsAbove = db.prepare(
    "SELECT ordinal FROM lcd_context_items WHERE conversation_id = ? AND ordinal > ? ORDER BY ordinal",
  );

  const updateCtxItemOrdinal = db.prepare(
    "UPDATE lcd_context_items SET ordinal = ? WHERE conversation_id = ? AND ordinal = ?",
  );

  const countCtxItems = db.prepare(
    "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ?",
  );

  /**
   * Lazily seed context_items 1:1 from lcd_messages for a conversation with zero
   * rows (A4 — no migration). One message-ref per message, ordinal = seq index,
   * refId = message id. Scope columns come from the first matching message row's
   * scope (the scope is conversation-uniform). Caller runs this inside a txn.
   * Skips silently on a conversation with no messages (nothing to seed).
   */
  function seedContextItems(conversationId: string): void {
    if ((countCtxItems.get(conversationId) as { c: number }).c > 0) return;
    // The full scoped message rows (need tenant/agent/session for the ctx rows).
    let ordinal = 0;
    for (const rawMsg of selectMsgs.all(conversationId)) {
      const parsed = messageRowMapper.parseOptionalRow(rawMsg);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad message row (WR-02)
      const row = parsed.value;
      insertCtxItem.run(
        randomUUID(),
        row.conversation_id,
        row.tenant_id,
        row.agent_id,
        row.session_key,
        ordinal,
        "message" satisfies LcdRefKind,
        row.id,
      );
      ordinal++;
    }
  }

  const seedTxn = db.transaction((conversationId: string) => {
    seedContextItems(conversationId);
  });

  // One atomic write: persist the leaf summary, link every covered message, and
  // range-replace the covered context_items message-refs with one summary-ref —
  // ordinals stay dense, gap-free, ordered (C3). NEVER deletes lcd_messages
  // (Pitfall 5 — FK RESTRICT enforces losslessness; expansion in Phase 131
  // recovers the underlying rows).
  const appendLeafSummaryTxn = db.transaction((input: AppendSummaryInput): string => {
    const conversationId = input.scope.conversationId;
    // Ensure the model-facing view exists before range-replacing it (auto-seed
    // so a leaf pass works even if getContextItems was never called first).
    seedContextItems(conversationId);

    // The covered run [start,end]: gather the message refIds it covers (only
    // `message`-refs link to lcd_messages — a `summary`-ref over a prior leaf is
    // possible in later phases but in 129 the eviction selects a message run).
    const coveredItems: LcdContextItem[] = [];
    for (const raw of selectCtxItemsInRange.all(conversationId, input.startOrdinal, input.endOrdinal)) {
      const parsed = ctxItemRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
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
    for (const rawMsg of selectMsgSeed.all(conversationId)) {
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

    // 2. Link one row per covered message id (losslessness ledger).
    for (const messageId of coveredMessageIds) {
      insertSummaryMessage.run(summaryId, messageId);
    }

    // 3. Delete the [start,end] context_items rows (vacates those ordinals).
    deleteCtxItemsInRange.run(conversationId, input.startOrdinal, input.endOrdinal);

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
      for (const raw of selectCtxOrdinalsAbove.all(conversationId, input.endOrdinal)) {
        const parsed = ctxOrdinalRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
        const ordinal = parsed.value.ordinal;
        updateCtxItemOrdinal.run(ordinal - shift, conversationId, ordinal);
      }
    }

    return summaryId;
  });

  // One atomic write (Phase 130, C2): persist ONE condensed (depth>0) summary,
  // link it to its CHILD SUMMARIES via lcd_summary_parents (NOT
  // lcd_summary_messages), and range-replace the covered contiguous run of
  // SUMMARY-refs with one condensed summary-ref — ordinals stay dense, gap-free,
  // ordered. A SIBLING CLONE of appendLeafSummaryTxn (steps 3-5 are IDENTICAL —
  // delete/shift operate on ordinals regardless of refKind). DIFFERENCES: the
  // recompute reads the CHILD SUMMARY rows (descendantCount = Σ
  // child.descendantCount; earliest/latest = min/max of the children — the store
  // is the authority); depth/taint/fallback/tokenCount/content are persisted
  // from the INPUT (the agent-side condense summarizer derives them); the link
  // is to children, not messages. NEVER deletes the child lcd_summaries rows (FK
  // RESTRICT enforces losslessness for the multi-tier DAG). Never logs content.
  const appendCondensedSummaryTxn = db.transaction((input: AppendCondensedSummaryInput): string => {
    const conversationId = input.scope.conversationId;
    // Ensure the model-facing view exists before range-replacing it (the same
    // auto-seed guard the leaf txn uses — a condensed pass works even if
    // getContextItems was never called first).
    seedContextItems(conversationId);

    // T-130 tamper guard (WR-02) — mirror the leaf path's T-129-22 discipline:
    // DERIVE the child set FROM the summary-refs actually living in the replaced
    // [startOrdinal,endOrdinal] range, instead of trusting `input.childSummaryIds`
    // and the range to agree (two independent inputs). Read the range rows once
    // (per-row degrade), and:
    //   (a) REJECT a range that still holds a surviving `message`-ref — a
    //       condensed run is summary-refs ONLY; collapsing a raw message into a
    //       condensed ref whose `lcd_summary_parents` links no message would break
    //       losslessness for that message. The throw rolls back the whole txn
    //       (non-fatal at the trigger, T-130-07).
    //   (b) LINK the range-derived summary ids (not the caller input), so a
    //       mismatched `childSummaryIds` can never corrupt the DAG edges — exactly
    //       as the leaf path links the messages it READ from the range, never the
    //       caller's intent. The `input.childSummaryIds` are therefore advisory:
    //       the range is the single authority (one source of truth).
    const inRangeChildIds: string[] = [];
    for (const raw of selectCtxItemsInRange.all(conversationId, input.startOrdinal, input.endOrdinal)) {
      const parsed = ctxItemRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
      if (parsed.value.ref_kind !== "summary") {
        throw new Error("condensed range/child mismatch: range contains a non-summary ref");
      }
      inRangeChildIds.push(parsed.value.ref_id);
    }
    const inRangeSet = new Set(inRangeChildIds);

    // Recompute descendantCount + time-range from the RANGE-DERIVED CHILD SUMMARY
    // rows (store is authority — the input's advisory fields are ignored). Read
    // the whole conversation's summaries once, index by id (WR-02 per-row
    // degrade), filter to the derived children.
    const childSet = inRangeSet;
    let descendantCount = 0;
    let earliestAt = Number.POSITIVE_INFINITY;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const raw of selectSummaries.all(conversationId)) {
      const parsed = summaryRowMapper.parseOptionalRow(raw);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
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

    // 2. Link one row per RANGE-DERIVED child summary id (losslessness ledger —
    //    children, not messages). Derived from the range (WR-02), so the links and
    //    the range-replaced window can never diverge.
    for (const childId of inRangeChildIds) {
      insertSummaryParent.run(summaryId, childId);
    }

    // 3. Delete the [start,end] context_items rows (vacates those ordinals).
    deleteCtxItemsInRange.run(conversationId, input.startOrdinal, input.endOrdinal);

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
      for (const raw of selectCtxOrdinalsAbove.all(conversationId, input.endOrdinal)) {
        const parsed = ctxOrdinalRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row (WR-02)
        const ordinal = parsed.value.ordinal;
        updateCtxItemOrdinal.run(ordinal - shift, conversationId, ordinal);
      }
    }

    return summaryId;
  });

  // One atomic write: the message row + its N part rows commit together (F1).
  const appendTxn = db.transaction((input: AppendMessageInput) => {
    const messageId = randomUUID();
    insertMsg.run(
      messageId,
      input.scope.conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      input.seq,
      input.role,
      input.tokenCount,
      input.createdAt,
    );

    let ordinal = 0;
    for (const part of input.parts) {
      insertPart.run(
        randomUUID(),
        messageId,
        ordinal,
        part.kind,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput === undefined ? null : JSON.stringify(part.toolInput),
        part.toolOutput === undefined ? null : JSON.stringify(part.toolOutput),
        boolToInt(part.isError),
        JSON.stringify(part.metadata),
      );
      ordinal++;
    }
  });

  return {
    append(input: AppendMessageInput): void {
      appendTxn(input);
    },

    getMessages(conversationId: string): LcdMessage[] {
      // WR-02: degrade PER ROW, not per result-set. `parseRows` returns err on
      // the first bad row and discards every already-validated row — so one
      // corrupt PART row would null a whole message body (orphaning a
      // downstream tool_result -> provider rejection) and one corrupt MESSAGE
      // row would drop the whole conversation. Validate each row with
      // `parseOptionalRow` and skip ONLY the bad row, keeping its good
      // siblings — the same graceful-degrade granularity `parseMetadata` uses
      // per field. Ordering is preserved (we iterate the ORDER BY result in
      // order). The skip is silent by design: the memory package has no
      // infra-logging dependency (AGENTS.md §2.4 forbids importing getLogger
      // directly); the boundary observability line lands in Phase 128 with the
      // injected-logger write path. A schema-violating row is unreachable via
      // the typed `append` — it requires on-disk corruption / schema drift.
      const out: LcdMessage[] = [];

      for (const rawMsg of selectMsgs.all(conversationId)) {
        const parsedMsg = messageRowMapper.parseOptionalRow(rawMsg);
        if (!parsedMsg.ok || !parsedMsg.value) continue; // skip only the bad message row
        const row = parsedMsg.value;

        const parts: LcdMessagePart[] = [];
        for (const rawPart of selectParts.all(row.id)) {
          const parsedPart = partRowMapper.parseOptionalRow(rawPart);
          if (!parsedPart.ok || !parsedPart.value) continue; // skip only the bad part row
          const p = parsedPart.value;
          parts.push({
            kind: p.kind as LcdPartKind,
            toolCallId: p.tool_call_id ?? undefined,
            toolName: p.tool_name ?? undefined,
            toolInput: parseJsonColumn(p.tool_input),
            toolOutput: parseJsonColumn(p.tool_output),
            isError: intToBool(p.is_error),
            metadata: parseMetadata(p.metadata),
          });
        }

        out.push({
          id: row.id,
          conversationId: row.conversation_id,
          seq: row.seq,
          role: row.role as LcdRole,
          tokenCount: row.token_count,
          createdAt: row.created_at,
          parts,
        });
      }

      return out;
    },

    appendLeafSummary(input: AppendSummaryInput): string {
      return appendLeafSummaryTxn(input);
    },

    appendCondensedSummary(input: AppendCondensedSummaryInput): string {
      return appendCondensedSummaryTxn(input);
    },

    getContextItems(conversationId: string): LcdContextItem[] {
      // Lazy-seed 1:1 from lcd_messages on first read (A4 — no migration). The
      // seed runs in its own txn so the SELECT below sees the inserted rows.
      if ((countCtxItems.get(conversationId) as { c: number }).c === 0) {
        seedTxn(conversationId);
      }

      // WR-02: degrade PER ROW, not per result-set — a corrupt/ drifted
      // context_items row is skipped, its siblings survive (NEVER `parseRows`,
      // which would discard every already-validated row). Ordering is preserved
      // (we iterate the ORDER BY ordinal result in order). The skip is silent by
      // design: the memory package has no infra-logging dependency (AGENTS.md
      // §2.4); the boundary observability line is agent-side (Plan 05).
      const out: LcdContextItem[] = [];
      for (const raw of selectCtxItems.all(conversationId)) {
        const parsed = ctxItemRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        out.push({
          ordinal: parsed.value.ordinal,
          refKind: parsed.value.ref_kind as LcdRefKind,
          refId: parsed.value.ref_id,
        });
      }
      return out;
    },

    getSummaries(conversationId: string): LcdSummary[] {
      // WR-02: degrade PER ROW, not per result-set — a corrupt/drifted summary
      // row is skipped, its siblings survive (NEVER `parseRows`, which would
      // discard every already-validated row). The skip is silent by design (the
      // memory package has no infra-logging dependency, AGENTS.md §2.4); the
      // boundary observability line is agent-side (the assembler, Plan 05). The
      // store NEVER logs the summary `content` (lossless store; T-129-10).
      const out: LcdSummary[] = [];
      for (const raw of selectSummaries.all(conversationId)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const row = parsed.value;
        out.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind as LcdSummaryKind,
          depth: row.depth,
          earliestAt: row.earliest_at,
          latestAt: row.latest_at,
          descendantCount: row.descendant_count,
          tokenCount: row.token_count,
          content: row.content,
          fileIds: parseFileIds(row.file_ids),
          taint: row.taint !== 0,
          fallback: row.fallback !== 0,
          createdAt: row.created_at,
        });
      }
      return out;
    },
  };
}

/** Parse the JSON `file_ids` column to a string[] — degrade to [] on corruption. */
function parseFileIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
