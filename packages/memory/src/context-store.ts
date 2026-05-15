// SPDX-License-Identifier: Apache-2.0
/**
 * Context store factory -- CRUD operations for all DAG entities.
 *
 * Factory function pattern: initializes schema (idempotent), prepares all
 * fixed-parameter SQL statements once in the closure, and returns a frozen
 * ContextStore object. Dynamic WHERE IN queries are prepared per-call with
 * chunking at 500 to stay well within SQLite's variable limit.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  ContextStorePort,
  CtxMessagePartRow,
  CtxMessageRow,
} from "@comis/core";
import { initContextSchema } from "./context-schema.js";
import { buildFtsQuery } from "./hybrid-search.js";
import { createRowMapper } from "./row-mapper.js";
import {
  CtxConversationRowSchema,
  CtxMessageRowSchema,
  CtxMessagePartRowSchema,
  CtxSummaryRowSchema,
  CtxContextItemRowSchema,
  CtxLargeFileRowSchema,
  CtxExpansionGrantRowSchema,
} from "./row-schemas.js";

// ---------------------------------------------------------------------------
// Row mappers (Phase 41 TS-HYG-03)
//
// Each mapper wraps a Zod schema and returns Result<TRow[]|TRow|undefined,
// MapperError> from raw better-sqlite3 .all()/.get() output. On validation
// failure the store DEGRADES SILENTLY (empty array / undefined), preserving
// the ContextStorePort plain-return contract. Context-store read methods are
// non-fatal — corrupt rows yield empty result sets, not crashes, which
// preserves the agent's ability to make forward progress (per Plan 41-04
// §"Use either pattern... 2. Unwrap-with-default").
// ---------------------------------------------------------------------------

const conversationMapper = createRowMapper(CtxConversationRowSchema);
const messageMapper = createRowMapper(CtxMessageRowSchema);
const messagePartMapper = createRowMapper(CtxMessagePartRowSchema);
const summaryMapper = createRowMapper(CtxSummaryRowSchema);
const contextItemMapper = createRowMapper(CtxContextItemRowSchema);
const largeFileMapper = createRowMapper(CtxLargeFileRowSchema);
const expansionGrantMapper = createRowMapper(CtxExpansionGrantRowSchema);

// Anonymous projection mappers (inline shapes — id-only projections, FTS hits).
const messageIdProjectionMapper = createRowMapper(
  z.strictObject({ message_id: z.number() }),
);
const summaryIdProjectionMapper = createRowMapper(
  z.strictObject({ summary_id: z.string() }),
);
const parentSummaryIdProjectionMapper = createRowMapper(
  z.strictObject({ parent_summary_id: z.string() }),
);
const ftsMessageHitMapper = createRowMapper(
  z.strictObject({
    messageId: z.number(),
    content: z.string(),
    rank: z.number(),
  }),
);
const ftsSummaryHitMapper = createRowMapper(
  z.strictObject({
    summaryId: z.string(),
    content: z.string(),
    rank: z.number(),
  }),
);
const regexMessageCandidateMapper = createRowMapper(
  z.strictObject({ message_id: z.number(), content: z.string() }),
);
const regexSummaryCandidateMapper = createRowMapper(
  z.strictObject({ summary_id: z.string(), content: z.string() }),
);
const lastSeqProjectionMapper = createRowMapper(
  z.strictObject({ max_seq: z.number().nullable() }),
);
const grantCountProjectionMapper = createRowMapper(
  z.strictObject({ cnt: z.number() }),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of bind parameters per chunked WHERE IN query. */
const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ContextStorePort bound to the given database.
 *
 * Calls initContextSchema (idempotent) to ensure all ctx_ tables,
 * indexes, and FTS5 virtual tables exist. Prepares all fixed-parameter
 * SQL statements once for performance.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns Frozen ContextStore implementation
 */
