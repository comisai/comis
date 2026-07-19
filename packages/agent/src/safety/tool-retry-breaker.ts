// SPDX-License-Identifier: Apache-2.0
import { unwrapExternalContent } from "@comis/core";
import { isMcpValidationError } from "../bridge/bridge-event-handlers.js";

/**
 * Tool retry circuit breaker: per-tool-signature consecutive failure tracking.
 *
 * Prevents infinite retry loops (e.g. an agent re-calling a failing MCP server
 * tool dozens of times) by blocking tool calls after repeated failures and
 * providing actionable LLM guidance with alternative tool suggestions.
 *
 * Two-level tracking:
 * - **Signature-level** (tool + sorted-args fingerprint): blocks after N consecutive
 *   failures for the exact same tool+args combination.
 * - **Tool-level** (tool name only): blocks after M total failures across all args
 *   for the same tool name.
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

/**
 * Transition verdict returned by `recordResult` when a tool-WIDE failure
 * counter crosses (or recovers from) its threshold. The breaker stays
 * emitter-free (lowest blast radius): it RETURNS this verdict and the bridge
 * (the sole holder of the event bus) emits the `tool:breaker_opened` /
 * `tool:breaker_reset` events.
 *
 * Only tool-WIDE transitions surface (tool-level total + error-pattern, both of
 * which make the tool unavailable to the model); the args-specific
 * signature-level counter does NOT produce a transition. `reset` fires
 * only on a success that recovers a non-zero counter — never on the lifecycle
 * `reset()` full-clear.
 */
export interface ToolBreakerTransition {
  transition: "opened" | "reset";
  toolName: string;
  /** "tool_failure_threshold" | "error_pattern" | "success" */
  reason: string;
  consecutiveFailures: number;
  /** extractErrorTag output (normalized, never raw body); "" for reset. */
  errorTag: string;
}

/** Configuration for the tool retry breaker. */
export interface ToolRetryBreakerConfig {
  maxConsecutiveFailures: number;
  maxToolFailures: number;
  suggestAlternatives: boolean;
  /** Max consecutive same-error-class failures (any args) before blocking.
   *  Stricter than args-based because same error + different args = stronger stuck signal. */
  maxConsecutiveErrorPatterns?: number;
  /**
   * Operator-supplied tool-alternative map. Keys are tool-name prefixes
   * (e.g., `"mcp__finance-data"`); values are arrays of suggested alternative
   * tool names. Used in block reasons to guide the LLM toward working tools.
   *
   * Defaults to an empty map (no alternatives suggested). The codebase MUST
   * NOT ship hardcoded MCP server names — operators opt in by populating
   * this map in their breaker config.
   */
  toolAlternatives?: Record<string, readonly string[]>;
}

/** Tool retry breaker interface -- tracks per-tool-signature failures. */
export interface ToolRetryBreaker {
  /** Check whether a tool call should be blocked before execution. */
  beforeToolCall(toolName: string, args: Record<string, unknown>): ToolRetryVerdict;
  /**
   * Record the result of a tool call (success or failure).
   *
   * Returns a {@link ToolBreakerTransition} ONLY at a tool-wide counter
   * crossing (tool-level total or error-pattern threshold, by EXACT equality)
   * or on a success that recovers a non-zero failure counter; otherwise
   * `undefined`. The breaker emits nothing itself — the bridge consumes this
   * verdict and emits the corresponding events.
   */
  recordResult(toolName: string, args: Record<string, unknown>, success: boolean, errorText?: string): ToolBreakerTransition | undefined;
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
  //    the inner stderr is completely different — e.g. two `spawn
  //    sandbox-exec ENOENT` failures trip maxConsecutiveErrorPatterns and
  //    the shared envelope tag then also rejects an unrelated
  //    `python3 --version` probe, collapsing exec entirely. Unwrap up to
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

