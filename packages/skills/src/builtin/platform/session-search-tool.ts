// SPDX-License-Identifier: Apache-2.0
/**
 * Session Search Tool: Search or browse full JSONL session history.
 *
 * Two modes:
 * 1. **Search mode** (query provided) — sanitizes FTS5 special chars, searches
 *    sessions via daemon-side session.search RPC, optionally summarizes matches.
 * 2. **Recent-sessions mode** (no query) — returns recent session metadata
 *    without loading message bodies (zero LLM cost).
 *
 * Delegates to the daemon-side session.search RPC method to find content
 * that may have been windowed, masked, or evicted from the visible context.
 * Enables agents to avoid duplicate tool calls by recovering prior results.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { jsonResult, readStringParam, readNumberParam, readBooleanParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";
import { sanitizeFts5Query } from "./fts5-sanitizer.js";

// -- Parameter Schema --------------------------------------------------------

const SessionSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Search query -- keywords, phrases, or boolean expressions. Omit for recent sessions metadata." }),
  ),
  scope: Type.Optional(
    Type.String({ description: "Filter by message role: 'all' (default), 'user', 'assistant', 'tool'" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum results to return (default: 10, max: 30)", minimum: 1, maximum: 30 }),
  ),
  summarize: Type.Optional(
    Type.Boolean({ description: "Summarize matched sessions using LLM (default: true when query provided)" }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a session search tool that finds content in the full session JSONL history,
 * or browses recent sessions when no query is provided.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing session_search
 */
export function createSessionSearchTool(rpcCall: RpcCall): AgentTool<typeof SessionSearchParams> {
  return {
    name: "session_search",
    label: "Session History Search",
    description:
      "Search the full conversation history across sessions, including content that may have been " +
      "cleared from your visible context window. Provide a query to search, or omit it to browse " +
      "recent sessions metadata. Use BEFORE re-calling tools when you see [Superseded] placeholders.",
    parameters: SessionSearchParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const query = readStringParam(params, "query", false);
        const scope = readStringParam(params, "scope", false) ?? "all";
        const limit = readNumberParam(params, "limit", false) ?? 10;
        const summarize = readBooleanParam(params, "summarize", false);

        if (query) {
          // Search mode: sanitize query and pass through
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
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
