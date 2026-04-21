// SPDX-License-Identifier: Apache-2.0
/**
 * Context Search Tool: FTS5 search over full DAG conversation history.
 *
 * Delegates to the daemon-side context.search RPC method to find content
 * across messages and summaries, including compressed/compacted content.
 * Enables agents in DAG mode to locate decisions, tool results, or
 * discussion topics from earlier in the conversation.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Parameter Schema --------------------------------------------------------

const CtxSearchParams = Type.Object({
  query: Type.String({ description: "Search pattern (FTS query or regex)" }),
  mode: Type.Optional(
    Type.String({ description: "Search mode: 'fts' (default) or 'regex'" }),
  ),
  scope: Type.Optional(
    Type.String({ description: "Search scope: 'both' (default), 'messages', or 'summaries'" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum results to return (default: 20, max: 100)", minimum: 1, maximum: 100 }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a context search tool that finds content in the full DAG conversation history.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing ctx_search
 */
export function createCtxSearchTool(rpcCall: RpcCall): AgentTool<typeof CtxSearchParams> {
  return {
    name: "ctx_search",
    label: "Context Search",
    description:
      "Search your full conversation history including content that has been " +
      "compressed into summaries. Use this to find decisions, tool results, " +
      "or discussion topics from earlier in the conversation.",
    parameters: CtxSearchParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const query = readStringParam(params, "query");
        const mode = readStringParam(params, "mode", false) ?? "fts";
        const scope = readStringParam(params, "scope", false) ?? "both";
        const limit = readNumberParam(params, "limit", false) ?? 20;

        const result = await rpcCall("context.search", { query, mode, scope, limit });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
