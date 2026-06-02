// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalEvents: interactive terminal-driver lifecycle events (terminal:*).
 *
 * P0/OPS-07 emits exactly two — a state-transition event and a spawn-failure
 * event. Both payloads carry `sessionId` + `agentId` + `timestamp` so a P0
 * transition is reconstructable from the bus alone (AGENTS.md §2.7). Counts /
 * ids / a redaction-safe `hint` only — never keystrokes, screen contents, or
 * command text (the keystroke audit surface is P3/P4, SEC-10).
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
}
