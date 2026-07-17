// SPDX-License-Identifier: Apache-2.0
// @allow-throw: MCP AgentTool boundary; pi-agent-core catches execution errors and records toolResult.isError.
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

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { registerToolMetadata, wrapExternalContent, tryGetContext, type WrapExternalContentOptions } from "@comis/core";
import { extractMcpServerName } from "@comis/shared";
export { extractMcpServerName };
import { resolveSourceProfile, type ToolSourceProfile } from "../../tools/builtin/tool-source-profiles.js";
import type { McpToolDefinition, McpClientManager, McpToolCallResult } from "../integrations/mcp-client/index.js";
import { sanitizeMcpToolResult } from "../../tools/integrations/mcp-result-sanitizer.js";
import { truncateJsonAware } from "./json-truncate.js";

// ---------------------------------------------------------------------------
// Diagnostic logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for MCP bridge diagnostic logging. */
interface McpBridgeLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// MCP error classification
// ---------------------------------------------------------------------------

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
 * which dispatches to the correct MCP server connection. Failures throw at
 * the AgentTool boundary so pi-agent-core records `toolResult.isError=true`
 * and the tool lifecycle reports a failed execution.
 *
 * Successful results are capped to the resolved source profile's maxChars
 * limit, preventing oversized MCP responses from consuming agent context.
 *
 * @param tools - MCP tool definitions from McpClientManager.getTools()
 * @param callTool - McpClientManager.callTool bound function
 * @param toolSourceProfiles - Optional per-tool overrides for source profiles
 * @param logger - Optional diagnostic logger for tracing tool result content shape
 * @param onSuspiciousContent - Optional callback fired when wrapped MCP content trips the suspicious-content heuristic
 * @param onResultTruncated - Optional callback fired ONCE per tool call whose
 *   result exceeded its source-profile `maxChars` and was truncated. Decoupled
 *   from the event bus (mirrors `onSuspiciousContent`): the daemon closure does
 *   the `eventBus.emit("mcp:server:result_truncated", …)`. Carries only sizes +
 *   identifiers (server, tool, originalSize, truncatedSize, traceId) — never
 *   the truncated content.
 * @param serverFiltersFn - Per-server filter lookup, called once per input tool
 *   with the server name parsed from its qualified name. Returns `undefined` or
 *   an empty filter ⇒ tool passes through. A non-empty `allowlist` restricts
 *   the server to ONLY the listed tool names; a `blocklist` rejects the listed
 *   names. When both are present the blocklist wins (a name on both lists is
 *   filtered out). Filtering runs BEFORE the `.map()` below, so excluded tools
 *   never receive an AgentTool wrapper and never enter the agent's tool registry
 *   — the agent simply does not see them.
 * @returns AgentTool instances ready for the agent executor
 */