  // 2. Caller-correctable schema/argument validation failures.
  if (isMcpValidationError(unwrapped)) return "validation_failed";

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
  const external = unwrapExternalContent(text);
  if (external !== null) {
    return external.content;
  }

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
 * counters. Counting them collapses exec entirely during legitimate work —
 * e.g. an agent iterating through several command shapes looking for one
 * that clears the shell-substitution + env-allowlist guards.
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

/**
 * Returns true if the given error tag indicates a parameter-validation
 * failure (invalid_value, missing_param, validation_failed).
 *
 * Used in buildBlockReason to produce a repair-not-abandon message instead
 * of the generic "appears to be unavailable" block reason.
 */
export function isParameterValidationTag(tag: string): boolean {
  return PARAMETER_VALIDATION_TAGS.has(tag);
}

/**
 * Returns true if `errorText` is a serialized tool-result envelope reporting a
 * command that RAN TO COMPLETION and exited non-zero — i.e. it carries a
 * numeric `details.exitCode`.
 *
 * Such results are corrective feedback for an agentic coding loop (a `tsc`
 * build that exits 2 on type errors, a test runner that exits 1, `grep`/`diff`
 * exit 1), NOT evidence that the `exec`/`process` tool is unavailable. The
 * agent fixes its input and re-runs, so — exactly like PARAMETER_VALIDATION_TAGS
 * — these MUST NOT count toward the breaker's signature, tool-total, or
 * error-pattern thresholds. Counting them shuts exec down mid-task: repeated
 * `npm run build` exits of 2 trip maxConsecutiveErrorPatterns and the breaker
 * tells the model exec is "unavailable. DO NOT retry this tool", killing the
 * edit→build→fix loop and forcing a bluffed completion.
 *
 * The discriminator is deliberately `details.exitCode` — the SAME field the
 * pi-event bridge inspects to flip toolSuccess=false in the first place
 * (`pi-event-bridge.ts`: `result.details.exitCode !== 0`). A process that NEVER
 * RAN (the exec sandbox failing to spawn — `spawn sandbox-exec ENOENT` — or an
 * EPERM sandbox deny) carries NO exitCode and is correctly NOT exempted: those
 * are genuine tool faults and still accumulate and block as before. Keying on
 * the inner-text exitCode instead would over-exempt those infra faults.
 *
 * Exported as a test seam alongside isParameterValidationTag.
 */
export function isCompletedCommandExit(errorText: string | undefined): boolean {
  // Fast reject keeps JSON.parse off the hot path for the common bracket-tag
  // errors (e.g. `[permission_denied] EPERM`) that carry no exit code.
  if (!errorText || !errorText.includes("exitCode")) return false;
  try {
    const obj = JSON.parse(errorText) as { details?: { exitCode?: unknown } };
    return typeof obj.details?.exitCode === "number";
  } catch {
    // Not a JSON envelope (e.g. a re-fed breaker block message) — not a
    // structured command exit.
    return false;
  }
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
 * @param errorTag - Normalized error tag extracted from lastError (used to branch on validation errors)
 * @param isToolLevel - Whether this is a tool-level (total) or signature-level (consecutive) block
 *
 * Exported as a test seam — the recordResult accumulation path is
 * unreachable for parameter-validation tags (early-return on
 * `PARAMETER_VALIDATION_TAGS.has(errorTag)` in `recordResult`),
 * so tests call this function directly.
 */
export function buildBlockReason(
  toolName: string,
  count: number,
  lastError: string | undefined,
  alternatives: string[],
  errorTag: string | undefined,
  isToolLevel: boolean,
): string {
  const failureType = isToolLevel ? "total" : "consecutive";
  // Collapse a re-fed serialized envelope OR the breaker's own prior block
  // message down to its innermost real error before embedding it. Without
  // this, feeding a prior block message back as lastError produces a
  // recursively self-nested clause ("failed N times with the same error:
  // \"…failed N-1 times with the same error: \\\"…\\\"\""). peelEnvelope
  // already strips both the JSON-envelope layer and the breaker's own
  // `same error: "…"` block prose; loop up to 2 layers to match extractErrorTag.
  // INVARIANT: the returned message contains `has failed` at most once and
  // never embeds a prior `appears to be unavailable` clause.
  let peeledError = lastError;
  if (peeledError !== undefined) {
    for (let depth = 0; depth < 2; depth++) {
      const peeled = peelEnvelope(peeledError);
      if (peeled === peeledError) break;
      peeledError = peeled;
    }
  }
  const errorClause = peeledError
    ? ` with the same error: "${peeledError.slice(0, 150)}"`
    : "";
  const header = errorTag && isParameterValidationTag(errorTag)
    ? `Tool "${toolName}" failed parameter validation ${count} times (same args). Fix the arguments before retrying.`
    : `Tool "${toolName}" has failed ${count} ${failureType} times${errorClause}. This tool appears to be unavailable.`;
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
  const toolAlternatives: Record<string, readonly string[]> = config.toolAlternatives ?? {};

  // Per-fingerprint (tool+args) consecutive failure tracking
  const signatureFailures = new Map<string, ToolSignatureState>();
  // Per-tool-name total failure count (across all args)
  const toolFailures = new Map<string, { count: number; lastError?: string }>();
  // Tool names that have exceeded the tool-level threshold
  const blockedTools = new Set<string>();
  // Per-error-pattern consecutive failure tracking (keyed by `${toolName}::err::${errorTag}`)
  const errorPatternFailures = new Map<string, { consecutiveFailures: number; lastError?: string; failingFingerprints: Set<string> }>();

  /**
   * Find alternative tools for a given tool name by prefix matching against
   * `config.toolAlternatives`. Closed-over the factory's `toolAlternatives`
   * local; defaults to no alternatives when the config field is omitted.
   * Spread to a fresh mutable array so the readonly-input / mutable-output
   * contract documented in `ToolRetryVerdict.alternatives?: string[]` is
   * preserved.
   *
   * @returns Array of alternative tool names, empty if no prefix match.
   */
  function findAlternatives(toolName: string): string[] {
    for (const [prefix, alts] of Object.entries(toolAlternatives)) {
      if (toolName.startsWith(prefix)) return [...alts];
    }
    return [];
  }

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
          reason: redirect ?? buildBlockReason(toolName, toolState?.count ?? maxToolFailures, lastErr, alternatives, extractErrorTag(toolState?.lastError ?? ""), true),
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
            reason: redirect ?? buildBlockReason(toolName, state.consecutiveFailures, lastErr, alternatives, errorTag, false),
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
          reason: redirect ?? buildBlockReason(toolName, sigState.consecutiveFailures, lastErr, alternatives, extractErrorTag(sigState.lastError ?? ""), false),
          alternatives,
        };
      }

