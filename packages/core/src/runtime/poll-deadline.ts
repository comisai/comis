// SPDX-License-Identifier: Apache-2.0
/**
 * Shared bounded-poll helper (DIVERGENCE 5).
 *
 * There is no other bounded-poll utility in the repo. It is authored in
 * `@comis/core/runtime` — NOT in `@comis/skills` — so Phase 189's daemon
 * background poller imports it without a package-boundary violation (it needs
 * the SAME loop the inline `execute()` baseline uses, byte-for-byte). The
 * `@comis/skills` FAL adapter consumes it in `execute()`.
 *
 * Sanctioned-clock discipline: the only clock/sleep this module touches are the
 * `systemNowMs` / `systemSleep` DEFAULTS from `./system-time.js` (themselves a
 * BOOTSTRAP_PATH_PATTERNS-exempt runtime root). Tests inject `nowMs`/`sleep`
 * (AGENTS.md §2.5) so they never touch a real timer.
 *
 * The helper is deliberately PROVIDER-AGNOSTIC: it returns a `PollOutcome`
 * discriminator (`done` / `failed` / `timeout`) and constructs no domain error.
 * The FAL adapter maps `{ kind: "timeout" }` onto a `VideoErrorKind:"job_timeout"`
 * Result carrying the loggable jobId — keeping this loop reusable by Phase 189.
 *
 * @module
 */
import { systemNowMs, systemSleep } from "./system-time.js";

/** An absolute-deadline view over an injectable clock. */
export interface PollDeadline {
  /** True once the clock has reached or passed the captured deadline. */
  exceeded(): boolean;
  /** Milliseconds left until the deadline; floors at 0 (never negative). */
  remainingMs(): number;
}

/**
 * Capture an absolute deadline from a `timeoutMs` budget. Inject `nowMs` for
 * fake-clock tests; defaults to the sanctioned `systemNowMs`.
 */
export function createPollDeadline(
  timeoutMs: number,
  nowMs: () => number = systemNowMs,
): PollDeadline {
  const deadlineMs = nowMs() + timeoutMs;
  return {
    exceeded: () => nowMs() >= deadlineMs,
    remainingMs: () => Math.max(0, deadlineMs - nowMs()),
  };
}

/**
 * Outcome discriminator — a terminal success status, a failed short-circuit, or
 * a deadline timeout. The caller (the adapter's `execute()`) maps `timeout` to
 * its domain `job_timeout` error and `failed` to the last thrown provider error.
 */
export type PollOutcome<S> =
  | { kind: "done"; status: S }
  | { kind: "failed"; status: S }
  | { kind: "timeout" };

/**
 * Bounded poll loop. Calls `poll()` until `isDone(status)` (→ done),
 * `isFailed(status)` (→ failed short-circuit, VPORT-02), or the deadline
 * (→ timeout). Sleeps `pollIntervalMs` (clamped to the remaining budget) between
 * attempts. Inject `nowMs` (via the `deadline`) and `sleep` for fake-timer
 * tests. Honors `signal?.aborted` (returns `timeout` so the caller surfaces a
 * single bounded-loop-ended branch).
 *
 * NEVER throws: a thrown `poll()` is the CALLER's concern — the FAL adapter
 * wraps `poll()` in `fromPromise` and maps a thrown HTTP error to the `failed`
 * branch itself; this helper only ever sees status snapshots + the deadline.
 */
export async function pollUntilDone<S>(opts: {
  poll: () => Promise<S>;
  isDone: (s: S) => boolean;
  isFailed: (s: S) => boolean;
  deadline: PollDeadline;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<PollOutcome<S>> {
  const sleep = opts.sleep ?? systemSleep;
  for (;;) {
    if (opts.signal?.aborted) return { kind: "timeout" };
    const status = await opts.poll();
    if (opts.isFailed(status)) return { kind: "failed", status };
    if (opts.isDone(status)) return { kind: "done", status };
    if (opts.deadline.exceeded()) return { kind: "timeout" };
    await sleep(Math.min(opts.pollIntervalMs, opts.deadline.remainingMs()));
    if (opts.deadline.exceeded()) return { kind: "timeout" };
  }
}
