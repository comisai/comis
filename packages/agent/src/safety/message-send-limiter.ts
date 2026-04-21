// SPDX-License-Identifier: Apache-2.0
/**
 * Per-execution message send rate limiter.
 *
 * Prevents runaway LLM loops from spamming users with dozens of
 * intermediate/progress/debug messages during a single agentic execution.
 * Every message.send delivers a real phone notification.
 *
 * Tracks message.send and message.reply tool calls per execution and blocks
 * after a configurable threshold. Other message actions (react, edit, delete,
 * fetch, attach) and non-message tools are always allowed.
 *

 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the message send limiter. */
export interface MessageSendLimiterConfig {
  /** Maximum message.send/reply calls per execution (0 = no limit). */
  maxSendsPerExecution: number;
}

/** Verdict returned by check() -- block or allow. */
export interface MessageSendVerdict {
  block: boolean;
  reason: string;
}

/** Per-execution message send limiter interface. */
export interface MessageSendLimiter {
  /** Check whether a tool call should be blocked. Returns undefined to allow, verdict to block. */
  check(toolName: string, args: Record<string, unknown>): MessageSendVerdict | undefined;
  /** Reset the counter (e.g., between executions). */
  reset(): void;
  /** Current send count. */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Actions that count toward the send limit. */
const COUNTED_ACTIONS = new Set(["send", "reply"]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a per-execution message send limiter.
 *
 * Follows the same factory-function-returning-interface pattern as
 * createToolRetryBreaker() and createCircuitBreaker().
 *
 * @param config - Limiter configuration (maxSendsPerExecution)
 * @returns MessageSendLimiter instance
 */
export function createMessageSendLimiter(config: MessageSendLimiterConfig): MessageSendLimiter {
  const { maxSendsPerExecution } = config;
  let sendCount = 0;

  return {
    check(toolName: string, args: Record<string, unknown>): MessageSendVerdict | undefined {
      // Only count message tool calls
      if (toolName !== "message") return undefined;

      // Only count send/reply actions
      const action = args.action as string | undefined;
      if (!action || !COUNTED_ACTIONS.has(action)) return undefined;

      // Unlimited mode
      if (maxSendsPerExecution <= 0) {
        sendCount++;
        return undefined;
      }

      // Within limit
      if (sendCount < maxSendsPerExecution) {
        sendCount++;
        return undefined;
      }

      // Over limit -- block
      return {
        block: true,
        reason:
          `Message send limit reached (${maxSendsPerExecution} per execution). ` +
          `Do not call message(action=send) or message(action=reply) again. ` +
          `Compose your remaining response as normal reply text instead.`,
      };
    },

    reset(): void {
      sendCount = 0;
    },

    get count(): number {
      return sendCount;
    },
  };
}
