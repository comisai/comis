// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduler-callback port: hexagonal boundary for cron-shaped time calculations
 * that agent needs but does not own.
 *
 * Today the only consumer is `session-reset-policy.ts` (`isDailyResetDue`), which
 * needs to know "what is the next 0 H * * * (in tz) at or after updatedAt?". The
 * canonical implementation lives in `@comis/scheduler` (`computeNextRunAtMs`,
 * croner-backed). Phase 32 commit 12 (ORCH-EXT-15) injects the callback through
 * agent's session-reset-policy entry point and removes agent's direct
 * `@comis/scheduler` import, closing the last cron-shape dependency edge from
 * agent into scheduler.
 *
 * The port is declared as a callback TYPE (not a `*Port` interface) because the
 * surface is a single pure function — wrapping it in an object with one method
 * would add ceremony without abstraction value. Future cron-shaped callbacks
 * that agent needs can be added to this file as additional exported types.
 *
 * @module
 */

/**
 * Compute the next "daily reset" run-time in milliseconds-since-epoch.
 *
 * Returns the next occurrence of `0 H * * *` (in the supplied IANA timezone)
 * at or after the supplied epoch-ms baseline (`updatedAt`). Used by the session
 * reset policy to decide whether a daily reset is due: a reset is due iff the
 * returned next-run timestamp is `<= nowMs` (i.e. the next reset already passed
 * between updatedAt and now).
 *
 * Returns `undefined` when no future run is computable — invalid hour /
 * timezone / cron-expression construction error. The session-reset-policy
 * caller treats `undefined` as "not due" so an invalid policy never spuriously
 * resets a session.
 *
 * Contract (mirrors the agent-internal helper this replaces, see
 * `packages/agent/src/session/session-reset-policy.ts` `isDailyResetDue`):
 *   - `hour` in [0, 23]
 *   - `timezone` is an IANA zone name (e.g. "America/New_York"); empty string
 *     means "use the system default". The wrapper handles the empty-string →
 *     undefined-tz mapping; consumers pass the raw config value through.
 *   - `updatedAt` is the wall-clock baseline (epoch ms) — the croner lookback
 *     starts here, so the returned next-run is strictly `>= updatedAt`.
 *
 * Implementation note: the canonical implementation in `@comis/scheduler`
 * (`computeNextRunAtMs` over the `{ kind: "cron", expr: "0 H * * *", tz }`
 * schedule) is what daemon composition wires into agent's deps. Tests
 * substitute a deterministic stub.
 *
 * @param updatedAt - Wall-clock baseline in epoch ms (typically session.updatedAt).
 * @param hour - Daily reset hour in [0, 23].
 * @param timezone - IANA timezone name; empty string = system default.
 * @returns Epoch ms of the next reset, or `undefined` when no future run computable.
 */
export type ComputeDailyResetNextRun = (
  updatedAt: number,
  hour: number,
  timezone: string,
) => number | undefined;
