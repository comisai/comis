// SPDX-License-Identifier: Apache-2.0
/**
 * Context Recall Tool: deep recall via bounded sub-agent spawning.
 *
 * Delegates to the daemon-side context.recall RPC method to spawn a
 * bounded sub-agent that searches the full DAG history and answers
 * a question about earlier conversation content. Subject to daily
 * recall quota enforcement.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { jsonResult, readStringParam, readNumberParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Parameter Schema --------------------------------------------------------

const CtxRecallParams = Type.Object({
  prompt: Type.String({ description: "What to find or answer from earlier history" }),
  query: Type.Optional(
    Type.String({ description: "Text search to find relevant summaries (if summary_ids not provided)" }),
  ),
  summary_ids: Type.Optional(
    Type.Array(Type.String(), { description: "Explicit summary IDs to expand" }),
  ),
  max_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum answer length (default: 2000, max: 10000)",
      minimum: 100,
      maximum: 10000,
    }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a context recall tool that spawns a bounded sub-agent for deep history recall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing ctx_recall
 */
export function createCtxRecallTool(rpcCall: RpcCall): AgentTool<typeof CtxRecallParams> {
  return {
    name: "ctx_recall",
    label: "Context Recall",
    description:
      "Deep recall -- spawns a bounded sub-agent to search the full DAG history and " +
      "answer a question about earlier conversation content. Use when ctx_search and " +
      "ctx_inspect are not sufficient to find or understand past context. " +
      "Subject to a daily recall quota.",
    parameters: CtxRecallParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
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
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
