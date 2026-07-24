// SPDX-License-Identifier: Apache-2.0
/**
 * Session Status Tool: View current session information.
 *
 * Delegates to the daemon-side session.status RPC method to retrieve
 * agent, model, token and cost totals, and step usage.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { jsonResult } from "../tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionStatusParams = Type.Object({});

type SessionStatusParamsType = Static<typeof SessionStatusParams>;

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
      "View your current session status including agent, model, token and cost totals, and step usage.",
    parameters: SessionStatusParams,

    async execute(
      _toolCallId: string,
      _params: SessionStatusParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const result = await rpcCall("session.status", {});
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
