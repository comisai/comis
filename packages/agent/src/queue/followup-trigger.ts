// SPDX-License-Identifier: Apache-2.0
/**
 * Follow-Up Trigger: Enqueues continuation agent runs after tool results or compaction.
 *
 * When the agent produces a result that indicates more work is needed (e.g.,
 * tool_result with needs_followup, or compaction_triggered), this module
 * creates a synthetic follow-up NormalizedMessage and tracks chain depth
 * to prevent infinite loops.
 *
 * @module
 */

import type { NormalizedMessage, SessionKey } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FollowupTriggerDeps {
  readonly maxFollowupRuns: number;
  readonly followupOnCompaction: boolean;
}

export interface FollowupTrigger {
  /** Check if a follow-up run should be enqueued based on execution result metadata */
  shouldFollowup(resultMetadata: Record<string, unknown>): boolean;
  /** Create a synthetic follow-up NormalizedMessage */
  createFollowupMessage(
    sessionKey: SessionKey,
    channelType: string,
    channelId: string,
    reason: "tool_result" | "compaction",
    chainId: string,
    chainDepth: number,
    extraMetadata?: Record<string, unknown>,
  ): NormalizedMessage;
  /** Get current chain depth for a chain ID */
  getChainDepth(chainId: string): number;
  /** Increment chain depth, returns the new depth */
  incrementChain(chainId: string): number;
  /** Clear chain tracking (call on session expiry or manual reset) */
  clearChain(chainId: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a follow-up trigger with configurable depth limits.
 *
 * @param deps - Configuration for max depth and compaction trigger behavior
 * @returns FollowupTrigger instance
 */
export function createFollowupTrigger(deps: FollowupTriggerDeps): FollowupTrigger {
  const chainDepths = new Map<string, number>();

  return {
    shouldFollowup(resultMetadata: Record<string, unknown>): boolean {
      if (resultMetadata.needs_followup === true) return true;
      if (resultMetadata.compaction_triggered === true && deps.followupOnCompaction) return true;
      return false;
    },

    createFollowupMessage(
      sessionKey: SessionKey,
      channelType: string,
      channelId: string,
      reason: "tool_result" | "compaction",
      chainId: string,
      chainDepth: number,
      extraMetadata?: Record<string, unknown>,
    ): NormalizedMessage {
      return {
        id: `followup-${chainId}-${chainDepth}`,
        channelId,
        channelType,
        senderId: "system",
        text: "[System: Continue processing. Previous results are in your conversation history.]",
        timestamp: Date.now(),
        attachments: [],
        metadata: {
          isFollowup: true,
          followupChainId: chainId,
          followupChainDepth: chainDepth,
          followupReason: reason,
          ...extraMetadata,
        },
      };
    },

    getChainDepth(chainId: string): number {
      return chainDepths.get(chainId) ?? 0;
    },

    incrementChain(chainId: string): number {
      const current = chainDepths.get(chainId) ?? 0;
      const next = current + 1;
      chainDepths.set(chainId, next);
      return next;
    },

    clearChain(chainId: string): void {
      chainDepths.delete(chainId);
    },
  };
}
