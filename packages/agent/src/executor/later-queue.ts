// SPDX-License-Identifier: Apache-2.0
/**
 * STREAM-02 — the `'later'`-priority between-turns queue (push-completion).
 *
 * Paces work WITHOUT polling token-burn. In-turn (`'now'`) work runs inline;
 * `'later'` work is DEFERRED past the current turn and surfaced via
 * PUSH-COMPLETION — when a deferred item finishes, it ANNOUNCES on the injected
 * `onComplete` callback (the announce-on-done pattern), so the model is
 * NOTIFIED rather than re-prompting in a poll loop (T-221-STREAM-02: a poll
 * loop burns tokens every turn it re-checks). The deferred fire is scheduled on
 * the injected {@link TimerPort} and `.unref()`'d, so a pending `'later'` item
 * never holds the event loop / blocks graceful daemon drain (T-221-STREAM-03).
 *
 * ---------------------------------------------------------------------------
 * Q-STREAM-1 Wave-0 SPIKE findings (Task 0) — recorded here per the plan so
 * Tasks 1-2 implement against a confirmed seam:
 *
 *   STREAM-01 ordering decision: ASSERT-ONLY (no net-new ordering buffer was
 *   needed at the message-array level). The SDK
 *   (@earendil-works/pi-coding-agent 0.79.3, exact-pinned in
 *   packages/agent/package.json) already "appends persisted tool results in
 *   assistant source order" regardless of completion order
 *   (node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md:775, issue
 *   #3503; reaffirmed at CHANGELOG.md:1520). The shipped
 *   `createMutationSerializer` (./tool-parallelism.ts:109) wraps `execute()`
 *   WITHOUT reordering results — read-only tools pass through concurrently
 *   (tool-parallelism.ts:116), stateful tools serialize through the mutex. So
 *   the cache-stable ordering holds. STREAM-01 therefore PINS that contract
 *   with an explicit, tested order-preserving collector
 *   (`createOrderPreservingResultBuffer`, ./tool-parallelism.ts) rather than
 *   adding a redundant message-array buffer.
 *
 *   STREAM-02 reuse decision: NET-NEW MODULE (this file), REUSING the
 *   coordinator-progress-fork ANNOUNCE-ON-DONE pattern, not the fork module
 *   itself. coordinator-progress-fork.ts (../spawn/coordinator-progress-fork.ts)
 *   schedules on an injected TimerPort, `.unref()`s the handle
 *   (coordinator-progress-fork.ts:137), and cancels via `handle.cancel()`
 *   (coordinator-progress-fork.ts:143) — this queue mirrors that exact
 *   dependency shape. raw `setTimeout`/`Date.now` are BANNED here
 *   (this file is NOT a globals-classifier bootstrap path — see
 *   test/support/globals-classifier.ts:84 BOOTSTRAP_PATH_PATTERNS), so the
 *   TimerPort/ClockPort injection is mandatory.
 *
 *   Pipeline hook: the mutation serializer is invoked via
 *   `applyMutationSerializer` (./executor-tool-pipeline.ts:329) at
 *   ./executor-tool-assembly.ts:776. STREAM-01's contract lives at that
 *   boundary. This `'later'` queue is a standalone between-turns scheduler the
 *   executor loop drives — it is NOT wired into the hot per-turn tool-assembly
 *   path, so it adds zero lines to that path.
 *
 *   Capped files confirmed UNTOUCHED: sub-agent-runner.ts (2643 lines, at its
 *   per-file cap) and prompt-assembly.ts (2035 lines, at its per-file cap)
 *   receive NO new lines — STREAM-01 lands in tool-parallelism.ts (231 lines)
 *   and STREAM-02 in this new file.
 * ---------------------------------------------------------------------------
 *
 * INTERNAL to @comis/agent — driven by the executor loop. Not re-exported from
 * packages/agent/src/index.ts (no public-export-consumers entry needed),
 * mirroring coordinator-progress-fork.ts.
 *
 * @module
 */
import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";

/**
 * Default between-turns deferral for a `'later'` item. A `'later'` item paces
 * work past the current turn; the exact delay is not load-bearing (the
 * push-completion announce is what matters, not the precise wait), so this is a
 * conservative one-minute default. Overridable per-queue via
 * {@link LaterQueueDeps.laterDelayMs}.
 */
export const DEFAULT_LATER_DELAY_MS = 60_000;

