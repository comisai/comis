// SPDX-License-Identifier: Apache-2.0
/**
 * Overflow recovery: detects context-exhausted errors and automatically
 * reduces context via two-phase strategy -- truncation of oversized tool
 * results, then emergency compaction of old tool results to placeholders.
 *
 * Truncate oversized tool results to 30% of window
 * Emergency compact all old tool results if still over budget
 * Retry LLM call with reduced context (handled by caller)
 * Log recovery outcome at INFO (handled by caller)
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/infra";

import { estimateMessageChars, estimateContextChars } from "../safety/token-estimator.js";
import { createToolResultSizeGuard, type ContentBlock } from "../safety/tool-result-size-guard.js";
import type { StreamFnWrapper } from "./stream-wrappers/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OverflowRecoveryConfig {
  /** Max total context chars (from agent config). Used to compute 30% truncation target. */
  maxContextChars: number;
  /** Fraction of window to truncate oversized results to. Default: 0.3 (30%). */
  truncationTargetRatio?: number;
}

export interface OverflowRecoveryResult {
  /** Whether recovery succeeded and context was reduced. */
  recovered: boolean;
  /** Action taken: 'truncated' | 'compacted' | 'both' | 'none'. */
  action: "truncated" | "compacted" | "both" | "none";
  /** Total chars freed by recovery. */
  charsFreed: number;
  /** Messages array after recovery (for retry). Only present if recovered=true. */
  recoveredMessages?: Message[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an overflow recovery handler with the given config and logger.
 *
 * The `recover` method applies a two-phase strategy to reduce context size:
 *
 * Phase 1: Truncate oversized tool results to a fraction of the context window.
 * Phase 2: Emergency-compact old tool results (before last assistant message)
 *          to placeholder text if total still exceeds the budget.
 *
 * Does not mutate the input messages array.
 *
 * @param config - Recovery configuration (maxContextChars, truncationTargetRatio)
 * @param logger - Logger for DEBUG output (caller handles INFO)
 * @returns Object with `recover(messages)` method
 */
export function createOverflowRecovery(
  config: OverflowRecoveryConfig,
  logger: ComisLogger,
): { recover(messages: readonly Message[]): OverflowRecoveryResult } {
  const sizeGuard = createToolResultSizeGuard();

  return {
    recover(messages: readonly Message[]): OverflowRecoveryResult {
      // Never mutate the input -- shallow copy individual entries as needed
      const msgs: Message[] = [...messages];

      const truncationTarget = Math.floor(
        config.maxContextChars * (config.truncationTargetRatio ?? 0.3),
      );

      // ---------------------------------------------------------------
      // Phase 1: Truncate oversized tool results
      // ---------------------------------------------------------------

      let phase1CharsFreed = 0;

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        if (msg.role !== "toolResult") continue;

        const msgChars = estimateMessageChars(msg);
        if (msgChars <= truncationTarget) continue;

        // Truncate content blocks to truncationTarget chars
        const result = sizeGuard.truncateIfNeeded(
          msg.content as ContentBlock[],
          truncationTarget,
        );

        if (!result.truncated) continue;

        const newMsg: Message = {
          ...msg,
          content: result.content as typeof msg.content,
        };

        const newChars = estimateMessageChars(newMsg);
        phase1CharsFreed += msgChars - newChars;
        msgs[i] = newMsg;

        logger.debug(
          { toolName: msg.toolName, originalChars: msgChars, truncatedTo: newChars, index: i },
          "Overflow recovery: tool result truncated",
        );
      }

      // ---------------------------------------------------------------
      // Phase 2: Emergency compact
      // ---------------------------------------------------------------

      let phase2CharsFreed = 0;
      let totalChars = estimateContextChars(msgs);

      if (totalChars > config.maxContextChars) {
        // Find the last assistant message index (protection boundary)
        let lastAssistantIndex = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]!.role === "assistant") {
            lastAssistantIndex = i;
            break;
          }
        }

        // Walk from oldest to newest, compacting tool results until within budget
        for (let i = 0; i < msgs.length && totalChars > config.maxContextChars; i++) {
          const msg = msgs[i]!;
          if (msg.role !== "toolResult") continue;

          // Protect in-flight tool results (after last assistant message)
          if (lastAssistantIndex !== -1 && i > lastAssistantIndex) continue;

          const originalChars = estimateMessageChars(msg);
          const placeholder = `[Tool result from '${msg.toolName}' emergency-compacted for overflow recovery (was ${originalChars} chars)]`;

          const compactedMsg: Message = {
            ...msg,
            content: [{ type: "text" as const, text: placeholder }] as typeof msg.content,
          };

          const newChars = estimateMessageChars(compactedMsg);
          const saved = originalChars - newChars;
          phase2CharsFreed += saved;
          totalChars -= saved;
          msgs[i] = compactedMsg;

          logger.debug(
            { toolName: msg.toolName, originalChars, index: i },
            "Overflow recovery: tool result emergency-compacted",
          );
        }
      }

