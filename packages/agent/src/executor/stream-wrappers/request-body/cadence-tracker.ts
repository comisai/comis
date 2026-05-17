// SPDX-License-Identifier: Apache-2.0
/**
 * Cadence-tracker session state + clear helper.
 *
 * Lives apart from cache-breakpoints.ts so breakpoint-placement.ts and
 * the factory can both depend on the tracker state without pulling in the
 * full cache-breakpoints module (which would force a circular dep through
 * cache-control-block.ts).
 *
 * Tracks consecutive turns of same-side cadence (slow vs fast) so the
 * factory can promote recent-zone TTL to "long" when user pauses
 * consistently exceed 5 minutes.
 *
 * @module
 */

export interface CadenceTrackerEntry {
  consecutiveSlowTurns: number;
  consecutiveFastTurns: number;
  promoted: boolean;
  lastObservedResponseTs: number | undefined;
}

export const sessionCadenceTracker = new Map<string, CadenceTrackerEntry>();

export function clearSessionCadenceTracker(sessionKey: string): void {
  sessionCadenceTracker.delete(sessionKey);
}

export const SLOW_CADENCE_PROMOTION_THRESHOLD = 3;
export const FAST_CADENCE_DEMOTION_THRESHOLD = 5;
export const SLOW_CADENCE_MS = 5 * 60 * 1000; // 5 minutes
