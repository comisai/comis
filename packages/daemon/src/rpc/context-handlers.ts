/**
 * Context RPC handler module.
 * Handles context.search, context.inspect, context.recall, and context.expand
 * RPC methods for DAG recall.
 * DAG Recall Tools.
 * @module
 */

import type { ContextStore } from "@comis/memory";
import { randomBytes } from "node:crypto";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for context RPC diagnostics. */
interface ContextHandlerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies required by context RPC handlers. */
export interface ContextHandlerDeps {
  /** Context store for DAG CRUD operations. */
  store: ContextStore;
  /** Tenant identifier for conversation resolution. */
  tenantId: string;
  /** Resolve the active conversation ID for the calling session. */
  resolveConversationId: (sessionKey: string) => string | undefined;
  /** RPC dispatcher for spawning sub-agents (ctx_recall -> session.spawn). */
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Context engine recall config (quota, token cap, timeout). */
  config: {
    maxRecallsPerDay: number;
    maxExpandTokens: number;
    recallTimeoutMs: number;
  };
  /** Structured logger for context RPC diagnostics. */
  logger: ContextHandlerLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create context RPC handlers for DAG recall tools.
 * Returns handlers for `context.search`, `context.inspect`,
 * `context.recall`, and `context.expand`.
 * @param deps - Injected dependencies
 * @returns Record of RPC method name to handler function
 */
export function createContextHandlers(deps: ContextHandlerDeps): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // context.search -- FTS5 search across messages and summaries
    // -----------------------------------------------------------------------
    "context.search": async (params) => {
      const sessionKey = params._callerSessionKey as string;
      const conversationId = deps.resolveConversationId(sessionKey);
      if (!conversationId) {
        throw new Error("No active DAG conversation for this session");
      }

      const query = params.query as string;
      if (!query) throw new Error("Missing required parameter: query");

      const mode = (params.mode as "fts" | "regex") ?? "fts";
      const scope = (params.scope as string) ?? "both";
      const limit = Math.min((params.limit as number) ?? 20, 100);

      const results: Array<{ id: string; content: string; type: "message" | "summary"; rank?: number }> = [];

      if (scope === "both" || scope === "messages") {
        const msgResults = deps.store.searchMessages(conversationId, query, { mode, limit });
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
        const sumResults = deps.store.searchSummaries(conversationId, query, { mode, limit });
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
        { conversationId, query, mode, scope, resultCount: results.length },
        "Context search completed",
      );

      return { results: results.slice(0, limit), total: results.length };
    },

