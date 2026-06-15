// SPDX-License-Identifier: Apache-2.0
/**
 * The settle engine (spec §5 wait, §4.3 attention model).
 *
 * The bounded, injected-clock debounce that powers every mutating tool's "act
 * then return the SETTLED snapshot" contract and the explicit `wait` tool.
 * It resolves on the EARLIEST of:
 *   - the stdout ring going quiet for `idleMs` (idle debounce) — armed IFF the
 *     caller asked for idle (`forIdleMs`) or asked for nothing specific (idle is
 *     the DEFAULT only when no `forText`/`forExit` is requested),
 *   - a `forText` substring appearing in the ring (text) — armed IFF `forText` set,
 *   - the session exiting (exit) — ALWAYS terminal (an exited program can produce
 *     no more output, so it ends any wait, including an idle/text wait),
 *   - the capped `timeoutMs` elapsing (timeout) — ALWAYS armed (the DoS bound).
 *
 * On timeout it resolves a LOAD-BEARING `isComplete:false` — it NEVER throws and
 * NEVER holds the turn open. A settle that could hang would strand a turn; a
 * settle that returned a false `isComplete:true` on timeout would convince the
 * attention model the work is done and abandon a live session. Both failure modes
 * are security/correctness load-bearing, so the engine is deterministic under a
 * fake timer and the timeout shape is hard-coded.
 *
 * Timer indirection mirrors `terminal-session-registry.ts`: the worker injects
 * `setTimer`/`clearTimer` whose production defaults wrap
 * `systemSetTimeout`/`systemClearTimeout` from `@comis/core` and `.unref()` the
 * handle so a pending timer never holds the event loop open. There is NO raw
 * `setTimeout` here and NO `@comis/infra` import; the engine is pure and
 * injectable. Everything is closure-local inside `runSettle` — no module-global
 * mutable state.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default idle window (the debounce): resolve `idle` once the ring is unchanged
 * for this many ms. A small value in the 75-150ms band — a shell settles fast.
 * The per-entry adaptive longer settle for AI CLIs is a later concern; this is
 * the bounded primitive with a sane default.
 */
export const SETTLE_DEFAULT_IDLE_MS = 120;

/**
 * The default overall settle timeout when the caller omits `timeoutMs` — the
 * post-action send_text/send_key quiesce + any bare wait. A small bound (a shell
 * settles fast); the explicit `wait` tool opts into a longer budget via `timeoutMs`.
 */
