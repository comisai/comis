// SPDX-License-Identifier: Apache-2.0
/**
 * ClockPort: hexagonal boundary for wall-clock and monotonic time reads.
 *
 * Every production caller of Date.now() / new Date() goes through this port; the
 * canonical Node-backed adapter is `createSystemClock()` in
 * @comis/infra/src/runtime/clock.ts.
 *
 * Type-only file — no runtime values. Adapter lives in @comis/infra.
 *
 * @module
 */

export interface ClockPort {
  /** Unix epoch milliseconds. */
  now(): number;
  /** Wall-clock Date for the rare consumer that genuinely needs Date. */
  nowDate(): Date;
}
