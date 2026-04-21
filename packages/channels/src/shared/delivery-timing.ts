// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery timing calculator -- pure function that computes inter-block
 * delays for 4 modes: off, natural, custom, adaptive.
 *
 * Consumes DeliveryTimingConfig from @comis/core.
 * No side effects, no timers -- just math. The block pacer handles
 * actual setTimeout/AbortSignal mechanics.
 */

import type { DeliveryTimingConfig } from "@comis/core";

/** Context about the block being delivered, used to compute adaptive delays. */
export interface BlockTimingContext {
  /** 0-based position in the delivery sequence */
  blockIndex: number;
  /** Total blocks being delivered in this response */
  totalBlocks: number;
  /** Character count of this block */
  blockCharCount: number;
  /** Convenience: blockIndex === 0 */
  isFirstBlock: boolean;
}

/**
 * Apply symmetric jitter to a base delay, clamped to non-negative.
 *
 * Jitter is centered: random offset in [-jitterMs/2, +jitterMs/2].
 * Result is always >= 0.
 */
function applyJitter(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return baseMs;
  const offset = (Math.random() - 0.5) * jitterMs;
  return Math.max(0, baseMs + offset);
}

/**
 * Natural mode: random delay between minMs and maxMs, plus jitter.
 * Defaults are 800-2500ms per schema.
 */
function naturalDelay(config: DeliveryTimingConfig): number {
  const base = Math.random() * (config.maxMs - config.minMs) + config.minMs;
  return applyJitter(base, config.jitterMs);
}

/**
 * Custom mode: same math as natural -- random between user-specified
 * minMs and maxMs, plus jitter. The distinction is semantic (user
 * deliberately chose these values).
 */
function customDelay(config: DeliveryTimingConfig): number {
  const base = Math.random() * (config.maxMs - config.minMs) + config.minMs;
  return applyJitter(base, config.jitterMs);
}

/**
 * Adaptive mode: combine block length and position signals.
 *
 * - Length signal: longer blocks produce longer delays (reading time).
 *   Capped at 2.0x for blocks >= 500 chars.
 * - Position signal: earlier blocks delivered faster (0.5x at start),
 *   later blocks slower (1.0x at end).
 * - Conversation pace: stubbed as 1.0 (deferred TIMING-D01).
 *
 * Signals are multiplied and scaled between minMs-maxMs.
 */
function adaptiveDelay(
  config: DeliveryTimingConfig,
  ctx: BlockTimingContext,
): number {
  const lengthFactor = Math.min(ctx.blockCharCount / 500, 2.0);
  const positionFactor =
    0.5 + (ctx.blockIndex / Math.max(ctx.totalBlocks, 1)) * 0.5;
  // Conversation pace stubbed (deferred)
  const paceFactor = 1.0;

  const combined = lengthFactor * positionFactor * paceFactor;
  const base = config.minMs + (config.maxMs - config.minMs) * combined;
  const clamped = Math.min(Math.max(base, config.minMs), config.maxMs);
  return applyJitter(clamped, config.jitterMs);
}

/**
 * Calculate the inter-block delivery delay in milliseconds.
 *
 * For the first block (ctx.isFirstBlock === true):
 * - If firstBlockDelayMs === 0, returns 0 (immediate delivery).
 * - If firstBlockDelayMs > 0, returns that delay with jitter applied.
 *
 * For subsequent blocks, dispatches to the configured mode.
 * Returns 0 for "off" mode.
 */
export function calculateDelay(
  config: DeliveryTimingConfig,
  ctx: BlockTimingContext,
): number {
  // First block handling
  if (ctx.isFirstBlock) {
    return config.firstBlockDelayMs > 0
      ? applyJitter(config.firstBlockDelayMs, config.jitterMs)
      : 0;
  }

  switch (config.mode) {
    case "off":
      return 0;
    case "natural":
      return naturalDelay(config);
    case "custom":
      return customDelay(config);
    case "adaptive":
      return adaptiveDelay(config, ctx);
  }
}
