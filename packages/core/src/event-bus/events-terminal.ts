// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalEvents: interactive terminal-driver lifecycle events (terminal:*).
 *
 * The base set emits a state-transition event and a spawn-failure event. The
 * keystroke + eviction audit surface is made LIVE with two more:
 * `terminal:keystroke` (every send_text/send_key) and
 * `terminal:session_evicted` (the reaper / cap-trip signal). Every payload
 * carries `sessionId` + `agentId` + `timestamp` so a transition is
 * reconstructable from the bus alone (AGENTS.md §2.7).
 *
 * Counts / ids / a redaction-safe `hint` or typed `reason` ONLY — NEVER
 * keystrokes, screen contents, or command text. The keystroke event carries a
 * redaction-safe SUMMARY (a redaction count + post-redaction byte length); the
 * REDACTED payload itself rides the structured LOG, never the bus.
 *
 * The richer `terminal:input_needed` / `terminal:stuck` attention set is
 * deferred and is intentionally NOT declared here — no speculative payloads.
 */
export interface TerminalEvents {
  /** Terminal session transitioned lifecycle state (created → running → exited|lost). */
  "terminal:session_state": {
    sessionId: string;
    agentId: string;
    state: "created" | "running" | "exited" | "lost";
    /**
     * DUAL MEANING by `state`: on `created` it is the create
     * OPERATION duration (`doneAt - start` of the spawn); on `lost` (the reaper/cap
     * eviction transition) it is the session's TOTAL wall-clock LIFETIME at eviction
     * (`nowMs - startedAt`, the same value as the companion `terminal:session_evicted`).
     * A consumer correlating `durationMs` across transitions must branch on `state` —
     * it is NOT a single uniform metric.
     */
    durationMs: number;
    timestamp: number;
  };

  /** Worker/child spawn failed — failure branch carries hint + errorKind. */
  "terminal:spawn_failed": {
    sessionId: string;
    agentId: string;
    hint: string;
    errorKind: string;
    timestamp: number;
  };

  /**
   * Keystroke audit signal: one event per send_text/send_key INVOCATION.
   * Carries a redaction-SAFE summary ONLY — the count of redactions + the
   * post-redaction byte length + the typed `outcome`, NEVER the raw keystroke
   * text/keys (the REDACTED payload rides the structured LOG, never the bus — see
   * terminal-tools.ts keystroke_audit step).
   *
   * ATTEMPT signal, not a delivery signal: this fires for EVERY
   * invocation — including a send REJECTED on a cap breach (`outcome:"rejected"`,
   * nothing typed) — so the audit trail records what the agent TRIED to type, not
   * only what reached a terminal. `sessionId` is the caller-asserted target; it is
   * NOT proof of ownership (a cross-owner / absent send degrades to a no-op in the
   * registry yet still emits this event with the asserted id). Do NOT count these
   * as bytes-on-the-wire.
   */
  "terminal:keystroke": {
    sessionId: string;
    agentId: string;
    kind: "text" | "key";
    /** Count of secret-shaped substrings scrubbed before audit (scrubSecretsFromText). */
    redactions: number;
    /** Byte length of the post-redaction payload — a size signal, not the content. */
    byteLength: number;
    /**
     * The attempt outcome (closed enum): `attempted` = the send passed the caps and
     * was forwarded to the registry; `rejected` = a per-session cap breach
     * (rate REJECT or interaction/wall-clock EVICT) blocked the forward. Lets a
     * consumer separate forwarded attempts from capped ones without leaking text.
     */
    outcome: "attempted" | "rejected";
    timestamp: number;
  };

  /**
   * Reaper / cap-trip eviction: a session was evicted with an audited
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
