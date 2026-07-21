// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions History Tool: view conversation history for a specific session.
 *
 * Delegates to the daemon-side session.history RPC method with pagination
 * support via offset and limit parameters.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
  jsonResult,
  readStringParam,
  readNumberParam,
} from "../tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionsHistoryParams = Type.Object({
  tenant_id: Type.String({ description: "Tenant that owns the target conversation" }),
  agent_id: Type.String({ description: "Agent that owns the target conversation" }),
  conversation_ref: Type.String({ description: "Opaque durable reference of the target conversation" }),
  offset: Type.Optional(
    Type.Integer({ description: "Pagination offset (default: 0)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max messages to return (default: 20)" }),
  ),
});

type SessionsHistoryParamsType = Static<typeof SessionsHistoryParams>;

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a sessions history tool that retrieves conversation history.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing sessions_history
 */
export function createSessionsHistoryTool(rpcCall: RpcCall): AgentTool<typeof SessionsHistoryParams> {
  return {
    name: "sessions_history",
    label: "Sessions History",
    description: "View conversation history for a durable tenant, agent, and conversation reference with pagination. Sub-agent listings expose agentId, conversationRef, and conversationScope.tenantId for this lookup.",
    parameters: SessionsHistoryParams,

    async execute(
      _toolCallId: string,
      params: SessionsHistoryParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const tenantId = readStringParam(p, "tenant_id");
        const agentId = readStringParam(p, "agent_id");
        const conversationRef = readStringParam(p, "conversation_ref");
        const offset = readNumberParam(p, "offset", false) ?? 0;
        const limit = readNumberParam(p, "limit", false) ?? 20;
        const result = await rpcCall("session.history", {
          tenant_id: tenantId,
          agent_id: agentId,
          conversation_ref: conversationRef,
          offset,
          limit,
        });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
