/**
 * MCP server management tool: multi-action tool for MCP server lifecycle.
 *
 * Supports 5 actions: list, status, connect, disconnect, reconnect.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to mcp.* RPC handlers via rpcCall.
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

const McpManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("connect"),
      Type.Literal("disconnect"),
      Type.Literal("reconnect"),
    ],
    { description: "MCP server management action. Valid values: list (all servers with status), status (detailed single server info), connect (add new server), disconnect (remove server), reconnect (restart server connection)" },
  ),
  name: Type.Optional(
    Type.String({
      description: "MCP server name. Required for status/connect/disconnect/reconnect.",
    }),
  ),
  transport: Type.Optional(
    Type.String({
      description: 'Transport type: "stdio", "sse", or "http". Required for connect. Use "http" for Streamable HTTP servers, "sse" for legacy SSE servers.',
    }),
  ),
  command: Type.Optional(
    Type.String({
      description: "Command to execute for stdio transport (e.g. npx). Required for stdio connect.",
    }),
  ),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Arguments for the stdio command (e.g. ["-y", "@upstash/context7-mcp"]).',
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "Server URL for remote transport (sse or http). Required for sse/http connect.",
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Custom HTTP headers for remote transports (e.g. Authorization). Keys are header names, values are header values.",
    }),
  ),
});

type McpManageToolParamsType = Static<typeof McpManageToolParams>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server management tool with 5 actions.
 *
 * Actions:
 * - **list** -- List all MCP servers with name, status, tool count
 * - **status** -- Get detailed status for one server (tools, health check)
 * - **connect** -- Connect to a new MCP server by config
 * - **disconnect** -- Disconnect an MCP server by name
 * - **reconnect** -- Disconnect and reconnect an MCP server
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the MCP management interface
 */
const VALID_ACTIONS = ["list", "status", "connect", "disconnect", "reconnect"] as const;

export function createMcpManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof McpManageToolParams> {
  return createAdminManageTool(
    {
      name: "mcp_manage",
      label: "MCP Server Management",
      description:
        "Manage MCP servers: list, status, connect, disconnect, reconnect.",
      parameters: McpManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "mcp",
      gatedActions: ["connect", "disconnect", "reconnect"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("mcp.list", { _trustLevel: ctx.trustLevel });
        },
        async status(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          return rpcCall("mcp.status", { name, _trustLevel: ctx.trustLevel });
        },
        async connect(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          const transport = readStringParam(p, "transport");
          return rpcCall("mcp.connect", {
            name,
            transport,
            command: p.command,
            args: p.args,
            url: p.url,
            headers: p.headers,
            _trustLevel: ctx.trustLevel,
          });
        },
        async disconnect(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          return rpcCall("mcp.disconnect", { name, _trustLevel: ctx.trustLevel });
        },
        async reconnect(p, rpcCall, ctx) {
          const name = readStringParam(p, "name");
          return rpcCall("mcp.reconnect", {
            name,
            transport: p.transport,
            command: p.command,
            args: p.args,
            url: p.url,
            headers: p.headers,
            _trustLevel: ctx.trustLevel,
          });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
