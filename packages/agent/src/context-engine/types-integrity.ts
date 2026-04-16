/**
 * DAG integrity checking and repair types.
 *
 * @module
 */

import type { ComisLogger } from "@comis/infra";
import type { ContextStore } from "@comis/memory";

// ---------------------------------------------------------------------------
// DAG Integrity
// ---------------------------------------------------------------------------

/**
 * A single integrity issue found during a DAG health check.
 */
export interface IntegrityIssue {
  /** Category of the integrity issue. */
  type:
    | "orphan_summary"
    | "stale_counts"
    | "contiguity_gap"
    | "dangling_ref"
    | "fts_desync"
    | "cycle";
  /** Whether the issue was auto-repaired or requires manual intervention. */
  severity: "auto_repaired" | "error";
  /** Human-readable description of the issue. */
  detail: string;
  /** Entity identifier (summary_id, message_id, etc.) when applicable. */
  entity?: string;
}

/**
 * Aggregate report from a DAG integrity check run.
 */
export interface IntegrityReport {
  /** Conversation that was checked. */
  conversationId: string;
  /** All issues found during the check. */
  issues: IntegrityIssue[];
  /** Number of issues that were auto-repaired. */
  repairsApplied: number;
  /** Number of issues logged as errors (not auto-repaired). */
  errorsLogged: number;
  /** Total duration of the integrity check in milliseconds. */
  durationMs: number;
}

/**
 * Dependency injection interface for the integrity checker.
 */
export interface IntegrityCheckDeps {
  /** Context store for all DAG read/write operations. */
  store: ContextStore;
  /** Raw better-sqlite3 Database handle for direct SQL queries. */
  db: unknown;
  /** Structured logger for the integrity module. */
  logger: ComisLogger;
  /** Optional event bus for emitting integrity check events. */
  eventBus?: {
    emit(event: "context:integrity", data: IntegrityCheckEvent): void;
  };
  /** Agent ID for event attribution. */
  agentId: string;
  /** Session key for event correlation. */
  sessionKey: string;
}

/**
 * Payload for the `context:integrity` event.
 */
export interface IntegrityCheckEvent {
  /** Conversation that was checked. */
  conversationId: string;
  /** Agent that triggered the integrity check. */
  agentId: string;
  /** Session key for event correlation. */
  sessionKey: string;
  /** Total number of issues found. */
  issueCount: number;
  /** Number of issues that were auto-repaired. */
  repairsApplied: number;
  /** Number of issues logged as errors. */
  errorsLogged: number;
  /** Deduplicated issue type values. */
  issueTypes: string[];
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Unix timestamp when the check completed. */
  timestamp: number;
}
