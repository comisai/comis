// SPDX-License-Identifier: Apache-2.0
/**
 * Tool output utility functions for consistent tool result formatting.
 *
 * These helpers standardize how tools produce results, errors, and read
 * parameters, ensuring a uniform interface across all builtin and platform tools.
 *
 * @module
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { UserTrustLevel } from "@comis/core";
import { classifyAction, safePath, tryGetContext } from "@comis/core";

// ---------------------------------------------------------------------------
// Structured error infrastructure
// ---------------------------------------------------------------------------

/**
 * Error code taxonomy for tool errors.
 * Covers all categories of tool-level failures that the LLM needs to
 * understand and potentially retry.
 */
export type ToolErrorCode =
  | "invalid_action"
  | "invalid_value"
  | "missing_param"
  | "permission_denied"
  | "not_found"
  | "conflict";

/**
 * Options for throwToolError formatting.
 * @internal
 */
interface ThrowToolErrorOptions {
  validValues?: string[];
  param?: string;
  hint?: string;
}

/**
 * Throw a structured tool error that the SDK catches and marks as isError:true.
 *
 * Produces plain-text format (NOT JSON) per user decision -- small models
 * (Haiku, Gemini Flash) parse plain text more reliably.
 *
 * Format: `[code] Message. Valid values: x, y, z. Hint: recovery text.`
 *
 * The thrown Error is caught by the SDK's executePreparedToolCall at
 * agent-loop.js:318-339, which sets `isError: true` on the tool result.
 *
 * @param code - The error category
 * @param message - Human-readable error description
 * @param options - Optional valid values, param name, and recovery hint
 * @throws Error with formatted message -- always (return type is `never`)
 */
export function throwToolError(
  code: ToolErrorCode,
  message: string,
  options?: ThrowToolErrorOptions,
): never {
  const parts: string[] = [`[${code}]`, message];
  if (options?.validValues && options.validValues.length > 0) {
    parts.push(`Valid values: ${options.validValues.join(", ")}.`);
  }
  if (options?.hint) {
    parts.push(`Hint: ${options.hint}.`);
  }
  throw new Error(parts.join(" "));
}

/**
 * Read and validate a string parameter against a fixed set of allowed values.
 *
 * Replaces the common pattern of `readStringParam()` + manual switch/default.
 * Returns the validated value typed as the union of allowed values.
 *
 * @param params - The parameters record
 * @param key - The parameter key to read
 * @param validValues - The allowed values (use `as const` for type inference)
 * @returns The validated value cast as T
 * @throws Error via throwToolError if value is not in validValues
 */
export function readEnumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  validValues: readonly T[],
): T {
  const value = readStringParam(params, key);
  if (!validValues.includes(value as T)) {
    throwToolError("invalid_value", `Invalid ${key}: "${value}".`, {
      validValues: [...validValues],
      param: key,
      hint: `Use one of the listed values for ${key}.`,
    });
  }
  return value as T;
}

/**
 * Create a successful JSON result with pretty-printed content.
 *
 * @param data - The result data to serialize
 * @returns AgentToolResult with JSON text content and typed details
 */
export function jsonResult<T>(data: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Create an image result with base64-encoded data.
 *
 * @param base64Data - The base64-encoded image data
 * @param mimeType - The image MIME type (e.g., "image/png")
 * @returns AgentToolResult with image content and type details
 */
export function imageResult(base64Data: string, mimeType: string): AgentToolResult<{ type: string }> {
  return {
    content: [{ type: "image", data: base64Data, mimeType }],
    details: { type: mimeType },
  };
}

/**
 * Create a dual-content result with both text reference and image data.
 * The text block comes FIRST so it survives context pruning; the image block
 * provides LLM vision for the current turn.
 *
 * @param base64Data - The base64-encoded image data
 * @param mimeType - The image MIME type
 * @param relativePath - Workspace-relative path to the persisted file
 * @param workspaceDir - Absolute workspace directory path
 * @returns AgentToolResult with [text, image] content blocks
 */
export function dualImageResult(
  base64Data: string,
  mimeType: string,
  relativePath: string,
  workspaceDir: string,
): AgentToolResult<{ type: string; filePath: string; relativePath: string }> {
  const absolutePath = safePath(workspaceDir, relativePath);
  return {
    content: [
      {
        type: "text",
        text: `Screenshot saved: ${relativePath}\nFull path: ${absolutePath}`,
      },
      { type: "image", data: base64Data, mimeType },
    ],
    details: { type: mimeType, filePath: absolutePath, relativePath },
  };
}

/**
 * Read a string parameter from a params record with type checking.
 *
 * @param params - The parameters record
 * @param key - The parameter key to read
 * @param required - Whether the parameter is required (default: true)
 * @returns The string value, or undefined if optional and missing
 * @throws Error if required and missing, or if wrong type
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Parameter ${key} must be a string, got ${typeof value}`);
  }
  return value;
}

/**
 * Read a number parameter from a params record with type checking.
 *
 * @param params - The parameters record
 * @param key - The parameter key to read
 * @param required - Whether the parameter is required (default: true)
 * @returns The number value, or undefined if optional and missing
 * @throws Error if required and missing, or if wrong type
 */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  required = true,
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`Parameter ${key} must be a number, got ${typeof value}`);
  }
  return value;
}

