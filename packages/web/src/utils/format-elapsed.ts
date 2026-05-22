// SPDX-License-Identifier: Apache-2.0
/**
 * Format an elapsed duration (ms) as "Xm YYs" or "Xs" (sub-minute, 1-decimal).
 * Returns "--" for null/undefined input.
 *
 * Distinct from `@comis/agent`'s envelope/elapsed-time.formatElapsed, which
 * is a (currentMs, previousMs, maxMs) delta-formatter producing "+30s" style.
 */
export function formatElapsed(ms?: number): string {
  if (ms == null) return "--";
  const totalSec = ms / 1000;
  if (totalSec >= 60) {
    const min = Math.floor(totalSec / 60);
    const sec = Math.floor(totalSec % 60);
    return `${min}m ${sec.toString().padStart(2, "0")}s`;
  }
  return `${totalSec.toFixed(1)}s`;
}
