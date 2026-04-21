// SPDX-License-Identifier: Apache-2.0
/**
 * Token management tool: multi-action tool for gateway token lifecycle.
 *
 * Supports 4 actions: list, create, revoke, rotate.
 * Mutating actions (create, revoke, rotate) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to tokens.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { readStringParam, throwToolError } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const TokensManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("create"),
      Type.Literal("revoke"),
      Type.Literal("rotate"),
    ],
    { description: "Token management action. Valid values: list (show active tokens), create (new token with scopes), revoke (invalidate token), rotate (atomic revoke and recreate)" },
  ),
  token_id: Type.Optional(
    Type.String({
      description: "Token identifier (required for revoke/rotate, optional for create -- auto-generated if omitted)",
    }),
  ),
  scopes: Type.Optional(
    Type.Array(Type.String(), {
      description: "Token scopes (required for create, e.g. [\"rpc\", \"ws\", \"admin\"])",
    }),
  ),
});

const VALID_ACTIONS = ["list", "create", "revoke", "rotate"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a token management tool with 4 actions.
 *
 * Actions:
 * - **list** -- List all active tokens (id, scopes, createdAt -- never secrets)
 * - **create** -- Create a new token with specified scopes (requires approval, returns secret once)
 * - **revoke** -- Revoke a token by ID (requires approval)
 * - **rotate** -- Atomically rotate a token: revoke old + create new (requires approval)
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for create/revoke/rotate actions
 * @returns AgentTool implementing the token management interface
 */
export function createTokensManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof TokensManageToolParams> {
  return createAdminManageTool(
    {
      name: "tokens_manage",
      label: "Token Management",
      description:
        "Manage gateway tokens: list, create, revoke, rotate. Create/revoke/rotate require approval.",
      parameters: TokensManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "tokens",
      gatedActions: ["create", "revoke", "rotate"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("tokens.list", { _trustLevel: ctx.trustLevel });
        },
        async create(p, rpcCall, ctx) {
          const scopes = p.scopes as string[] | undefined;
          if (!Array.isArray(scopes) || scopes.length === 0) {
            throwToolError("missing_param", "Missing required parameter: scopes (array of strings).", {
              param: "scopes",
              hint: "Provide a non-empty array of scope strings, e.g. [\"rpc\", \"ws\"].",
            });
          }
          const tokenId = readStringParam(p, "token_id", false);
          return rpcCall("tokens.create", {
            id: tokenId,
            scopes,
            _trustLevel: ctx.trustLevel,
          });
        },
        async revoke(p, rpcCall, ctx) {
          const tokenId = readStringParam(p, "token_id");
          return rpcCall("tokens.revoke", { id: tokenId, _trustLevel: ctx.trustLevel });
        },
        async rotate(p, rpcCall, ctx) {
          const tokenId = readStringParam(p, "token_id");
          return rpcCall("tokens.rotate", { id: tokenId, _trustLevel: ctx.trustLevel });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
