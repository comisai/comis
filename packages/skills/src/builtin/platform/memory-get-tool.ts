// SPDX-License-Identifier: Apache-2.0
/**
 * Memory Get Tool: Read specific memory file sections by path.
 *
 * Delegates to the daemon-side memory.get_file RPC method. Path security
 * validation (SafePath) is handled daemon-side where the base directory
 * is known, not in the tool itself.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "./tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const MemoryGetParams = Type.Object({
  path: Type.String({ description: "File path relative to workspace" }),
  start_line: Type.Optional(
    Type.Integer({ description: "Start line (1-based)" }),
  ),
  end_line: Type.Optional(
    Type.Integer({ description: "End line (1-based)" }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a memory get tool that reads specific memory file sections.
 *
 * SafePath validation happens daemon-side in the rpcCall handler,
 * not in this tool. The tool simply passes the path through.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing memory_get
 */
export function createMemoryGetTool(rpcCall: RpcCall): AgentTool<typeof MemoryGetParams> {
  return {
    name: "memory_get",
    label: "Memory Get",
    description:
      "Read specific memory file sections by path. Supports line range selection. Paths are validated for security via SafePath.",
    parameters: MemoryGetParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const path = readStringParam(params, "path");
        const startLine = readNumberParam(params, "start_line", false);
        const endLine = readNumberParam(params, "end_line", false);

        const rpcParams: Record<string, unknown> = { path };
        if (startLine !== undefined) rpcParams.startLine = startLine;
        if (endLine !== undefined) rpcParams.endLine = endLine;

        const result = await rpcCall("memory.get_file", rpcParams);
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
