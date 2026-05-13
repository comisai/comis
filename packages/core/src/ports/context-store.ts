// SPDX-License-Identifier: Apache-2.0
/**
 * ContextStorePort: hexagonal architecture boundary for context persistence.
 *
 * Type-only full mirror of @comis/memory's ContextStore. Per Claude's
 * Discretion in 28-CONTEXT.md ("Recommended: full mirror -- bigger surface
 * upfront, smaller Phase 31 churn"), this declaration covers EVERY public
 * method memory exposes (38 methods), not the agent-consumed subset.
 *
 * Phase 31 commit 1 (MEM-CTX-PORTS-03 / RES-PIT-5) moved the row DTOs
 * (`Ctx*Row`) into the sibling type-only carrier `context-store-types.ts`.
 * The interface body below is unchanged — every row-DTO reference now
 * resolves through the `import type` block below.
 *
 * The implementation lives at @comis/memory's createContextStore(). Phase 31
 * makes that factory's return type compatible with this port (return-type-only
 * change -- implementation unchanged).
 *
 * @module
 */

import type {
  CtxConversationRow,
  CtxMessageRow,
  CtxMessagePartRow,
  CtxSummaryRow,
  CtxContextItemRow,
  CtxLargeFileRow,
  CtxExpansionGrantRow,
} from "./context-store-types.js";

// ---------------------------------------------------------------------------
// ContextStorePort -- full mirror of @comis/memory's ContextStore.
// ---------------------------------------------------------------------------

/**
 * Full mirror of memory's ContextStore. Every public method on memory's
 * ContextStore appears here verbatim with the same signature.
 *
 * Method groups (mirrors source-of-truth layout in
 * packages/memory/src/context-store.ts:39-187):
 *   - Conversations      (5 methods)
 *   - Messages           (5 methods)
 *   - Message Parts      (3 methods)
 *   - Summaries          (5 methods)
 *   - Summary Links      (5 methods)
 *   - Context Items      (2 methods)
 *   - Large Files        (3 methods)
 *   - Expansion Grants   (6 methods)
 *   - Quota              (1 method)
 *   - FTS5 Search        (2 methods)
 *   - Bulk Operations    (1 method)
 *
 * Total: 38 methods. The structural shape MUST match memory's interface
 * exactly so Phase 31 retarget is a pure name swap.
 */
export interface ContextStorePort {
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
