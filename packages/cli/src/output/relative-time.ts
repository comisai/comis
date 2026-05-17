// SPDX-License-Identifier: Apache-2.0
/**
 * Relative-time formatter for OAuth expiry rendering.
 *
 * Produces compact strings like "5m", "27d", or "expired" for UI tables.
 * Used by `comis auth list` (expiresIn column) and `comis auth status`
 * (per-provider nextExpiry field).
 *
 * Branches:
 *   - delta <= 0       → "expired"
 *   - delta < 1h       → "<m>m" (e.g., "5m", "32m")
 *   - 1h <= delta < 1d → "<h>h"
 *   - delta >= 1d      → "<d>d"
 *
 * @module
 */

import { systemNowMs } from "@comis/core";
const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Format the time-until-expiry for an absolute epoch-ms expiry timestamp.
 *
 * @param expiresAtMs - Absolute epoch-ms when the credential expires
 * @param now - Reference "now" (defaulted to systemNowMs() — overridable for tests)
 * @returns "expired" | "<n>m" | "<n>h" | "<n>d"
 */
export function formatRelativeExpiry(
  expiresAtMs: number,
  now: number = systemNowMs(),
): string {
  const delta = expiresAtMs - now;
  if (delta <= 0) return "expired";
  if (delta < MS_PER_HOUR) return `${Math.floor(delta / MS_PER_MIN)}m`;
  if (delta < MS_PER_DAY) return `${Math.floor(delta / MS_PER_HOUR)}h`;
  return `${Math.floor(delta / MS_PER_DAY)}d`;
}
