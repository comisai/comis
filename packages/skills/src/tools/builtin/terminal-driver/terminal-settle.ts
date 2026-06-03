// SPDX-License-Identifier: Apache-2.0
/**
 * The settle engine (spec §5 wait, §4.3 attention model, TR-05).
 *
 * The bounded, injected-clock debounce that powers every P1 mutating tool's
 * "act then return the SETTLED snapshot" contract and the explicit `wait` tool.
 * It resolves on the EARLIEST of:
 *   - the stdout ring going quiet for `idleMs` (idle debounce),
 *   - a `forText` substring appearing in the ring (text),
 *   - the session exiting (exit),
 *   - the capped `timeoutMs` elapsing (timeout).
 *
 * On timeout it resolves a LOAD-BEARING `isComplete:false` — it NEVER throws and
 * NEVER holds the turn open. A settle that could hang would strand a turn; a
 * settle that returned a false `isComplete:true` on timeout would convince the P5
 * attention model the work is done and abandon a live session. Both failure modes
 * are security/correctness load-bearing, so the engine is deterministic under a
 * fake timer and the timeout shape is hard-coded.
 *
 * Timer indirection mirrors `terminal-session-registry.ts` (119-03 + MR-01): the
 * worker (Plan 04) injects `setTimer`/`clearTimer` whose production defaults wrap
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
 * for this many ms. A small value in the 75-150ms band per CONTEXT — a shell
 * settles fast. The per-entry adaptive longer settle for AI CLIs is P5; P1 ships
 * the bounded primitive with a sane default.
 */
export const SETTLE_DEFAULT_IDLE_MS = 120;

/**
 * The hard upper bound on the overall settle (spec §5 cap). `runSettle` clamps
 * any requested `timeoutMs` to this — an agent cannot request an unbounded /
 * huge in-turn wait that holds the worker's single-threaded frame loop (DoS).
 */
export const SETTLE_MAX_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The injected ports `runSettle` needs. The worker (Plan 04) wires these to the
 * session's ring append + the backend close; tests inject a deterministic fake
 * scheduler + ring source. NO `@comis/infra`, NO raw timers.
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
}

/** The settle parameters (the `wait` tool's body, spec §5). */
export interface SettleParams {
  /** The idle debounce window in ms (default {@link SETTLE_DEFAULT_IDLE_MS}). */
  forIdleMs?: number;
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
  const cap = Math.min(params.timeoutMs ?? SETTLE_MAX_TIMEOUT_MS, SETTLE_MAX_TIMEOUT_MS);
  const idleMs = params.forIdleMs ?? SETTLE_DEFAULT_IDLE_MS;
  const { forText } = params;

  return new Promise<SettleResult>((resolve) => {
    let done = false;
    let idleTimer: unknown;
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

    /** (Re)start the idle debounce: clear the prior idle timer, schedule a fresh one. */
    function restartIdle(): void {
      if (idleTimer !== undefined) deps.clearTimer(idleTimer);
      idleTimer = deps.setTimer(() => {
        settle({ matched: true, isComplete: true, reason: "idle" });
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
      settle({ matched: false, isComplete: false, reason: "timeout" });
    }, cap);

    // Ring-change: a forText hit resolves text immediately; otherwise (re)start
    // the idle debounce so quiet for idleMs resolves idle.
    unsubs.push(
      deps.onRingChange(() => {
        if (forText !== undefined && deps.getRing().includes(forText)) {
          settle({ matched: true, isComplete: true, reason: "text" });
          return;
        }
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

    // Start the idle debounce once at entry (quiet-from-now resolves idle).
    restartIdle();
  });
}
