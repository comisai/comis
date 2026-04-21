// SPDX-License-Identifier: Apache-2.0
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
  // 0. Unwrap serialized tool-result envelopes. When the exec wrapper
  //    returns a failure, the error text reaches us as
  //    `{"content":[{"type":"text","text":"<real error>"}], "details":...}`.
  //    Every exec failure starts with that envelope, so without unwrapping
  //    the 80-char fallback below buckets structurally-identical-envelope
  //    errors under the same tag (`content_type_text_text_...`) even when
  //    the inner stderr is completely different. That's what collapsed
  //    exec in session 678314278 lines 40-51 — two `spawn sandbox-exec
  //    ENOENT` failures triggered maxConsecutiveErrorPatterns, which then
  //    also rejected an unrelated `python3 --version` probe. Unwrap up to
  //    2 levels deep (the breaker's own block message is a *second*
  //    envelope layer wrapping the inner tool failure).
  let unwrapped = errorText;
  for (let depth = 0; depth < 2; depth++) {
    const peeled = peelEnvelope(unwrapped);
    if (peeled === unwrapped) break;
    unwrapped = peeled;
  }

  // 1. Bracketed tag: [some_tag]
  const bracketMatch = /\[(\w+)\]/.exec(unwrapped);
  if (bracketMatch) return bracketMatch[1]!;

  // 2. "Validation failed" prefix
  if (/^validation failed/i.test(unwrapped)) return "validation_failed";

  // 3. Fallback: normalize first 80 chars of the unwrapped text
  return unwrapped
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Peel one layer of a serialized tool-result envelope, returning the inner
 * text. Returns the input unchanged if the envelope shape doesn't match.
 * Handles both raw JSON envelopes and the breaker's own serialized block
 * message (which starts with prose then embeds the next envelope in quotes).
 */
function peelEnvelope(text: string): string {
  // Shape A: raw JSON envelope — `{"content":[{"type":"text","text":"..."}], ...}`
  // Use prefix sniff to avoid JSON.parse cost on non-envelope errors.
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") && trimmed.includes("\"content\"")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const content = obj.content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0] as Record<string, unknown> | undefined;
        if (first?.type === "text" && typeof first.text === "string") {
          return first.text;
        }
      }
    } catch {
      // Not valid JSON — fall through.
    }
  }

  // Shape B: breaker block message — starts with a prose prefix that
  // embeds the next envelope in quotes:
  //   `Tool "exec" has failed 2 consecutive times with the same error:
  //    "{\"content\":[...]}". This tool appears to be unavailable. ...`
  // Peel the quoted JSON substring, if present.
  const quoted = /same error: "([^]+?)"\.\s/.exec(text);
  if (quoted) {
    // The captured group is JSON with escaped quotes. Unescape by parsing
    // the outer quoted string as JSON (wrap in extra quotes so JSON.parse
    // handles the escapes).
    try {
      const inner = JSON.parse(`"${quoted[1]!}"`) as string;
      return inner;
    } catch {
      // Fall through — return prefix + match unchanged.
    }
  }

  return text;
}

/**
 * Error tags that represent parameter-validation rejections (bad args),
 * not tool-execution failures. These are corrective feedback — the agent
 * can fix them by changing its args on the next call — so they MUST NOT
 * count toward the breaker's signature, tool-total, or error-pattern
 * counters. Counting them collapsed exec entirely during a legitimate
 * Cloudflare Pages deploy attempt when the agent iterated through several
 * command shapes looking for one that cleared the shell-substitution +
 * env-allowlist guards (Telegram session 678314278, jsonl lines 86–105).
 *
 * Real tool-execution failures (`permission_denied`, `not_found`,
 * `conflict`, `timeout`, EPERM sandbox denies, etc.) are unchanged —
 * they still accumulate and block as before.
 */
export const PARAMETER_VALIDATION_TAGS = new Set([
  "invalid_value",
  "missing_param",
  "validation_failed",
]);

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
 * When tool failures are caused by the macOS sandbox-exec profile denying writes
 * to protected paths (~/.comis/skills/, global node_modules, ~/.gitconfig,
 * /var/folders/), return a specific redirect message pointing the agent to
 * `skills_manage` (for skill installs) or the agent workspace (for package installs).
 *
 * Returns undefined if no sandbox-denial signature matches -- callers fall back to
 * the generic buildBlockReason() output.
 *
 * Specificity order (most specific first): .comis/skills > .gitconfig > node_modules > var/folders.
 * When multiple signatures match, the more specific one wins.
 *
 * This helper is intentionally non-exported -- it is internal plumbing for the
 * three reason-building sites inside createToolRetryBreaker.beforeToolCall.
 */
