// SPDX-License-Identifier: Apache-2.0
// @allow-throw: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.
/**
 * MCP OAuth login tool: starts the PKCE OAuth flow for an MCP server.
 *
 * Single-action tool (plain AgentTool, not createAdminManageTool) — the
 * action enum overhead is unnecessary for a tool with one operation.
 *
 * Trust gate: admin level via createTrustGuard (same level as mcp_manage).
 * Returns `authUrl` as `content[0].text` — the FIRST and only text block —
 * so `recoverEmptyFinalResponse` and the activity renderer both capture it.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { readStringParam, createTrustGuard } from "../tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Activity label registration
// ---------------------------------------------------------------------------

registerActivityLabelSpec("mcp_login", {
  semanticPhase: "tool",
  label: "MCP OAuth login",
  actions: {
    login: { label: "starting MCP OAuth login" },
  },
});

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const McpLoginToolParams = Type.Object({
  server_name: Type.String({
    description: "Name of the MCP server to start OAuth login for.",
  }),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the mcp_login agent tool wrapping the `mcp.oauth_login` RPC.
 *
 * The tool returns the `authUrl` as `content[0].text` (first block, no prose
 * prefix) so `recoverEmptyFinalResponse` and the activity renderer capture it.
 * If the daemon returns no `authUrl` (e.g., an error state), a status fallback
 * string is surfaced instead.
 *
 * @param rpcCall - RPC call function delegating to the daemon backend.
 * @returns AgentTool implementing the mcp_login interface.
 */
export function createMcpLoginTool(rpcCall: RpcCall): AgentTool<typeof McpLoginToolParams> {
  const trustGuard = createTrustGuard("mcp_login");

  return {
    name: "mcp_login",
    label: "MCP OAuth Login",
    description:
      "Start the OAuth login flow for an MCP server that requires OAuth authentication. " +
      "Returns a verification URL — deliver it to the user before any background polling. " +
      "Use after mcp_manage(action:\"connect\", auth:\"oauth\") returns a needs_oauth_login action.",
    parameters: McpLoginToolParams,

    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // Trust gate: enforce admin trust level (throws if insufficient).
        trustGuard();

        const p = params as Record<string, unknown>;
        const serverName = readStringParam(p, "server_name");
        const result = await rpcCall("mcp.oauth_login", { server_name: serverName });
        const r = result as { authUrl?: string; status?: string };

        // authUrl MUST be content[0].text — first block, no prose wrapping.
        // recoverEmptyFinalResponse and the activity renderer pick up content[0].text.
        const text = r.authUrl
          ? r.authUrl
          : `OAuth login status: ${r.status ?? "unknown"}`;

        return {
          content: [{ type: "text" as const, text }],
          details: result,
        };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
