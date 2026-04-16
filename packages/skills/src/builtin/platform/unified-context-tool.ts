/**
 * Unified Context Tool: single tool with action dispatch covering search, recall, inspect, expand.
 *
 * Consolidates 4 individual context DAG tools into one tool with an `action` parameter:
 * - action "search" -> context.search RPC (from ctx-search-tool)
 * - action "recall" -> context.recall RPC (from ctx-recall-tool)
 * - action "inspect" -> context.inspect RPC (from ctx-inspect-tool)
 * - action "expand" -> context.expand RPC (from ctx-expand-tool)
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam, readEnumParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Parameter Schema --------------------------------------------------------

const VALID_ACTIONS = ["search", "recall", "inspect", "expand"] as const;

const UnifiedContextParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("recall"),
      Type.Literal("inspect"),
      Type.Literal("expand"),
    ],
    {
      description:
        "Context action to perform. Valid values: search (FTS5 search over DAG history), " +
        "recall (deep recall via bounded sub-agent spawning), " +
        "inspect (view full content of a DAG summary or file by ID), " +
        "expand (walk deeper into the context DAG)",
    },
  ),
  // search params
  query: Type.Optional(
    Type.String({ description: "Search pattern (FTS query or regex) (action: search), or text search for summaries (action: recall)" }),
  ),
  mode: Type.Optional(
    Type.String({ description: "Search mode: 'fts' (default) or 'regex' (action: search)" }),
  ),
  scope: Type.Optional(
    Type.String({ description: "Search scope: 'both' (default), 'messages', or 'summaries' (action: search)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum results to return (action: search default 20 max 100)" }),
  ),
  // recall params
  prompt: Type.Optional(
    Type.String({ description: "What to find or answer from earlier history (action: recall)" }),
  ),
  summary_ids: Type.Optional(
    Type.Array(Type.String(), { description: "Explicit summary IDs to expand (action: recall)" }),
  ),
  max_tokens: Type.Optional(
    Type.Integer({ description: "Maximum answer length (default: 2000, max: 10000) (action: recall)" }),
  ),
  // inspect params
  id: Type.Optional(
    Type.String({ description: "ID of the summary (sum_xxx) or file (file_xxx) to inspect (action: inspect)" }),
  ),
  // expand params
  grant_id: Type.Optional(
    Type.String({ description: "The expansion grant ID (provided in domain knowledge) (action: expand)" }),
  ),
  summary_id: Type.Optional(
    Type.String({ description: "The summary to expand (action: expand)" }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a unified context tool with action dispatch covering search, recall, inspect, expand.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing context_tool
 */
export function createUnifiedContextTool(rpcCall: RpcCall): AgentTool<typeof UnifiedContextParams> {
  return {
    name: "context_tool",
    label: "Context Tool",
    description:
      "Unified context DAG management tool. Actions: " +
      "search (FTS5 search over full DAG conversation history including compressed content), " +
      "recall (deep recall via bounded sub-agent spawning, subject to daily quota), " +
      "inspect (view full content of a specific summary or file from the context DAG), " +
      "expand (walk deeper into the DAG by expanding a summary into children, requires expansion grant).",
    parameters: UnifiedContextParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const action = readEnumParam(params, "action", VALID_ACTIONS);

        switch (action) {
          case "search": {
            const query = readStringParam(params, "query");
            const mode = readStringParam(params, "mode", false) ?? "fts";
            const scope = readStringParam(params, "scope", false) ?? "both";
            const limit = readNumberParam(params, "limit", false) ?? 20;

            const result = await rpcCall("context.search", { query, mode, scope, limit });
            return jsonResult(result);
          }

          case "recall": {
            const prompt = readStringParam(params, "prompt");
            const query = readStringParam(params, "query", false);
            const summary_ids = Array.isArray(params.summary_ids) ? params.summary_ids : undefined;
            const max_tokens = readNumberParam(params, "max_tokens", false) ?? 2000;

            const result = await rpcCall("context.recall", {
              prompt,
              ...(query !== undefined && { query }),
              ...(summary_ids !== undefined && { summary_ids }),
              max_tokens,
            });
            return jsonResult(result);
          }

          case "inspect": {
            const id = readStringParam(params, "id");
            const result = await rpcCall("context.inspect", { id });
            return jsonResult(result);
          }

          case "expand": {
            const grant_id = readStringParam(params, "grant_id");
            const summary_id = readStringParam(params, "summary_id");

            const result = await rpcCall("context.expand", { grant_id, summary_id });
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