      // ---------------------------------------------------------------
      // Build result
      // ---------------------------------------------------------------

      const charsFreed = phase1CharsFreed + phase2CharsFreed;
      let action: OverflowRecoveryResult["action"];

      if (phase1CharsFreed > 0 && phase2CharsFreed > 0) {
        action = "both";
      } else if (phase1CharsFreed > 0) {
        action = "truncated";
      } else if (phase2CharsFreed > 0) {
        action = "compacted";
      } else {
        action = "none";
      }

      const recovered = charsFreed > 0;

      return {
        recovered,
        action,
        charsFreed,
        ...(recovered ? { recoveredMessages: msgs } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// One-shot StreamFnWrapper for retry integration
// ---------------------------------------------------------------------------

/**
 * Create a one-shot StreamFnWrapper that applies overflow recovery on its
 * first invocation, then passes through unchanged on subsequent calls.
 *
 * This wrapper is designed to be temporarily prepended to the wrapper chain
 * (outermost position) when a context overflow error is detected. On the
 * retry `session.prompt()` call, it intercepts the context, applies the
 * two-phase recovery (truncation + emergency compaction), and delegates
 * to the next wrapper with the reduced context. After firing once, it
 * becomes a transparent pass-through.
 *
 * @param config - Recovery configuration (maxContextChars, truncationTargetRatio)
 * @param logger - Logger for DEBUG/INFO output
 * @returns A named StreamFnWrapper ("overflowRecoveryWrapper") and the
 *          recovery result (populated after first invocation)
 */
export function createOverflowRecoveryWrapper(
  config: OverflowRecoveryConfig,
  logger: ComisLogger,
): { wrapper: StreamFnWrapper; getResult(): OverflowRecoveryResult | undefined } {
  let fired = false;
  let result: OverflowRecoveryResult | undefined;

  const wrapper: StreamFnWrapper = function overflowRecoveryWrapper(next: StreamFn): StreamFn {
    return (model, context, options) => {
      if (fired) {
        // Already applied -- pass through unchanged
        return next(model, context, options);
      }

      fired = true;

      const recovery = createOverflowRecovery(config, logger);
      result = recovery.recover(context.messages);

      if (!result.recovered || !result.recoveredMessages) {
        // Nothing to recover -- pass through unchanged
        return next(model, context, options);
      }

      logger.info(
        {
          action: result.action,
          charsFreed: result.charsFreed,
          hint: `Overflow recovery ${result.action}: freed ${result.charsFreed} chars, retrying LLM call`,
          errorKind: "resource" as const,
        },
        "Context overflow recovery applied",
      );

      const recoveredContext: Context = {
        ...context,
        messages: result.recoveredMessages,
      };

      return next(model, recoveredContext, options);
    };
  };

  return {
    wrapper,
    getResult() {
      return result;
    },
  };
}
