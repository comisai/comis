// SPDX-License-Identifier: Apache-2.0
/**
 * Microcompaction orchestration.
 *
 * Three trigger paths consolidated here:
 *  - `runTimeBasedMicrocompact`: TTL-expiry trigger. Runs when more than
 *    one TTL window has elapsed since the last assistant response. Calls
 *    `onAdaptiveRetentionReset` on success.
 *  - `runTokenCeilingMicrocompact`: token-budget trigger. Runs when the
 *    estimated context size exceeds the configured ceiling. Does NOT call
 *    `onAdaptiveRetentionReset` because the cache may still be warm.
 *  - `runEveryTurnMicrocompact`: UNCONDITIONAL every-turn pass. Runs
 *    on every turn regardless of TTL/ceiling so the long-running coordinator's
 *    context stays flat, not only after an idle gap. Fence-protected
 *    and, like the ceiling trigger, does NOT reset adaptive retention (the cache
 *    may still be warm). Clears tool results only — never thinking blocks, which
 *    `stripReplayThinking` already handles on the cached prefix.
 *
 * All delegate to `clearStaleToolResults` (+ `clearStaleThinkingBlocks` for the
 * TTL/ceiling triggers, tool-result-clearing.ts) and protect messages at/below
 * the cache fence.
 *
 * @module
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ComisLogger } from "@comis/core";

import { CHARS_PER_TOKEN_RATIO } from "../../../context-engine/index.js";
import { estimateContextChars } from "../../../safety/token-estimator.js";
import {
  clearStaleThinkingBlocks,
  clearStaleToolResults,
} from "./tool-result-clearing.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Time-based microcompact -- clear stale tool results when cache is cold.
 * Runs BEFORE breakpoint placement because clearing results changes message sizes.
 * Fence-aware -- skip clearing messages at/below the previous turn's
 * cache fence to preserve prefix stability after cache breaks.
 */
export function runTimeBasedMicrocompact(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (!config.getElapsedSinceLastResponse || !config.sessionKey) return;
  const elapsed = config.getElapsedSinceLastResponse();
  if (elapsed === undefined) return;
  // Determine TTL from current retention (pre-latch, since we're checking if cache is cold)
  const baseRetentionForTtl = config.getCacheRetention() ?? "long";
  const ttlMs = baseRetentionForTtl === "long" ? 3_600_000 : 300_000;
  if (elapsed <= ttlMs || !Array.isArray(result.messages)) return;

  const keepWindow = config.observationKeepWindow ?? 25;
  const microcompactFence = config.getCacheFenceIndex?.() ?? -1;
  const cleared = clearStaleToolResults(
    result.messages as Array<Record<string, unknown>>,
    keepWindow,
    microcompactFence,
  );
  // Also clear thinking blocks from old assistant messages
  const thinkingCleared = clearStaleThinkingBlocks(
    result.messages as Array<Record<string, unknown>>,
    keepWindow,
    microcompactFence,
  );
  if (cleared > 0 || thinkingCleared > 0) {
    config.onContentModification?.();
    if (cleared > 0) config.onAdaptiveRetentionReset?.();
    logger.debug(
      { cleared, thinkingCleared, elapsedMs: elapsed, ttlMs, keepWindow, sessionKey: config.sessionKey },
      "Time-based microcompact cleared stale content",
    );
  }
}

/**
 * Token-ceiling microcompact -- clear stale content when context grows too large.
 * Runs independently of TTL: a session with rapid back-and-forth can accumulate massive
 * context within a single TTL window. Unlike TTL trigger, does NOT reset adaptive retention
 * because the cache may still be warm.
 * Fence-aware -- respects cache fence.
 */
export function runTokenCeilingMicrocompact(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (!config.microcompactTokenCeiling || !config.sessionKey) return;
  const msgs = result.messages as Array<Record<string, unknown>>;
  if (!Array.isArray(msgs)) return;
  // flat-by-design: aggregate in-request hygiene trigger over estimateContextChars; the request-body accounting roots (estimateBlockTokens) are factored
  const estimatedTokens = estimateContextChars(msgs as unknown as Message[]) / CHARS_PER_TOKEN_RATIO;
  if (estimatedTokens <= config.microcompactTokenCeiling) return;

  const keepWindow = config.observationKeepWindow ?? 25;
  const ceilingFence = config.getCacheFenceIndex?.() ?? -1;
  const cleared = clearStaleToolResults(msgs, keepWindow, ceilingFence);
  const thinkingCleared = clearStaleThinkingBlocks(msgs, keepWindow, ceilingFence);
  if (cleared > 0 || thinkingCleared > 0) {
    config.onContentModification?.();
    // NOTE: Do NOT call onAdaptiveRetentionReset -- cache may still be warm
    logger.debug(
      { cleared, thinkingCleared, estimatedTokens: Math.round(estimatedTokens), ceiling: config.microcompactTokenCeiling, sessionKey: config.sessionKey },
      "Token-ceiling microcompact cleared stale content",
    );
  }
}

/**
 * Every-turn microcompact -- unconditional Tier-0 pass.
 *
 * Unlike the TTL and token-ceiling triggers (which only fire after an idle gap or
 * once the context crosses a size ceiling), this runs on EVERY turn so a long-running
 * coordinator's context stays flat continuously rather than only recovering after an
 * idle period. It clears stale compactable tool results beyond the keep window.
 *
 * Cache-stable: threads `getCacheFenceIndex()` so it never clears at/below
 * the cached prefix (a clear inside the fence would re-pay cache_creation on the whole
 * suffix every turn), keeps the last `observationKeepWindow` results, and -- because the
 * cleared-result placeholder is byte-stable and frozen by tool-call-id -- the cached
 * prefix stays byte-identical turn-over-turn. Like `runTokenCeilingMicrocompact`, it
 * does NOT call `onAdaptiveRetentionReset` (the cache may still be warm); it only signals
 * `onContentModification` so the cache-break detector treats the change as deliberate.
 *
 * Tool results only -- thinking blocks on the cached prefix are handled by
 * `stripReplayThinking` upstream in the onPayload pipeline.
 */
export function runEveryTurnMicrocompact(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (!config.sessionKey || !Array.isArray(result.messages)) return;

  const keepWindow = config.observationKeepWindow ?? 25;
  const fence = config.getCacheFenceIndex?.() ?? -1;
  const cleared = clearStaleToolResults(
    result.messages as Array<Record<string, unknown>>,
    keepWindow,
    fence,
  );
  if (cleared > 0) {
    config.onContentModification?.();
    // NOTE: Do NOT call onAdaptiveRetentionReset -- the every-turn pass runs on a
    // (possibly) warm cache, mirroring runTokenCeilingMicrocompact.
    logger.debug(
      { cleared, keepWindow, fence, sessionKey: config.sessionKey, step: "every-turn-microcompact" },
      "Every-turn Tier-0 microcompact cleared stale results",
    );
  }
}
