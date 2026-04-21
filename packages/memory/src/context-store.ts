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
import { initContextSchema } from "./context-schema.js";
import { buildFtsQuery } from "./hybrid-search.js";
import type {
  CtxConversationRow,
  CtxContextItemRow,
  CtxExpansionGrantRow,
  CtxLargeFileRow,
  CtxMessagePartRow,
  CtxMessageRow,
  CtxSummaryRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of bind parameters per chunked WHERE IN query. */
const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context store interface for CRUD operations on all DAG entities. */
export interface ContextStore {
  // --- Conversations ---
  createConversation(params: {
    tenantId: string;
    agentId: string;
    sessionKey: string;
    title?: string;
  }): string;
  getConversation(conversationId: string): CtxConversationRow | undefined;
  getConversationBySession(
    tenantId: string,
    sessionKey: string,
  ): CtxConversationRow | undefined;
  listConversations(
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): CtxConversationRow[];
  touchConversation(conversationId: string): void;

  // --- Messages ---
  insertMessage(params: {
    conversationId: string;
    seq: number;
    role: string;
    content: string;
    contentHash: string;
    tokenCount: number;
    toolName?: string;
    toolCallId?: string;
  }): number;
  getMessagesByConversation(
    conversationId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): CtxMessageRow[];
  getMessagesByIds(ids: number[]): CtxMessageRow[];
  getMessageByHash(
    conversationId: string,
    contentHash: string,
  ): CtxMessageRow | undefined;
  getLastMessageSeq(conversationId: string): number;

  // --- Message Parts ---
  insertParts(
    messageId: number,
    parts: Array<{
      ordinal: number;
      partType: string;
      content?: string;
      metadata?: string;
    }>,
  ): void;
  getPartsByMessage(messageId: number): CtxMessagePartRow[];
  getPartsByMessages(messageIds: number[]): Map<number, CtxMessagePartRow[]>;

  // --- Summaries ---
  insertSummary(params: {
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
  }): string;
  getSummary(summaryId: string): CtxSummaryRow | undefined;
  getSummariesByConversation(
    conversationId: string,
    opts?: { depth?: number },
  ): CtxSummaryRow[];
  updateSummaryCountsDirty(summaryIds: string[], dirty: boolean): void;
  deleteSummary(summaryId: string): void;

  // --- Summary Links ---
  linkSummaryMessages(summaryId: string, messageIds: number[]): void;
  linkSummaryParents(
    summaryId: string,
    parentSummaryIds: string[],
  ): void;
  getSourceMessageIds(summaryId: string): number[];
  getParentSummaryIds(summaryId: string): string[];
  getChildSummaryIds(summaryId: string): string[];

  // --- Context Items ---
  replaceContextItems(
    conversationId: string,
    items: Array<{
      ordinal: number;
      itemType: "message" | "summary";
      messageId?: number;
      summaryId?: string;
    }>,
  ): void;
  getContextItems(conversationId: string): CtxContextItemRow[];

  // --- Large Files ---
  insertLargeFile(params: {
    fileId: string;
    conversationId: string;
    fileName?: string;
    mimeType?: string;
    byteSize?: number;
    contentHash?: string;
    storagePath: string;
    explorationSummary?: string;
  }): string;
  getLargeFile(fileId: string): CtxLargeFileRow | undefined;
  getLargeFileByHash(
    conversationId: string,
    contentHash: string,
  ): CtxLargeFileRow | undefined;

  // --- Expansion Grants ---
  createGrant(params: {
    grantId: string;
    issuerSession: string;
    conversationIds: string[];
    summaryIds?: string[];
    maxDepth?: number;
    tokenCap?: number;
    expiresAt: string;
  }): string;
  getGrant(grantId: string): CtxExpansionGrantRow | undefined;
  getActiveGrants(issuerSession: string): CtxExpansionGrantRow[];
  consumeGrantTokens(grantId: string, tokens: number): void;
  revokeGrant(grantId: string): void;
  cleanupExpiredGrants(): number;

  // --- Quota ---
  /** Count all grants created today by issuerSession (including revoked/expired). */
  countGrantsToday(issuerSession: string): number;

  // --- FTS5 Search ---
  searchMessages(
    conversationId: string,
    query: string,
    opts: { mode: "fts" | "regex"; limit: number },
  ): Array<{ messageId: number; content: string; rank?: number }>;
  searchSummaries(
    conversationId: string,
    query: string,
    opts: { mode: "fts" | "regex"; limit: number },
  ): Array<{ summaryId: string; content: string; rank?: number }>;

  // --- Bulk Operations ---
  deleteConversation(conversationId: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ContextStore bound to the given database.
 *
 * Calls initContextSchema (idempotent) to ensure all ctx_ tables,
 * indexes, and FTS5 virtual tables exist. Prepares all fixed-parameter
 * SQL statements once for performance.
 *
 * @param db - An open better-sqlite3 Database instance
 * @returns Frozen ContextStore implementation
 */
export function createContextStore(db: Database.Database): ContextStore {
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
      // 1. Get all message IDs and summary IDs for FTS cleanup
      const msgRows = getMsgIdsByConvStmt.all(conversationId) as Array<{
        message_id: number;
      }>;
      const sumRows = getSumIdsByConvStmt.all(conversationId) as Array<{
        summary_id: string;
      }>;

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

  const store: ContextStore = {
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
      return getConvStmt.get(conversationId) as
        | CtxConversationRow
        | undefined;
    },

    getConversationBySession(tenantId, sessionKey) {
      return getConvBySessionStmt.get(tenantId, sessionKey) as
        | CtxConversationRow
        | undefined;
    },

    touchConversation(conversationId) {
      touchConvStmt.run(conversationId);
    },

    listConversations(tenantId, opts) {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      return listConvStmt.all(tenantId, limit, offset) as CtxConversationRow[];
    },

    // --- Messages ---

    insertMessage(params) {
      return insertMessageTx(params);
    },

    getMessagesByConversation(conversationId, opts) {
      const limit = opts?.limit ?? 1000;
      if (opts?.afterSeq !== undefined) {
        return getMsgsByConvAfterSeqStmt.all(
          conversationId,
          opts.afterSeq,
          limit,
        ) as CtxMessageRow[];
      }
      return getMsgsByConvStmt.all(conversationId, limit) as CtxMessageRow[];
    },

    getMessagesByIds(ids) {
      if (ids.length === 0) return [];
      const results: CtxMessageRow[] = [];
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT * FROM ctx_messages WHERE message_id IN (${placeholders}) ORDER BY seq ASC`,
          )
          .all(...chunk) as CtxMessageRow[];
        results.push(...rows);
      }
      return results;
    },

    getMessageByHash(conversationId, contentHash) {
      return getMsgByHashStmt.get(conversationId, contentHash) as
        | CtxMessageRow
        | undefined;
    },

    getLastMessageSeq(conversationId) {
      const row = getLastSeqStmt.get(conversationId) as {
        max_seq: number | null;
      };
      return row.max_seq ?? 0;
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
      return getPartsByMsgStmt.all(messageId) as CtxMessagePartRow[];
    },

    getPartsByMessages(messageIds) {
      const result = new Map<number, CtxMessagePartRow[]>();
      if (messageIds.length === 0) return result;
      for (let i = 0; i < messageIds.length; i += CHUNK_SIZE) {
        const chunk = messageIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT * FROM ctx_message_parts WHERE message_id IN (${placeholders}) ORDER BY ordinal ASC`,
          )
          .all(...chunk) as CtxMessagePartRow[];
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
      return getSumStmt.get(summaryId) as CtxSummaryRow | undefined;
    },

    getSummariesByConversation(conversationId, opts) {
      if (opts?.depth !== undefined) {
        return getSumsByConvDepthStmt.all(
          conversationId,
          opts.depth,
        ) as CtxSummaryRow[];
      }
      return getSumsByConvStmt.all(conversationId) as CtxSummaryRow[];
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
      const rows = getSourceMsgIdsStmt.all(summaryId) as Array<{
        message_id: number;
      }>;
      return rows.map((r) => r.message_id);
    },

    getParentSummaryIds(summaryId) {
      const rows = getParentSumIdsStmt.all(summaryId) as Array<{
        parent_summary_id: string;
      }>;
      return rows.map((r) => r.parent_summary_id);
    },

    getChildSummaryIds(summaryId) {
      const rows = getChildSumIdsStmt.all(summaryId) as Array<{
        summary_id: string;
      }>;
      return rows.map((r) => r.summary_id);
    },

    // --- Context Items ---

    replaceContextItems(conversationId, items) {
      replaceContextItemsTx(conversationId, items);
    },

    getContextItems(conversationId) {
      return getCtxItemsStmt.all(conversationId) as CtxContextItemRow[];
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
      return getFileStmt.get(fileId) as CtxLargeFileRow | undefined;
    },

    getLargeFileByHash(conversationId, contentHash) {
      return getFileByHashStmt.get(conversationId, contentHash) as
        | CtxLargeFileRow
        | undefined;
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
      return getGrantStmt.get(grantId) as CtxExpansionGrantRow | undefined;
    },

    getActiveGrants(issuerSession) {
      return getActiveGrantsStmt.all(
        issuerSession,
      ) as CtxExpansionGrantRow[];
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
      const row = countGrantsTodayStmt.get(issuerSession) as { cnt: number };
      return row.cnt;
    },

    // --- FTS5 Search ---

    searchMessages(conversationId, query, opts) {
      if (opts.mode === "fts") {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) return [];
        const rows = db
          .prepare(
            `SELECT f.rowid AS messageId, m.content, f.rank
             FROM ctx_messages_fts f
             JOIN ctx_messages m ON m.message_id = f.rowid
             WHERE ctx_messages_fts MATCH ?
               AND m.conversation_id = ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, conversationId, opts.limit) as Array<{
          messageId: number;
          content: string;
          rank: number;
        }>;
        return rows;
      }

      // Regex mode: LIKE pre-filter + JS regex post-filter
      // Extract longest literal run from regex for LIKE pre-filter
      const literalRuns = query.match(/[a-zA-Z0-9]{2,}/g);
      const likeSubstring = literalRuns
        ? literalRuns.reduce((a, b) => (a.length >= b.length ? a : b))
        : "";
      const likePattern = likeSubstring ? `%${likeSubstring}%` : "%";
      const candidates = db
        .prepare(
          `SELECT message_id, content
           FROM ctx_messages
           WHERE conversation_id = ?
             AND content LIKE ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(
          conversationId,
          likePattern,
          opts.limit * 3,
        ) as Array<{ message_id: number; content: string }>;

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
        const rows = db
          .prepare(
            `SELECT f.summary_id AS summaryId, s.content, f.rank
             FROM ctx_summaries_fts f
             JOIN ctx_summaries s ON s.summary_id = f.summary_id
             WHERE f.content MATCH ?
               AND s.conversation_id = ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, conversationId, opts.limit) as Array<{
          summaryId: string;
          content: string;
          rank: number;
        }>;
        return rows;
      }

      // Regex mode
      const literalRuns = query.match(/[a-zA-Z0-9]{2,}/g);
      const likeSubstring = literalRuns
        ? literalRuns.reduce((a, b) => (a.length >= b.length ? a : b))
        : "";
      const likePattern = likeSubstring ? `%${likeSubstring}%` : "%";
      const candidates = db
        .prepare(
          `SELECT summary_id, content
           FROM ctx_summaries
           WHERE conversation_id = ?
             AND content LIKE ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          conversationId,
          likePattern,
          opts.limit * 3,
        ) as Array<{ summary_id: string; content: string }>;

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
