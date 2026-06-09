// SPDX-License-Identifier: Apache-2.0
/**
 * Context-engine error types (Phase 166 CWF-02).
 *
 * These named error classes cross the transformContext boundary so the executor
 * can map them to the correct finishReason without inspecting string messages.
 */

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
      `Context exhausted: assembled ${assembledTokens} tokens leaves no room in effective window ${effectiveWindow}`,
    );
  }
}
