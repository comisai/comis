// SPDX-License-Identifier: Apache-2.0
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

// fingerprint is the shared 12-hex sha256 digest util. It is imported from
// @comis/core (its canonical home) — NOT from @comis/infra:
// @comis/agent is architecturally FORBIDDEN from depending on @comis/infra
// (enforced by packages/agent/src/__tests__/architecture.test.ts). agent
// already depends on @comis/core, so this adds no package edge.
import { fingerprint } from "@comis/core";

// ---------------------------------------------------------------------------
// MCP attribution helpers
// Re-exported from @comis/shared (canonical home).
// ---------------------------------------------------------------------------

export { extractMcpServerName } from "@comis/shared";

/**
 * Cap for {@link extractErrorText} output. A tool result can be a 53 KB body
 * (possibly secret/PII-bearing); bounding it here keeps both the tool-retry
 * breaker's `lastError` and the WARN log from ingesting an unbounded body
 * (an information-disclosure and context-bloat DoS threat).
 */
const MAX_ERROR_TEXT_CHARS = 2000;

/**
 * Classify an MCP error message into a category for observability.
 */
export type McpErrorType = "timeout" | "connection" | "transport" | "validation" | "tool_error" | "unknown";

const MCP_VALIDATION_ERROR =
  /\bvalidation failed\b|\binput validation error\b|\bmcp error\s*-32602\b|\binvalid params?\b|\bmust have required propert(?:y|ies)\b|(?:^|[\s"'=:])too_big(?:$|[\s"',}:])/i;

/** Whether an MCP failure is a caller-correctable schema/argument rejection. */
export function isMcpValidationError(errorText: string | undefined): boolean {
  return errorText !== undefined && MCP_VALIDATION_ERROR.test(errorText);
}

export function classifyMcpErrorType(errorText: string | undefined): McpErrorType {
  if (!errorText) return "unknown";
  const lower = errorText.toLowerCase();
  if (isMcpValidationError(errorText)) return "validation";
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
 *
 * The output is BOUNDED at {@link MAX_ERROR_TEXT_CHARS}: an oversized value is
 * truncated and suffixed with `…[+N chars, digest:<12hex>]`, where the digest
 * is `fingerprint(rawFullText)`. Both the breaker (`recordResult` lastError)
 * and the WARN log then receive the bounded form automatically — the raw body
 * never crosses into logs/events.
 */
export function extractErrorText(result: unknown): string {
  return boundErrorText(coerceErrorText(result));
}

/** Coerce a tool result to its raw (UNBOUNDED) error text. */
function coerceErrorText(result: unknown): string {
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

/** Cap raw error text at the char limit, appending a non-reversible digest. */
function boundErrorText(raw: string): string {
  if (raw.length <= MAX_ERROR_TEXT_CHARS) return raw;
  return `${raw.slice(0, MAX_ERROR_TEXT_CHARS)}…[+${raw.length - MAX_ERROR_TEXT_CHARS} chars, digest:${fingerprint(raw)}]`;
}
