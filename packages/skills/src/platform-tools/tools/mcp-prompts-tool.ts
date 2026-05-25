// SPDX-License-Identifier: Apache-2.0
/**
 * GLOBAL prompts utility platform tools.
 *
 * Two tools — `list_prompts` and `get_prompt` — each take a required
 * `server: string` parameter naming the connected MCP server to query (and
 * `get_prompt` additionally takes a `name` plus an optional `arguments`
 * record). The tools are GLOBAL (not per-server) for the same 40-tool-ceiling
 * reason as the resources tools (see mcp-resources-tool.ts).
 *
 * Each tool delegates to the matching adapter in mcp-client-resources.ts;
 * adapter errors surface as an error-shaped `AgentToolResult`
 * (`details.success:false`), never a throw. Returned content is
 * `JSON.stringify`'d server data.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { McpClientManager } from "../../skills/integrations/mcp-client/mcp-client-types.js";
import {
  listPromptsForServer,
  getPromptFromServer,
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
// list_prompts
// ---------------------------------------------------------------------------

const ListPromptsParams = Type.Object({
  server: Type.String({ description: "MCP server name (must be a connected server advertising prompts)" }),
});
type ListPromptsParamsType = Static<typeof ListPromptsParams>;

/**
 * Create the global `list_prompts` tool: lists the prompts advertised by the
 * named connected MCP server.
 */
export function createListPromptsTool(
  mcpManager: McpClientManager,
): AgentTool<typeof ListPromptsParams> {
  return {
    name: "list_prompts",
    label: "List MCP Prompts",
    description:
      "List prompt templates exposed by a connected MCP server. Pass the server name; returns each prompt's name, description, and arguments.",
    parameters: ListPromptsParams,
    async execute(
      _toolCallId: string,
      params: ListPromptsParamsType,
    ): Promise<AgentToolResult<ToolDetails>> {
      const result = await listPromptsForServer(mcpManager, params.server);
      if (!result.ok) return errorResult(result.error.message);
      return okResult(result.value);
    },
  };
}

// ---------------------------------------------------------------------------
// get_prompt
// ---------------------------------------------------------------------------

const GetPromptParams = Type.Object({
  server: Type.String({ description: "MCP server name (must be a connected server advertising prompts)" }),
  name: Type.String({ description: "Prompt name to fetch (from list_prompts output)" }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional template arguments for the prompt, keyed by argument name",
    }),
  ),
});
type GetPromptParamsType = Static<typeof GetPromptParams>;

/**
 * Create the global `get_prompt` tool: fetches a single prompt (by name, with
 * optional template arguments) from the named connected MCP server.
 */
export function createGetPromptTool(
  mcpManager: McpClientManager,
): AgentTool<typeof GetPromptParams> {
  return {
    name: "get_prompt",
    label: "Get MCP Prompt",
    description:
      "Fetch a single prompt template (by name) from a connected MCP server, optionally supplying template arguments.",
    parameters: GetPromptParams,
    async execute(
      _toolCallId: string,
      params: GetPromptParamsType,
    ): Promise<AgentToolResult<ToolDetails>> {
      const result = await getPromptFromServer(
        mcpManager,
        params.server,
        params.name,
        params.arguments,
      );
      if (!result.ok) return errorResult(result.error.message);
      return okResult(result.value);
    },
  };
}
