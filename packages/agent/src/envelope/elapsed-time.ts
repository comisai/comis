// SPDX-License-Identifier: Apache-2.0
/**
 * Format elapsed time between two timestamps as a compact suffix.
 *
 * Returns strings like "+30s", "+2m", "+1h", "+3d".
 * Returns empty string if the difference is negative or exceeds maxMs.
 *
 * @param currentMs - Current message timestamp in milliseconds since epoch
 * @param previousMs - Previous message timestamp in milliseconds since epoch
 * @param maxMs - Maximum elapsed time to display (returns empty if exceeded). Optional.
 * @returns Formatted elapsed string or empty string
 */
export function formatElapsed(
  currentMs: number,
  previousMs: number,
  maxMs?: number,
): string {
  const diffMs = currentMs - previousMs;
  if (diffMs < 0) return "";

  if (maxMs !== undefined && diffMs > maxMs) return "";

  const seconds = Math.floor(diffMs / 1_000);
  if (seconds < 60) return `+${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `+${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `+${hours}h`;

  const days = Math.floor(hours / 24);
  return `+${days}d`;
}
