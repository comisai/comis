// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Context RPC handler module for DAG recall tools.
 *
 * Handles context.search, context.inspect, context.recall, context.expand,
 * context.conversations, context.tree, and context.searchByConversation
 * RPC methods.
 *
 * Uses the `@comis/core` contract registry. Method keys are
 * computed-property names (`[ContextSearchContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/memory.ts` (shared with
 * memory-handlers.ts — both files map to the MemoryApiDeps cluster slice).
 *
 * The dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` — never model
 * internals in the contract schema. The `_callerSessionKey` used by
 * `context.search` + `context.recall` to resolve the active DAG
 * conversation is read from rawParams BEFORE the strip step; the admin
 * `_trustLevel` gate (used by the 3 admin-scoped methods) is also read
 * pre-strip.
 *
 * Bespoke pre-Zod validation is intentionally retained for user-friendly
 * error UX matching the 30+ existing handler-test assertions in
 * context-handlers.test.ts. The contract parse runs AFTER and serves as
 * type-narrowing + defense-in-depth.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import {
  ContextSearchContract,
  ContextInspectContract,
  ContextRecallContract,
  ContextExpandContract,
  ContextConversationsContract,
  ContextTreeContract,
  ContextSearchByConversationContract,
  stripInternalFields,
  type ContextStorePort,
  systemNowMs,
  systemNowDate,
  systemDateFrom,
  systemGetEnv,
} from "@comis/core";
import type { RpcHandler } from "./types.js";
import { PreconditionError, ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: MemoryApiDeps (shared with memory-handlers). The
// dispatcher constructs this handler only inside the `deps.contextStore ?
// ...` truthy branch, supplying explicit `store`, `config`,
// `resolveConversationId`, and `rpcCall` fields. The alias narrows those
// optional cluster-slice fields to required, matching the handler body's
// direct accesses.
import type { MemoryApiDeps } from "./types.js";
export type ContextHandlerDeps = MemoryApiDeps & {
  store: ContextStorePort;
  config: { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number };
  resolveConversationId: (sessionKey: string) => string | undefined;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create context RPC handlers for DAG recall tools.
 * Returns handlers for `context.search`, `context.inspect`,
 * `context.recall`, `context.expand`, `context.conversations`,
 * `context.tree`, and `context.searchByConversation`.
 * @param deps - Injected dependencies
 * @returns Record of RPC method name to handler function
 */
export function createContextHandlers(deps: ContextHandlerDeps): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // context.search -- FTS5 search across messages and summaries
    // -----------------------------------------------------------------------
    [ContextSearchContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards FIRST (preserve operator-friendly error UX
      // matching the existing context-handlers.test.ts assertions).
      const sessionKey = rawParams._callerSessionKey as string;
      const conversationId = deps.resolveConversationId(sessionKey);
      if (!conversationId) {
        // PreconditionError → dispatcher classifies as warn/precondition.
        // Caller-state mismatch, not an internal failure.
        throw new PreconditionError("No active DAG conversation for this session");
      }

      const queryRaw = rawParams.query as string | undefined;
      if (!queryRaw) throw new ValidationError("Missing required parameter: query");

      const userParams = stripInternalFields(rawParams);
      const params = ContextSearchContract.request.parse(userParams);

      const mode = params.mode ?? "fts";
      const scope = params.scope ?? "both";
      const limit = Math.min(params.limit ?? 20, 100);

      const results: Array<{ id: string; content: string; type: "message" | "summary"; rank?: number }> = [];

      if (scope === "both" || scope === "messages") {
        const msgResults = deps.store.searchMessages(conversationId, params.query, { mode, limit });
        for (const r of msgResults) {
          results.push({
            id: String(r.messageId),
            content: r.content.slice(0, 500),
            type: "message",
            rank: r.rank,
          });
        }
      }

      if (scope === "both" || scope === "summaries") {
        const sumResults = deps.store.searchSummaries(conversationId, params.query, { mode, limit });
        for (const r of sumResults) {
          results.push({
            id: r.summaryId,
            content: r.content.slice(0, 500),
            type: "summary",
            rank: r.rank,
          });
        }
      }

      // Sort by rank ascending (FTS5 rank: lower is better).
      // For regex mode results without rank, keep insertion order.
      results.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

      deps.logger.info(
        { conversationId, query: params.query, mode, scope, resultCount: results.length },
        "Context search completed",
      );

      const result = { results: results.slice(0, limit), total: results.length };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ContextSearchContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // context.inspect -- full content of a summary or file by ID
    // -----------------------------------------------------------------------
    [ContextInspectContract.method]: async (rawParams) => {
      const idRaw = rawParams.id as string | undefined;
      if (!idRaw) throw new ValidationError("Missing required parameter: id");

      const userParams = stripInternalFields(rawParams);
      const params = ContextInspectContract.request.parse(userParams);
      const id = params.id;

      // Summary inspection
      if (id.startsWith("sum_")) {
        const summary = deps.store.getSummary(id);
        if (!summary) throw new Error(`Summary not found: ${id}`);

        // Fetch lineage
        const parentIds = deps.store.getParentSummaryIds(id);
        const childIds = deps.store.getChildSummaryIds(id);
        const sourceMessageIds = deps.store.getSourceMessageIds(id);

        const result = {
          type: "summary",
          summaryId: summary.summary_id,
          content: summary.content,
          depth: summary.depth,
          kind: summary.kind,
          tokenCount: summary.token_count,
          earliestAt: summary.earliest_at,
          latestAt: summary.latest_at,
          descendantCount: summary.descendant_count,
          parentIds,
          childIds,
          sourceMessageCount: sourceMessageIds.length,
        };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ContextInspectContract.response.parse(result);
        }
        return result;
      }

      // File inspection
      if (id.startsWith("file_")) {
        const file = deps.store.getLargeFile(id);
        if (!file) throw new Error(`File not found: ${id}`);

        // Read file content from disk
        // eslint-disable-next-line no-useless-assignment
        let content = "";
        try {
          const { readFile } = await import("node:fs/promises");
          content = await readFile(file.storage_path, "utf-8");
        } catch {
          content = "[File content unavailable on disk]";
        }

        const result = {
          type: "file",
          fileId: file.file_id,
          fileName: file.file_name,
          mimeType: file.mime_type,
          byteSize: file.byte_size,
          explorationSummary: file.exploration_summary,
          content: content.slice(0, 100_000),
        };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ContextInspectContract.response.parse(result);
        }
        return result;
      }

      throw new ValidationError(`Unknown ID prefix. Expected 'sum_' or 'file_', got: ${id.slice(0, 10)}`);
    },

    // -----------------------------------------------------------------------
    // context.recall -- deep recall via bounded sub-agent spawning
    // -----------------------------------------------------------------------
    [ContextRecallContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards FIRST (preserve operator-friendly error UX).
      const sessionKey = rawParams._callerSessionKey as string;
      const conversationId = deps.resolveConversationId(sessionKey);
      if (!conversationId) {
        // PreconditionError → dispatcher classifies as warn/precondition.
        throw new PreconditionError("No active DAG conversation for this session");
      }

      // Quota check: count all grants today (crash-resilient)
      const todayCount = deps.store.countGrantsToday(sessionKey);
      if (todayCount >= deps.config.maxRecallsPerDay) {
        // Quota exhaustion is a caller-state precondition violation, not a
        // bug or input-shape failure — warn-level via PreconditionError.
        throw new PreconditionError(
          `Daily recall quota exceeded (${deps.config.maxRecallsPerDay}/day). Try ctx_search or ctx_inspect instead.`,
        );
      }

      const promptRaw = rawParams.prompt as string | undefined;
      if (!promptRaw) throw new ValidationError("Missing required parameter: prompt");

      const userParams = stripInternalFields(rawParams);
      const params = ContextRecallContract.request.parse(userParams);

      const prompt = params.prompt;
      const query = params.query;
      const summaryIds = params.summary_ids;
      const _maxTokens = params.max_tokens ?? 2000;

      // Find candidate summaries
      type CandidateSummary = { summaryId: string; content: string };
      const candidateSummaries: CandidateSummary[] = [];

      if (summaryIds && summaryIds.length > 0) {
        for (const sid of summaryIds) {
          const s = deps.store.getSummary(sid);
          if (s) {
            candidateSummaries.push({ summaryId: s.summary_id, content: s.content });
          }
        }
      } else if (query) {
        const searchResults = deps.store.searchSummaries(conversationId, query, {
          mode: "fts",
          limit: 5,
        });
        for (const r of searchResults) {
          candidateSummaries.push({ summaryId: r.summaryId, content: r.content });
        }
      }

      if (candidateSummaries.length === 0) {
        const emptyResult = {
          answer: "No relevant summaries found for this recall query.",
          citations: [],
        };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ContextRecallContract.response.parse(emptyResult);
        }
        return emptyResult;
      }

      const candidateSummaryIds = candidateSummaries.map((s) => s.summaryId);

      // Create expansion grant
      const grantId = "grant_" + randomBytes(8).toString("hex");
      const expiresAt = systemDateFrom(
        systemNowMs() + deps.config.recallTimeoutMs,
      ).toISOString();

      deps.store.createGrant({
        grantId,
        issuerSession: sessionKey,
        conversationIds: [conversationId],
        summaryIds: candidateSummaryIds,
        maxDepth: 3,
        tokenCap: deps.config.maxExpandTokens,
        expiresAt,
      });

      deps.logger.info(
        {
          conversationId,
          grantId,
          candidateCount: candidateSummaries.length,
          prompt: prompt.slice(0, 100),
        },
        "Context recall initiated",
      );

      try {
        // Build domain knowledge for sub-agent
        const domainKnowledge = [
          "EXPANSION_GRANT: " + grantId,
          "CONVERSATION: " + conversationId,
          ...candidateSummaries.map(
            (s) => "Summary " + s.summaryId + ":\n" + s.content,
          ),
        ];

        // Spawn sub-agent
        const spawnResult = (await deps.rpcCall("session.spawn", {
          task:
            "You are a context recall assistant. Answer this question using the " +
            "provided summaries and the ctx_expand/ctx_inspect tools:\n\n" +
            prompt,
          tool_groups: ["context_expand"],
          domain_knowledge: domainKnowledge,
          objective: prompt,
          async: false,
          max_steps: 10,
          _agentId: rawParams._agentId,
        })) as { response?: string } | undefined;

        // Extract result
        const grant = deps.store.getGrant(grantId);
        const result = {
          answer: spawnResult?.response ?? "Sub-agent did not produce an answer.",
          citations: candidateSummaryIds,
          grantId,
          tokensConsumed: grant?.tokens_consumed ?? 0,
        };
        if (systemGetEnv("NODE_ENV") !== "production") {
          ContextRecallContract.response.parse(result);
        }
        return result;
      } finally {
        // Cleanup: revoke grant and clean up expired
        deps.store.revokeGrant(grantId);
        deps.store.cleanupExpiredGrants();
      }
    },

    // -----------------------------------------------------------------------
    // context.conversations -- list all conversations for operator (admin)
    // -----------------------------------------------------------------------
    [ContextConversationsContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      const userParams = stripInternalFields(rawParams);
      const params = ContextConversationsContract.request.parse(userParams);
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const conversations = deps.store.listConversations(deps.tenantId, { limit, offset });
      const result = { conversations, total: conversations.length };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ContextConversationsContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // context.tree -- summary tree for a conversation (admin)
    // -----------------------------------------------------------------------
    [ContextTreeContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      const conversationIdRaw = rawParams.conversation_id as string | undefined;
      if (!conversationIdRaw) throw new Error("Missing required parameter: conversation_id");

      const userParams = stripInternalFields(rawParams);
      const params = ContextTreeContract.request.parse(userParams);
      const conversationId = params.conversation_id;

      const conv = deps.store.getConversation(conversationId);
      if (!conv) throw new Error("Conversation not found");
      const summaries = deps.store.getSummariesByConversation(conversationId);
      const nodes = summaries.map((s) => ({
        summaryId: s.summary_id,
        kind: s.kind,
        depth: s.depth,
        tokenCount: s.token_count,
        contentPreview: s.content.slice(0, 200),
        childIds: deps.store.getChildSummaryIds(s.summary_id),
        parentIds: deps.store.getParentSummaryIds(s.summary_id),
        createdAt: s.created_at,
      }));
      const messageCount = deps.store.getLastMessageSeq(conversationId);
      const result = { conversationId, nodes, messageCount };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ContextTreeContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // context.searchByConversation -- FTS5 search within a conversation (admin)
    // -----------------------------------------------------------------------
    [ContextSearchByConversationContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      const conversationIdRaw = rawParams.conversation_id as string | undefined;
      if (!conversationIdRaw) throw new Error("Missing required parameter: conversation_id");
      const queryRaw = rawParams.query as string | undefined;
      if (!queryRaw) throw new Error("Missing required parameter: query");

      const userParams = stripInternalFields(rawParams);
      const params = ContextSearchByConversationContract.request.parse(userParams);
      const conversationId = params.conversation_id;
      const query = params.query;
      const limit = params.limit ?? 50;

      const messages = deps.store.searchMessages(conversationId, query, { mode: "fts", limit });
      const summaries = deps.store.searchSummaries(conversationId, query, { mode: "fts", limit });
      const result = {
        results: [
          ...messages.map((m) => ({ id: String(m.messageId), type: "message" as const, content: m.content, rank: m.rank })),
          ...summaries.map((s) => ({ id: s.summaryId, type: "summary" as const, content: s.content, rank: s.rank })),
        ].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, limit),
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ContextSearchByConversationContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // context.expand -- walk deeper into the DAG with grant authorization
    // -----------------------------------------------------------------------
    [ContextExpandContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards FIRST (preserve operator-friendly error UX).
      const grantIdRaw = rawParams.grant_id as string | undefined;
      if (!grantIdRaw) throw new Error("Missing required parameter: grant_id");
      const summaryIdRaw = rawParams.summary_id as string | undefined;
      if (!summaryIdRaw) throw new Error("Missing required parameter: summary_id");

      const userParams = stripInternalFields(rawParams);
      const params = ContextExpandContract.request.parse(userParams);
      const grantId = params.grant_id;
      const summaryId = params.summary_id;

      // Validate grant
      const grant = deps.store.getGrant(grantId);
      if (!grant) throw new Error("Grant not found: " + grantId);
      if (grant.revoked) throw new Error("Grant has been revoked: " + grantId);
      if (systemDateFrom(grant.expires_at) < systemNowDate()) {
        throw new Error("Grant has expired: " + grantId);
      }

      // Check token cap
      if (grant.tokens_consumed >= grant.token_cap) {
        throw new Error(
          `Token cap reached (${grant.tokens_consumed}/${grant.token_cap}). Cannot expand further.`,
        );
      }

      // Validate summary
      const summary = deps.store.getSummary(summaryId);
      if (!summary) throw new Error("Summary not found: " + summaryId);

      // Verify summary belongs to an allowed conversation
      const allowedConversations: string[] = JSON.parse(grant.conversation_ids);
      if (!allowedConversations.includes(summary.conversation_id)) {
        throw new Error(
          "Summary does not belong to an authorized conversation",
        );
      }

      // Walk DAG
      const remainingBudget = grant.token_cap - grant.tokens_consumed;
      const children: Array<{
        type: "summary" | "message";
        id: string | number;
        content: string;
        tokenCount: number;
      }> = [];
      let tokensExpanded = 0;

      if (summary.kind === "condensed") {
        // Condensed summary: expand into parent summaries
        const parentIds = deps.store.getParentSummaryIds(summaryId);
        for (const pid of parentIds) {
          if (tokensExpanded >= remainingBudget) break;
          const parentSummary = deps.store.getSummary(pid);
          if (parentSummary) {
            children.push({
              type: "summary",
              id: parentSummary.summary_id,
              content: parentSummary.content,
              tokenCount: parentSummary.token_count,
            });
            tokensExpanded += parentSummary.token_count;
          }
        }
      } else {
        // Leaf summary: expand into source messages
        const messageIds = deps.store.getSourceMessageIds(summaryId);
        if (messageIds.length > 0) {
          const messages = deps.store.getMessagesByIds(messageIds);
          for (const msg of messages) {
            if (tokensExpanded >= remainingBudget) break;
            children.push({
              type: "message",
              id: msg.message_id,
              content: msg.content,
              tokenCount: msg.token_count,
            });
            tokensExpanded += msg.token_count;
          }
        }
      }

      // Track tokens
      if (tokensExpanded > 0) {
        deps.store.consumeGrantTokens(grantId, tokensExpanded);
      }

      const result = {
        summaryId,
        depth: summary.depth,
        kind: summary.kind,
        children,
        tokensExpanded,
        tokenBudgetRemaining: remainingBudget - tokensExpanded,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ContextExpandContract.response.parse(result);
      }
      return result;
    },
  };
}
