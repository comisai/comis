// SPDX-License-Identifier: Apache-2.0
/**
 * Memory Search Tool: Semantic search over agent memory.
 *
 * Delegates to the daemon-side memory.search_files RPC method for hybrid
 * text and vector search across stored memories and session transcripts.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "./tool-helpers.js";

// ── RPC Type ────────────────────────────────────────────────────────

/** RPC call function type for daemon communication. */
export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ── Parameter Schema ────────────────────────────────────────────────

const MemorySearchParams = Type.Object({
  query: Type.String({ description: "Semantic search query" }),
  limit: Type.Optional(
    Type.Integer({ description: "Max results (default 10)", default: 10 }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a memory search tool that finds relevant memories semantically.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing memory_search
 */
export function createMemorySearchTool(rpcCall: RpcCall): AgentTool<typeof MemorySearchParams> {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search memory semantically. Finds relevant memories and session transcripts using hybrid text and vector search.",
    parameters: MemorySearchParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const query = readStringParam(params, "query");
        const limit = readNumberParam(params, "limit", false) ?? 10;

        const result = await rpcCall("memory.search_files", { query, limit });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
