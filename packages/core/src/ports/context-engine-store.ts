// SPDX-License-Identifier: Apache-2.0
/**
 * ContextEngineStore: per-session context read/write methods.
 *
 * Carved out of ContextStorePort to give the agent context-engine + executor
 * a narrower view (no admin/cleanup methods). The daemon's context-handlers
 * consume the wider intersection `ContextEngineStore & ContextAdminStore`
 * (aliased as `ContextStorePort`).
 *
 * Method groups (34 total): Conversations (3), Messages (5), Message Parts (3),
 * Summaries (5), Summary Links (5), Context Items (2), Large Files (3),
 * Expansion Grants (6), Quota (1), FTS5 Search (2). Classification per
 * .planning/phases/60-config-audit-emitters-contextstoreport-split-tool-deferral-t/60-RESEARCH.md
 * §B.1 (the 4 methods classified Admin — listConversations, cleanupExpiredGrants,
 * deleteConversation, touchConversation — live in context-admin-store.ts).
 *
 * Row DTOs (`Ctx*Row`) live in the sibling type-only carrier
 * `context-store-types.ts`; every row-DTO reference resolves through the
 * `import type` block below.
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

/**
 * Per-session context store surface — 34 methods.
 *
 * Consumed by the agent context-engine (5 files: dag-integrity,
 * dag-reconciliation, dag-triggers, dag-assembler, types-dag, types-integrity)
 * and the agent executor (2 files: executor-context-engine-setup,
 * pi-executor-types). The daemon's setup-agents wiring injects this narrower
 * view into the agent runtime; the underlying memory adapter still satisfies
 * the wider intersection (ContextEngineStore & ContextAdminStore).
 */
export interface ContextEngineStore {
  // --- Conversations (3 methods — listConversations + touchConversation moved to Admin) ---
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

  // --- Messages (5 methods) ---
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

  // --- Message Parts (3 methods) ---
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

  // --- Summaries (5 methods) ---
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

  // --- Summary Links (5 methods) ---
  linkSummaryMessages(summaryId: string, messageIds: number[]): void;
  linkSummaryParents(
    summaryId: string,
    parentSummaryIds: string[],
  ): void;
  getSourceMessageIds(summaryId: string): number[];
  getParentSummaryIds(summaryId: string): string[];
  getChildSummaryIds(summaryId: string): string[];

  // --- Context Items (2 methods) ---
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

  // --- Large Files (3 methods) ---
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

  // --- Expansion Grants (6 methods — cleanupExpiredGrants moved to Admin) ---
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

  // --- Quota (1 method) ---
  /** Count all grants created today by issuerSession (including revoked/expired). */
  countGrantsToday(issuerSession: string): number;

  // --- FTS5 Search (2 methods) ---
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
}
