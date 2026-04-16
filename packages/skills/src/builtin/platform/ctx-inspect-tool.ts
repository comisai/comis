/**
 * Context Inspect Tool: view full content of a DAG summary or file by ID.
 *
 * Delegates to the daemon-side context.inspect RPC method to fetch full
 * summary content with lineage (parents, children, source message count)
 * or file content by ID prefix (sum_ or file_).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Parameter Schema --------------------------------------------------------

const CtxInspectParams = Type.Object({
  id: Type.String({
    description: "ID of the summary (sum_xxx) or file (file_xxx) to inspect",
  }),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a context inspect tool that retrieves full content from the DAG.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing ctx_inspect
 */
export function createCtxInspectTool(rpcCall: RpcCall): AgentTool<typeof CtxInspectParams> {
  return {
    name: "ctx_inspect",
    label: "Context Inspect",
    description:
      "View the full content of a specific summary or file from the context DAG. " +
      "Use this to see full details of content referenced in <context_summary> tags " +
      "or [Tool result ... Use ctx_inspect to view.] placeholders.",
    parameters: CtxInspectParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const id = readStringParam(params, "id");
        const result = await rpcCall("context.inspect", { id });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
