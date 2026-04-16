/**
 * Relevance filter for heartbeat notifications.
 *
 * Classifies heartbeat check results by severity and determines
 * whether a notification should be surfaced based on visibility
 * settings, quiet hours, and critical bypass configuration.
 */

/** Controls which notification levels are visible to the user. */
export interface NotificationVisibility {
  /** Show "ok" status heartbeat results. */
  showOk: boolean;
  /** Show "alert" level heartbeat results. */
  showAlerts: boolean;
}

/** Default visibility: alerts only, suppress routine ok status. */
export const DEFAULT_VISIBILITY: NotificationVisibility = {
  showOk: false,
  showAlerts: true,
};

/** Severity classification for heartbeat check results. */
export type NotificationLevel = "ok" | "alert" | "critical";

/** Token embedded in heartbeat check output to signal "all clear". */
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";

/** Options for the shouldNotify decision function. */
export interface ShouldNotifyOptions {
  /** Classified severity of the heartbeat result. */
  level: NotificationLevel;
  /** Current visibility configuration. */
  visibility: NotificationVisibility;
  /** Whether we are currently in quiet hours. */
  isQuietHours: boolean;
  /** Whether critical alerts bypass quiet hours. */
  criticalBypass: boolean;
}

/**
 * Determine whether a heartbeat result should surface as a notification.
 *
 * Decision logic:
 * 1. Critical + criticalBypass -> always notify (even during quiet hours)
 * 2. Quiet hours -> suppress non-critical
 * 3. OK -> respect visibility.showOk
 * 4. Alert -> respect visibility.showAlerts
 */
export function shouldNotify(opts: ShouldNotifyOptions): boolean {
  const { level, visibility, isQuietHours, criticalBypass } = opts;

  // Critical with bypass always notifies
  if (level === "critical" && criticalBypass) return true;

  // Quiet hours suppress everything else
  if (isQuietHours) return false;

  // Respect visibility settings
  if (level === "ok") return visibility.showOk;
  if (level === "alert") return visibility.showAlerts;

  // Critical without bypass but not in quiet hours -> always notify
  return true;
}

/**
 * Classify a heartbeat check result text into a notification level.
 *
 * - Contains HEARTBEAT_OK_TOKEN -> "ok"
 * - Contains "CRITICAL" or "EMERGENCY" (case-insensitive) -> "critical"
 * - Everything else -> "alert"
 */
export function classifyHeartbeatResult(text: string): NotificationLevel {
  if (text.includes(HEARTBEAT_OK_TOKEN)) return "ok";
  const upper = text.toUpperCase();
  if (upper.includes("CRITICAL") || upper.includes("EMERGENCY")) return "critical";
  return "alert";
}
