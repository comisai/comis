// SPDX-License-Identifier: Apache-2.0
/**
 * Post-payload cadence tracking (Phase 42 split per EXEC-SPLIT-02).
 *
 * Records inter-turn pause durations and decides recent-zone TTL promotion
 * (slow cadence) or demotion (fast cadence). Symmetric:
 *  - 3 consecutive slow turns (elapsed > 5 minutes) → promote to "long" TTL
 *  - 5 consecutive fast turns → demote back to "short" TTL
 *
 * Runs AFTER `onPayloadForCacheDetection` so the detection snapshot
 * reflects the pre-mutation state. Mutation takes effect on the next
 * turn's `placeCacheBreakpoints` call.
 *
 * Lifted verbatim from request-body-injector.ts:1849-1897.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

import {
  FAST_CADENCE_DEMOTION_THRESHOLD,
  SLOW_CADENCE_MS,
  SLOW_CADENCE_PROMOTION_THRESHOLD,
  sessionCadenceTracker,
} from "./cadence-tracker.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Track cadence for recent-zone TTL promotion/demotion. Mutates the
 * module-level `sessionCadenceTracker` map. The decision read by the next
 * turn's `placeCacheBreakpoints` via `cadence.promoted`.
 */
export function trackRecentZoneCadence(
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (
    !config.promoteRecentZoneOnSlowCadence ||
    !config.sessionKey ||
    !config.getElapsedSinceLastResponse ||
    !config.getLastResponseTs
  ) {
    return;
  }

  const lastResponseTs = config.getLastResponseTs();
  if (lastResponseTs === undefined) return;

  let tracker = sessionCadenceTracker.get(config.sessionKey);
  if (!tracker) {
    tracker = {
      consecutiveSlowTurns: 0,
      consecutiveFastTurns: 0,
      promoted: false,
      lastObservedResponseTs: undefined,
    };
    sessionCadenceTracker.set(config.sessionKey, tracker);
  }

  // Same-turn guard: successive onPayload calls inside one execute() all
  // observe the same lastResponseTs. Only count once per turn boundary.
  if (lastResponseTs === tracker.lastObservedResponseTs) return;

  tracker.lastObservedResponseTs = lastResponseTs;
  const elapsed = config.getElapsedSinceLastResponse();
  if (elapsed === undefined) return;

  if (elapsed > SLOW_CADENCE_MS) {
    tracker.consecutiveSlowTurns++;
    tracker.consecutiveFastTurns = 0;
    if (!tracker.promoted && tracker.consecutiveSlowTurns >= SLOW_CADENCE_PROMOTION_THRESHOLD) {
      tracker.promoted = true;
      logger.info(
        { sessionKey: config.sessionKey, consecutiveSlowTurns: tracker.consecutiveSlowTurns },
        "Recent-zone TTL promoted to long: slow cadence detected",
      );
    }
  } else {
    tracker.consecutiveFastTurns++;
    tracker.consecutiveSlowTurns = 0;
    if (tracker.promoted && tracker.consecutiveFastTurns >= FAST_CADENCE_DEMOTION_THRESHOLD) {
      tracker.promoted = false;
      logger.info(
        { sessionKey: config.sessionKey, consecutiveFastTurns: tracker.consecutiveFastTurns },
        "Recent-zone TTL demoted to short: fast cadence resumed",
      );
    }
  }
}
