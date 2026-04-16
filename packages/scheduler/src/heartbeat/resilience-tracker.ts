/**
 * Resilience tracker: pure functions for heartbeat backoff, error
 * classification, alert decisions, and recovery detection.
 */

/**
 * Backoff schedule in milliseconds: [30s, 1m, 5m, 15m, 60m].
 * Matches CronScheduler's ERROR_BACKOFF_SCHEDULE_MS.
 */
export const HEARTBEAT_BACKOFF_SCHEDULE_MS = Object.freeze([
  30_000, 60_000, 300_000, 900_000, 3_600_000,
] as const);

/** Error classification for retry decisions. */
export type ErrorClassification = "transient" | "permanent";

/** Alert decision result from shouldFireAlert. */
export interface AlertDecision {
  shouldAlert: boolean;
  reason: string;
}

/** Permanent error message patterns (lowercase match). */
const PERMANENT_PATTERNS = [
  "not found",
  "not enabled",
  "not configured",
  "invalid",
  "validation",
  "unauthorized",
  "forbidden",
] as const;

/**
 * Compute backoff delay based on consecutive error count.
 *
 * Returns 0 for errors <= 0, otherwise indexes into the backoff schedule
 * clamped to array bounds: index = min(consecutiveErrors - 1, length - 1).
 */
export function computeBackoffMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 0;

  const index = Math.min(
    consecutiveErrors - 1,
    HEARTBEAT_BACKOFF_SCHEDULE_MS.length - 1,
  );
  return HEARTBEAT_BACKOFF_SCHEDULE_MS[index];
}

/**
 * Classify an error for retry decisions.
 *
 * Non-Error objects are treated as transient (unknown cause).
 * Error messages are matched against permanent patterns (case-insensitive).
 * Everything else is transient (retryable).
 */
export function classifyError(error: unknown): ErrorClassification {
  if (!(error instanceof Error)) return "transient";

  const msg = error.message.toLowerCase();
  for (const pattern of PERMANENT_PATTERNS) {
    if (msg.includes(pattern)) return "permanent";
  }

  return "transient";
}

/** Options for shouldFireAlert decision. */
export interface ShouldFireAlertOpts {
  consecutiveErrors: number;
  alertThreshold: number;
  lastAlertMs: number;
  cooldownMs: number;
  nowMs: number;
  classification: ErrorClassification;
}

/**
 * Decide whether to fire a heartbeat failure alert.
 *
 * - Permanent errors: alert on first failure (consecutiveErrors >= 1) if cooldown expired
 * - Transient errors: alert only when consecutiveErrors >= alertThreshold AND cooldown expired
 * - Cooldown active: suppress alert regardless of error count
 */
export function shouldFireAlert(opts: ShouldFireAlertOpts): AlertDecision {
  const {
    consecutiveErrors,
    alertThreshold,
    lastAlertMs,
    cooldownMs,
    nowMs,
    classification,
  } = opts;

  // Check cooldown first (applies to both transient and permanent)
  if (lastAlertMs > 0 && nowMs - lastAlertMs < cooldownMs) {
    return { shouldAlert: false, reason: "cooldown-active" };
  }

  // Permanent errors: alert on first failure
  if (classification === "permanent" && consecutiveErrors >= 1) {
    return { shouldAlert: true, reason: "permanent-error" };
  }

  // Transient errors: must meet threshold
  if (consecutiveErrors < alertThreshold) {
    return { shouldAlert: false, reason: "below-threshold" };
  }

  return { shouldAlert: true, reason: "threshold-exceeded" };
}

/**
 * Detect recovery: returns true if the previous tick had errors.
 * Used to log recovery events when a heartbeat succeeds after failures.
 */
export function isRecovery(previousErrors: number): boolean {
  return previousErrors > 0;
}
