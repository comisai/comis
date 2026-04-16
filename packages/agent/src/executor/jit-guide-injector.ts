/**
 * JIT Guide Injector: Appends verbose operational guidance to tool results
 * on first use within a session.
 *
 * Two guide sources:
 *
 * 1. getToolGuideWithSchema(): Per-tool operational guidance (e.g., workspace
 *    customization guide for agents_manage) combined with output schema JSON
 *    when available. Returns undefined for unguided/unschemaed tools.
 *
 * 2. SYSTEM_PROMPT_GUIDES: Deferred system prompt sections (e.g., Task
 *    Delegation, Privileged Tools). Keyed by trigger tool name or sentinel
 *    (`__privileged_tools__` for any of the 10 privileged tools).
 *
 * A single tool call can trigger BOTH a tool guide AND a section guide.
 * Both use separate deliveredGuides keys so they are tracked independently.
 *
 * Session lifecycle:
 * - deliveredGuides Set tracks which guides have been delivered
 * - Cleared on session reset (isFirstMessageInSession) by pi-executor
 * - Tool is marked as delivered even on error results
 * - Guide block is only appended on non-error results
 *
 * @module
 */

import { getToolGuideWithSchema, SYSTEM_PROMPT_GUIDES } from "../bootstrap/sections/tool-descriptions.js";
import { PRIVILEGED_TOOL_NAMES } from "../bootstrap/sections/tooling-sections.js";
import type { ComisLogger } from "@comis/infra";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

/** Set of privileged tool names for O(1) lookup. */
const PRIVILEGED_TOOL_SET = new Set(PRIVILEGED_TOOL_NAMES);

/** Sentinel key for the privileged tools section guide (delivered once for first privileged tool). */
const PRIVILEGED_SECTION_KEY = "section:privileged";

// ---------------------------------------------------------------------------
// wrapToolResultWithGuide: Core injection logic
// ---------------------------------------------------------------------------

/**
 * Append one-time operational guides to a tool's result content.
 *
 * Checks both TOOL_GUIDES (per-tool) and SYSTEM_PROMPT_GUIDES (deferred
 * system prompt sections). A tool can trigger both; they are combined into
 * a single appended guide block.
 *
 * - If no guide exists for the tool, returns result unchanged.
 * - If guide was already delivered in this session, returns result unchanged.
 * - Always marks the tool as delivered (even on error).
 * - Skips injection when result has isError: true (but still marks delivered).
 * - Logs at INFO level when guide is injected.
 *
 * Note: AgentToolResult does not formally include isError (it is set by
 * the agent-loop on the message level), but some tools (MCP, discovery)
 * include it at runtime. We check for it defensively.
 */
export function wrapToolResultWithGuide(
  toolName: string,
  result: AgentToolResult<unknown>,
  deliveredGuides: Set<string>,
  logger: ComisLogger,
): AgentToolResult<unknown> {
  // Collect guide texts and their type keys for observability
  const guideTexts: string[] = [];
  const guideTypes: string[] = [];

  // 1. TOOL_GUIDES: per-tool operational guide
  const toolGuide = getToolGuideWithSchema(toolName);
  if (toolGuide && !deliveredGuides.has(toolName)) {
    deliveredGuides.add(toolName);
    guideTexts.push(toolGuide);
    guideTypes.push(`tool:${toolName}`);
  }

  // 2. SYSTEM_PROMPT_GUIDES: deferred section by tool name
  const sectionGuide = SYSTEM_PROMPT_GUIDES[toolName];
  const sectionKey = `section:${toolName}`;
  if (sectionGuide && !deliveredGuides.has(sectionKey)) {
    deliveredGuides.add(sectionKey);
    guideTexts.push(sectionGuide);
    guideTypes.push(sectionKey);
  }

  // 3. SYSTEM_PROMPT_GUIDES: privileged tools sentinel
  if (PRIVILEGED_TOOL_SET.has(toolName) && !deliveredGuides.has(PRIVILEGED_SECTION_KEY)) {
    const privilegedGuide = SYSTEM_PROMPT_GUIDES["__privileged_tools__"];
    if (privilegedGuide) {
      deliveredGuides.add(PRIVILEGED_SECTION_KEY);
      guideTexts.push(privilegedGuide);
      guideTypes.push(PRIVILEGED_SECTION_KEY);
    }
  }

  // Nothing to inject
  if (guideTexts.length === 0) return result;

  // Skip injection on error results (still marked delivered above).
  // isError is a runtime extension -- not in AgentToolResult type.
  if ((result as unknown as Record<string, unknown>).isError) return result;

  // Log guide injection with guide type classification
  const combinedSize = guideTexts.reduce((sum, t) => sum + t.length, 0);
  logger.info(
    { toolName, guideSize: combinedSize, guideCount: guideTexts.length, guideTypes },
    "JIT guide injected",
  );

  const guideBlock = {
    type: "text" as const,
    text: `\n---\n[Tool Guide - shown once per session]\n${guideTexts.join("\n\n")}\n---`,
  };

  return {
    ...result,
    content: [...result.content, guideBlock],
  };
}

// ---------------------------------------------------------------------------
// createJitGuideWrapper: Factory for wrapping ToolDefinition[]
// ---------------------------------------------------------------------------

/**
 * Wrap each tool's execute() method to inject JIT guides on first use.
 *
 * Returns a new array of ToolDefinitions with wrapped execute functions.
 * Non-guided tools pass through with no overhead beyond the name check.
 *
 * Follows the same execute() signature pattern as agentToolToToolDefinition
 * in tool-definition-adapter.ts.
 */
export function createJitGuideWrapper(
  tools: ToolDefinition[],
  deliveredGuides: Set<string>,
  logger: ComisLogger,
): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, _ctx);
      return wrapToolResultWithGuide(tool.name, result, deliveredGuides, logger);
    },
  }));
}
