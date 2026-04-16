/**
 * MCP Tool Bridge: Converts MCP tool definitions to AgentTool instances.
 *
 * Follows the pattern established by skill-tool-bridge.ts for converting
 * external tool definitions into the AgentTool format expected by the
 * agent executor (pi-agent-core).
 *
 * Key functions:
 * - mcpToolsToAgentTools: Batch convert MCP tools to AgentTool[]
 * - jsonSchemaToTypeBox: Basic JSON Schema -> TypeBox conversion
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "@sinclair/typebox";
import { registerToolMetadata } from "@comis/core";
import { resolveSourceProfile, type ToolSourceProfile } from "../builtin/tool-source-profiles.js";
import type { McpToolDefinition, McpClientManager, McpToolCallResult } from "../integrations/mcp-client.js";
import { sanitizeMcpToolResult } from "../integrations/mcp-result-sanitizer.js";
import { truncateJsonAware } from "./json-truncate.js";

// ---------------------------------------------------------------------------
// Diagnostic logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for MCP bridge diagnostic logging. */
interface McpBridgeLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// MCP tool name parsing and error classification
// ---------------------------------------------------------------------------

/**
 * Extract the MCP server name from a sanitized tool name.
 *
 * Sanitized MCP tool names use the format `mcp__serverName--toolName`.
 * Returns `undefined` for non-MCP tools or malformed names.
 *
 * @example
 * extractMcpServerName("mcp__context7--resolve-library-id") // "context7"
 * extractMcpServerName("mcp__srv__v2--ns--tool") // "srv__v2"
 * extractMcpServerName("bash") // undefined
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice(5); // strip "mcp__"
  const sepIdx = rest.indexOf("--");
  if (sepIdx <= 0) return undefined; // no separator or empty server name
  return rest.slice(0, sepIdx);
}

/**
 * Classify an MCP error message into a category for observability.
 *
 * Returns one of: "timeout", "connection", "tool_error", "transport", "unknown".
 */
export function classifyMcpErrorType(errorText: string | undefined): string {
  if (!errorText) return "unknown";
  const lower = errorText.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (lower.includes("not connected") || lower.includes("disconnected")) return "connection";
  if (lower.includes("crashed unexpectedly") || lower.includes("pipe") || lower.includes("epipe") || lower.includes("econnreset")) return "transport";
  if (lower.includes("mcp tool error:") || lower.includes("mcp tool returned an error")) return "tool_error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// JSON Schema -> TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Convert a basic JSON Schema definition to a TypeBox TSchema.
 *
 * Handles primitive types, arrays, and objects. Complex schema features
 * (oneOf, allOf, $ref, etc.) fall back to Type.Any().
 *
 * This is intentionally simple -- MCP tool schemas are typically flat
 * objects with primitive properties. Complex schemas still work but
 * lose TypeBox-level validation detail.
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  const type = schema.type;

  if (type === "string") {
    return Type.String();
  }

  if (type === "number") {
    return Type.Number();
  }

  if (type === "integer") {
    return Type.Integer();
  }

  if (type === "boolean") {
    return Type.Boolean();
  }

  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      return Type.Array(jsonSchemaToTypeBox(items));
    }
    return Type.Array(Type.Any());
  }

  if (type === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required as string[]) ?? [];

    if (!properties) {
      return Type.Object({});
    }

    const typeboxProps: Record<string, TSchema> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const converted = jsonSchemaToTypeBox(propSchema);
      typeboxProps[key] = required.includes(key) ? converted : Type.Optional(converted);
    }

    return Type.Object(typeboxProps);
  }

  // Fallback for unknown or complex schema types
  return Type.Any();
}

// ---------------------------------------------------------------------------
// Description truncation
// ---------------------------------------------------------------------------

/** Maximum characters for LLM-facing MCP tool descriptions. */
export const MAX_LLM_DESCRIPTION_CHARS = 2048;

const TRUNCATED_SUFFIX = " [truncated]";

/**
 * Truncate a tool description for LLM consumption. Returns the original
 * string when it fits within the budget, or a truncated version with
 * "[truncated]" suffix. Returns undefined for undefined input.
 */
