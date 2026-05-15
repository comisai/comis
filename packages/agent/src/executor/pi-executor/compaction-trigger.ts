// SPDX-License-Identifier: Apache-2.0
/**
 * Compaction-flush event handler — wires the `compaction:flush` event bus
 * subscription that resets lifecycle timers, notifies the cache-break
 * detector, and clears session latches after a compaction cycle completes.
 *
 * Phase 42 split per EXEC-SPLIT-05/06.
 *
 * Closure-extraction protocol: state-by-parameter (Readonly<CompactionTriggerState>).
 * The state surface is intentionally empty (`{}`) — this helper installs an
 * event-bus listener that only reads from `deps` (logger, eventBus). It is
 * kept under the `state, deps` first-param contract so the EXEC-SPLIT-06
 * structural test treats it uniformly with the other closure-extracted
 * helpers.
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";

import type { PiExecutorDeps } from "./pi-executor-types.js";
import { resetTrackerTimers } from "../tool-lifecycle.js";
import {
  getCacheBreakDetector,
  clearSessionLatches,
} from "../executor-session-state.js";

/**
 * State surface required by the compaction-flush handler. Empty by design
 * (the handler reads from `deps` only) — the field-less Readonly shape
 * preserves the EXEC-SPLIT-06 closure-extraction contract (`state` first,
 * `deps` second) so the structural test treats this helper uniformly.
 *
 * Future fields (if compaction ever needs per-agent state) can be added
 * without breaking the call-site.
 */
export interface CompactionTriggerState {
  readonly _empty?: never;
}

/**
 * Install the `compaction:flush` event-bus listener. Called once per factory
 * construction (in `createPiExecutor`), before the executor returns. The
 * listener resets per-session lifecycle timers, notifies the cache-break
 * detector to reset its baseline, and clears session latches for a fresh
 * cache cycle after compaction.
 *
 * Side effects (intentional):
 *  - `deps.eventBus.on("compaction:flush", …)` — subscription persists for
 *    the lifetime of the executor.
 *  - Per-event: `resetTrackerTimers` (Map.delete on present keys);
 *    `getCacheBreakDetector(...).notifyCompaction`; `clearSessionLatches`
 *    (all idempotent / Map-membership-checked).
 */
export function installCompactionTrigger(
  state: Readonly<CompactionTriggerState>,
  deps: PiExecutorDeps,
): void {
  // Acknowledge the readonly state parameter (preserves closure-extraction
  // contract; the helper currently has no per-agent state). Casting through
  // `void` keeps the no-unused-vars lint quiet without disabling it.
  void state;
  // Compaction resets lifecycle timers (prevents stale demotion data).
  // Uses resetTrackerTimers which checks Map membership -- never creates phantom entries.
  deps.eventBus.on("compaction:flush", (event) => {
    const key = formatSessionKey(event.sessionKey);
    if (resetTrackerTimers(key)) {
      deps.logger.info(
        { sessionKey: key },
        "Tool lifecycle timers reset after compaction",
      );
    }
    // Notify cache break detector of compaction (resets baseline).
    getCacheBreakDetector(deps.logger).notifyCompaction(key);
    // Reset latches for fresh cache cycle after compaction
    clearSessionLatches(key);
  });
}
