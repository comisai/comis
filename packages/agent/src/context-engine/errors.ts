// SPDX-License-Identifier: Apache-2.0
/**
 * Context-engine error types (Phase 166 CWF-02).
 *
 * These named error classes cross the transformContext boundary so the executor
 * can map them to the correct finishReason without inspecting string messages.
 */

/**
 * Stable prefix of every ContextExhaustionError message.
 *
 * HR-01 (v2.19): when this error is thrown by the pre-flight during a MID-TURN
 * continuation, the pi-ai SDK converts the throw into a turn_end with
 * stopReason:"error" and a STRING errorMessage — the `instanceof` is lost, so
 * the top-level handleEnvelopeException mapping never runs. The bridge recovers
 * the signal at that boundary via `isContextExhaustionErrorMessage()`. Sharing
 * this prefix between the constructor and the predicate keeps the contract from
 * drifting (no magic literal in the bridge). See design/small-model-orchestration-fidelity.md §4.
 */
export const CONTEXT_EXHAUSTION_MESSAGE_PREFIX = "Context exhausted: assembled" as const;

/** Thrown by lcd-assembler.transformContext when assembled input cannot fit in the
 *  effective window even after eviction, preamble trimming, and thinking down-shift.
 *  Caught by the executor and mapped to finishReason: "context_exhausted".
 *  Design ref: design/small-model-context-fidelity.md §4 Fix 3 item 2d. */
export class ContextExhaustionError extends Error {
  override name = "ContextExhaustionError" as const;
  constructor(
    public readonly effectiveWindow: number,
    public readonly assembledTokens: number,
  ) {
    super(
      `${CONTEXT_EXHAUSTION_MESSAGE_PREFIX} ${assembledTokens} tokens leaves no room in effective window ${effectiveWindow}`,
    );
  }
}

/**
 * True when an error MESSAGE string is a ContextExhaustionError surfaced across a
 * boundary that strips the type (the SDK's turn_end-error conversion). Used by the
 * bridge to map a mid-turn context-exhaustion throw to finishReason:"context_exhausted"
 * so the executor delivers the honest degraded reply instead of the empty-turn
 * recovery's "the work was done" synthesis. Pure; tolerant of undefined/empty.
 */
export function isContextExhaustionErrorMessage(message: string | undefined): boolean {
  return typeof message === "string" && message.startsWith(CONTEXT_EXHAUSTION_MESSAGE_PREFIX);
}