export const SETTLE_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The hard upper bound on the overall settle (spec §5 cap). `runSettle` clamps any
 * requested `timeoutMs` to this. Sized for INTERACTIVE AI-CLI DRIVING (the v2.11 use
 * case): a driven `claude`/`codex` task routinely runs 60-90s+ (model latency +
 * multi-file writes), so the prior 15s cap made the headline use case impossible —
 * `wait` always timed out before the CLI finished, stranding the agent with a
 * not-complete result. The idle debounce (`forIdleMs`) still returns the instant the
 * CLI goes quiet, so this is only the worst-case ceiling for a never-idle stream, not
 * the common wait length. (The settle is timer-driven and does NOT block the worker's
 * frame loop — other sessions' reads/writes interleave while one wait pends.)
 */
export const SETTLE_MAX_TIMEOUT_MS = 600_000;

/**
 * Margin added to the settle budget when sizing the daemon→worker IPC reply timeout
 * for a `wait` (terminal-session-registry): the worker replies only once the settle
 * resolves, so the reply timeout must exceed the settle's own cap by enough for the
 * reply frame to travel back — else the IPC pre-empts a legitimate long settle.
 */
export const WAIT_REPLY_MARGIN_MS = 10_000;

/**
 * The daemon→worker IPC reply timeout for a `wait` round-trip: the clamped settle
 * budget plus {@link WAIT_REPLY_MARGIN_MS}. Fast methods (read/write/resize/status)
 * keep the generic short reply timeout (fast wedge detection); only `wait` needs one
 * scaled to its settle duration, else a 60-90s AI-CLI settle is cut off at ~10s.
 */
export function waitReplyTimeoutMs(timeoutMs?: number): number {
  return Math.min(timeoutMs ?? SETTLE_DEFAULT_TIMEOUT_MS, SETTLE_MAX_TIMEOUT_MS) + WAIT_REPLY_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The injected ports `runSettle` needs. The worker wires these to the session's
 * ring append + the backend close; tests inject a deterministic fake scheduler +
 * ring source. NO `@comis/infra`, NO raw timers.
 */
export interface SettleDeps {
  /** Schedule a one-shot timer; returns an opaque handle for `clearTimer`. */
  setTimer: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle. */
  clearTimer: (handle: unknown) => void;
  /** The current stdout ring snapshot. */
  getRing: () => string;
  /** Whether the session's backend is still alive. */
  isAlive: () => boolean;
  /** Subscribe to ring-append notifications; returns an unsubscribe. */
  onRingChange: (cb: () => void) => () => void;
  /** Subscribe to backend-exit notifications; returns an unsubscribe. */
  onExit: (cb: () => void) => () => void;
  /**
   * OPTIONAL gate: may the session settle IDLE right now? The worker wires this
   * to `!hasContentBelowFold()` so a frame with content below the visible
   * viewport (still scrolling / more to render) is NOT marked idle — the idle
   * timer RE-ARMS instead of resolving. Absent ⇒ always settleable. This gates
   * ONLY the idle path; exit/text/timeout are UNCHANGED (exit stays
   * always-terminal, the load-bearing `isComplete:false` on timeout is
   * preserved). The gate can only SUPPRESS an idle-settle (keep waiting), never
   * falsely declare settled — the SAFE direction.
   */
  isSettleable?: () => boolean;
}

/** The settle parameters (the `wait` tool's body, spec §5). All conditions are opt-in. */
export interface SettleParams {
  /**
   * The idle debounce window in ms. When set, the idle condition is ARMED at this
   * value. When omitted, idle is armed only if NO other condition (`forText`/
   * `forExit`) is requested — then it defaults to {@link SETTLE_DEFAULT_IDLE_MS};
   * a `forExit`/`forText`-only wait does NOT arm idle, so a quiet window cannot
   * pre-empt the requested exit/text condition.
   */
  forIdleMs?: number;
  /**
   * The number of CONSECUTIVE quiet idle windows the ring must stay unchanged for
   * before the idle condition resolves (spec §4.3). Defaults to `1` — the
   * single-window 120-02 behavior. A value `> 1` is the adaptive debounce for an
   * AI CLI that emits in bursts with sub-`idleMs` gaps mid-generation: a ring
   * change part-way through the sequence RE-ARMS and RESETS the count, so idle
   * resolves only after N windows of UNINTERRUPTED quiet. SAFE-direction only —
   * more windows can DELAY an idle-settle (bounded by `timeoutMs`), never falsely
   * declare it settled; exit/text/timeout are UNCHANGED.
   */
  stableWindows?: number;
  /** Resolve `text` when this substring appears in the ring. */
  forText?: string;
  /** Honor an exit as a settle reason (an exit always terminates a settle regardless). */
  forExit?: boolean;
  /** The overall bound in ms, clamped to {@link SETTLE_MAX_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The settle result — the `{matched,isComplete,reason}` core of the `wait` shape. */
export interface SettleResult {
  matched: boolean;
  isComplete: boolean;
  reason: "idle" | "text" | "exit" | "timeout";
  /**
   * Diagnostic for a `reason:"timeout"` (not-complete) settle: was the screen STILL
   * changing within the last idle window when the budget elapsed? `true` ⇒ the driven
   * program was actively producing output (it has NOT finished — keep waiting); `false`
   * ⇒ the screen was idle with no match (maybe done, awaiting input, or stuck). Absent
   * for the complete reasons (idle/text/exit), whose `isComplete:true` is unambiguous.
   * (T1.1: the live friction was a wait returning not-complete with no "why".)
   */
  producing?: boolean;
}

/**
 * The actionable hint for a settle RESULT — branched by failure class so a caller (or a
 * driving agent) reads a not-complete timeout correctly instead of mistaking it for a
 * failure/empty result. Returns a string ONLY for `reason:"timeout"` (the ambiguous,
 * not-complete case): `producing:true` ⇒ keep waiting; `producing:false` ⇒ inspect the
 * screen/status. The complete reasons (idle/text/exit) carry `isComplete:true` and need
 * no hint. Pure + total — no clock, no I/O.
 */
export function settleHint(result: SettleResult): string | undefined {
  if (result.reason !== "timeout") return undefined;
  return result.producing === true
    ? "The program was STILL producing output when the wait budget elapsed — it has NOT finished. Call wait again (optionally with a larger timeoutMs) to keep waiting; do not treat this as a failure or an empty result."
    : "The screen was idle at the wait timeout with no match — the program may be done (read the screen), waiting for input, or stuck. Check terminal_session_status before retrying.";
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a bounded settle. Resolves on the earliest of idle / text / exit / timeout;
 * clamps `timeoutMs` to {@link SETTLE_MAX_TIMEOUT_MS}; returns `isComplete:false`
 * on timeout; routes every timer through the injected port; leaks no
 * timer/subscription; and NEVER throws.
 *
 * @param deps - The injected timer + ring/liveness ports.
 * @param params - The settle parameters.
 * @returns A promise resolving the `{matched,isComplete,reason}` core.
 */
export function runSettle(deps: SettleDeps, params: SettleParams): Promise<SettleResult> {
  const cap = Math.min(params.timeoutMs ?? SETTLE_DEFAULT_TIMEOUT_MS, SETTLE_MAX_TIMEOUT_MS);
  const idleMs = params.forIdleMs ?? SETTLE_DEFAULT_IDLE_MS;
  // N CONSECUTIVE quiet idle windows before idle resolves (spec §4.3). Floored at
  // 1 (the single-window 120-02 default); a non-finite/<1 request collapses to 1.
  // Only the idle path consults it — exit/text/timeout are UNCHANGED.
  const stableWindows = Math.max(1, Math.floor(params.stableWindows ?? 1) || 1);
  const { forText } = params;

  // The wait conditions are OPT-IN (spec §5). The idle debounce is armed IFF the
  // caller explicitly asked for it (`forIdleMs`) OR asked for NOTHING specific
  // (idle is the sensible DEFAULT only when no forText/forExit is requested). When
  // the caller asked for forExit (or forText), a quiet output window must NOT fire
  // the idle timer and pre-empt the slightly-later exit/text event: on a real PTY
  // that mis-reported reason:"idle" for a session that actually EXITED, and the
  // attention model would read "awaiting input" for a dead session. exit and
  // timeout stay ALWAYS armed regardless; text is armed when forText is set. The
  // post-action send_text/send_key quiesce requests forIdleMs explicitly, so it
  // keeps its idle behavior.
  const idleArmed = params.forIdleMs !== undefined || (forText === undefined && params.forExit !== true);

  return new Promise<SettleResult>((resolve) => {
    let done = false;
    let idleTimer: unknown;
    // The consecutive-quiet-window counter (closure-local — no module-global
    // state). Incremented each time a settleable idle window elapses; RESET to 0
    // on any ring change (the windows must be CONSECUTIVE). Idle resolves only when
    // it reaches `stableWindows`.
    let stableCount = 0;
    // T1.1 diagnostic: did the ring change within the last (unfinished) idle window?
    // Set on every ring change, CLEARED when a full quiet window elapses — so at the
    // overall-timeout it tells whether the program was still producing output.
    let sawChange = false;
    // eslint-disable-next-line prefer-const -- read by settle() on the fast-path early-returns (forText/dead-session) BEFORE its single conditional assignment at the timeout schedule below; `const` would TDZ-throw on those paths.
    let overallTimer: unknown;
    const unsubs: Array<() => void> = [];

    /**
     * Idempotent resolution: clears EVERY timer (idle + overall), removes every
     * subscription, and resolves the promise exactly once. A second call (e.g. a
     * stray exit after an idle resolution) is a no-op.
     */
    function settle(result: SettleResult): void {
      if (done) return;
      done = true;
      if (idleTimer !== undefined) deps.clearTimer(idleTimer);
      if (overallTimer !== undefined) deps.clearTimer(overallTimer);
      for (const off of unsubs) off();
      unsubs.length = 0;
      resolve(result);
    }

    /**
     * (Re)start the idle debounce: clear the prior idle timer, schedule a fresh
     * one. A NO-OP when idle is not armed (forExit/forText-only waits) so a quiet
     * window can never pre-empt the requested exit/text condition.
     *
     * When the idle window elapses but `isSettleable()` is false (content remains
     * below the fold), the timer RE-ARMS instead of resolving idle: a
     * still-rendering frame is never marked idle. The gate can only delay an
     * idle-settle (bounded by the overall timeout), never force one — exit/text
     * /timeout are unaffected.
     *
     * Adaptive N-stable-window (spec §4.3): a settleable idle window does not
     * resolve immediately — it INCREMENTS the consecutive-quiet count and re-arms
     * until the count reaches `stableWindows` (default 1 ⇒ the unchanged
     * single-window behavior). The count is RESET to 0 by any ring change (see the
     * onRingChange handler), so only UNINTERRUPTED quiet resolves idle — an AI CLI
     * burst part-way through cannot be mistaken for a settled prompt. A below-fold
     * window neither counts nor resolves (it re-arms, leaving the count untouched).
     */
    function restartIdle(): void {
      if (!idleArmed) return;
      if (idleTimer !== undefined) deps.clearTimer(idleTimer);
      idleTimer = deps.setTimer(() => {
        if (deps.isSettleable !== undefined && !deps.isSettleable()) {
          restartIdle(); // content below the fold ⇒ keep waiting, don't settle idle
          return;
        }
        sawChange = false; // a full quiet idle window elapsed with no ring change (T1.1)
        stableCount += 1;
        if (stableCount >= stableWindows) {
          settle({ matched: true, isComplete: true, reason: "idle" });
          return;
        }
        restartIdle(); // not enough consecutive quiet windows yet ⇒ keep waiting
      }, idleMs);
    }

    // Fast paths evaluated at entry, before scheduling anything that could leak.
    if (forText !== undefined && deps.getRing().includes(forText)) {
      settle({ matched: true, isComplete: true, reason: "text" });
      return;
    }
    if (!deps.isAlive()) {
      // A dead session cannot settle further — exit always terminates a settle.
      settle({ matched: true, isComplete: true, reason: "exit" });
      return;
    }

    // Overall timeout (the DoS-bounded cap): the load-bearing isComplete:false.
    overallTimer = deps.setTimer(() => {
      settle({ matched: false, isComplete: false, reason: "timeout", producing: sawChange });
    }, cap);

    // Ring-change: a forText hit resolves text immediately; otherwise RESET the
    // consecutive-quiet count (the windows must be uninterrupted, spec §4.3) and
    // (re)start the idle debounce so quiet for idleMs resolves idle.
    unsubs.push(
      deps.onRingChange(() => {
        sawChange = true; // output is arriving — the program is producing (T1.1 diagnostic)
        if (forText !== undefined && deps.getRing().includes(forText)) {
          settle({ matched: true, isComplete: true, reason: "text" });
          return;
        }
        stableCount = 0;
        restartIdle();
      }),
    );

    // Exit: a backend close always terminates the settle (honor forExit, but a
    // dead session cannot settle further regardless of the flag).
    unsubs.push(
      deps.onExit(() => {
        settle({ matched: true, isComplete: true, reason: "exit" });
      }),
    );

    // Arm the idle debounce once at entry IFF idle is armed (a no-op otherwise):
    // quiet-from-now resolves idle only when the caller asked for idle or for
    // nothing specific. exit + timeout (and text, if forText) remain armed above.
    restartIdle();
  });
}
