/**
 * Session management tool: multi-action tool for session lifecycle management.
 *
 * Supports 4 actions: delete, reset, export, compact.
 * Destructive actions (delete, reset) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to session.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SessionsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("delete"),
      Type.Literal("reset"),
      Type.Literal("export"),
      Type.Literal("compact"),
    ],
    { description: "Session management action. Valid values: delete (archive and remove session), reset (clear messages, keep identity), export (download transcript as JSON), compact (reduce token usage)" },
  ),
  session_key: Type.String({
    description: "The formatted session key (e.g., tenant:user:channel)",
  }),
  instructions: Type.Optional(
    Type.String({
      description: "Optional instructions for compaction guidance (only used with compact action)",
    }),
  ),
});

type SessionsManageToolParamsType = Static<typeof SessionsManageToolParams>;

const VALID_ACTIONS = ["delete", "reset", "export", "compact"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session management tool with 4 actions.
 *
 * Actions:
 * - **delete** -- Delete a session, archiving its transcript (requires approval)
 * - **reset** -- Clear session messages while preserving identity (requires approval)
 * - **export** -- Export a session transcript as JSON
 * - **compact** -- Trigger compaction on a session to reduce token usage
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for delete/reset actions
 * @returns AgentTool implementing the session management interface
 */
export function createSessionsManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof SessionsManageToolParams> {
  return createAdminManageTool(
    {
      name: "sessions_manage",
      label: "Session Management",
      description:
        "Admin session lifecycle: delete, reset, export, compact. Delete/reset require approval.",
      parameters: SessionsManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "session",
      gatedActions: ["delete", "reset"],
      actionOverrides: {
        async delete(p, rpcCall, ctx) {
          const sessionKey = readStringParam(p, "session_key");
          return rpcCall("session.delete", { session_key: sessionKey, _trustLevel: ctx.trustLevel });
        },
        async reset(p, rpcCall, ctx) {
          const sessionKey = readStringParam(p, "session_key");
          return rpcCall("session.reset", { session_key: sessionKey, _trustLevel: ctx.trustLevel });
        },
        async export(p, rpcCall, ctx) {
          const sessionKey = readStringParam(p, "session_key");
          return rpcCall("session.export", { session_key: sessionKey, _trustLevel: ctx.trustLevel });
        },
        async compact(p, rpcCall, ctx) {
          const sessionKey = readStringParam(p, "session_key");
          const instructions = readStringParam(p, "instructions", false);
          return rpcCall("session.compact", {
            session_key: sessionKey,
            instructions,
            _trustLevel: ctx.trustLevel,
          });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
