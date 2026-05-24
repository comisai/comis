// SPDX-License-Identifier: Apache-2.0
/**
 * GLOBAL resources utility platform tools (Phase 65 OPUX-10).
 *
 * Two tools — `list_resources` and `read_resource` — each take a required
 * `server: string` parameter naming the connected MCP server to query. The
 * tools are GLOBAL (not per-server): the descriptor count stays fixed at 2
 * regardless of how many MCP servers are connected, which avoids Cursor's
 * 40-tool ceiling when many resources-capable servers are wired (the
 * per-server alternative would emit N×2 descriptors).
 *
 * Each tool delegates to the matching adapter in mcp-client-resources.ts.
 * Adapter errors (server not connected, SDK throw translated to `err`) are
 * surfaced as an error-shaped `AgentToolResult` with `details.success:false`
 * — NOT a throw — so the LLM can read the failure text and self-correct
 * (e.g. call `mcp_manage`/`list` to discover the right server name).
 *
 * Returned content is `JSON.stringify`'d server data. Resource/prompt content
 * is server-controlled; this tool does not introduce new untrusted-content
 * rendering beyond JSON serialization (the agent's conversation-layer
 * prompt-injection defenses apply, matching the obs_query plain-data return).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { McpClientManager } from "../../skills/integrations/mcp-client/mcp-client-types.js";
import {
  listResourcesForServer,
  readResourceFromServer,
} from "../../skills/integrations/mcp-client/mcp-client-resources.js";

// ---------------------------------------------------------------------------
// Result helpers (error-shaped, not throws)
// ---------------------------------------------------------------------------

interface ToolDetails {
  readonly success: boolean;
}

function okResult(data: unknown): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: { success: true },
  };
}

function errorResult(message: string): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { success: false },
  };
}

// ---------------------------------------------------------------------------
// list_resources
// ---------------------------------------------------------------------------

const ListResourcesParams = Type.Object({
  server: Type.String({ description: "MCP server name (must be a connected server advertising resources)" }),
});
type ListResourcesParamsType = Static<typeof ListResourcesParams>;

/**
 * Create the global `list_resources` tool: lists the resources advertised by
 * the named connected MCP server.
 */
export function createListResourcesTool(
  mcpManager: McpClientManager,
): AgentTool<typeof ListResourcesParams> {
  return {
    name: "list_resources",
    label: "List MCP Resources",
    description:
      "List resources exposed by a connected MCP server. Pass the server name; returns each resource's uri, name, description, and mimeType.",
    parameters: ListResourcesParams,
    async execute(
      _toolCallId: string,
      params: ListResourcesParamsType,
    ): Promise<AgentToolResult<ToolDetails>> {
      const result = await listResourcesForServer(mcpManager, params.server);
      if (!result.ok) return errorResult(result.error.message);
      return okResult(result.value);
    },
  };
}

// ---------------------------------------------------------------------------
// read_resource
// ---------------------------------------------------------------------------

const ReadResourceParams = Type.Object({
  server: Type.String({ description: "MCP server name (must be a connected server advertising resources)" }),
  uri: Type.String({ description: "Resource URI to read (from list_resources output)" }),
});
type ReadResourceParamsType = Static<typeof ReadResourceParams>;

/**
 * Create the global `read_resource` tool: reads the contents of a single
 * resource (by URI) from the named connected MCP server.
 */
export function createReadResourceTool(
  mcpManager: McpClientManager,
): AgentTool<typeof ReadResourceParams> {
  return {
    name: "read_resource",
    label: "Read MCP Resource",
    description:
      "Read the contents of a single resource (by uri) from a connected MCP server. Pass the server name and the resource uri.",
    parameters: ReadResourceParams,
    async execute(
      _toolCallId: string,
      params: ReadResourceParamsType,
    ): Promise<AgentToolResult<ToolDetails>> {
      const result = await readResourceFromServer(mcpManager, params.server, params.uri);
      if (!result.ok) return errorResult(result.error.message);
      return okResult(result.value);
    },
  };
}
