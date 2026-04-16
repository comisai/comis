/**
 * Tool retry circuit breaker: per-tool-signature consecutive failure tracking.
 *
 * Prevents infinite retry loops (like the 48-call yfinance incident) by blocking
 * tool calls after repeated failures and providing actionable LLM guidance with
 * alternative tool suggestions.
 *
 * Two-level tracking:
 * - **Signature-level** (tool + sorted-args fingerprint): blocks after N consecutive
 *   failures for the exact same tool+args combination.
 * - **Tool-level** (tool name only): blocks after M total failures across all args
 *   for the same tool name.
 *

 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Verdict returned by beforeToolCall -- block or allow. */
export interface ToolRetryVerdict {
  block: boolean;
  reason?: string;
  alternatives?: string[];
}

/** Configuration for the tool retry breaker. */
export interface ToolRetryBreakerConfig {
  maxConsecutiveFailures: number;
  maxToolFailures: number;
  suggestAlternatives: boolean;
  /** Max consecutive same-error-class failures (any args) before blocking.
   *  Stricter than args-based because same error + different args = stronger stuck signal. */
  maxConsecutiveErrorPatterns?: number;
}

/** Tool retry breaker interface -- tracks per-tool-signature failures. */
export interface ToolRetryBreaker {
  /** Check whether a tool call should be blocked before execution. */
  beforeToolCall(toolName: string, args: Record<string, unknown>): ToolRetryVerdict;
  /** Record the result of a tool call (success or failure). */
  recordResult(toolName: string, args: Record<string, unknown>, success: boolean, errorText?: string): void;
  /** Return list of tool names that are fully blocked (tool-level). */
  getBlockedTools(): string[];
  /** Clear all state -- unblock all tools, reset all counters. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Per-signature failure state. */
interface ToolSignatureState {
  consecutiveFailures: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Alternative tool mapping (hardcoded v1)
// ---------------------------------------------------------------------------

/**
 * Maps tool name prefixes to alternative tools that can serve similar purposes.
 * Used in block reasons to guide the LLM toward working alternatives.
 */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  "mcp__yfinance": ["web_search", "mcp__tavily--tavily-search", "web_fetch"],
};

// ---------------------------------------------------------------------------
// Error tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract a normalized error classification tag from error text.
 *
 * Priority:
 * 1. Bracketed tag pattern: `[not_read]` -> `"not_read"`
 * 2. "Validation failed" prefix -> `"validation_failed"`
 * 3. Fallback: first 80 chars, lowercased, non-alphanumeric to `_`, collapsed
 *
 * @param errorText - Raw error text from tool execution
 * @returns Normalized error tag for pattern grouping
 */
export function extractErrorTag(errorText: string): string {
  // 1. Bracketed tag: [some_tag]
  const bracketMatch = /\[(\w+)\]/.exec(errorText);
  if (bracketMatch) return bracketMatch[1]!;

  // 2. "Validation failed" prefix
  if (/^validation failed/i.test(errorText)) return "validation_failed";

  // 3. Fallback: normalize first 80 chars
  return errorText
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic fingerprint for a tool call using sorted-key JSON.
 *
 * IMPORTANT: Uses Object.entries().sort() to ensure key ordering is deterministic
 * regardless of insertion order. Plain JSON.stringify produces different output
 * for { a: 1, b: 2 } vs { b: 2, a: 1 }.
 *
 * Pattern from: packages/agent/src/context-engine/reread-detector.ts
 */
function fingerprint(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = JSON.stringify(
    Object.fromEntries(Object.entries(args).sort()),
  );
  return `${toolName}::${sortedArgs}`;
}

/**
 * Find alternative tools for a given tool name by prefix matching.
 * @returns Array of alternative tool names, empty if none known.
 */
function findAlternatives(toolName: string): string[] {
  for (const [prefix, alts] of Object.entries(TOOL_ALTERNATIVES)) {
    if (toolName.startsWith(prefix)) return alts;
  }
  return [];
}

/**
 * Build an actionable block reason for the LLM, capped at 500 chars.
 *
 * @param toolName - The blocked tool name
 * @param count - Number of failures (consecutive or total)
 * @param lastError - Last error text from the tool, if available
 * @param alternatives - Alternative tool names to suggest
 * @param isToolLevel - Whether this is a tool-level (total) or signature-level (consecutive) block
 */
function buildBlockReason(
  toolName: string,
  count: number,
  lastError: string | undefined,
  alternatives: string[],
  isToolLevel: boolean,
): string {
  const failureType = isToolLevel ? "total" : "consecutive";
  const errorClause = lastError
    ? ` with the same error: "${lastError.slice(0, 150)}"`
    : "";
  const header = `Tool "${toolName}" has failed ${count} ${failureType} times${errorClause}. This tool appears to be unavailable.`;
  const suggestion = alternatives.length > 0
    ? alternatives.map(a => `- Use ${a}`).join("\n")
    : "- Use alternative approaches to complete your task";
  const full = `${header}\n\nDO NOT retry this tool. Instead:\n${suggestion}\n- Use the data you already have to complete your task\n- If you cannot complete the task without this tool, report the limitation in your output`;
  return full.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a tool retry breaker instance.
 *
 * Follows the same factory-function-returning-interface pattern as
 * `createCircuitBreaker()` in circuit-breaker.ts.
 *
 * @param config - Breaker configuration (thresholds and alternative suggestion toggle)
 * @returns ToolRetryBreaker instance
 */
export function createToolRetryBreaker(config: ToolRetryBreakerConfig): ToolRetryBreaker {
  const { maxConsecutiveFailures, maxToolFailures, suggestAlternatives } = config;
  const maxErrorPatterns = config.maxConsecutiveErrorPatterns ?? 2;

  // Per-fingerprint (tool+args) consecutive failure tracking
  const signatureFailures = new Map<string, ToolSignatureState>();
  // Per-tool-name total failure count (across all args)
  const toolFailures = new Map<string, { count: number; lastError?: string }>();
  // Tool names that have exceeded the tool-level threshold
  const blockedTools = new Set<string>();
  // Per-error-pattern consecutive failure tracking (keyed by `${toolName}::err::${errorTag}`)
  const errorPatternFailures = new Map<string, { consecutiveFailures: number; lastError?: string }>();

  return {
    beforeToolCall(toolName: string, args: Record<string, unknown>): ToolRetryVerdict {
      // Check tool-level block first (all args blocked)
      if (blockedTools.has(toolName)) {
        const toolState = toolFailures.get(toolName);
        const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
        return {
          block: true,
          reason: buildBlockReason(toolName, toolState?.count ?? maxToolFailures, toolState?.lastError, alternatives, true),
          alternatives,
        };
      }

      // Check error-pattern block BEFORE signature-level check
      // Same error with different args = stronger stuck signal
      const errorPatternPrefix = `${toolName}::err::`;
      for (const [key, state] of errorPatternFailures) {
        if (key.startsWith(errorPatternPrefix) && state.consecutiveFailures >= maxErrorPatterns) {
          const errorTag = key.slice(errorPatternPrefix.length);
          const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
          return {
            block: true,
            reason: buildBlockReason(toolName, state.consecutiveFailures, `[${errorTag}] ${state.lastError ?? ""}`.trim(), alternatives, false),
            alternatives,
          };
        }
      }

      // Check signature-level block (specific tool+args blocked)
      const fp = fingerprint(toolName, args);
      const sigState = signatureFailures.get(fp);
      if (sigState && sigState.consecutiveFailures >= maxConsecutiveFailures) {
        const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
        return {
          block: true,
          reason: buildBlockReason(toolName, sigState.consecutiveFailures, sigState.lastError, alternatives, false),
          alternatives,
        };
      }

      return { block: false };
    },

    recordResult(toolName: string, args: Record<string, unknown>, success: boolean, errorText?: string): void {
      const fp = fingerprint(toolName, args);

      if (success) {
        // Reset consecutive counter for this specific signature
        const existing = signatureFailures.get(fp);
        if (existing) {
          existing.consecutiveFailures = 0;
        }
        // Reset ALL error-pattern counters for this tool on success
        const errorPatternPrefix = `${toolName}::err::`;
        for (const key of errorPatternFailures.keys()) {
          if (key.startsWith(errorPatternPrefix)) {
            errorPatternFailures.delete(key);
          }
        }
        // Note: tool-level total counter is NOT reset on success
        return;
      }

      // Failure path: update signature state
      const sigState = signatureFailures.get(fp) ?? { consecutiveFailures: 0 };
      sigState.consecutiveFailures++;
      sigState.lastError = errorText;
      signatureFailures.set(fp, sigState);

      // Update tool-level total counter
      const toolState = toolFailures.get(toolName) ?? { count: 0 };
      toolState.count++;
      toolState.lastError = errorText;
      toolFailures.set(toolName, toolState);

      // Check if tool-level threshold exceeded
      if (toolState.count >= maxToolFailures) {
        blockedTools.add(toolName);
      }

      // Update error-pattern tracking
      const errorTag = extractErrorTag(errorText ?? "unknown");
      const patternKey = `${toolName}::err::${errorTag}`;
      const patternState = errorPatternFailures.get(patternKey) ?? { consecutiveFailures: 0 };
      patternState.consecutiveFailures++;
      patternState.lastError = errorText;
      errorPatternFailures.set(patternKey, patternState);
    },

    getBlockedTools(): string[] {
      return [...blockedTools];
    },

    reset(): void {
      signatureFailures.clear();
      toolFailures.clear();
      blockedTools.clear();
      errorPatternFailures.clear();
    },
  };
}