function buildSandboxRedirectMessage(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  const deny = /(eperm|operation not permitted)/i.test(errorText);
  if (!deny) return undefined;

  // Order matters: most specific signature wins.
  let matchedPath: string | undefined;
  if (/\.comis\/skills/i.test(errorText)) {
    matchedPath = "~/.comis/skills/";
  } else if (/\.gitconfig/i.test(errorText)) {
    matchedPath = "~/.gitconfig";
  } else if (/node_modules/i.test(errorText)) {
    matchedPath = "global node_modules (e.g., ~/.nvm/.../lib/node_modules)";
  } else if (/(\/private)?\/var\/folders\//i.test(errorText)) {
    matchedPath = "/var/folders/ (system temp)";
  }
  if (!matchedPath) return undefined;

  const msg =
    `The exec sandbox blocks writes to ${matchedPath}. ` +
    `To install a skill, call discover_tools({query: "skills_manage"}) and then use skills_manage ` +
    `with scope: "local" (it writes into the agent's own workspace/skills). ` +
    `For package installs, keep everything inside the agent workspace ` +
    `(e.g., run "npm install" from a workspace-local directory under ./output/...). ` +
    `Do not retry exec against this path.`;
  return msg.slice(0, 500);
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
  const errorPatternFailures = new Map<string, { consecutiveFailures: number; lastError?: string; failingFingerprints: Set<string> }>();

  return {
    beforeToolCall(toolName: string, args: Record<string, unknown>): ToolRetryVerdict {
      // Check tool-level block first (all args blocked)
      if (blockedTools.has(toolName)) {
        const toolState = toolFailures.get(toolName);
        const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
        const lastErr = toolState?.lastError;
        const redirect = buildSandboxRedirectMessage(lastErr);
        return {
          block: true,
          reason: redirect ?? buildBlockReason(toolName, toolState?.count ?? maxToolFailures, lastErr, alternatives, true),
          alternatives,
        };
      }

      // Check error-pattern block BEFORE signature-level check.
      // Only block if the incoming args' fingerprint already failed with this
      // error — novel args pass through as a "probe" (the tool-total counter
      // at maxToolFailures remains as backstop for truly broken tools).
      const errorPatternPrefix = `${toolName}::err::`;
      const incomingFp = fingerprint(toolName, args);
      for (const [key, state] of errorPatternFailures) {
        if (key.startsWith(errorPatternPrefix) && state.consecutiveFailures >= maxErrorPatterns) {
          if (!state.failingFingerprints.has(incomingFp)) continue;
          const errorTag = key.slice(errorPatternPrefix.length);
          const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
          const lastErr = `[${errorTag}] ${state.lastError ?? ""}`.trim();
          const redirect = buildSandboxRedirectMessage(lastErr);
          return {
            block: true,
            reason: redirect ?? buildBlockReason(toolName, state.consecutiveFailures, lastErr, alternatives, false),
            alternatives,
          };
        }
      }

      // Check signature-level block (specific tool+args blocked)
      const fp = fingerprint(toolName, args);
      const sigState = signatureFailures.get(fp);
      if (sigState && sigState.consecutiveFailures >= maxConsecutiveFailures) {
        const alternatives = suggestAlternatives ? findAlternatives(toolName) : [];
        const lastErr = sigState.lastError;
        const redirect = buildSandboxRedirectMessage(lastErr);
        return {
          block: true,
          reason: redirect ?? buildBlockReason(toolName, sigState.consecutiveFailures, lastErr, alternatives, false),
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

      // Skip counter updates for parameter-validation tags — these are
      // corrective feedback the agent fixes by re-calling with different
      // args, not evidence of tool unavailability. See
      // PARAMETER_VALIDATION_TAGS above for the full rationale.
      const errorTag = extractErrorTag(errorText ?? "unknown");
      if (PARAMETER_VALIDATION_TAGS.has(errorTag)) {
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
      const patternKey = `${toolName}::err::${errorTag}`;
      const patternState = errorPatternFailures.get(patternKey) ?? { consecutiveFailures: 0, failingFingerprints: new Set() };
      patternState.consecutiveFailures++;
      patternState.lastError = errorText;
      patternState.failingFingerprints.add(fp);
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
