// SPDX-License-Identifier: Apache-2.0
/**
 * Unified Session Tool: single tool with action dispatch covering search, status, history, list.
 *
 * Consolidates 4 individual session tools into one tool with an `action` parameter:
 * - action "search" -> session.search RPC (from session-search-tool)
 * - action "status" -> session.status RPC (from session-status-tool)
 * - action "history" -> session.history RPC (from sessions-history-tool)
 * - action "list" -> session.list RPC (from sessions-list-tool)
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam, readBooleanParam, readEnumParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";
import { sanitizeFts5Query } from "./fts5-sanitizer.js";

// -- Parameter Schema --------------------------------------------------------

const VALID_ACTIONS = ["search", "status", "history", "list"] as const;

const UnifiedSessionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("status"),
      Type.Literal("history"),
      Type.Literal("list"),
    ],
    {
      description:
        "Session action to perform. Valid values: search (search/browse session history), " +
        "status (view current session info), history (view conversation history for a session), " +
        "list (list active sessions)",
    },
  ),
  // search params
  query: Type.Optional(
    Type.String({ description: "Search query -- keywords, phrases, or boolean expressions. Omit for recent sessions metadata. (action: search)" }),
  ),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("all"),
        Type.Literal("user"),
        Type.Literal("assistant"),
        Type.Literal("tool"),
      ],
      { description: "Filter by message role: 'all' (default), 'user', 'assistant', 'tool' (action: search)" },
    ),
  ),
  summarize: Type.Optional(
    Type.Boolean({ description: "Summarize matched sessions using LLM (default: true when query provided) (action: search)" }),
  ),
  // history params
  session_key: Type.Optional(
    Type.String({ description: "Target session key to retrieve history for (action: history)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ description: "Pagination offset (default: 0) (action: history)" }),
  ),
  // shared params
  limit: Type.Optional(
    Type.Integer({ description: "Maximum results to return (action: search default 10 max 30, action: history default 20)" }),
  ),
  // list params
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("all"),
        Type.Literal("dm"),
        Type.Literal("group"),
        Type.Literal("sub-agent"),
      ],
      { description: "Filter by session kind (default: all). (action: list)" },
    ),
  ),
  since_minutes: Type.Optional(
    Type.Integer({ description: "Only sessions active within N minutes (action: list)" }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a unified session tool with action dispatch covering search, status, history, list.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing session_tool
 */
export function createUnifiedSessionTool(rpcCall: RpcCall): AgentTool<typeof UnifiedSessionParams> {
  return {
    name: "session_tool",
    label: "Session Tool",
    description:
      "Unified session management tool. Actions: " +
      "search (search/browse full conversation history across sessions), " +
      "status (view current session model, token usage, duration), " +
      "history (view conversation history for a specific session with pagination), " +
      "list (list active sessions filtered by kind and recency).",
    parameters: UnifiedSessionParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const action = readEnumParam(params, "action", VALID_ACTIONS);

        switch (action) {
          case "search": {
            const query = readStringParam(params, "query", false);
            const scope = readStringParam(params, "scope", false) ?? "all";
            const limit = readNumberParam(params, "limit", false) ?? 10;
            const summarize = readBooleanParam(params, "summarize", false);

            if (query) {
              const sanitizedQuery = sanitizeFts5Query(query);
              const effectiveSummarize = summarize ?? true;
              const result = await rpcCall("session.search", {
                query: sanitizedQuery,
                scope,
                limit,
                summarize: effectiveSummarize,
              });
              return jsonResult(result);
            }

            // Recent-sessions mode: no query, never summarize
            const result = await rpcCall("session.search", {
              scope,
              limit,
              summarize: false,
            });
            return jsonResult(result);
          }

          case "status": {
            const result = await rpcCall("session.status", {});
            return jsonResult(result);
          }

          case "history": {
            const sessionKey = readStringParam(params, "session_key");
            const offset = readNumberParam(params, "offset", false) ?? 0;
            const limit = readNumberParam(params, "limit", false) ?? 20;
            const result = await rpcCall("session.history", {
              session_key: sessionKey,
              offset,
              limit,
            });
            return jsonResult(result);
          }

          case "list": {
            const limit = readNumberParam(params, "limit", false);
            const result = await rpcCall("session.list", {
              kind: readStringParam(params, "kind", false) ?? "all",
              since_minutes: readNumberParam(params, "since_minutes", false),
              ...(limit !== undefined && { limit }),
            });
            return jsonResult(result);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
