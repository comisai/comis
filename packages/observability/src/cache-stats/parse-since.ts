// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI input parser — invalid input bubbles to a user-readable error message + process.exit(1) at the CLI call site (packages/cli/src/commands/cache.ts). The two throws below are the only validation surface; their messages embed the offending input for operator diagnosis.
/**
 * `--since` window shorthand parser.
 *
 * Accepts `Nh | Nd | Nw | Nm | Ny` where N is 1..99999. Returns the
 * window width in milliseconds. The CLI subtracts the result from
 * `Date.now()` to derive the `sinceMs` RPC parameter.
 *
 * The regex is bounded at 5 digits + single unit letter to avoid ReDoS.
 * Empty / malformed input throws — the CLI wraps the throw in a `try`
 * and surfaces a user-readable error message before `process.exit(1)`.
 *
 * Lives under `cache-stats/` (not `shared/`) because no other surface
 * needs the same lookup table yet. If a second consumer arrives, the
 * mapping is two lines to refactor.
 *
 * @module
 */

/** Bounded regex: 1-5 digit positive integer + single unit letter. */
const PATTERN = /^([1-9]\d{0,4})([hdwmy])$/;

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  // Approximations: m = 30d, y = 365d. Operator-friendly defaults — the
  // window is reported in epoch ms in the response, so callers needing
  // calendar-precise windows pass --until explicitly.
  m: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a `--since` shorthand into milliseconds.
 *
 * @param input - shorthand like `1h`, `24h`, `7d`, `30d`, `4w`, `6m`, `1y`
 * @returns window width in milliseconds (positive integer)
 * @throws if `input` does not match `Nh | Nd | Nw | Nm | Ny` with N ≥ 1
 */
export function parseSince(input: string): number {
  const m = PATTERN.exec(input);
  if (!m) {
    throw new Error(
      `Invalid --since value: ${input}. Use Nh, Nd, Nw, Nm, or Ny (e.g., 1h, 24h, 7d, 30d).`,
    );
  }
  const n = parseInt(m[1] ?? "0", 10);
  const unitKey = m[2] ?? "";
  const unit = UNIT_MS[unitKey];
  if (!unit) {
    throw new Error(`Invalid --since unit: ${unitKey}.`);
  }
  return n * unit;
}
