/**
 * Context truncation recovery: emergency strategy for handling context-length
 * overflow errors from LLM providers. When a prompt exceeds the model's
 * context window, this module determines whether to retry with a truncated
 * conversation (keeping only the most recent messages).
 *
 * Designed for use in the model-retry error path. Wiring is NOT done here.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of truncation analysis. */
export interface ContextTruncationResult {
  shouldRetry: boolean;
  /** Number of messages to keep (most recent). */
  keepCount: number;
  /** Reason for the truncation decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/** Patterns that indicate a context-length overflow error. */
const OVERFLOW_PATTERNS = [
  /context.length.exceeded/i,
  /prompt.is.too.long/i,
  /maximum.context.length/i,
  /token.limit/i,
  /max.tokens/i,
  /too.many.tokens/i,
  /request.too.large/i,
  /content.too.large/i,
  /input.too.long/i,
  /exceeds.*(?:token|context|length|limit)/i,
];

/**
 * Check whether an error represents a context-length overflow.
 *
 * Inspects error.message, String(error), and common API error shapes
 * (error.error?.type, error.status === 400 with overflow message).
 *
 * @param error - The error to check (string, Error, or API error object)
 * @returns true if the error indicates context overflow
 */
export function isContextOverflowError(error: unknown): boolean {
  // Collect candidate strings to match against
  const candidates: string[] = [];

  if (typeof error === "string") {
    candidates.push(error);
  } else if (error instanceof Error) {
    candidates.push(error.message);
    // Check for nested cause
    if (error.cause && typeof error.cause === "string") {
      candidates.push(error.cause);
    } else if (error.cause instanceof Error) {
      candidates.push(error.cause.message);
    }
  }

  // Handle API-style error objects: { error: { type, message }, status }
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;

    if (typeof obj.message === "string") {
      candidates.push(obj.message);
    }

    // Nested error.error.type or error.error.message
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.type === "string") candidates.push(inner.type);
      if (typeof inner.message === "string") candidates.push(inner.message);
    }

    // String(error) as fallback
    try {
      const str = String(error);
      if (str !== "[object Object]") candidates.push(str);
    } catch {
      // ignore
    }
  }

  // Match any candidate against overflow patterns
  return candidates.some((text) => OVERFLOW_PATTERNS.some((re) => re.test(text)));
}

// ---------------------------------------------------------------------------
// Truncation strategy
// ---------------------------------------------------------------------------

/**
 * Determine whether to retry with a truncated conversation.
 *
 * @param totalMessages - Current number of messages in the conversation
 * @param opts.keepCount - Number of most-recent messages to keep (default: 4)
 * @param opts.minMessages - Minimum messages below which truncation is pointless (default: 2)
 * @returns Truncation decision with reason
 */
export function truncateContextForRecovery(
  totalMessages: number,
  opts?: { keepCount?: number; minMessages?: number },
): ContextTruncationResult {
  const keepCount = opts?.keepCount ?? 4;
  const minMessages = opts?.minMessages ?? 2;

  // Already minimal -- nothing to trim
  if (totalMessages <= minMessages) {
    return {
      shouldRetry: false,
      keepCount: totalMessages,
      reason: `Conversation already at minimum size (${totalMessages} messages, min=${minMessages})`,
    };
  }

  // Can't trim if keepCount >= totalMessages
  if (totalMessages <= keepCount) {
    return {
      shouldRetry: false,
      keepCount: totalMessages,
      reason: `Conversation too short to trim (${totalMessages} messages, keepCount=${keepCount})`,
    };
  }

  return {
    shouldRetry: true,
    keepCount,
    reason: `Truncating from ${totalMessages} to ${keepCount} most recent messages`,
  };
}
