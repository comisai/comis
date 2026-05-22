// SPDX-License-Identifier: Apache-2.0
/**
 * ContextAdminStore: admin/cleanup methods (cross-session list, expired-grant
 * cleanup, conversation-scope deletion, conversation touch).
 *
 * Carved out of ContextStorePort (Phase 60-02, REFACTOR-04). Currently
 * consumed only by the daemon's context-handlers (context.conversations admin
 * RPC + the recall-path cleanupExpiredGrants finally hook). Reserved for
 * admin RPCs.
 *
 * Method classification per .planning/phases/60-.../60-RESEARCH.md §B.1:
 *   - `listConversations`     — cross-session list (admin RPC)
 *   - `cleanupExpiredGrants`  — recall-path lifecycle cleanup
 *   - `deleteConversation`    — bulk conversation-scope deletion
 *   - `touchConversation`     — border case (no current production caller;
 *                               kept as defensive contract)
 *
 * The 4 methods here together with the 34 methods in ContextEngineStore
 * compose the full 38-method `ContextStorePort` via intersection alias.
 *
 * @module
 */

import type { CtxConversationRow } from "./context-store-types.js";

/**
 * Admin/cleanup surface — 4 methods.
 *
 * Agent code MUST NOT depend on this interface (it would widen the agent's
 * structural type-system access to bulk-deletion / cross-tenant list
 * methods). The daemon's setup-agents wiring injects the narrower
 * ContextEngineStore into the agent runtime.
 */
export interface ContextAdminStore {
  /**
   * Cross-session: list conversations for a tenant. Admin RPC consumer
   * (daemon context-handlers context.conversations).
   */
  listConversations(
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): CtxConversationRow[];

  /**
   * Lifecycle: cleanup expired expansion grants. Called from the recall-path
   * finally hook in daemon context-handlers.
   */
  cleanupExpiredGrants(): number;

  /**
   * Bulk: delete a conversation and all its descendants (messages, parts,
   * summaries, links, context-items, large-files, grants).
   */
  deleteConversation(conversationId: string): void;

  /**
   * Lifecycle: touch a conversation's updatedAt timestamp. Border case per
   * RESEARCH §B.1 row 5 — kept in Admin because there is no current
   * production caller; treated as a defensive admin-side contract surface.
   */
  touchConversation(conversationId: string): void;
}
