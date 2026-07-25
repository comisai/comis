// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Context (LCD lossless-store) operator-browse RPC handler module.
 *
 * Backs the web Context DAG browser (`packages/web/src/views/context-dag-browser.ts`):
 * without this module its `context.conversations` / `context.tree` calls would hit
 * unregistered methods and fail with JSON-RPC -32601, leaving the view dead. This
 * module registers the two methods (computed-key `[Contract.method]:` form, so the
 * bidirectional 1:1 architecture test resolves them through
 * `packages/core/src/api-contracts/context.ts`).
 *
 * **Scope.** Both methods are AGENT+TENANT scoped exactly like the
 * `rpc`-scoped memory reads: `agentId` comes from the dispatcher-injected
 * `_agentId` (falling back to `deps.defaultAgentId`), `tenantId` from
 * `deps.tenantId`. The caller cannot pass agentId/tenantId — they ride the
 * request context, so a browse can never widen past one agent within one tenant.
 *
 * **Content posture.** `context.conversations` is pure metadata (ids / counts /
 * time-bounds). `context.tree` is the structural DAG (summary nodes + the count
 * of raw messages still in the context_items view) with a short, length-bounded
 * `contentPreview` per summary node and the per-node `taint` flag — surfaced for
 * a HUMAN operator dashboard (Lit text-escapes it), NEVER re-fed to a model. Full
 * per-node content recovery (the taint-sensitive `context.inspect`) and in-
 * conversation FTS (`context.searchByConversation`) are intentionally
 * unregistered.
 *
 * The dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)`; `_agentId` is read
 * from rawParams pre-strip (it is not part of the public contract).
 *
 * @module
 */

import {
  ContextConversationsContract,
  ContextTreeContract,
  ConversationRefSchema,
  stripInternalFields,
  systemDateFrom,
  systemGetEnv,
  type ContextStoreScope,
  type LcdSummary,
} from "@comis/core";
import type { MemoryApiDeps as ContextHandlerDeps } from "./types.js";
import type { RpcHandler } from "./types.js";

export type { ContextHandlerDeps };

const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/** Bounded preview length for a summary node's body (operator display only). */
const CONTENT_PREVIEW_MAX = 280;

/** Convert an epoch-ms instant to an ISO-8601 string via the sanctioned clock helper. */
function isoFromEpoch(epochMs: number): string {
  return systemDateFrom(epochMs).toISOString();
}

/**
 * Create the context.* operator-browse RPC handlers.
 *
 * Consumes the shared `MemoryApiDeps` slice (so it unifies with memory-handlers
 * under the ApiDispatchDeps multi-extends). The `lcdStore` (ContextStorePort) +
 * `contextBrowse` (ContextBrowsePort) are optional; when unwired each handler
 * fail-closes to an empty result rather than throwing.
 */
export function createContextHandlers(deps: ContextHandlerDeps): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // context.conversations — distinct conversations for THIS agent+tenant.
    // -----------------------------------------------------------------------
    [ContextConversationsContract.method]: async (rawParams) => {
      // Agent from the dispatcher (never caller-supplied); tenant from deps.
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = ContextConversationsContract.request.parse(userParams);
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;

      if (!deps.contextBrowse) {
        // Browse port not wired (e.g. an unwired test/setup) — fail closed.
        const empty = { conversations: [], total: 0 };
        if (IS_DEV) ContextConversationsContract.response.parse(empty);
        return empty;
      }

      const page = deps.contextBrowse.listConversations(
        { tenantId: deps.tenantId, agentId },
        { limit, offset },
      );

      const result = {
        conversations: page.conversations.map((c) => ({
          conversation_ref: c.conversationRef,
          tenant_id: c.tenantId,
          agent_id: c.agentId,
          session_key: c.sessionKey,
          title: c.title,
          created_at: isoFromEpoch(c.createdAt),
          updated_at: isoFromEpoch(c.updatedAt),
          message_count: c.messageCount,
        })),
        total: page.total,
      };

      // ids/counts/timestamps only — NEVER conversation content.
      deps.logger.debug(
        { method: "context.conversations", agentId, count: result.conversations.length, total: result.total, step: "context-browse" },
        "context.conversations resolved",
      );
      if (IS_DEV) ContextConversationsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // context.tree — the resolved DAG (summary nodes + raw-message count).
    // -----------------------------------------------------------------------
    [ContextTreeContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = ContextTreeContract.request.parse(userParams);
      const parsedConversationRef = ConversationRefSchema.safeParse(params.conversation_ref);
      if (!parsedConversationRef.success) throw new Error("Invalid conversation reference");
      const conversationRef = parsedConversationRef.data;

      if (!deps.lcdStore) {
        const empty = { conversationRef, nodes: [], messageCount: 0 };
        if (IS_DEV) ContextTreeContract.response.parse(empty);
        return empty;
      }

      // Agent+tenant read scope. sessionKey == conversationRef in the current single-
      // session-per-conversation model; the LCD read filters on
      // (conversation_id, agent_id, tenant_id), so sessionKey is unused for
      // these reads but is required by the ContextStoreScope shape.
      const scope: ContextStoreScope = {
        conversationRef,
        tenantId: deps.tenantId,
        agentId,
        sessionKey: conversationRef,
      };

      const summaries = deps.lcdStore.getSummaries(scope);

      // Build the inverse (child -> parents) edge map by walking each condensed
      // summary's children. getSummaryChildren is the only edge read; parentIds
      // are derived by inverting it so the UI can lay out the DAG both ways.
      const childIdsBySummary = new Map<string, string[]>();
      const parentIdsBySummary = new Map<string, string[]>();
      for (const s of summaries) {
        if (s.kind === "condensed") {
          const children = deps.lcdStore.getSummaryChildren(scope, s.summaryId);
          const childIds = children.map((c) => c.summaryId);
          childIdsBySummary.set(s.summaryId, childIds);
          for (const childId of childIds) {
            const parents = parentIdsBySummary.get(childId) ?? [];
            parents.push(s.summaryId);
            parentIdsBySummary.set(childId, parents);
          }
        }
      }

      const nodes = summaries.map((s: LcdSummary) => ({
        summaryId: s.summaryId,
        kind: s.kind,
        depth: s.depth,
        tokenCount: s.tokenCount,
        // Bounded, untrusted-origin preview for the human operator view (Lit
        // escapes it; never re-fed to a model). content is otherwise never
        // surfaced/logged here.
        contentPreview: s.content.slice(0, CONTENT_PREVIEW_MAX),
        childIds: childIdsBySummary.get(s.summaryId) ?? [],
        parentIds: parentIdsBySummary.get(s.summaryId) ?? [],
        taint: s.taint,
        createdAt: isoFromEpoch(s.createdAt),
      }));

      // Raw turns NOT yet collapsed into a summary = the message-ref items.
      const messageCount = deps.lcdStore
        .getContextItems(scope)
        .filter((item) => item.refKind === "message").length;

      const result = { conversationRef, nodes, messageCount };

      // ids/counts only — NEVER the summary content (lossless store; the
      // bounded preview rides the response, not the log line).
      deps.logger.debug(
        { method: "context.tree", agentId, conversationRef, nodeCount: nodes.length, messageCount, step: "context-browse" },
        "context.tree resolved",
      );
      if (IS_DEV) ContextTreeContract.response.parse(result);
      return result;
    },
  };
}
