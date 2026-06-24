// SPDX-License-Identifier: Apache-2.0
/**
 * The `sleep` primitive (STREAM-03).
 *
 * A builtin AgentTool the model calls to PAUSE between turns. Its whole reason
 * to exist is cost: instead of polling in a token-burning loop ("is the child
 * done yet?" every turn), the model sleeps ONCE for a duration keyed to the
 * ~5-minute prompt-cache TTL. While it sleeps, concurrency-safe reads /
 * background children keep running and the prompt cache stays warm — so pacing
 * costs zero tokens and never busts the cache. The description surfaces that
 * TTL so the model defers in a single call rather than spinning.
 *
 * Safety invariants (asserted in sleep-tool.test.ts):
 *   - The timer is the sanctioned `systemSetTimeout` (raw `setTimeout` is banned
 *     by globals.test.ts) and is `.unref()`'d, so a pending sleep NEVER blocks
 *     graceful daemon drain.
 *   - The duration is CLAMPED to `[0, MAX_SLEEP_MS]` — a negative/absurd request
 *     becomes a safe bound, never a throw and never an unbounded sleep.
 *   - The `AbortSignal` cancels the sleep promptly AND clears the timer (no
 *     handle leak across many aborted sleeps).
 *
 * The tool mutates no state — registered `isReadOnly: true, isConcurrencySafe:
 * true` in the tool-metadata registry so the parallel-execution serializer lets
 * it overlap reads.
 *
 * @module
 */

import { Type } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import { jsonResult, readNumberParam } from "../../platform-tools/tool-helpers.js";

/**
 * Upper bound on a single sleep, in milliseconds. Chosen to match the ~5-minute
 * Anthropic prompt-cache TTL the verify-only cache stack tracks: a sleep longer
 * than the cache window would let the cached prefix expire, defeating the point.
 * A request above this is clamped down to it (T-221-SLEEP-01 mitigation).
 */
export const MAX_SLEEP_MS = 300_000; // ~5 minutes

/**
 * Injectable one-shot timer, mirroring the sanctioned `systemSetTimeout` /
 * `systemClearTimeout` shape. The default wiring uses those helpers; tests
 * inject a fake clock to assert the unref / clear / advance invariants
 * deterministically without a real wall-clock wait. The handle carries Node's
 * native `.unref()` (so a pending sleep doesn't keep the event loop alive).
 */
export interface SleepTimer {
  setTimeout(cb: () => void, ms: number): { unref(): unknown };
  clearTimeout(handle: { unref(): unknown }): void;
}

/** Dependencies for {@link createSleepTool}. All optional — the default timer is the sanctioned helper. */
export interface SleepToolDeps {
  /** Injectable timer; defaults to the sanctioned systemSetTimeout/systemClearTimeout. */
  timer?: SleepTimer;
}

const SleepParams = Type.Object(
  {
    seconds: Type.Optional(
      Type.Number({
        description: `How long to pause, in seconds. Clamped to 0..${MAX_SLEEP_MS / 1000}s. If both seconds and ms are given, ms wins.`,
      }),
    ),
    ms: Type.Optional(
      Type.Number({
        description: `How long to pause, in milliseconds. Clamped to 0..${MAX_SLEEP_MS}ms. Takes precedence over seconds.`,
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The default timer: the sanctioned `systemSetTimeout`/`systemClearTimeout`
 * runtime helpers. Defined once so production always wires the real timer and
 * tests can swap in a fake.
 */
const defaultTimer: SleepTimer = {
  setTimeout: (cb, ms) => systemSetTimeout(cb, ms),
  clearTimeout: (handle) => systemClearTimeout(handle as ReturnType<typeof systemSetTimeout>),
};

/**
 * Resolve the requested duration to a clamped millisecond value. `ms` wins over
 * `seconds`. A non-finite / missing request defaults to {@link MAX_SLEEP_MS}
 * (the cache-window pace) rather than throwing — a sleep with no argument means
 * "defer for the cache TTL". The result is always within `[0, MAX_SLEEP_MS]`.
 */
function resolveClampedMs(params: Record<string, unknown>): number {
  const msParam = readNumberParam(params, "ms", false);
  const secParam = readNumberParam(params, "seconds", false);
  let requested: number;
  if (msParam !== undefined && Number.isFinite(msParam)) {
    requested = msParam;
  } else if (secParam !== undefined && Number.isFinite(secParam)) {
    requested = secParam * 1000;
  } else {
    // No usable duration supplied → pace for the full cache window.
    requested = MAX_SLEEP_MS;
  }
  if (!Number.isFinite(requested)) requested = MAX_SLEEP_MS;
  return Math.min(MAX_SLEEP_MS, Math.max(0, Math.floor(requested)));
}

/**
 * Create the `sleep` builtin AgentTool.
 *
 * @param deps - Optional dependencies. `timer` defaults to the sanctioned
 *   systemSetTimeout/systemClearTimeout helpers.
 * @returns AgentTool implementing the sleep primitive (STREAM-03).
 */
export function createSleepTool(deps: SleepToolDeps = {}): AgentTool<typeof SleepParams> {
  const timer = deps.timer ?? defaultTimer;
  // Comis extension: promptGuidelines is not part of the AgentTool type; spread
  // it (the exec/ls convention) to avoid excess-property checks.
  const guidelines = {
    promptGuidelines: [
      "Use sleep to PACE — not to poll. When you are waiting on a background child or a concurrency-safe read, sleep ONCE for the time you expect it to take rather than re-checking every turn; re-checking burns tokens and busts the prompt cache.",
      "A single sleep up to the ~5-minute prompt-cache TTL keeps the cached prefix warm while parallel work finishes. Prefer one longer sleep over many short ones.",
    ],
  };
  return {
    ...guidelines,
    name: "sleep",
    label: "Sleep",
    description:
      "Pause for a bounded duration to let background or child work finish without consuming tokens. " +
      `Max ~${MAX_SLEEP_MS / 1000}s — this matches the ~5-minute prompt-cache TTL, so a single sleep keeps the cache warm. ` +
      "Sleep ONCE rather than polling in a loop: polling burns tokens every turn and busts the cache, whereas one sleep lets concurrency-safe reads overlap and the cached prefix survive.",
    parameters: SleepParams,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const clampedMs = resolveClampedMs(params);

      // Fast path: already aborted before we schedule anything — never start a timer.
      if (signal?.aborted) {
        return jsonResult({ sleptMs: 0, requestedMs: clampedMs, aborted: true, note: "Sleep aborted before it started." });
      }

      const aborted = await new Promise<boolean>((resolve) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          timer.clearTimeout(handle); // clear the pending timer → no handle leak (T-221-SLEEP-04)
          resolve(true);
        };
        const handle = timer.setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, clampedMs);
        // Never let a pending sleep block graceful daemon shutdown (T-221-SLEEP-01).
        handle.unref();
        signal?.addEventListener("abort", onAbort, { once: true });
      });

      if (aborted) {
        return jsonResult({ sleptMs: 0, requestedMs: clampedMs, aborted: true, note: "Sleep aborted." });
      }
      return jsonResult({
        sleptMs: clampedMs,
        requestedMs: clampedMs,
        aborted: false,
        note: `Slept ${clampedMs}ms (${(clampedMs / 1000).toFixed(1)}s).`,
      });
    },
  };
}
