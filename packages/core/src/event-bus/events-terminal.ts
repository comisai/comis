// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalEvents: interactive terminal-driver lifecycle events (terminal:*).
 *
 * P0/OPS-07 emits a state-transition event and a spawn-failure event. P4
 * (Phase 123, SEC-10/OPS-06) makes the keystroke + eviction audit surface LIVE
 * with two more: `terminal:keystroke` (every send_text/send_key) and
 * `terminal:session_evicted` (the reaper / cap-trip signal). P5 (Phase 124,
 * TR-11/OPS-04/SEC-11/SEC-12) adds the attention + audit set: `terminal:input_needed`
 * (the agent-wake signal), `terminal:stuck` (settled, no progress), `terminal:escalated`
 * (an auto-answer escalation / hop-limit / loop audit), and `terminal:auto_answered`
 * (a safe-pattern answer was sent). Phase 164 (DRIVE-02, v2.24) adds the autonomous-drive
 * promotion signal `terminal:drive_promoted` (a long drive crossed the inline→detached
 * threshold — the skills wait tool emits it, the daemon wake dispatcher consumes it to
 * fire ONE "drive started (backgrounded)" notification). Phase 165 (DUR-01, v2.24) adds the
 * durability RE-ATTACH signal `terminal:drive_reattached` (on a daemon restart the session
 * registry recovered a durable drive whose detached tmux server SURVIVED + re-attached it as
 * `running` instead of `lost` — the daemon emits it so a 40h drive's restart is reconstructable
 * via `comis explain`, design §9); the genuinely-gone path REUSES the existing
 * `terminal:session_state(state:"lost")` (there is NO `failed` member — the user-facing `failed`
 * OUTCOME is Phase 166 NOTIFY-01's, derived from lost + a durable journal + an unrecoverable
 * reason). Every payload carries `sessionId` + `agentId` + `timestamp` so a transition is
 * reconstructable from the bus alone (AGENTS.md §2.7).
 *
 * Counts / ids / a redaction-safe `hint`, typed `reason`, or typed `state` ONLY
 * — NEVER keystrokes, screen contents, or command text. The keystroke event
 * carries a redaction-safe SUMMARY (a redaction count + post-redaction byte
 * length); `terminal:auto_answered` carries the matched-pattern INDEX + a
 * keystroke COUNT, never the keystroke. The REDACTED detail itself rides the
 * structured LOG, never the bus.
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

  /**
   * Attention wake (TR-11): the classifier settled the grid to a state that
   * needs the agent — the cursor is parked at a plausible input position
   * (`awaiting-input`) or the session is `stuck`. The dispatcher (124-07) turns
   * this into AT MOST ONE woken turn per unanswered frame. Carries a typed
   * `state` + a SHORT STRUCTURAL `reason` tag (e.g. `"settled_cursor_parked"`)
   * — NEVER screen text. The screen contents that drove the classification ride
   * the structured LOG, never the bus.
   */
  "terminal:input_needed": {
    sessionId: string;
    agentId: string;
    state: "awaiting-input" | "stuck";
    /** A short structural classification tag (e.g. "settled_cursor_parked") — NEVER screen text. */
    reason: string;
    /**
     * Classifier confidence (CLASS-02) — `high` for the structural certainties
     * (cursor parked at a prompt), `medium` for the heuristics (e.g. `dialog_detected`).
     * A 2-value enum, content-free: it rides the wake event for the autonomous policy
     * (164–166) + a future `comis explain`. The screen that drove it rides the LOG.
     */
    confidence: "high" | "medium";
    timestamp: number;
  };

  /**
   * Stuck signal (OPS-04): the session settled with no affordance and made no
   * progress for longer than the operator `stuckMs`. A DURATION signal, not
   * content — `noProgressMs` is the elapsed no-progress window, nothing about
   * what is (or is not) on screen.
   */
  "terminal:stuck": {
    sessionId: string;
    agentId: string;
    /** Elapsed no-progress window in ms (settled, no affordance) — a duration, not content. */
    noProgressMs: number;
    /**
     * The classifier's structural reason tag (e.g. "no_progress") — surface-only for
     * observability symmetry with `terminal:input_needed` (CLASS-02; RESEARCH Open Q3).
     * A machine tag, NEVER screen text; the FSM does NOT branch on it in 163.
     */
    reason: string;
    /** Classifier confidence (CLASS-02) — a 2-value enum, content-free (see input_needed). */
    confidence: "high" | "medium";
    timestamp: number;
  };

  /**
   * Escalation audit (SEC-11/SEC-12): the auto-answer policy or a guard escalated
   * to a human instead of acting — a destructive/approval/auth-login prompt, a
   * detected loop, the dispatcher hop limit, a stuck session, or a frame that
   * matched no safe pattern. Carries a typed closed `reason` ONLY (the audited
   * WHY); the prompt that triggered it rides the structured LOG, never the bus.
   */
  "terminal:escalated": {
    sessionId: string;
    agentId: string;
    reason:
      | "destructive"
      | "approval"
      | "auth_login"
      | "loop_detected"
      | "hop_limit"
      | "stuck"
      | "no_safe_match";
    timestamp: number;
  };

  /**
   * Auto-answer audit (SEC-12): a safe-pattern answer was sent. Carries the
   * matched operator-pattern INDEX + the count of keystrokes sent — NEVER the
   * keystroke itself (mirrors `terminal:keystroke`'s redaction-safe summary). The
   * redacted keystroke detail rides the structured LOG, never the bus.
   */
  "terminal:auto_answered": {
    sessionId: string;
    agentId: string;
    /** Index of the matched operator safe-pattern (hintPatterns) — an id, not the prompt. */
    matchedPatternIndex: number;
    /** Count of keystrokes the canned answer sent — a size signal, not the content. */
    keystrokeCount: number;
    timestamp: number;
  };

  /**
   * Autonomous-drive promotion (DRIVE-02, Phase 164, v2.24): a backgrounded-capable
   * drive crossed the inline→detached threshold. The skills wait tool (Context A,
   * the agent's LLM turn) consults the pure `shouldPromoteDrive` predicate (164-02) on
   * its `WaitResult` and, on a qualifying wait, emits this event; the fd3 wake dispatcher
   * (Context B, the daemon) consumes it into a closure-local promoted-Set and fires
   * EXACTLY ONE "drive started (backgrounded)" notification (promote-once — the skills
   * tool emits per-qualifying-wait, the daemon collapses to one). A sub-threshold inline
   * drive (a `git status` one-shot) emits nothing (I1).
   *
   * CONTENT-FREE (I3): carries `sessionId`/`agentId` + a typed `reason` enum (the WHY it
   * promoted) + `timestamp` ONLY — NEVER the screen, command output, or a secret. The
   * screen digest that drove the wait rides the structured LOG, never the bus.
   */
  "terminal:drive_promoted": {
    sessionId: string;
    agentId: string;
    /**
     * Why the drive promoted (a closed enum, NEVER screen text — I3):
     * `producing` = the honest `isComplete:false,producing:true` settle signal under
     * `mode:"auto"` (the program is still working); `mode_detached` = the operator set
     * `drive.mode:"detached"` (promote-at-first-wait, an explicit opt-in).
     */
    reason: "producing" | "mode_detached";
    timestamp: number;
  };

  /**
   * Autonomous-drive RE-ATTACH (DUR-01, Phase 165, v2.24): on a daemon restart the session
   * registry recovered a persisted descriptor whose detached tmux server SURVIVED and
   * re-attached the drive as `running` (NOT `lost`) WITHOUT a second create frame (I10 — the
   * worker's `has-session`-gated backend re-attaches the surviving pane on the next read). The
   * registry's `onReattached` hook (injected, infra-decoupled) drives this so a 40h drive's
   * restart/re-attach is reconstructable via `comis explain` (design §9). MIRRORS
   * {@link TerminalEvents}["terminal:drive_promoted"]'s content-free shape (the 164 precedent).
   *
   * The genuinely-gone counterpart is NOT a new event: it REUSES the existing
   * `terminal:session_state(state:"lost")` + a content-free unrecoverable reason on the
   * structured LOG. There is NO `state:"failed"` member (the union is
   * created|running|exited|lost); the user-facing `failed` OUTCOME is Phase 166 NOTIFY-01's,
   * derived downstream from (`lost` + a durable drive journal + the unrecoverable reason).
   *
   * CONTENT-FREE (I3): sessionId / agentId + a single-member `reason` enum (the WHY it
   * re-attached, NEVER the screen) / timestamp ONLY. The screen the drive resumed on rides the
   * detached tmux session, never the bus.
   *
   * OBSERVABILITY NOTE (165-REVIEW ME-01): this event can fire DURING the daemon's boot sweep
   * BEFORE the wake-FSM subscribes (the recover-on-boot race), and it is NOT in observability's
   * TRAJECTORY_BRIDGE_MAPPING — so the AUTHORITATIVE §9 boot re-attach record an operator
   * reconstructs via `comis explain` is the INFO log at the emit site
   * (`terminal-durable-wiring.ts`'s onReattached), which survives regardless of any subscriber.
   */
  "terminal:drive_reattached": {
    sessionId: string;
    agentId: string;
    /** Why the drive re-attached (a closed enum, NEVER screen text — I3): `tmux_alive` = the persisted descriptor's `comis-<id>` tmux server survived the restart, so it re-attached instead of being flipped `lost`. */
    reason: "tmux_alive";
    timestamp: number;
  };
}