function truncateDescription(desc: string | undefined): string | undefined {
  if (!desc || desc.length <= MAX_LLM_DESCRIPTION_CHARS) return desc;
  return desc.slice(0, MAX_LLM_DESCRIPTION_CHARS - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

// ---------------------------------------------------------------------------
// MCP tool -> AgentTool conversion
// ---------------------------------------------------------------------------

/**
 * Extract the server name from a qualified tool name "mcp:{server}/{tool}".
 * Returns the full name as fallback.
 */
function extractServerName(qualifiedName: string): string {
  const match = qualifiedName.match(/^mcp:([^/]+)\//);
  return match ? match[1] : qualifiedName;
}

/**
 * Sanitize a qualified MCP tool name for use as an LLM API tool name.
 *
 * LLM APIs (Anthropic, OpenAI) require tool names to match `^[a-zA-Z0-9_-]{1,128}$`.
 * Qualified names like "mcp:context7/resolve-library-id" contain invalid characters
 * (`:`, `/`). This function replaces them: "mcp:" -> "mcp__", "/" -> "--".
 *
 * Example: "mcp:context7/resolve-library-id" -> "mcp__context7--resolve-library-id"
 */
export function sanitizeMcpToolName(qualifiedName: string): string {
  return qualifiedName.replace(/:/g, "__").replace(/\//g, "--");
}

/**
 * Convert an array of MCP tool definitions to AgentTool instances.
 *
 * Each AgentTool's execute() delegates to the provided callTool function,
 * which dispatches to the correct MCP server connection. Error results
 * from the MCP server are returned as text content (not thrown), matching
 * the AgentTool contract.
 *
 * Successful results are capped to the resolved source profile's maxChars
 * limit, preventing oversized MCP responses from consuming agent context.
 *
 * @param tools - MCP tool definitions from McpClientManager.getTools()
 * @param callTool - McpClientManager.callTool bound function
 * @param toolSourceProfiles - Optional per-tool overrides for source profiles
 * @param logger - Optional diagnostic logger for tracing tool result content shape
 * @returns AgentTool instances ready for the agent executor
 */
export function mcpToolsToAgentTools(
  tools: McpToolDefinition[],
  callTool: McpClientManager["callTool"],
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>,
  logger?: McpBridgeLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any>[] {
  /** Log the content shape of an execute() return value for content-loss diagnosis. */
  function logResult(
    result: AgentToolResult<{ success: boolean }>,
    toolCallId: string,
    toolName: string,
    isError: boolean,
  ): void {
    if (!logger) return;
    const firstBlock = result.content?.[0];
    logger.debug(
      {
        toolName,
        toolCallId,
        contentLength: result.content?.length ?? 0,
        hasDetails: !!result.details,
        firstBlockType: firstBlock?.type,
        firstBlockTextLen: firstBlock?.type === "text" ? (firstBlock as { text: string }).text.length : undefined,
        isError,
      },
      "MCP bridge execute() result shape",
    );
  }

  return tools.map((tool) => {
    const typeboxSchema = jsonSchemaToTypeBox(tool.inputSchema);
    const serverName = extractServerName(tool.qualifiedName);
    const sanitizedName = sanitizeMcpToolName(tool.qualifiedName);

    // Register full description as searchHint for BM25 scoring in discover_tools
    registerToolMetadata(sanitizedName, { searchHint: tool.description ?? "" });

    return {
      name: sanitizedName,
      label: tool.name,
      // Truncate description for LLM token budget; full text preserved in searchHint above
      description: truncateDescription(tool.description) ?? `MCP tool from ${serverName}`,
      parameters: typeboxSchema,

      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<{ success: boolean }>> {
        try {
          const result = await callTool(tool.qualifiedName, params);

          if (!result.ok) {
            const errorResult = {
              content: [{ type: "text" as const, text: `MCP tool error: ${result.error.message}` }],
              details: { success: false },
            };
            logResult(errorResult, _toolCallId, sanitizedName, true);
            return errorResult;
          }

          const value: McpToolCallResult = result.value;

          if (value.isError) {
            const errorText = value.content
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n");
            const isErrorResult = {
              content: [
                {
                  type: "text" as const,
                  text: errorText || "MCP tool returned an error with no details",
                },
              ],
              details: { success: false },
            };
            logResult(isErrorResult, _toolCallId, sanitizedName, true);
            return isErrorResult;
          }

          // Collect text content from the MCP result
          let textParts = value.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n");

          // Sanitize MCP result (NFKC normalization + invisible char removal)
          textParts = sanitizeMcpToolResult(textParts);

          // Source-gate: cap text to resolved profile's maxChars limit
          const profile = resolveSourceProfile(sanitizedName, toolSourceProfiles?.[sanitizedName]);
          if (textParts.length > profile.maxChars) {
            const { truncated } = truncateJsonAware(textParts, profile.maxChars);
            textParts = truncated;
          }

          const successResult = {
            content: [{ type: "text" as const, text: textParts || "Tool returned no text content" }],
            details: { success: true },
          };
          logResult(successResult, _toolCallId, sanitizedName, false);
          return successResult;
        } catch (error: unknown) {
          // Defense-in-depth: callTool returns Result and should never throw,
          // but if something unexpected happens, return a clean error to the agent
          // instead of letting it propagate and produce an opaque SDK error message.
          const message = error instanceof Error ? error.message : String(error);
          const crashResult = {
            content: [{ type: "text" as const, text: `MCP tool "${tool.qualifiedName}" crashed unexpectedly: ${message}` }],
            details: { success: false },
          };
          logResult(crashResult, _toolCallId, sanitizedName, true);
          return crashResult;
        }
      },
    };
  });
}
