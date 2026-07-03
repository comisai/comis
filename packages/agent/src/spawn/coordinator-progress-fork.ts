// SPDX-License-Identifier: Apache-2.0
/**
 * The ~30s read-only progress fork.
 *
 * A multi-day coordinator spawns children that may run for minutes. Without a
 * progress signal a long child advances invisibly until it returns. This helper
 * surfaces that advance every ~30s by emitting a CONTENT-FREE
 * `session:sub_agent_progress` event — a 3-5 word status line + elapsed +
 * steps — WITHOUT the child completing.
 *
 * It is deliberately NOT a re-execution. "Fork"
 * here means a cheap read-only *summary* of the in-flight child's current step
 * state, NOT a second run. The helper has NO reference to `executeAgent`, a
 * spawner, a tool dispatcher, or a model — its ONLY input is a pure
 * `getStepState` read plus the injected clock/timers. A naive fork that re-ran
 * the child or called a tool would burn the per-root budget and could itself
 * spawn (fork-bomb); this one cannot, by construction.
 *
 * Discipline:
 *   - CONTENT-FREE (AGENTS.md §2.7): the event carries identifiers + a short
 *     status `progressLine` + counts + a timestamp ONLY — never the child's
 *     output, message body, or any tool result.
 *   - No-globals (AGENTS §2.5; globals.test.ts): time is read from the injected
 *     {@link ClockPort} and the interval is scheduled on the injected
 *     {@link TimerPort} — never `setInterval`/`Date.now`. The handle is
 *     `.unref()`'d so it never blocks event-loop exit, and `stop()` cancels it
 *     via `handle.cancel()` (never raw `clearInterval`), so the fork never
 *     outlives the child (no leaked timer).
 *   - No model call: the `progressLine` is built deterministically from the step
 *     count — it is a state summary, not an LLM summarization (cheap +
 *     deterministic).
 *
 * INTERNAL to @comis/agent — consumed by sub-agent-runner.ts. NOT re-exported
 * from packages/agent/src/index.ts (no public-export-consumers entry needed).
 *
 * @module
 */
import type { ClockPort, TimerPort, TimerHandle, EventMap } from "@comis/core";

/** Default progress cadence (~30s). */
export const COORDINATOR_PROGRESS_INTERVAL_MS = 30_000;

/**
 * The minimal event-bus surface the fork needs: it ONLY ever emits the
 * content-free progress event. The production `TypedEventBus` (whose `emit` is
 * the generic `emit<K>(event, payload)`) satisfies this narrower contract, so
 * the runner passes its real bus unchanged. Deliberately narrow — the fork has
 * no `.on`/`.off` and cannot subscribe to or trigger anything else.
 */
export interface ProgressForkEventBus {
  emit(event: "session:sub_agent_progress", payload: EventMap["session:sub_agent_progress"]): unknown;
}

/**
 * Dependencies for {@link createCoordinatorProgressFork}. Note what is ABSENT:
 * there is no `executeAgent`, no spawner, no tool dispatcher, and no model — the
 * fork is read-only by its type. `getStepState` is a PURE read of the in-flight
 * run's current step counter (the runner passes a thin closure over its run
 * handle); the fork never mutates run state.
 */
export interface CoordinatorProgressForkDeps {
  /** Emit-only bus surface (the real TypedEventBus satisfies it). */
  eventBus: ProgressForkEventBus;
  /** Injected wall-clock — elapsedMs is `clock.now() - startMs` (no Date.now). */
  clock: ClockPort;
  /** Injected timer port — the ~30s tick (no setInterval global). */
  timers: TimerPort;
  /** The in-flight child run id (echoed on the event; never derived from content). */
  runId: string;
  /** The child agent id (echoed on the event). */
  agentId: string;
  /**
   * Pure read of the in-flight child's current step state. The fork's ONLY
   * input besides the clock/timers — there is no re-execution channel. When the
   * runner cannot cheaply read a live step count it returns `{ stepsExecuted: 0 }`
   * and the elapsed wall-clock is the advance signal (a count-only advance is
   * still NOT a re-execution).
   */
  getStepState: () => { stepsExecuted: number };
  /** Override the ~30s cadence (default {@link COORDINATOR_PROGRESS_INTERVAL_MS}). */
  intervalMs?: number;
}

/** Opaque lifecycle handle — start the fork at spawn, stop it in the completion finally. */
export interface CoordinatorProgressForkHandle {
  /** Begin the ~30s read-only progress ticks. Idempotent — a second start is a no-op. */
  start(): void;
  /**
   * Stop the fork: cancel the interval (via `handle.cancel()`) so it never
   * outlives the child. Idempotent and safe to call before `start()` (no-op).
   */
  stop(): void;
}

/**
 * Build a short, content-free progress status line from the step count. ≤ ~6
 * words by construction (AGENTS.md §2.7) — a status descriptor, NOT child
 * content. NEVER incorporate the child's output here.
 */
function buildProgressLine(stepsExecuted: number): string {
  return `running, step ${stepsExecuted}`;
}

/**
 * Create the read-only progress fork. See the module doc for the full
 * read-only / content-free / no-globals / no-leak contract.
 */
export function createCoordinatorProgressFork(
  deps: CoordinatorProgressForkDeps,
): CoordinatorProgressForkHandle {
  const { eventBus, clock, timers, runId, agentId, getStepState } = deps;
  const intervalMs = deps.intervalMs ?? COORDINATOR_PROGRESS_INTERVAL_MS;

  let handle: TimerHandle | undefined;
  let startMs = 0;

  function tick(): void {
    // READ-ONLY: a pure step read + a clock read. No tool, no spawn, no model.
    const { stepsExecuted } = getStepState();
    const now = clock.now();
    eventBus.emit("session:sub_agent_progress", {
      runId,
      agentId,
      progressLine: buildProgressLine(stepsExecuted),
      elapsedMs: now - startMs,
      stepsExecuted,
      timestamp: now,
    });
  }

  return {
    start(): void {
      if (handle) return; // idempotent — never schedule two intervals
      startMs = clock.now();
      handle = timers.setInterval(tick, intervalMs);
      // Never block event-loop exit (the runner's keep-alive interval is
      // unref()'d for the same reason).
      handle.unref();
    },
    stop(): void {
      // Cancel via the opaque handle (never raw clearInterval). Idempotent +
      // safe before start() — handle is undefined then, and cancel() is a no-op
      // on an already-cancelled timer.
      handle?.cancel();
    },
  };
}
