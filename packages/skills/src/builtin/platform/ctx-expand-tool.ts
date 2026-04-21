// SPDX-License-Identifier: Apache-2.0
/**
 * Context Expand Tool: walk deeper into the context DAG.
 *
 * Delegates to the daemon-side context.expand RPC method to expand a
 * summary into its children (sub-summaries or source messages). Only
 * available to recall sub-agents with a valid expansion grant. Tracks
 * token consumption against the grant's token budget.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Parameter Schema --------------------------------------------------------

const CtxExpandParams = Type.Object({
  grant_id: Type.String({ description: "The expansion grant ID (provided in domain knowledge)" }),
  summary_id: Type.String({ description: "The summary to expand" }),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a context expand tool that walks deeper into the context DAG.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing ctx_expand
 */
export function createCtxExpandTool(rpcCall: RpcCall): AgentTool<typeof CtxExpandParams> {
  return {
    name: "ctx_expand",
    label: "Context Expand",
    description:
      "Walk deeper into the context DAG by expanding a summary into its children " +
      "(sub-summaries or source messages). Only available to recall sub-agents " +
      "with a valid expansion grant. Expansion is subject to a token budget.",
    parameters: CtxExpandParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const grant_id = readStringParam(params, "grant_id");
        const summary_id = readStringParam(params, "summary_id");

        const result = await rpcCall("context.expand", { grant_id, summary_id });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