/** Priority of a queued work item. */
export type LaterPriority =
  /** In-turn: run inline immediately (before any deferred work). */
  | "now"
  /** Between-turns: defer past the current turn; surface via push-completion. */
  | "later";

/** A unit of work the queue paces. `run()` is synchronous — the queue announces
 *  its return value on completion. */
export interface LaterQueueItem<T = unknown> {
  /** Stable id echoed on the completion announcement (never derived from content). */
  id: string;
  /** Priority — `'now'` runs inline; `'later'` defers to a push-completed fire. */
  priority: LaterPriority;
  /** The work. Its return value is announced via {@link LaterQueueDeps.onComplete}. */
  run: () => T;
}

/** The push-completion announcement — what the parent is NOTIFIED with on done. */
export interface LaterCompletion<T = unknown> {
  /** The completed item's id. */
  id: string;
  /** The completed item's result (the `run()` return value). */
  result: T;
}

/** Dependencies for {@link createLaterQueue}. Note what is ABSENT: there is no
 *  `poll` callback — completion is PUSHED via `onComplete`, never polled. */
export interface LaterQueueDeps<T = unknown> {
  /** Injected timer port — the between-turns fire (no setTimeout global). */
  timers: TimerPort;
  /** Injected wall-clock (no Date.now global). Present for parity with the
   *  coordinator-progress-fork dependency shape and future scheduling needs. */
  clock?: ClockPort;
  /**
   * PUSH-COMPLETION callback (announce-on-done): invoked with the
   * {@link LaterCompletion} when an item finishes — for `'now'` items
   * synchronously at enqueue, for `'later'` items when the deferred timer
   * fires. This is the "announce, don't poll" surface (T-221-STREAM-02).
   */
  onComplete: (completion: LaterCompletion<T>) => void;
  /** Override the between-turns deferral (default {@link DEFAULT_LATER_DELAY_MS}). */
  laterDelayMs?: number;
}

/** The queue handle the executor loop drives. */
export interface LaterQueue<T = unknown> {
  /**
   * Enqueue a work item. A `'now'` item runs INLINE before returning (in-turn
   * work, push-completed synchronously). A `'later'` item is DEFERRED on an
   * unref'd between-turns timer and push-completed when it fires — it does NOT
   * run inline this turn, and it runs AFTER all in-turn work.
   */
  enqueue(item: LaterQueueItem<T>): void;
  /** Number of `'later'` items still pending (not yet fired or cancelled). */
  pendingCount(): number;
  /**
   * Cancel every pending `'later'` item: each scheduled timer is cancelled (via
   * `handle.cancel()`, never raw clearTimeout) so it never fires and never
   * announces. Idempotent. Call in the executor's drain/shutdown path so a
   * pending `'later'` item never outlives the session.
   */
  cancel(): void;
}

/**
 * Create a {@link LaterQueue}. See the module doc for the full
 * push-completion / no-poll / unref'd-timer / priority contract and the
 * Q-STREAM-1 spike findings.
 */
export function createLaterQueue<T = unknown>(
  deps: LaterQueueDeps<T>,
): LaterQueue<T> {
  const { timers, onComplete } = deps;
  const laterDelayMs = deps.laterDelayMs ?? DEFAULT_LATER_DELAY_MS;

  // Pending deferred timers, keyed by item id so cancel() can drop them all.
  const pending = new Map<string, TimerHandle>();

  function announce(id: string, result: T): void {
    onComplete({ id, result });
  }

  return {
    enqueue(item: LaterQueueItem<T>): void {
      if (item.priority === "now") {
        // In-turn work: run inline, push-complete synchronously. This is why a
        // 'now' item enqueued AFTER a 'later' item still runs first — the
        // 'later' item is only scheduled, never run inline.
        announce(item.id, item.run());
        return;
      }

      // 'later': defer past this turn on an unref'd, cancelable timer. When it
      // fires it runs the work and ANNOUNCES (push-completion) — no poll loop.
      const handle = timers.setTimeout(() => {
        pending.delete(item.id);
        announce(item.id, item.run());
      }, laterDelayMs);
      // Never block event-loop exit (mirrors coordinator-progress-fork.ts:137).
      handle.unref();
      pending.set(item.id, handle);
    },
    pendingCount(): number {
      return pending.size;
    },
    cancel(): void {
      // Cancel via the opaque handle (never raw clearTimeout). Idempotent.
      for (const handle of pending.values()) {
        handle.cancel();
      }
      pending.clear();
    },
  };
}
