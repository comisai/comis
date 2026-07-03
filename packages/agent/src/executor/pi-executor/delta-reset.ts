// SPDX-License-Identifier: Apache-2.0
/**
 * Composes the optional channel streaming callback with a throttled
 * stall-timer reset.
 *
 * Stream deltas — text AND thinking — are model activity: they must extend
 * the stall budget exactly like tool completions do, or a silent local
 * prefill that streams thinking (but no tool calls) dies at the whole-turn
 * race while visibly working.
 *
 * @module
 */

import type { ClockPort } from "@comis/core";

/**
 * State surface for the composer factory. Empty fields-wise — the canonical
 * `state` first param satisfies the closure-extraction protocol (every
 * pi-executor/ export accepts state explicitly); all inputs ride the `args`
 * parameter (the session-bootstrap.ts `SessionBootstrapState` convention).
 */
export interface DeltaResetState {
  readonly _empty?: never;
}

/**
 * Build the ALWAYS-DEFINED bridge `onDelta`: resets the stall timer
 * (throttled) and forwards the delta to the channel callback (when present)
 * — in that order.
 *
 * - ALWAYS-DEFINED — the bridge presence-gates on `deps.onDelta`
 *   (pi-event-bridge.ts `message_update` case), so a missing channel
 *   callback must not silently disable delta→reset. Channel-less runs
 *   (cron, graph subagents) stream deltas too.
 * - RESET BEFORE FORWARD — the reset is the
 *   safety-relevant half of the composition and must not be hostage to the
 *   forwarding half: a throwing channel callback propagates to the bridge's
 *   message_update catch (swallowed there), so forwarding first would skip
 *   the reset on EVERY delta and a visibly-streaming turn would die at the
 *   stall budget despite continuous activity.
 * - LIVE ref — `getResetTimer` reads the reset fn at call time
 *   (`currentResetTimer` is assigned later, at the `onResetTimer` hand-off
 *   when the prompt race starts). A delta arriving before assignment is a
 *   correct no-op, never a captured-undefined bug.
 * - Throttled ~1/s — resetting a timer per token is needless churn;
 *   a hand-rolled clock compare touches no timer between throttle windows.
 *   The first delta always resets.
 * - WALL-CLOCK REGRESSION SAFE — `ClockPort.now()` is
 *   epoch ms, not monotonic: a backwards system-clock step (NTP correction,
 *   RTC fix after resume) would otherwise make `now - lastResetAtMs`
 *   negative and starve resets for the full step duration while the
 *   (monotonic) stall timer keeps counting — a spurious stall kill on a
 *   visibly-working turn. Re-baselining on regression bounds the starvation
 *   to one throttle window. Forward jumps stay harmless (extra resets).
 * - Unconditional for all providers — the timer is entirely client-side,
 *   so there is no `enabled` flag and no per-provider gating.
 */
export function createDeltaResetComposer(
  state: Readonly<DeltaResetState>,
  args: {
    channelOnDelta: ((delta: string, kind: "text" | "thinking") => void) | undefined;
    getResetTimer: () => (() => void) | undefined;
    clock: ClockPort;
    /** Minimum ms between stall-timer resets. Default 1_000 (~1/s). */
    throttleMs?: number;
  },
): (delta: string, kind: "text" | "thinking") => void {
  void state;
  const throttleMs = args.throttleMs ?? 1_000;
  let lastResetAtMs = Number.NEGATIVE_INFINITY; // first delta always resets
  return (delta, kind) => {
    const now = args.clock.now();
    if (now < lastResetAtMs) lastResetAtMs = now; // wall clock stepped backwards — re-baseline
    if (now - lastResetAtMs >= throttleMs) {
      lastResetAtMs = now;
      args.getResetTimer()?.();
    }
    args.channelOnDelta?.(delta, kind);
  };
}
