// SPDX-License-Identifier: Apache-2.0
/**
 * LAT-02 (Phase 177): composes the optional channel streaming callback with a
 * throttled stall-timer reset.
 *
 * Stream deltas — text AND thinking — are model activity: they must extend
 * the stall budget exactly like tool completions do, or a silent local
 * prefill that streams thinking (but no tool calls) dies at the whole-turn
 * race while visibly working (Critical Finding 6).
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
 * Build the ALWAYS-DEFINED bridge `onDelta`: forwards the delta to the
 * channel callback (when present) and resets the stall timer, throttled.
 *
 * - ALWAYS-DEFINED — the bridge presence-gates on `deps.onDelta`
 *   (pi-event-bridge.ts `message_update` case), so a missing channel
 *   callback must not silently disable delta→reset. Channel-less runs
 *   (cron, graph subagents) stream deltas too.
 * - LIVE ref — `getResetTimer` reads the reset fn at call time
 *   (`currentResetTimer` is assigned later, at the `onResetTimer` hand-off
 *   when the prompt race starts). A delta arriving before assignment is a
 *   correct no-op, never a captured-undefined bug (Pitfall 2).
 * - Throttled ~1/s — resetting a timer per token is needless churn (R-7);
 *   a hand-rolled clock compare touches no timer between throttle windows
 *   (T-177-10). The first delta always resets.
 * - Unconditional for all providers — 177-01 DECISION gate_scope:
 *   all-providers (the timer is entirely client-side; no `enabled` flag).
 */
export function createDeltaResetComposer(
  state: Readonly<DeltaResetState>,
  args: {
    channelOnDelta: ((delta: string, kind: "text" | "thinking") => void) | undefined;
    getResetTimer: () => (() => void) | undefined;
    clock: ClockPort;
    /** Minimum ms between stall-timer resets. Default 1_000 (~1/s, R-7). */
    throttleMs?: number;
  },
): (delta: string, kind: "text" | "thinking") => void {
  void state;
  const throttleMs = args.throttleMs ?? 1_000;
  let lastResetAtMs = Number.NEGATIVE_INFINITY; // first delta always resets
  return (delta, kind) => {
    args.channelOnDelta?.(delta, kind);
    const now = args.clock.now();
    if (now - lastResetAtMs >= throttleMs) {
      lastResetAtMs = now;
      args.getResetTimer()?.();
    }
  };
}