export function mcpToolsToAgentTools(
  tools: McpToolDefinition[],
  callTool: McpClientManager["callTool"],
  toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>,
  logger?: McpBridgeLogger,
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"],
  serverFiltersFn?: (serverName: string) =>
    | { readonly allowlist?: readonly string[]; readonly blocklist?: readonly string[] }
    | undefined,
  // Fired once per truncating tool call (decoupled emit callback).
  onResultTruncated?: (e: {
    server: string;
    tool: string;
    originalSize: number;
    truncatedSize: number;
    traceId: string;
  }) => void,
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

  // Apply the per-server allowlist/blocklist BEFORE the .map() so filtered
  // tools never receive an AgentTool wrapper, never register tool metadata,
  // and never reach the agent. Uses the LOCAL extractServerName helper
  // (matches /^mcp:([^/]+)\//), not the @comis/shared re-export above.
  const filtered = serverFiltersFn
    ? tools.filter((tool) => {
        const serverName = extractServerName(tool.qualifiedName);
        const filters = serverFiltersFn(serverName);
        if (!filters) return true;
        // Allowlist applies only when present AND non-empty — an empty
        // allowlist is a no-op, not a deny-all.
        if (filters.allowlist && filters.allowlist.length > 0) {
          if (!filters.allowlist.includes(tool.name)) return false;
        }
        // Blocklist always applies (even when the allowlist also lists the
        // name) — blocklist wins.
        if (filters.blocklist && filters.blocklist.includes(tool.name)) {
          return false;
        }
        return true;
      })
    : tools;

  return filtered.map((tool) => {
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
        params: unknown,
      ): Promise<AgentToolResult<{ success: boolean }>> {
        let result: Awaited<ReturnType<McpClientManager["callTool"]>>;
        try {
          result = await callTool(tool.qualifiedName, params as Record<string, unknown>);
        } catch (error: unknown) {
          // Defense-in-depth: callTool returns Result and should never throw.
          // Throwing here is deliberate: pi-agent-core is the immediate boundary
          // that converts this exception into an isError=true tool result.
          const message = error instanceof Error ? error.message : String(error);
          const crashText = `MCP tool "${tool.qualifiedName}" crashed unexpectedly: ${message}`;
          const crashResult = {
            content: [{ type: "text" as const, text: crashText }],
            details: { success: false },
          };
          logResult(crashResult, _toolCallId, sanitizedName, true);
          throw new Error(crashText, { cause: error });
        }

        if (!result.ok) {
          const errorText = `MCP tool error: ${result.error.message}`;
          const errorResult = {
            content: [{ type: "text" as const, text: errorText }],
            details: { success: false },
          };
          logResult(errorResult, _toolCallId, sanitizedName, true);
          throw new Error(errorText);
        }

        const value: McpToolCallResult = result.value;

        const capText = (text: string): string => {
          const profile = resolveSourceProfile(sanitizedName, toolSourceProfiles?.[sanitizedName]);
          if (text.length <= profile.maxChars) return text;
          const originalSize = text.length;
          const { truncated, wasTruncated } = truncateJsonAware(text, profile.maxChars);
          if (wasTruncated) {
            onResultTruncated?.({
              server: serverName,
              tool: tool.name,
              originalSize,
              truncatedSize: truncated.length,
              traceId: tryGetContext()?.traceId ?? "",
            });
          }
          return truncated;
        };

        if (value.isError) {
          const rawErrorText = value.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n");
          const sanitizedErrorText = capText(sanitizeMcpToolResult(rawErrorText));
          const errorText = sanitizedErrorText
            ? wrapExternalContent(sanitizedErrorText, {
                source: "mcp_tool",
                onSuspiciousContent,
              })
            : "MCP tool returned an error with no details";
          const isErrorResult = {
            content: [{ type: "text" as const, text: errorText }],
            details: { success: false },
          };
          logResult(isErrorResult, _toolCallId, sanitizedName, true);
          throw new Error(errorText);
        }

        // Collect text content from the MCP result
        let textParts = value.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        // Sanitize MCP result (NFKC normalization + invisible char removal)
        textParts = sanitizeMcpToolResult(textParts);

        // Source-gate: cap text to resolved profile's maxChars limit.
        textParts = capText(textParts);

        // Wrap AFTER cap so SECURITY NOTICE boilerplate is preserved
        // (wrap-then-cap would truncate the closing <<<END_UNTRUSTED_xxx>>>
        // marker mid-content). Fixed ~150-byte wrapper boilerplate sits beyond
        // the per-source maxChars budget — the cap governs content size, not
        // wrapper overhead. The `if (textParts)` guard preserves the empty-
        // content fallback "Tool returned no text content" path below.
        if (textParts) {
          textParts = wrapExternalContent(textParts, {
            source: "mcp_tool",
            onSuspiciousContent,
          });
        }

        const successResult = {
          content: [{ type: "text" as const, text: textParts || "Tool returned no text content" }],
          details: { success: true },
        };
        logResult(successResult, _toolCallId, sanitizedName, false);
        return successResult;
      },
    };
  });
}

/**
 * Extract the per-server filter lists from a persisted MCP server entry into
 * the shape `serverFiltersFn` expects.
 *
 * This helper lives in the bridge on purpose: it is the single place that
 * names the literal `toolAllowlist` / `toolBlocklist` fields, so callers
 * (e.g. the daemon's setup-tools serverFiltersFn closure) can read the
 * persisted filters WITHOUT spelling out those identifiers. An
 * architecture-grep (`mcp-tool-filtering-bridge-only.test.ts`) confines the
 * literals to this file + the schema + the schema snapshot.
 *
 * Returns `undefined` when the entry carries neither list, so the bridge's
 * filter short-circuits (tool passes through) for unfiltered servers.
 *
 * @param entry - a persisted MCP server entry (McpServerEntry-shaped)
 * @returns `{ allowlist?, blocklist? }` or `undefined` when both are absent
 */
export function extractServerToolFilters(
  entry: { toolAllowlist?: readonly string[]; toolBlocklist?: readonly string[] },
): { readonly allowlist?: readonly string[]; readonly blocklist?: readonly string[] } | undefined {
  const out: { allowlist?: readonly string[]; blocklist?: readonly string[] } = {};
  if (entry.toolAllowlist !== undefined) out.allowlist = entry.toolAllowlist;
  if (entry.toolBlocklist !== undefined) out.blocklist = entry.toolBlocklist;
  return out.allowlist === undefined && out.blocklist === undefined ? undefined : out;
}
