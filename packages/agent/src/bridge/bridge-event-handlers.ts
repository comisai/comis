/**
 * Bridge event handler helpers module.
 *
 * Contains utility functions used by PiEventBridge for event processing:
 * - MCP server name extraction and error classification
 * - Tool argument sanitization for observability
 * - Error text extraction from tool results
 *
 * Extracted from pi-event-bridge.ts to isolate event processing helpers.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// MCP attribution helpers
// Defined inline to avoid cross-package import from @comis/skills.
// ---------------------------------------------------------------------------

/**
 * Extract the MCP server name from a sanitized tool name.
 * Format: `mcp__serverName--toolName`. Returns undefined for non-MCP tools.
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice(5);
  const sepIdx = rest.indexOf("--");
  if (sepIdx <= 0) return undefined;
  return rest.slice(0, sepIdx);
}

/**
 * Classify an MCP error message into a category for observability.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate tool arg values >200 chars to a char-count placeholder.
 * Returns a new object -- never mutates input.
 */
export function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      out[key] = value.length > 200 ? `[${value.length} chars]` : value;
    } else {
      try {
        const serialized = JSON.stringify(value);
        out[key] = serialized.length > 200 ? `[${serialized.length} chars]` : value;
      } catch {
        out[key] = "[unserializable]";
      }
    }
  }
  return out;
}

/**
 * Extract human-readable error text from a tool failure result.
 */
export function extractErrorText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result instanceof Error) return result.message;
  if (result != null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "[unserializable]";
  }
}
