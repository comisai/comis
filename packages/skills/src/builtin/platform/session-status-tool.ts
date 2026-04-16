/**
 * Session Status Tool: View current session information.
 *
 * Delegates to the daemon-side session.status RPC method to retrieve
 * model, token usage, session duration, and step count.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult } from "./tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionStatusParams = Type.Object({
  model: Type.Optional(
    Type.String({ description: "Optional model override for this session" }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a session status tool that reports current session information.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing session_status
 */
export function createSessionStatusTool(rpcCall: RpcCall): AgentTool<typeof SessionStatusParams> {
  return {
    name: "session_status",
    label: "Session Status",
    description:
      "View your current session status including model, token usage, and session duration.",
    parameters: SessionStatusParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const model = typeof p.model === "string" ? p.model : undefined;
        const result = await rpcCall("session.status", { ...(model && { model }) });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