export function createContextStore(db: Database.Database): ContextStorePort {
  // Idempotent schema initialization
  initContextSchema(db);

  // -----------------------------------------------------------------------
  // Prepared statements (fixed-parameter)
  // -----------------------------------------------------------------------

  // -- Conversations --
  const insertConvStmt = db.prepare(`
    INSERT INTO ctx_conversations (conversation_id, tenant_id, agent_id, session_key, title)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getConvStmt = db.prepare(
    "SELECT * FROM ctx_conversations WHERE conversation_id = ?",
  );
  const getConvBySessionStmt = db.prepare(
    "SELECT * FROM ctx_conversations WHERE tenant_id = ? AND session_key = ?",
  );
  const touchConvStmt = db.prepare(
    "UPDATE ctx_conversations SET updated_at = datetime('now') WHERE conversation_id = ?",
  );
  const listConvStmt = db.prepare(
    "SELECT * FROM ctx_conversations WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  );

  // -- Messages --
  const insertMsgStmt = db.prepare(`
    INSERT INTO ctx_messages (conversation_id, seq, role, content, content_hash, token_count, tool_name, tool_call_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMsgFtsStmt = db.prepare(
    "INSERT INTO ctx_messages_fts(rowid, content) VALUES (?, ?)",
  );
  const getMsgsByConvStmt = db.prepare(
    "SELECT * FROM ctx_messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT ?",
  );
  const getMsgsByConvAfterSeqStmt = db.prepare(
    "SELECT * FROM ctx_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
  );
  const getMsgByHashStmt = db.prepare(
    "SELECT * FROM ctx_messages WHERE conversation_id = ? AND content_hash = ?",
  );
  const getLastSeqStmt = db.prepare(
    "SELECT MAX(seq) as max_seq FROM ctx_messages WHERE conversation_id = ?",
  );

  // -- Message Parts --
  const insertPartStmt = db.prepare(`
    INSERT INTO ctx_message_parts (message_id, ordinal, part_type, content, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getPartsByMsgStmt = db.prepare(
    "SELECT * FROM ctx_message_parts WHERE message_id = ? ORDER BY ordinal ASC",
  );

  // -- Summaries --
  const insertSumStmt = db.prepare(`
    INSERT INTO ctx_summaries (summary_id, conversation_id, kind, depth, content, token_count, file_ids, earliest_at, latest_at, source_token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSumFtsStmt = db.prepare(
    "INSERT INTO ctx_summaries_fts(summary_id, content) VALUES (?, ?)",
  );
  const getSumStmt = db.prepare(
    "SELECT * FROM ctx_summaries WHERE summary_id = ?",
  );
  const getSumsByConvStmt = db.prepare(
    "SELECT * FROM ctx_summaries WHERE conversation_id = ? ORDER BY created_at ASC",
  );
  const getSumsByConvDepthStmt = db.prepare(
    "SELECT * FROM ctx_summaries WHERE conversation_id = ? AND depth = ? ORDER BY created_at ASC",
  );
  const deleteSumFtsStmt = db.prepare(
    "DELETE FROM ctx_summaries_fts WHERE summary_id = ?",
  );
  const deleteSumStmt = db.prepare(
    "DELETE FROM ctx_summaries WHERE summary_id = ?",
  );

  // -- Summary Links --
  const insertSumMsgStmt = db.prepare(
    "INSERT INTO ctx_summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)",
  );
  const insertSumParentStmt = db.prepare(
    "INSERT INTO ctx_summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)",
  );
  const getSourceMsgIdsStmt = db.prepare(
    "SELECT message_id FROM ctx_summary_messages WHERE summary_id = ? ORDER BY ordinal ASC",
  );
  const getParentSumIdsStmt = db.prepare(
    "SELECT parent_summary_id FROM ctx_summary_parents WHERE summary_id = ? ORDER BY ordinal ASC",
  );
  const getChildSumIdsStmt = db.prepare(
    "SELECT summary_id FROM ctx_summary_parents WHERE parent_summary_id = ? ORDER BY ordinal ASC",
  );

  // -- Context Items --
  const deleteCtxItemsStmt = db.prepare(
    "DELETE FROM ctx_context_items WHERE conversation_id = ?",
  );
  const insertCtxItemStmt = db.prepare(`
    INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getCtxItemsStmt = db.prepare(
    "SELECT * FROM ctx_context_items WHERE conversation_id = ? ORDER BY ordinal ASC",
  );

  // -- Large Files --
  const insertFileStmt = db.prepare(`
    INSERT INTO ctx_large_files (file_id, conversation_id, file_name, mime_type, byte_size, content_hash, storage_path, exploration_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getFileStmt = db.prepare(
    "SELECT * FROM ctx_large_files WHERE file_id = ?",
  );
  const getFileByHashStmt = db.prepare(
    "SELECT * FROM ctx_large_files WHERE conversation_id = ? AND content_hash = ?",
  );

  // -- Expansion Grants --
  const insertGrantStmt = db.prepare(`
    INSERT INTO ctx_expansion_grants (grant_id, issuer_session, conversation_ids, summary_ids, max_depth, token_cap, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getGrantStmt = db.prepare(
    "SELECT * FROM ctx_expansion_grants WHERE grant_id = ?",
  );
  const getActiveGrantsStmt = db.prepare(
    "SELECT * FROM ctx_expansion_grants WHERE issuer_session = ? AND revoked = 0 AND expires_at > datetime('now')",
  );
  const consumeGrantStmt = db.prepare(
    "UPDATE ctx_expansion_grants SET tokens_consumed = tokens_consumed + ? WHERE grant_id = ?",
  );
  const revokeGrantStmt = db.prepare(
    "UPDATE ctx_expansion_grants SET revoked = 1 WHERE grant_id = ?",
  );
  const cleanupGrantsStmt = db.prepare(
    "DELETE FROM ctx_expansion_grants WHERE expires_at < datetime('now') OR revoked = 1",
  );
  const countGrantsTodayStmt = db.prepare(
    "SELECT COUNT(*) as cnt FROM ctx_expansion_grants WHERE issuer_session = ? AND created_at >= date('now')",
  );

  // -- Bulk: conversation delete helper stmts --
  const getMsgIdsByConvStmt = db.prepare(
    "SELECT message_id FROM ctx_messages WHERE conversation_id = ?",
  );
  const getSumIdsByConvStmt = db.prepare(
    "SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?",
  );
  const deleteSumMsgsByConvStmt = db.prepare(
    "DELETE FROM ctx_summary_messages WHERE summary_id IN (SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?)",
  );
  const deleteSumParentsByConvStmt = db.prepare(
    "DELETE FROM ctx_summary_parents WHERE summary_id IN (SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?) OR parent_summary_id IN (SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?)",
  );
  const deleteCtxItemsByConvStmt = db.prepare(
    "DELETE FROM ctx_context_items WHERE conversation_id = ?",
  );
  const deleteConvStmt = db.prepare(
    "DELETE FROM ctx_conversations WHERE conversation_id = ?",
  );

  // -----------------------------------------------------------------------
  // Transactions
  // -----------------------------------------------------------------------

  const insertMessageTx = db.transaction(
    (params: {
      conversationId: string;
      seq: number;
      role: string;
      content: string;
      contentHash: string;
      tokenCount: number;
      toolName?: string;
      toolCallId?: string;
    }): number => {
      const info = insertMsgStmt.run(
        params.conversationId,
        params.seq,
        params.role,
        params.content,
        params.contentHash,
        params.tokenCount,
        params.toolName ?? null,
        params.toolCallId ?? null,
      );
      const messageId = Number(info.lastInsertRowid);
      insertMsgFtsStmt.run(messageId, params.content);
      return messageId;
    },
  );

  const insertSummaryTx = db.transaction(
    (params: {
      summaryId: string;
      conversationId: string;
      kind: "leaf" | "condensed";
      depth: number;
      content: string;
      tokenCount: number;
      fileIds?: string[];
      earliestAt?: string;
      latestAt?: string;
      sourceTokenCount?: number;
    }): string => {
      insertSumStmt.run(
        params.summaryId,
        params.conversationId,
        params.kind,
        params.depth,
        params.content,
        params.tokenCount,
        JSON.stringify(params.fileIds ?? []),
        params.earliestAt ?? null,
        params.latestAt ?? null,
        params.sourceTokenCount ?? 0,
      );
      insertSumFtsStmt.run(params.summaryId, params.content);
      return params.summaryId;
    },
  );

  const deleteSummaryTx = db.transaction((summaryId: string): void => {
    // Delete summary links first (RESTRICT prevents deleting summary while linked)
    db.prepare(
      "DELETE FROM ctx_summary_messages WHERE summary_id = ?",
    ).run(summaryId);
    db.prepare(
      "DELETE FROM ctx_summary_parents WHERE summary_id = ? OR parent_summary_id = ?",
    ).run(summaryId, summaryId);
    // Delete context items referencing this summary
    db.prepare(
      "DELETE FROM ctx_context_items WHERE summary_id = ?",
    ).run(summaryId);
    // Clean up FTS
    deleteSumFtsStmt.run(summaryId);
    // Delete summary row
    deleteSumStmt.run(summaryId);
  });

  const replaceContextItemsTx = db.transaction(
    (
      conversationId: string,
      items: Array<{
        ordinal: number;
        itemType: "message" | "summary";
        messageId?: number;
        summaryId?: string;
      }>,
    ): void => {
      deleteCtxItemsStmt.run(conversationId);
      for (const item of items) {
        insertCtxItemStmt.run(
          conversationId,
          item.ordinal,
          item.itemType,
          item.messageId ?? null,
          item.summaryId ?? null,
        );
      }
    },
  );

  const deleteConversationTx = db.transaction(
    (conversationId: string): void => {
      // 1. Get all message IDs and summary IDs for FTS cleanup.
      // Degrade-on-validation-error: empty array → no FTS cleanup needed
      // for the corrupt rows; the CASCADE on conversation delete still fires.
      const msgIdsParsed = messageIdProjectionMapper.parseRows(
        getMsgIdsByConvStmt.all(conversationId),
      );
      const msgRows = msgIdsParsed.ok ? msgIdsParsed.value : [];
      const sumIdsParsed = summaryIdProjectionMapper.parseRows(
        getSumIdsByConvStmt.all(conversationId),
      );
      const sumRows = sumIdsParsed.ok ? sumIdsParsed.value : [];

      // 2. Delete summary links first (RESTRICT on message_id and parent_summary_id)
      deleteSumMsgsByConvStmt.run(conversationId);
      deleteSumParentsByConvStmt.run(conversationId, conversationId);

      // 3. Delete context items (RESTRICT on message_id and summary_id)
      deleteCtxItemsByConvStmt.run(conversationId);

      // 4. Clean up FTS entries explicitly (FTS5 does not CASCADE)
      const msgIds = msgRows.map((r) => r.message_id);
      if (msgIds.length > 0) {
        for (let i = 0; i < msgIds.length; i += CHUNK_SIZE) {
          const chunk = msgIds.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk.map(() => "?").join(",");
          db.prepare(
            `DELETE FROM ctx_messages_fts WHERE rowid IN (${placeholders})`,
          ).run(...chunk);
        }
      }

      const sumIds = sumRows.map((r) => r.summary_id);
      if (sumIds.length > 0) {
        for (let i = 0; i < sumIds.length; i += CHUNK_SIZE) {
          const chunk = sumIds.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk.map(() => "?").join(",");
          db.prepare(
            `DELETE FROM ctx_summaries_fts WHERE summary_id IN (${placeholders})`,
          ).run(...chunk);
        }
      }

      // 5. Delete conversation row (CASCADE handles messages, summaries,
      //    large_files, expansion_grants)
      deleteConvStmt.run(conversationId);
    },
  );

  // -----------------------------------------------------------------------
  // Store implementation
  // -----------------------------------------------------------------------

  const store: ContextStorePort = {
    // --- Conversations ---

    createConversation(params) {
      const conversationId = "conv_" + randomBytes(8).toString("hex");
      insertConvStmt.run(
        conversationId,
        params.tenantId,
        params.agentId,
        params.sessionKey,
        params.title ?? null,
      );
      return conversationId;
    },

    getConversation(conversationId) {
      const parsed = conversationMapper.parseOptionalRow(
        getConvStmt.get(conversationId),
      );
      // Degrade-on-validation-error → undefined (consistent with missing).
      return parsed.ok ? parsed.value : undefined;
    },

    getConversationBySession(tenantId, sessionKey) {
      const parsed = conversationMapper.parseOptionalRow(
        getConvBySessionStmt.get(tenantId, sessionKey),
      );
      return parsed.ok ? parsed.value : undefined;
    },

    touchConversation(conversationId) {
      touchConvStmt.run(conversationId);
    },

    listConversations(tenantId, opts) {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const parsed = conversationMapper.parseRows(
        listConvStmt.all(tenantId, limit, offset),
      );
      // Degrade-on-validation-error → empty list.
      return parsed.ok ? parsed.value : [];
    },

    // --- Messages ---

    insertMessage(params) {
      return insertMessageTx(params);
    },

    getMessagesByConversation(conversationId, opts) {
      const limit = opts?.limit ?? 1000;
      const raw =
        opts?.afterSeq !== undefined
          ? getMsgsByConvAfterSeqStmt.all(conversationId, opts.afterSeq, limit)
          : getMsgsByConvStmt.all(conversationId, limit);
      const parsed = messageMapper.parseRows(raw);
      return parsed.ok ? parsed.value : [];
    },

    getMessagesByIds(ids) {
      if (ids.length === 0) return [];
      const results: CtxMessageRow[] = [];
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const raw = db
          .prepare(
            `SELECT * FROM ctx_messages WHERE message_id IN (${placeholders}) ORDER BY seq ASC`,
          )
          .all(...chunk);
        const parsed = messageMapper.parseRows(raw);
        const rows = parsed.ok ? parsed.value : [];
        results.push(...rows);
      }
      return results;
    },

    getMessageByHash(conversationId, contentHash) {
      const parsed = messageMapper.parseOptionalRow(
        getMsgByHashStmt.get(conversationId, contentHash),
      );
      return parsed.ok ? parsed.value : undefined;
    },

    getLastMessageSeq(conversationId) {
      const parsed = lastSeqProjectionMapper.parseOptionalRow(
        getLastSeqStmt.get(conversationId),
      );
      const row = parsed.ok ? parsed.value : undefined;
      return row?.max_seq ?? 0;
    },

    // --- Message Parts ---

    insertParts(messageId, parts) {
      for (const part of parts) {
        insertPartStmt.run(
          messageId,
          part.ordinal,
          part.partType,
          part.content ?? null,
          part.metadata ?? null,
        );
      }
    },

    getPartsByMessage(messageId) {
      const parsed = messagePartMapper.parseRows(getPartsByMsgStmt.all(messageId));
      return parsed.ok ? parsed.value : [];
    },

    getPartsByMessages(messageIds) {
      const result = new Map<number, CtxMessagePartRow[]>();
      if (messageIds.length === 0) return result;
      for (let i = 0; i < messageIds.length; i += CHUNK_SIZE) {
        const chunk = messageIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const raw = db
          .prepare(
            `SELECT * FROM ctx_message_parts WHERE message_id IN (${placeholders}) ORDER BY ordinal ASC`,
          )
          .all(...chunk);
        const parsed = messagePartMapper.parseRows(raw);
        const rows = parsed.ok ? parsed.value : [];
        for (const row of rows) {
          let parts = result.get(row.message_id);
          if (!parts) {
            parts = [];
            result.set(row.message_id, parts);
          }
          parts.push(row);
        }
      }
      return result;
    },

    // --- Summaries ---

    insertSummary(params) {
      return insertSummaryTx(params);
    },

    getSummary(summaryId) {
      const parsed = summaryMapper.parseOptionalRow(getSumStmt.get(summaryId));
      return parsed.ok ? parsed.value : undefined;
    },

    getSummariesByConversation(conversationId, opts) {
      const raw =
        opts?.depth !== undefined
          ? getSumsByConvDepthStmt.all(conversationId, opts.depth)
          : getSumsByConvStmt.all(conversationId);
      const parsed = summaryMapper.parseRows(raw);
      return parsed.ok ? parsed.value : [];
    },

    updateSummaryCountsDirty(summaryIds, dirty) {
      if (summaryIds.length === 0) return;
      const dirtyVal = dirty ? 1 : 0;
      for (let i = 0; i < summaryIds.length; i += CHUNK_SIZE) {
        const chunk = summaryIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        db.prepare(
          `UPDATE ctx_summaries SET counts_dirty = ? WHERE summary_id IN (${placeholders})`,
        ).run(dirtyVal, ...chunk);
      }
    },

    deleteSummary(summaryId) {
      deleteSummaryTx(summaryId);
    },

    // --- Summary Links ---

    linkSummaryMessages(summaryId, messageIds) {
      for (let i = 0; i < messageIds.length; i++) {
        insertSumMsgStmt.run(summaryId, messageIds[i], i);
      }
    },

    linkSummaryParents(summaryId, parentSummaryIds) {
      for (let i = 0; i < parentSummaryIds.length; i++) {
        insertSumParentStmt.run(summaryId, parentSummaryIds[i], i);
      }
    },

    getSourceMessageIds(summaryId) {
      const parsed = messageIdProjectionMapper.parseRows(
        getSourceMsgIdsStmt.all(summaryId),
      );
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => r.message_id);
    },

    getParentSummaryIds(summaryId) {
      const parsed = parentSummaryIdProjectionMapper.parseRows(
        getParentSumIdsStmt.all(summaryId),
      );
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => r.parent_summary_id);
    },

    getChildSummaryIds(summaryId) {
      const parsed = summaryIdProjectionMapper.parseRows(
        getChildSumIdsStmt.all(summaryId),
      );
      const rows = parsed.ok ? parsed.value : [];
      return rows.map((r) => r.summary_id);
    },

    // --- Context Items ---

    replaceContextItems(conversationId, items) {
      replaceContextItemsTx(conversationId, items);
    },

    getContextItems(conversationId) {
      const parsed = contextItemMapper.parseRows(
        getCtxItemsStmt.all(conversationId),
      );
      return parsed.ok ? parsed.value : [];
    },

    // --- Large Files ---

    insertLargeFile(params) {
      insertFileStmt.run(
        params.fileId,
        params.conversationId,
        params.fileName ?? null,
        params.mimeType ?? null,
        params.byteSize ?? null,
        params.contentHash ?? null,
        params.storagePath,
        params.explorationSummary ?? null,
      );
      return params.fileId;
    },

    getLargeFile(fileId) {
      const parsed = largeFileMapper.parseOptionalRow(getFileStmt.get(fileId));
      return parsed.ok ? parsed.value : undefined;
    },

    getLargeFileByHash(conversationId, contentHash) {
      const parsed = largeFileMapper.parseOptionalRow(
        getFileByHashStmt.get(conversationId, contentHash),
      );
      return parsed.ok ? parsed.value : undefined;
    },

    // --- Expansion Grants ---

    createGrant(params) {
      insertGrantStmt.run(
        params.grantId,
        params.issuerSession,
        JSON.stringify(params.conversationIds),
        JSON.stringify(params.summaryIds ?? []),
        params.maxDepth ?? 3,
        params.tokenCap ?? 4000,
        params.expiresAt,
      );
      return params.grantId;
    },

    getGrant(grantId) {
      const parsed = expansionGrantMapper.parseOptionalRow(
        getGrantStmt.get(grantId),
      );
      return parsed.ok ? parsed.value : undefined;
    },

    getActiveGrants(issuerSession) {
      const parsed = expansionGrantMapper.parseRows(
        getActiveGrantsStmt.all(issuerSession),
      );
      return parsed.ok ? parsed.value : [];
    },

    consumeGrantTokens(grantId, tokens) {
      consumeGrantStmt.run(tokens, grantId);
    },

    revokeGrant(grantId) {
      revokeGrantStmt.run(grantId);
    },

    cleanupExpiredGrants() {
      const result = cleanupGrantsStmt.run();
      return result.changes;
    },

    // --- Quota ---

    countGrantsToday(issuerSession) {
      const parsed = grantCountProjectionMapper.parseOptionalRow(
        countGrantsTodayStmt.get(issuerSession),
      );
      const row = parsed.ok ? parsed.value : undefined;
      return row?.cnt ?? 0;
    },

    // --- FTS5 Search ---

    searchMessages(conversationId, query, opts) {
      if (opts.mode === "fts") {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) return [];
        const raw = db
          .prepare(
            `SELECT f.rowid AS messageId, m.content, f.rank
             FROM ctx_messages_fts f
             JOIN ctx_messages m ON m.message_id = f.rowid
             WHERE ctx_messages_fts MATCH ?
               AND m.conversation_id = ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, conversationId, opts.limit);
        const parsed = ftsMessageHitMapper.parseRows(raw);
        return parsed.ok ? parsed.value : [];
      }

      // Regex mode: LIKE pre-filter + JS regex post-filter
      // Extract longest literal run from regex for LIKE pre-filter
      const literalRuns = query.match(/[a-zA-Z0-9]{2,}/g);
      const likeSubstring = literalRuns
        ? literalRuns.reduce((a, b) => (a.length >= b.length ? a : b))
        : "";
      const likePattern = likeSubstring ? `%${likeSubstring}%` : "%";
      const candidatesRaw = db
        .prepare(
          `SELECT message_id, content
           FROM ctx_messages
           WHERE conversation_id = ?
             AND content LIKE ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(conversationId, likePattern, opts.limit * 3);
      const candidatesParsed = regexMessageCandidateMapper.parseRows(candidatesRaw);
      const candidates = candidatesParsed.ok ? candidatesParsed.value : [];

      try {
        const regex = new RegExp(query, "i");
        return candidates
          .filter((r) => regex.test(r.content))
          .slice(0, opts.limit)
          .map((r) => ({
            messageId: r.message_id,
            content: r.content,
          }));
      } catch {
        // Invalid regex -- return empty
        return [];
      }
    },

    searchSummaries(conversationId, query, opts) {
      if (opts.mode === "fts") {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) return [];
        const raw = db
          .prepare(
            `SELECT f.summary_id AS summaryId, s.content, f.rank
             FROM ctx_summaries_fts f
             JOIN ctx_summaries s ON s.summary_id = f.summary_id
             WHERE f.content MATCH ?
               AND s.conversation_id = ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, conversationId, opts.limit);
        const parsed = ftsSummaryHitMapper.parseRows(raw);
        return parsed.ok ? parsed.value : [];
      }

      // Regex mode
      const literalRuns = query.match(/[a-zA-Z0-9]{2,}/g);
      const likeSubstring = literalRuns
        ? literalRuns.reduce((a, b) => (a.length >= b.length ? a : b))
        : "";
      const likePattern = likeSubstring ? `%${likeSubstring}%` : "%";
      const candidatesRaw = db
        .prepare(
          `SELECT summary_id, content
           FROM ctx_summaries
           WHERE conversation_id = ?
             AND content LIKE ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(conversationId, likePattern, opts.limit * 3);
      const candidatesParsed = regexSummaryCandidateMapper.parseRows(candidatesRaw);
      const candidates = candidatesParsed.ok ? candidatesParsed.value : [];

      try {
        const regex = new RegExp(query, "i");
        return candidates
          .filter((r) => regex.test(r.content))
          .slice(0, opts.limit)
          .map((r) => ({
            summaryId: r.summary_id,
            content: r.content,
          }));
      } catch {
        return [];
      }
    },

    // --- Bulk Operations ---

    deleteConversation(conversationId) {
      deleteConversationTx(conversationId);
    },
  };

  return Object.freeze(store);
}
