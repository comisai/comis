// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions List Tool: list active sessions filtered by kind and recency.
 *
 * Delegates to the daemon-side session.list RPC method. Sessions can be
 * filtered by kind (dm, group, sub-agent) and recency (since_minutes).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import {
  jsonResult,
  readStringParam,
  readNumberParam,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionsListParams = Type.Object({
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("all"),
        Type.Literal("dm"),
        Type.Literal("group"),
        Type.Literal("sub-agent"),
      ],
      { description: "Filter by session kind (default: all). Valid values: all (every session), dm (direct messages), group (group chats), sub-agent (sub-agent sessions)" },
    ),
  ),
  since_minutes: Type.Optional(
    Type.Integer({ description: "Only sessions active within N minutes" }),
  ),
});

type SessionsListParamsType = Static<typeof SessionsListParams>;

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a sessions list tool that lists active sessions.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing sessions_list
 */
export function createSessionsListTool(rpcCall: RpcCall): AgentTool<typeof SessionsListParams> {
  return {
    name: "sessions_list",
    label: "Sessions List",
    description: "List active sessions filtered by kind and recency.",
    parameters: SessionsListParams,

    async execute(
      _toolCallId: string,
      params: SessionsListParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const result = await rpcCall("session.list", {
          kind: readStringParam(p, "kind", false) ?? "all",
          since_minutes: readNumberParam(p, "since_minutes", false),
        });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
