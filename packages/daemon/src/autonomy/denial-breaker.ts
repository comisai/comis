// SPDX-License-Identifier: Apache-2.0
/**
 * `createDenialBreaker` — the per-`rootRunId` consecutive-floor-block counter
 * with trip-once semantics.
 *
 * The "never loop" guarantee: after N CONSECUTIVE floor-blocks a self-driving run
 * trips the breaker so the chokepoint aborts + escalates rather than
 * retry-looping and burning the aggregate budget (a DoS-on-self; the
 * per-root budget stays the independent backstop).
 *
 * This is a daemon-internal sibling of {@link createBoundedAutonomy}, modeled on
 * `tool-retry-breaker.ts`/`circuit-breaker.ts` but SIMPLER: it is a PURE counter —
 *   - NO {@link ClockPort} (the trip is count-based, not time-based — unlike the
 *     circuit breaker's resetTimeout),
 *   - NO throws (Result-style verdict per AGENTS §2.1 — it returns a verdict, the
 *     chokepoint converts it to an abort),
 *   - NO eventBus emit / killByRootRun side effect (the chokepoint owns the bus
 *     emit + kill fan-out; the breaker is pure state + a verdict + its own
 *     content-free trip log).
 *
 * CONSECUTIVE, not cumulative: {@link DenialBreaker.recordAllow} resets the
 * counter, so a single deny inside a productive loop never accumulates to a trip.
 * The trip fires on the EXACT crossing of `denialBreakerN` (`===`,
 * never `>=`) so a later deny does not re-trip — the same trip-once
 * discipline as `tool-retry-breaker.ts` (a `>=` verdict would inflate the
 * breakerTimeline and re-abort an already-aborting run).
 *
 * Trust boundary: the chokepoint (trusted, in-daemon) is the SOLE driver. It calls
 * recordDenial ONLY on a `CapabilityDeniedError` floor-block (NOT generic
 * RPC/validation errors, which would trip the breaker on noise — the same
 * classification discipline as `tool-retry-breaker.ts`), recordAllow
 * on the allow branch of a gated method, and {@link DenialBreaker.evict} at run
 * termination. So the breaker holds no untrusted input (rootRunId is a
 * daemon-minted id) and counts only genuine floor-blocks.
 *
 * @module
 */
import type { ComisLogger } from "@comis/infra";

/**
 * The verdict {@link DenialBreaker.recordDenial} returns: whether THIS denial was
 * the exact crossing of the threshold, and the current consecutive count.
 */
export interface DenialVerdict {
  /** `true` ONLY on the exact crossing of `denialBreakerN` — never on a later deny. */
  tripped: boolean;
  /** The current consecutive floor-block count for this rootRunId. */
  consecutive: number;
}

/** The per-`rootRunId` consecutive-floor-block breaker (pure state + a verdict). */
export interface DenialBreaker {
  /**
   * Count one floor-block for `rootRunId`.
   * @returns `tripped:true` ONLY on the EXACT crossing of `denialBreakerN`.
   */
  recordDenial(rootRunId: string): DenialVerdict;
  /** A successful (allowed) gated call resets the consecutive counter (a real step happened). */
  recordAllow(rootRunId: string): void;
  /** Drop a tree's counter (on run end / evict / kill) so the per-root map cannot grow unbounded. */
  evict(rootRunId: string): void;
}

/**
 * Create the per-`rootRunId` consecutive-floor-block breaker.
 *
 * @param deps.denialBreakerN - the consecutive-floor-block threshold; the run
 *   trips on the Nth consecutive floor-block (N=1 → trips on the first).
 * @param deps.logger - structured logger; the trip emits ONE content-free WARN
 *   through it (a `child({ submodule })` scope, matching the sibling modules).
 */
export function createDenialBreaker(deps: { denialBreakerN: number; logger: ComisLogger }): DenialBreaker {
  const { denialBreakerN } = deps;
  const logger = deps.logger.child({ submodule: "denial-breaker" });

  // rootRunId → consecutive floor-block count. Reset on recordAllow, dropped on
  // evict (the per-root cleanup discipline — prevents a per-cron-fire-root
  // map leak under a storm of distinct roots).
  const consecutiveByRoot = new Map<string, number>();

  return {
    recordDenial(rootRunId: string): DenialVerdict {
      const consecutive = (consecutiveByRoot.get(rootRunId) ?? 0) + 1;
      consecutiveByRoot.set(rootRunId, consecutive);

      // EXACT crossing — `===`, never `>=`, so the trip verdict fires ONCE at the
      // threshold and a later deny on an already-tripped root does not re-trip
      // (the chokepoint kills the tree on the first trip; a second trip would
      // re-abort an already-aborting run and double-count the breakerTimeline).
      const tripped = consecutive === denialBreakerN;

      if (tripped) {
        // Content-free trip WARN: errorKind + an operator hint naming
        // the knob + the count + the rootRunId (an id, not a body). NO message
        // body — the denied action's args/content never leak here. The eventBus
        // abort + killByRootRun belong to the chokepoint, not here.
        logger.warn(
          {
            rootRunId,
            consecutive,
            denialBreakerN,
            errorKind: "validation" as const,
            hint: "denial breaker tripped after N consecutive floor-blocks — the run will abort + escalate (autonomy.denialBreakerN)",
          },
          "Denial breaker tripped",
        );
      }

      return { tripped, consecutive };
    },

    recordAllow(rootRunId: string): void {
      // A real allowed step happened → reset. ONLY
      // an ACTUAL allowed gated call resets; the chokepoint guarantees this is
      // called only on the allow branch of a gated method (never on a deny).
      consecutiveByRoot.delete(rootRunId);
    },

    evict(rootRunId: string): void {
      // Run-end / evict / kill cleanup (the per-root cleanup discipline).
      // Idempotent — deleting an absent key is a no-op.
      consecutiveByRoot.delete(rootRunId);
    },
  };
}
