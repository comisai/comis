// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent error-context classification.
 *
 * Maps a raw error message plus the run's end reason onto the structured
 * `{ errorType, retryable, failingTool? }` triple that drives offline analysis
 * and the batcher's retry-vs-dead-letter decision. Pure and dependency-free —
 * no I/O, no ports, no clock — so the classification table can be exercised
 * directly. Split out of `sub-agent-result-processor.ts` to keep that file
 * under the production line cap.
 * @module
 */

/**
 * Transport-layer failures are classified separately for diagnostics and
 * higher-level execution policy. The bare Node errno spellings do not contain
 * "timeout"/"timed out" (e.g. "ETIMEDOUT".toLowerCase() is "etimedout"), so
 * the timeout branch misses them. Match these explicitly, case-insensitively,
 * as a substring of the error message
 * (real delivery errors wrap the errno in surrounding text, e.g.
 * "connect ECONNREFUSED 127.0.0.1:443").
 *
 * The token list is deliberately errno-style only, PLUS the errno-less real
 * phrasings emitted by undici/fetch ("fetch failed", "network request failed",
 * "socket hang up"). The natural-language phrases "connection reset" /
 * "connection refused" are intentionally OMITTED: every genuine Node transport
 * error carries its errno spelling (ECONNRESET / ECONNREFUSED, already matched
 * here), so those phrases add no real-failure coverage but DO over-match a
 * PERMANENT error that quotes them as content (e.g. a tool result
 * `"connection refused by policy"`). Keeping the list errno-anchored bounds the
 * false-positive surface (mirrors the 5xx `\b5\d{2}\b` word-boundary guard).
 */
const TRANSIENT_TRANSPORT_TOKENS = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "epipe",
  "enetunreach",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network request failed",
];

/**
 * Classify an error message and endReason into structured error context
 * for offline analysis and retry decisions.
 */
export function classifyErrorContext(
  errorMessage: string,
  endReason: "failed" | "killed" | "watchdog_timeout" | "ghost_sweep",
  killedBy?: "parent" | "health_monitor" | "operator" | "system",
): {
  errorType: string;
  retryable: boolean;
  failingTool?: string;
} {
  const lowerMsg = errorMessage.toLowerCase();

  // Derive errorType from endReason and error message patterns
  let errorType: string;
  let retryable: boolean;

  switch (endReason) {
    case "watchdog_timeout":
      errorType = "ExecutionTimeout";
      retryable = true;
      break;
    case "ghost_sweep":
      errorType = "GhostRunTimeout";
      retryable = true;
      break;
    case "killed":
      // The structured twin of the attributed error string — a
      // health-monitor stuck-kill must never read as a parent kill.
      errorType =
        killedBy === "health_monitor" ? "StuckKilledByHealthMonitor"
        : killedBy === "operator" ? "KilledByOperator"
        : killedBy === "system" ? "KilledBySystem"
        : "KilledByParent";
      retryable = false;
      break;
    default: {
      // Classify from error message content
      if (lowerMsg.includes("budget") || lowerMsg.includes("cost limit")) {
        errorType = "BudgetExceeded";
        retryable = false;
      } else if (lowerMsg.includes("timeout") || lowerMsg.includes("timed out")) {
        errorType = "ExecutionTimeout";
        retryable = true;
      } else if (TRANSIENT_TRANSPORT_TOKENS.some((token) => lowerMsg.includes(token))) {
        // Transport-layer blips (ECONNRESET/ECONNREFUSED/EPIPE/
        // "socket hang up"/"fetch failed"/...) are transient — the batcher
        // retries them with backoff before dead-lettering. Placed AFTER the
        // budget/timeout branches (which precede it) so a permanent budget
        // message never reaches here.
        errorType = "TransportError";
        retryable = true;
      } else if (lowerMsg.includes("rate limit") || lowerMsg.includes("429")) {
        errorType = "RateLimited";
        retryable = true;
      } else if (lowerMsg.includes("provider") || /\b5\d{2}\b/.test(errorMessage)) {
        // Match HTTP 5xx status codes (500-599) bounded by word boundaries
        // so token counts like "50000" or "100" do not falsely trigger.
        errorType = "ProviderError";
        retryable = true;
      } else if (lowerMsg.includes("circuit") || lowerMsg.includes("breaker")) {
        errorType = "CircuitBreakerOpen";
        retryable = true;
      } else if (lowerMsg.includes("context") && (lowerMsg.includes("exhaust") || lowerMsg.includes("loop"))) {
        errorType = "ContextExhausted";
        retryable = false;
      } else if (lowerMsg.includes("max steps") || lowerMsg.includes("step limit")) {
        errorType = "StepLimitReached";
        retryable = false;
      } else {
        errorType = "Unknown";
        retryable = false;
      }
    }
  }

  // Attempt to extract failing tool from error message
  // Pattern: "Tool X failed", "error in tool X", "X: error"
  let failingTool: string | undefined;
  const toolMatch = errorMessage.match(/\btool[:\s]+["']?(\w+)["']?/i)
    ?? errorMessage.match(/^(\w+):\s/);
  if (toolMatch?.[1]) {
    failingTool = toolMatch[1];
  }

  return {
    errorType,
    retryable,
    ...(failingTool ? { failingTool } : {}),
  };
}