      return { block: false };
    },

    recordResult(toolName: string, args: Record<string, unknown>, success: boolean, errorText?: string): ToolBreakerTransition | undefined {
      const fp = fingerprint(toolName, args);

      if (success) {
        // Reset consecutive counter for this specific signature
        const existing = signatureFailures.get(fp);
        // RESET edge: only an observable transition if this signature was
        // actually failing (a success after no prior failure is a no-op).
        const hadConsecutive = (existing?.consecutiveFailures ?? 0) > 0;
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
        // Note: tool-level total counter is NOT reset on success, and a success
        // never clears blockedTools. So a tool that has already crossed
        // maxToolFailures stays hard-blocked even after this success — emitting
        // `reset` here would assert the breaker is usable again while
        // beforeToolCall still returns block:true. Gate the reset
        // transition on the tool's actual availability: only report reset when
        // the success genuinely restores a usable tool (signature-level recovery
        // on a tool that is NOT tool-level blocked). The local counter cleanup
        // above still runs unconditionally — only the observable transition is
        // suppressed.
        const stillBlocked = blockedTools.has(toolName);
        return (hadConsecutive && !stillBlocked)
          ? { transition: "reset", toolName, reason: "success", consecutiveFailures: 0, errorTag: "" }
          : undefined;
      }

      // Skip counter updates for parameter-validation tags — these are
      // corrective feedback the agent fixes by re-calling with different
      // args, not evidence of tool unavailability. See
      // PARAMETER_VALIDATION_TAGS above for the full rationale.
      const errorTag = extractErrorTag(errorText ?? "unknown");
      if (PARAMETER_VALIDATION_TAGS.has(errorTag)) {
        return undefined;
      }

      // Skip counter updates for completed command exits — a command that ran
      // to completion and exited non-zero (tsc build errors, failing tests,
      // grep/diff exit 1) is corrective feedback the agent resolves by fixing
      // its input and re-running, NOT tool unavailability. Genuine infra faults
      // (spawn ENOENT, EPERM) carry no exitCode and still accumulate. See
      // isCompletedCommandExit above for the full rationale.
      if (isCompletedCommandExit(errorText)) {
        return undefined;
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

      // Check if tool-level threshold exceeded. The block stays `>=` (Set.add is
      // idempotent), but the OPEN transition fires on the EXACT crossing only —
      // `===` so the bridge emits `tool:breaker_opened` once per open, never on
      // every later failure (a `>=` verdict would inflate the incident report's
      // breakerTimeline).
      if (toolState.count >= maxToolFailures) {
        blockedTools.add(toolName);
      }
      const openedToolLevel = toolState.count === maxToolFailures;

      // Update error-pattern tracking
      const patternKey = `${toolName}::err::${errorTag}`;
      const patternState = errorPatternFailures.get(patternKey) ?? { consecutiveFailures: 0, failingFingerprints: new Set() };
      patternState.consecutiveFailures++;
      patternState.lastError = errorText;
      patternState.failingFingerprints.add(fp);
      errorPatternFailures.set(patternKey, patternState);
      const openedPattern = patternState.consecutiveFailures === maxErrorPatterns;

      // Tool-WIDE open transition: tool-level total OR error-pattern. The
      // args-specific signature-level counter does NOT emit a transition — it is
      // a narrower, self-healing state checked in beforeToolCall.
      if (openedToolLevel || openedPattern) {
        return {
          transition: "opened",
          toolName,
          reason: openedToolLevel ? "tool_failure_threshold" : "error_pattern",
          // Report the counter that actually crossed the threshold.
          // A tool_failure_threshold open is driven by the tool-WIDE total
          // (`toolState.count`) crossing maxToolFailures across different args —
          // each individual signature may sit at consecutiveFailures===1. An
          // error_pattern open is driven by the per-pattern consecutive counter.
          // Reporting `sigState.consecutiveFailures` here mislabels an N-failure
          // open as "opened after 1 failure" in the incident report's
          // breakerTimeline.
          consecutiveFailures: openedToolLevel
            ? toolState.count
            : patternState.consecutiveFailures,
          errorTag,
        };
      }
      return undefined;
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
