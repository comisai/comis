// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions Send Tool: send a message into another session.
 *
 * Delegates to the daemon-side session.send RPC method. Supports three
 * modes: fire-and-forget (default), wait (blocks for response), and
 * ping-pong (multi-turn exchange with timeout and max turns).
 *
 * @module
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  readStringParam,
  readNumberParam,
} from "../tool-helpers.js";
import { createRpcDispatchTool } from "../messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionsSendParams = Type.Object({
  tenant_id: Type.String({ description: "Tenant that owns the target conversation" }),
  agent_id: Type.String({ description: "Agent that owns the target conversation" }),
  conversation_ref: Type.String({ description: "Opaque durable reference of the target conversation" }),
  text: Type.String({ description: "Message text to inject into target session" }),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("fire-and-forget"),
        Type.Literal("wait"),
        Type.Literal("ping-pong"),
      ],
      { description: "Send mode (default: fire-and-forget). Valid values: fire-and-forget (send without waiting), wait (block for response), ping-pong (multi-turn exchange)" },
    ),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ description: "Wait timeout in ms (for wait/ping-pong modes)" }),
  ),
  max_turns: Type.Optional(
    Type.Integer({ description: "Max ping-pong turns 0-5 (for ping-pong mode)" }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a sessions send tool for cross-session messaging.
 *
 * Supports fire-and-forget (default), wait (blocks for response),
 * and ping-pong (multi-turn exchange) modes.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing sessions_send
 */
export function createSessionsSendTool(rpcCall: RpcCall): AgentTool<typeof SessionsSendParams> {
  return createRpcDispatchTool(
    {
      name: "sessions_send",
      label: "Sessions Send",
      description:
        "Send a message to an exact tenant, agent, and durable conversation reference. " +
        "Use sessions_list to discover targets. Supports fire-and-forget (default), wait, and ping-pong modes.",
      parameters: SessionsSendParams,
      rpcMethod: "session.send",
      useToolCallIdAsOperationId: true,
      transformParams(p) {
        const tenantId = readStringParam(p, "tenant_id");
        const agentId = readStringParam(p, "agent_id");
        const conversationRef = readStringParam(p, "conversation_ref");
        const text = readStringParam(p, "text");
        const mode = readStringParam(p, "mode", false) ?? "fire-and-forget";
        const timeoutMs = readNumberParam(p, "timeout_ms", false);
        const maxTurns = readNumberParam(p, "max_turns", false);
        return {
          tenant_id: tenantId,
          agent_id: agentId,
          conversation_ref: conversationRef,
          text,
          mode,
          timeout_ms: timeoutMs,
          max_turns: maxTurns,
        };
      },
    },
    rpcCall,
  );
}
