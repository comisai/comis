// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalEvents: interactive terminal-driver lifecycle events (terminal:*).
 *
 * P0/OPS-07 emits a state-transition event and a spawn-failure event. P4
 * (Phase 123, SEC-10/OPS-06) makes the keystroke + eviction audit surface LIVE
 * with two more: `terminal:keystroke` (every send_text/send_key) and
 * `terminal:session_evicted` (the reaper / cap-trip signal). Every payload
 * carries `sessionId` + `agentId` + `timestamp` so a transition is
 * reconstructable from the bus alone (AGENTS.md §2.7).
 *
 * Counts / ids / a redaction-safe `hint` or typed `reason` ONLY — NEVER
 * keystrokes, screen contents, or command text. The keystroke event carries a
 * redaction-safe SUMMARY (a redaction count + post-redaction byte length); the
 * REDACTED payload itself rides the structured LOG, never the bus.
 *
 * The richer `terminal:input_needed` / `terminal:stuck` attention set is P5
 * (Phase 124) and is intentionally NOT declared here — no speculative payloads.
 */
export interface TerminalEvents {
  /** Terminal session transitioned lifecycle state (created → running → exited|lost). */
  "terminal:session_state": {
    sessionId: string;
    agentId: string;
    state: "created" | "running" | "exited" | "lost";
    durationMs: number;
    timestamp: number;
  };

  /** Worker/child spawn failed — OPS-07 failure branch carries hint + errorKind. */
  "terminal:spawn_failed": {
    sessionId: string;
    agentId: string;
    hint: string;
    errorKind: string;
    timestamp: number;
  };

  /**
   * Keystroke audit signal (SEC-10): one event per send_text/send_key. Carries a
   * redaction-SAFE summary ONLY — the count of redactions + the post-redaction byte
   * length, NEVER the raw keystroke text/keys (the REDACTED payload rides the
   * structured LOG, never the bus — see terminal-tools.ts keystroke_audit step).
   */
  "terminal:keystroke": {
    sessionId: string;
    agentId: string;
    kind: "text" | "key";
    /** Count of secret-shaped substrings scrubbed before audit (scrubSecretsFromText). */
    redactions: number;
    /** Byte length of the post-redaction payload — a size signal, not the content. */
    byteLength: number;
    timestamp: number;
  };

  /**
   * Reaper / cap-trip eviction (OPS-06): a session was evicted with an audited
   * reason. The companion terminal:session_state(state:"lost") still fires for the
   * lifecycle transition; this carries the WHY (which cap/TTL tripped).
   */
  "terminal:session_evicted": {
    sessionId: string;
    agentId: string;
    reason: "idle" | "max_sessions" | "wall_clock" | "max_interactions";
    durationMs: number;
    timestamp: number;
  };
}
