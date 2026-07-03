// SPDX-License-Identifier: Apache-2.0
/**
 * Session index event types for the append-only session lifecycle log.
 *
 * Three discriminated-union event types are written to
 * `~/.comis/logs/session-index.YYYY-MM-DD.jsonl`:
 *
 *   - `session_started` — once per session, fired from pi-event-bridge
 *     inside the !alreadyEmitted guard
 *   - `turn_completed` — once per LLM turn, fired from the
 *     `observability:token_usage` bus event which carries BOTH input
 *     AND output tokens
 *   - `session_ended` — once per session destroy, fired from
 *     comis-session-manager
 *
 * @module
 */

/** Common fields present on every session index event. */
interface SessionIndexEventBase {
  /** Trace schema discriminator — used by downstream readers to validate records. */
  readonly traceSchema: "comis-session-index";
  /** Schema version — increment when the shape changes. */
  readonly schemaVersion: 1;
  /** ISO 8601 timestamp of when the event was written. */
  readonly ts: string;
  /** True for harness/bench/test-injected sessions — excluded from obs.* by default (D9). */
  readonly synthetic?: boolean;
  /** Provenance of the session: "runtime" (production), "test" (VITEST), "bench" (harness). */
  readonly source?: "test" | "bench" | "runtime";
}

/**
 * Emitted once per session when the first LLM turn begins.
 * Co-located with `session:started` eventBus emit + trajectoryRegistry latch.
 */
export interface SessionStartedEvent extends SessionIndexEventBase {
  readonly event: "session_started";
  /** Formatted session key — unique session identifier. */
  readonly sessionId: string;
  /** Formatted session key (same as sessionId, explicit for readers). */
  readonly sessionKey: string;
  /** Channel type (e.g., "telegram", "discord"). */
  readonly channelType: string;
  /** Platform chat ID. */
  readonly channelId: string;
  /** Agent ID. */
  readonly agentId: string;
  /** Initial execution ID(s) for this session. */
  readonly traceIds: string[];
}

/**
 * Emitted once per LLM turn, sourced from the `observability:token_usage`
 * bus event which carries both input AND output tokens (not from onTurnUsage
 * which only has input tokens).
 */
export interface TurnCompletedEvent extends SessionIndexEventBase {
  readonly event: "turn_completed";
  /** Formatted session key. */
  readonly sessionId: string;
  /** Execution ID for this turn. */
  readonly traceId: string;
  /** LLM latency in milliseconds for this turn. */
  readonly durationMs: number;
  /** Input tokens consumed by this turn. */
  readonly inputTokens: number;
  /** Output tokens produced by this turn. */
  readonly outputTokens: number;
  /** The SDK per-turn stop signal (reliable — captured in the same turn_end).
   *  "error" marks the aborted calls that would otherwise be indistinguishable
   *  from healthy idle rows (0/0 tokens, null error). */
  readonly stopReason?: string;
  /** The execution-level finish disposition, forwarded only once it has settled
   *  away from the init default "stop" (it settles AFTER this row on the turn
   *  that degrades — the same ordering guard as model.completed), so a degraded
   *  cause (context_exhausted/…) lands on subsequent rows. */
  readonly finishReason?: string;
  /** Last error message, if the turn ended with an error; null otherwise. */
  readonly lastError: string | null;
}

/**
 * Emitted once when the session is destroyed (destroySession called).
 * Co-located with `session:ended` eventBus emit.
 */
export interface SessionEndedEvent extends SessionIndexEventBase {
  readonly event: "session_ended";
  /** Formatted session key. */
  readonly sessionId: string;
  /** Reason the session ended. */
  readonly exitReason: string;
  /** Total number of turns completed in this session. */
  readonly turnCount: number;
  /** Total tokens consumed across all turns. */
  readonly totalTokens: number;
}

/** Discriminated union of all session index event types. */
export type SessionIndexEvent =
  | SessionStartedEvent
  | TurnCompletedEvent
  | SessionEndedEvent;
