// SPDX-License-Identifier: Apache-2.0
/**
 * Reasoning-aware output headroom primitives (Fix 3 / Phase 166 CWF-02).
 *
 * Pure functions; no runtime deps, no I/O.
 * Consumers: lcd-assembler.ts (pre-flight fit check),
 *            config-resolver.ts (dynamic max_tokens clamp),
 *            executor-stream-setup.ts (thinking-effort governor).
 * Design ref: design/small-model-context-fidelity.md §4 Fix 3 + §3 corollaries.
 */

import { MIN_VISIBLE_OUTPUT_TOKENS } from "./constants.js";

export { MIN_VISIBLE_OUTPUT_TOKENS };

/**
 * Thinking-token reserve: tokens a model spends on its thinking block
 * BEFORE it can emit the visible answer or first tool call.
 *
 * "none" style = 0 for all levels (no thinking block emitted).
 * "native" style = empirically sized per qwen3.6:35b observed blocks.
 *
 * Sizing rationale — sized to qwen3.6:35b observed high-thinking block
 * (the NVDA incident: in 32477 + out 291 = 32768, stopReason 'length',
 * 0 tool calls — high-effort thinking consumed essentially the entire 32K window).
 * native/high=8192 is a defensible middle ground: large enough that a high-thinking
 * block is not silently truncated on a 32K window (leaves ~23K for history),
 * conservative enough not to over-evict on wide windows.
 * The governor down-shifts (high→med→low) when even this won't fit, so
 * over-reserving is self-correcting. Frontier (cap=∞) never reaches the
 * governor → byte-identical. native/xhigh=12288 (vs NATIVE_REASONING_MAIN_PATH_FLOOR=16384
 * in verification-gate.ts) leaves a 4K margin for the answer body on top of the
 * thinking block.
 */
export const THINKING_RESERVE_TOKENS: Readonly<
  Record<"none" | "native", Readonly<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", number>>>
> = {
  none:   { off: 0, minimal: 0,     low: 0,     medium: 0,     high: 0,      xhigh: 0      },
  native: { off: 0, minimal: 512,   low: 1_024, medium: 3_072, high: 8_192,  xhigh: 12_288 },
} as const;

/**
 * Compute reasoning-aware output headroom for a single dispatch.
 *
 * outputHeadroom = thinkingReserve[reasoningStyle][thinkingLevel] + MIN_VISIBLE_OUTPUT_TOKENS
 *
 * @param reasoningStyle - Model's reasoning style: "none" (standard) or "native" (thinking block).
 * @param thinkingLevel  - Configured thinking effort level.
 * @returns Total output headroom tokens to reserve from the context window.
 */
export function computeOutputHeadroom(
  reasoningStyle: "none" | "native",
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): number {
  return THINKING_RESERVE_TOKENS[reasoningStyle][thinkingLevel] + MIN_VISIBLE_OUTPUT_TOKENS;
}

/** The governor's down-shift order — the meaningful thinking levels
 *  (low through xhigh) that the thinking-effort governor can operate on. */
export const MIN_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/**
 * Down-shift a thinkingLevel by one step toward less-reserved thinking.
 *
 * Returns undefined when at or below "low" (no further down-shift possible →
 * signals context_exhaustion to the caller).
 * Does NOT down-shift "off" or "minimal" (they are already minimal-reserve
 * and cannot meaningfully trade thinking headroom for history).
 *
 * Shift map: xhigh → high → medium → low → undefined
 *
 * @param level - Current thinking level.
 * @returns The next-lower governor level, or undefined if already at floor.
 */
export function downshiftThinkingLevel(
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): "low" | "medium" | "high" | "xhigh" | undefined {
  switch (level) {
    case "xhigh":   return "high";
    case "high":    return "medium";
    case "medium":  return "low";
    case "low":
    case "minimal":
    case "off":
      return undefined; // Cannot down-shift further — signals context_exhaustion
  }
}
