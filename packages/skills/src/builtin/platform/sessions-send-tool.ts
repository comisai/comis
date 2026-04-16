/**
 * Sessions Send Tool: send a message into another session.
 *
 * Delegates to the daemon-side session.send RPC method. Supports three
 * modes: fire-and-forget (default), wait (blocks for response), and
 * ping-pong (multi-turn exchange with timeout and max turns).
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import {
  readStringParam,
  readNumberParam,
} from "./tool-helpers.js";
import { createRpcDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionsSendParams = Type.Object({
  session_key: Type.String({ description: "Target session key to send the message to" }),
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

type SessionsSendParamsType = Static<typeof SessionsSendParams>;

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
        "Send a message into another session. Supports fire-and-forget (default), wait (blocks for response), and ping-pong (multi-turn exchange) modes.",
      parameters: SessionsSendParams,
      rpcMethod: "session.send",
      transformParams(p) {
        const sessionKey = readStringParam(p, "session_key");
        const text = readStringParam(p, "text");
        const mode = readStringParam(p, "mode", false) ?? "fire-and-forget";
        const timeoutMs = readNumberParam(p, "timeout_ms", false);
        const maxTurns = readNumberParam(p, "max_turns", false);
        return {
          session_key: sessionKey,
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
