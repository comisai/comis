// SPDX-License-Identifier: Apache-2.0
/**
 * Stall detection with per-phase multipliers for lifecycle reactions.
 *
 * Computes per-phase stall thresholds by applying multipliers to the
 * configurable base thresholds (stallSoftMs, stallHardMs). Phases with
 * longer expected durations (coding, web, media) get higher multipliers
 * to avoid false stall warnings.
 */

import type { LifecycleReactionsTimingConfig } from "@comis/core";
import type { LifecyclePhase } from "./lifecycle-state-machine.js";

/**
 * Stall time multipliers per lifecycle phase.
 *
 * Higher multipliers for phases that are expected to take longer:
 * - coding (2.0x): Long-running bash/code operations
 * - web (1.5x): Network-bound operations
 * - media (3.0x): Image/video/audio processing
 * - thinking/memory/tool (1.0x): Standard processing time
 *
 * Phases not listed (idle, queued, done, error, stall_soft, stall_hard)
 * default to 1.0x via getPhaseMultiplier().
 */
export const PHASE_MULTIPLIERS: Record<string, number> = {
  thinking: 1.0,
  memory: 1.0,
  tool: 1.0,
  coding: 2.0,
  web: 1.5,
  media: 3.0,
};

/** Computed stall thresholds for a specific phase. */
export interface StallThresholds {
  /** Soft stall warning threshold in milliseconds. */
  softMs: number;
  /** Hard stall warning threshold in milliseconds. */
  hardMs: number;
}

/**
 * Returns the stall time multiplier for a given lifecycle phase.
 *
 * Defaults to 1.0 for phases not explicitly listed in PHASE_MULTIPLIERS
 * (idle, queued, done, error, stall_soft, stall_hard).
 */
export function getPhaseMultiplier(phase: LifecyclePhase): number {
  return PHASE_MULTIPLIERS[phase] ?? 1.0;
}

/**
 * Computes stall detection thresholds for a specific phase.
 *
 * Multiplies the base timing thresholds (stallSoftMs, stallHardMs) by
 * the phase-specific multiplier.
 *
 * @example
 * ```ts
 * // Default timing: stallSoftMs=15000, stallHardMs=30000
 * computeStallThresholds("coding", timing)
 * // => { softMs: 30000, hardMs: 60000 } (2.0x multiplier)
 *
 * computeStallThresholds("media", timing)
 * // => { softMs: 45000, hardMs: 90000 } (3.0x multiplier)
 * ```
 */
export function computeStallThresholds(
  phase: LifecyclePhase,
  timing: Pick<LifecycleReactionsTimingConfig, "stallSoftMs" | "stallHardMs">,
): StallThresholds {
  const multiplier = getPhaseMultiplier(phase);
  return {
    softMs: timing.stallSoftMs * multiplier,
    hardMs: timing.stallHardMs * multiplier,
  };
}
