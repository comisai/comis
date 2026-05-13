// SPDX-License-Identifier: Apache-2.0
/**
 * AgentTool to ToolDefinition adapter.
 *
 * Converts Comis's AgentTool instances to pi-coding-agent's ToolDefinition
 * format by wrapping the execute() signature to accept the additional
 * ExtensionContext parameter (which is ignored -- Comis manages its own context).
 *
 * The adapter preserves tool.name exactly, which is critical for tool policy
 * matching (TOOL_PROFILES and TOOL_GROUPS filter on .name).
 *
 * When resolvedDescriptions is provided (pre-resolved lean descriptions from
 * the daemon), the adapter overrides tool.description with the lean version.
 * This avoids a circular dependency (skills cannot import from agent).
 *
 * @module
 */

import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

/**
 * Convert a single AgentTool to ToolDefinition format.
 *
 * When resolvedDescriptions is provided and contains an entry for tool.name,
 * the lean description overrides tool.description. This enables the dual-summary
 * architecture: TOOL_SUMMARIES in system prompt, LEAN_TOOL_DESCRIPTIONS in API defs.
 */
 
export function agentToolToToolDefinition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
  tool: AgentTool<any>,
  resolvedDescriptions?: Record<string, string>,
): ToolDefinition {
  // Resolve base description (lean override or factory description)
  let description = resolvedDescriptions?.[tool.name] ?? tool.description;

  // Merge promptGuidelines into description
  // Guidelines are a Comis extension not on AgentTool type
  const guidelines = (tool as unknown as Record<string, unknown>).promptGuidelines as string[] | undefined;
  if (guidelines?.length) {
    description += "\n\nGuidelines:\n" + guidelines.map(g => `- ${g}`).join("\n");
  }

  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description,
    parameters: tool.parameters,
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
       
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Batch convert AgentTool[] to ToolDefinition[].
 *
 * When resolvedDescriptions is provided, each tool's description is overridden
 * with the pre-resolved lean description (if an entry exists for that tool name).
 */
 
export function agentToolsToToolDefinitions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
  tools: AgentTool<any>[],
  resolvedDescriptions?: Record<string, string>,
): ToolDefinition[] {
  return tools.map(t => agentToolToToolDefinition(t, resolvedDescriptions));
}
