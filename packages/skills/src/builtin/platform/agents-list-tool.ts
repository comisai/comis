// SPDX-License-Identifier: Apache-2.0
/**
 * Agents List Tool: List all available agent IDs.
 *
 * Delegates to the daemon-side agents.list RPC method to retrieve
 * the configured agent identifiers in the system.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult } from "./tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const AgentsListParams = Type.Object({});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create an agents list tool that lists all available agent IDs.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing agents_list
 */
export function createAgentsListTool(rpcCall: RpcCall): AgentTool<typeof AgentsListParams> {
  return {
    name: "agents_list",
    label: "Agents List",
    description: "List all available agent IDs configured in the system.",
    parameters: AgentsListParams,

    async execute(
       
      _toolCallId: string,
       
      _params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const result = await rpcCall("agents.list", {});
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