/**
 * Read a boolean parameter from a params record with type checking.
 *
 * @param params - The parameters record
 * @param key - The parameter key to read
 * @param required - Whether the parameter is required (default: true)
 * @returns The boolean value, or undefined if optional and missing
 * @throws Error if required and missing, or if wrong type
 */
export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
  required = true,
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Parameter ${key} must be a boolean, got ${typeof value}`);
  }
  return value;
}

/**
 * Create an action gate function that classifies an action type.
 *
 * The returned function uses the core action classifier to determine
 * whether an action requires confirmation (i.e., is destructive).
 * When `_confirmed: true` is set in params, the gate is bypassed --
 * this allows the LLM to re-call an action after user approval.
 *
 * @param actionType - The action type string to classify
 * @returns A function that returns actionType and requiresConfirmation
 */
export function createActionGate(
  actionType: string,
): (params: Record<string, unknown>) => { actionType: string; requiresConfirmation: boolean } {
  return (params: Record<string, unknown>) => {
    // If the caller already confirmed (re-call after user approval), bypass the gate
    if (params._confirmed === true) {
      return { actionType, requiresConfirmation: false };
    }
    const classification = classifyAction(actionType);
    return {
      actionType,
      requiresConfirmation: classification === "destructive",
    };
  };
}

/**
 * Trust level hierarchy for comparison.
 * Higher index = higher privilege.
 */
export const TRUST_HIERARCHY: readonly UserTrustLevel[] = ["guest", "user", "admin"];

/**
 * Check if the actual trust level meets or exceeds the required minimum.
 *
 * @param actual - The actual trust level from the request context
 * @param minimum - The minimum trust level required
 * @returns true if actual >= minimum in the trust hierarchy
 */
export function meetsMinimumTrust(actual: UserTrustLevel, minimum: UserTrustLevel): boolean {
  return TRUST_HIERARCHY.indexOf(actual) >= TRUST_HIERARCHY.indexOf(minimum);
}

/**
 * Create a trust guard that checks the current request context's trust level
 * against a minimum requirement before allowing a privileged tool to execute.
 *
 * Used by privileged tools (agents_manage, sessions_manage, etc.) to enforce
 * Enforces per-tool minimum trust level via tryGetContext().
 *
 * Throws throwToolError("permission_denied", ...) when trust is insufficient,
 * which is caught by the SDK's executePreparedToolCall and marked isError:true.
 * When trust is sufficient, returns void (callers just call `trustGuard()`).
 *
 * @param toolName - Name of the tool (for error messages)
 * @param minimumTrust - Minimum trust level required (default: "admin")
 * @returns A function that throws if unauthorized, returns void if authorized
 */
export function createTrustGuard(
  toolName: string,
  minimumTrust: UserTrustLevel = "admin",
): () => void {
  return () => {
    const ctx = tryGetContext();
    const actualTrust = ctx?.trustLevel ?? "guest";
    if (!meetsMinimumTrust(actualTrust, minimumTrust)) {
      throwToolError(
        "permission_denied",
        `Insufficient trust level for ${toolName}: requires ${minimumTrust}, current level is ${actualTrust}.`,
        { hint: "This tool requires admin trust level." },
      );
    }
  };
}
