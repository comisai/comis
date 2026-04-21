// SPDX-License-Identifier: Apache-2.0
/**
 * HeartbeatSourcePort: Pluggable interface for heartbeat check sources.
 *
 * Each source represents a system or service to monitor. Implementations
 * perform the actual check (e.g., HTTP ping, disk space, process health)
 * and return a structured result for the HeartbeatRunner to classify.
 */

/** Result of a single heartbeat source check. */
export interface HeartbeatCheckResult {
  /** Unique identifier for the source that produced this result. */
  sourceId: string;
  /** Human-readable check output (classified by relevance filter). */
  text: string;
  /** Timestamp (ms since epoch) when the check was performed. */
  timestamp: number;
  /** Optional metadata for logging/debugging. */
  metadata?: Record<string, unknown>;
}

/**
 * Port interface for pluggable heartbeat check sources.
 *
 * Implementations should:
 * - Return HeartbeatCheckResult with HEARTBEAT_OK_TOKEN in text for healthy status
 * - Include "CRITICAL" or "EMERGENCY" in text for high-severity issues
 * - Return any other text for alert-level issues
 */
export interface HeartbeatSourcePort {
  /** Unique identifier for this source. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Perform the health check and return a result. */
  check(): Promise<HeartbeatCheckResult>;
}