    // -----------------------------------------------------------------------
    // context.inspect -- full content of a summary or file by ID
    // -----------------------------------------------------------------------
    "context.inspect": async (params) => {
      const id = params.id as string;
      if (!id) throw new Error("Missing required parameter: id");

      // Summary inspection
      if (id.startsWith("sum_")) {
        const summary = deps.store.getSummary(id);
        if (!summary) throw new Error(`Summary not found: ${id}`);

        // Fetch lineage
        const parentIds = deps.store.getParentSummaryIds(id);
        const childIds = deps.store.getChildSummaryIds(id);
        const sourceMessageIds = deps.store.getSourceMessageIds(id);

        return {
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

        return {
          type: "file",
          fileId: file.file_id,
          fileName: file.file_name,
          mimeType: file.mime_type,
          byteSize: file.byte_size,
          explorationSummary: file.exploration_summary,
          content: content.slice(0, 100_000),
        };
      }

      throw new Error(`Unknown ID prefix. Expected 'sum_' or 'file_', got: ${id.slice(0, 10)}`);
    },

    // -----------------------------------------------------------------------
    // context.recall -- deep recall via bounded sub-agent spawning
    // -----------------------------------------------------------------------
    "context.recall": async (params) => {
      const sessionKey = params._callerSessionKey as string;
      const conversationId = deps.resolveConversationId(sessionKey);
      if (!conversationId) {
        throw new Error("No active DAG conversation for this session");
      }

      // Quota check: count all grants today (crash-resilient)
      const todayCount = deps.store.countGrantsToday(sessionKey);
      if (todayCount >= deps.config.maxRecallsPerDay) {
        throw new Error(
          `Daily recall quota exceeded (${deps.config.maxRecallsPerDay}/day). Try ctx_search or ctx_inspect instead.`,
        );
      }

      const prompt = params.prompt as string;
      if (!prompt) throw new Error("Missing required parameter: prompt");

      const query = params.query as string | undefined;
      const summaryIds = Array.isArray(params.summary_ids)
        ? (params.summary_ids as string[])
        : undefined;
      const _maxTokens = (params.max_tokens as number) ?? 2000;

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
        return {
          answer: "No relevant summaries found for this recall query.",
          citations: [],
        };
      }

      const candidateSummaryIds = candidateSummaries.map((s) => s.summaryId);

      // Create expansion grant
      const grantId = "grant_" + randomBytes(8).toString("hex");
      const expiresAt = new Date(
        Date.now() + deps.config.recallTimeoutMs,
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
          _agentId: params._agentId,
        })) as { response?: string } | undefined;

        // Extract result
        const grant = deps.store.getGrant(grantId);
        return {
          answer: spawnResult?.response ?? "Sub-agent did not produce an answer.",
          citations: candidateSummaryIds,
          grantId,
          tokensConsumed: grant?.tokens_consumed ?? 0,
        };
      } finally {
        // Cleanup: revoke grant and clean up expired
        deps.store.revokeGrant(grantId);
        deps.store.cleanupExpiredGrants();
      }
    },

    // -----------------------------------------------------------------------
    // context.conversations -- list all conversations for operator (admin)
    // -----------------------------------------------------------------------
    "context.conversations": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const offset = typeof params.offset === "number" ? params.offset : 0;
      const conversations = deps.store.listConversations(deps.tenantId, { limit, offset });
      return { conversations, total: conversations.length };
    },

    // -----------------------------------------------------------------------
    // context.tree -- summary tree for a conversation (admin)
    // -----------------------------------------------------------------------
    "context.tree": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");
      const conversationId = params.conversation_id as string;
      if (!conversationId) throw new Error("Missing required parameter: conversation_id");
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
      return { conversationId, nodes, messageCount };
    },

    // -----------------------------------------------------------------------
    // context.searchByConversation -- FTS5 search within a conversation (admin)
    // -----------------------------------------------------------------------
    "context.searchByConversation": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");
      const conversationId = params.conversation_id as string;
      if (!conversationId) throw new Error("Missing required parameter: conversation_id");
      const query = params.query as string;
      if (!query) throw new Error("Missing required parameter: query");
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const messages = deps.store.searchMessages(conversationId, query, { mode: "fts", limit });
      const summaries = deps.store.searchSummaries(conversationId, query, { mode: "fts", limit });
      return {
        results: [
          ...messages.map((m) => ({ id: String(m.messageId), type: "message" as const, content: m.content, rank: m.rank })),
          ...summaries.map((s) => ({ id: s.summaryId, type: "summary" as const, content: s.content, rank: s.rank })),
        ].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, limit),
      };
    },

    // -----------------------------------------------------------------------
    // context.expand -- walk deeper into the DAG with grant authorization
    // -----------------------------------------------------------------------
    "context.expand": async (params) => {
      const grantId = params.grant_id as string;
      if (!grantId) throw new Error("Missing required parameter: grant_id");
      const summaryId = params.summary_id as string;
      if (!summaryId) throw new Error("Missing required parameter: summary_id");

      // Validate grant
      const grant = deps.store.getGrant(grantId);
      if (!grant) throw new Error("Grant not found: " + grantId);
      if (grant.revoked) throw new Error("Grant has been revoked: " + grantId);
      if (new Date(grant.expires_at) < new Date()) {
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

      return {
        summaryId,
        depth: summary.depth,
        kind: summary.kind,
        children,
        tokensExpanded,
        tokenBudgetRemaining: remainingBudget - tokensExpanded,
      };
    },
  };
}
