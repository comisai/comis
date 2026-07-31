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
import {
  fingerprint,
  redactValue,
  unwrapExternalContent,
} from "@comis/core";
import { tryCatch } from "@comis/shared";
import { formatValidationError } from "../safety/validation-error-formatter.js";

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

export type RuntimeToolGuard =
  | "step_limit"
  | "background_task_capacity"
  | "spawn_ceiling";

const STEP_LIMIT_TOOL_GUARD = /\bstep limit reached\b.*\bblocking tool execution\b/i;
const BACKGROUND_TASK_CAPACITY_GUARD = /\[background_capacity\]\s+background task capacity reached:/i;
const SPAWN_CEILING_GUARD = /\[spawn_ceiling\]\s+sub-agent spawn rejected:/i;

/** Identify failures produced by the local execution guard before the tool boundary. */
export function classifyRuntimeToolGuard(errorText: string | undefined): RuntimeToolGuard | undefined {
  if (errorText === undefined) return undefined;
  if (STEP_LIMIT_TOOL_GUARD.test(errorText)) return "step_limit";
  if (BACKGROUND_TASK_CAPACITY_GUARD.test(errorText)) return "background_task_capacity";
  if (SPAWN_CEILING_GUARD.test(errorText)) return "spawn_ceiling";
  return undefined;
}

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

const SAFE_MCP_FAILURE_CODES = new Set([
  "credential_invalid",
  "credential_missing",
  "permission_denied",
  "rate_limited",
]);

/**
 * Extract a generic machine failure code from a structurally wrapped MCP
 * result. Only known content-free codes are admitted; arbitrary external text
 * and provider values never enter logs or trajectories through this path.
 */
export function extractMcpFailureCode(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;

  for (const part of content) {
    if (
      part === null
      || typeof part !== "object"
      || (part as Record<string, unknown>).type !== "text"
    ) {
      continue;
    }
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    const external = unwrapExternalContent(text);
    if (external === null || external.source !== "mcp_tool") continue;
    const parsed = tryCatch(() => JSON.parse(external.content) as unknown);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
      continue;
    }
    const code = (parsed.value as Record<string, unknown>).code;
    if (typeof code === "string" && SAFE_MCP_FAILURE_CODES.has(code)) {
      return code;
    }
  }
  return undefined;
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

const DIAGNOSTIC_AUTHORITY_ID_KEYS = new Set([
  "tenant_id",
  "tenantId",
  "agent_id",
  "agentId",
]);
const NUMERIC_AUTHORITY_ID = /^\d{1,32}$/;

/**
 * Build the trajectory-only failed-call argument preview.
 *
 * Numeric tenant and agent identifiers can resemble phone numbers. Preserve
 * them only when phone-shape detection was the sole redaction reason for that
 * exact authority field; every secret, path, and other PII decision remains
 * untouched. User-visible tool params continue to use the ordinary fully
 * redacted value.
 */
export function buildFailureArgsPreview(
  args: unknown,
  homeDir?: string,
): Record<string, unknown> | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const rawArgs = args as Record<string, unknown>;
  const redacted = redactValue(rawArgs, { homeDir });
  if (
    redacted.value === null
    || typeof redacted.value !== "object"
    || Array.isArray(redacted.value)
  ) {
    return undefined;
  }

  const preview = { ...(redacted.value as Record<string, unknown>) };
  for (const key of DIAGNOSTIC_AUTHORITY_ID_KEYS) {
    const rawValue = rawArgs[key];
    if (typeof rawValue !== "string" || !NUMERIC_AUTHORITY_ID.test(rawValue)) {
      continue;
    }
    const reasons = redacted.redactionsApplied
      .filter((record) => record.key === key)
      .map((record) => record.reason);
    if (
      reasons.length > 0
      && reasons.every((reason) => reason === "pii_phone")
    ) {
      preview[key] = rawValue;
    }
  }
  return sanitizeToolArgs(preview);
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
  const nestedValidation = extractFormattedValidation(result);
  if (nestedValidation !== null) return nestedValidation;
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

/**
 * Find and format an SDK validation error before its full rejected-argument
 * dump is serialized into logs or trajectories. Tool results wrap the text in
 * `content[]`, while direct boundary errors can arrive as strings or
 * `message`/`error` fields.
 */
function extractFormattedValidation(result: unknown): string | null {
  if (typeof result === "string") return formatValidationError(result);
  if (result instanceof Error) return formatValidationError(result.message);
  if (result === null || typeof result !== "object") return null;

  const obj = result as Record<string, unknown>;
  for (const field of [obj.message, obj.error]) {
    if (typeof field !== "string") continue;
    const formatted = formatValidationError(field);
    if (formatted !== null) return formatted;
  }
  if (!Array.isArray(obj.content)) return null;
  for (const part of obj.content) {
    if (part === null || typeof part !== "object") continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    const formatted = formatValidationError(text);
    if (formatted !== null) return formatted;
  }
  return null;
}

/** Cap raw error text at the char limit, appending a non-reversible digest. */
function boundErrorText(raw: string): string {
  if (raw.length <= MAX_ERROR_TEXT_CHARS) return raw;
  return `${raw.slice(0, MAX_ERROR_TEXT_CHARS)}…[+${raw.length - MAX_ERROR_TEXT_CHARS} chars, digest:${fingerprint(raw)}]`;
}
