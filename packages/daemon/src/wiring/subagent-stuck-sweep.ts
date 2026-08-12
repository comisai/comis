// SPDX-License-Identifier: Apache-2.0
/**
 * Stuck sub-agent sweep — idle-based detection for the daemon health tick.
 *
 * "Stuck" means NO OBSERVED PROGRESS for the threshold window, NOT "the run
 * is old": a healthy long-running research sub-agent doing continuous
 * tool/LLM work must never be killed for exceeding a wall-clock age (the
 * wall-clock budget belongs to the runner's own per-run watchdog,
 * `maxRunTimeoutMs`). Progress is observed from the shared event bus — the
 * same per-call/tool boundary signals the trajectory bridge records:
 *
 *   - `tool:started` / `tool:executed` — a tool boundary was crossed;
 *   - `execution:stream_progress`     — an active model emitted a bounded delta signal;
 *   - `observability:token_usage`      — an LLM call completed.
 *
 * A hang INSIDE a single LLM call is governed by the prompt-timeout
 * governor (which surfaces as an error the run handles itself); a hang
 * INSIDE a single tool call is governed by the per-tool timeout. The sweep
 * is the outer safety net for runs that stop producing boundary events
 * entirely (leaked promise, dead SDK session).
 *
 * The sweep itself is PURE (no clock, no I/O) so the kill predicate is
 * unit-testable; the daemon health tick supplies `now`, the run snapshot,
 * and the tracker's `lastActivityFor`.
 *
 * @module
 */

import type { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Activity tracker — bus-fed lastActivity map keyed by formatted sessionKey.
// ---------------------------------------------------------------------------

/** Bus-fed per-session activity clock. `prune` keeps the map bounded to the
 *  currently-active run set; `dispose` detaches the bus handlers. */
export interface SubagentActivityTracker {
  /** Last observed progress timestamp for a session, or undefined. */
  lastActivityFor(sessionKey: string): number | undefined;
  /** Drop every key not in `activeKeys` (called once per health tick). */
  prune(activeKeys: ReadonlySet<string>): void;
  /** Detach the bus handlers (daemon shutdown). */
  dispose(): void;
}

/**
 * Subscribe a lastActivity map to the progress-bearing bus events.
 * `nowMs` is injected (daemon passes the health tick's clock) so the
 * tracker stays clock-free for tests.
 */
export function createSubagentActivityTracker(
  eventBus: TypedEventBus,
  nowMs: () => number,
): SubagentActivityTracker {
  const lastActivity = new Map<string, number>();

  const touch = (payload: unknown): void => {
    const sessionKey = (payload as { sessionKey?: unknown } | undefined)?.sessionKey;
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    lastActivity.set(sessionKey, nowMs());
  };

  eventBus.on("tool:started", touch);
  eventBus.on("tool:executed", touch);
  eventBus.on("execution:stream_progress", touch);
  eventBus.on("observability:token_usage", touch);

  return {
    lastActivityFor(sessionKey) {
      return lastActivity.get(sessionKey);
    },
    prune(activeKeys) {
      for (const key of lastActivity.keys()) {
        if (!activeKeys.has(key)) lastActivity.delete(key);
      }
    },
    dispose() {
      eventBus.off("tool:started", touch);
      eventBus.off("tool:executed", touch);
      eventBus.off("execution:stream_progress", touch);
      eventBus.off("observability:token_usage", touch);
      lastActivity.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure sweep predicate.
// ---------------------------------------------------------------------------

/** The run fields the sweep reads (a SubAgentRun shallow view). */
export interface StuckSweepRunView {
  runId: string;
  agentId: string;
  status: string;
  startedAt: number;
  sessionKey: string;
  graphId?: string;
  /** Run this one was spawned by, when it is a nested spawn. */
  parentRunId?: string;
}

/** One kill decision with the telemetry the WARN + killRun attribution carry. */
export interface StuckKillDecision {
  runId: string;
  agentId: string;
  isGraphRun: boolean;
  runtimeMs: number;
  idleMs: number;
  thresholdMs: number;
}

/**
 * Decide which running sub-agents are stuck. A run is stuck when its IDLE
 * time — `now - (lastActivityFor(sessionKey) ?? startedAt)` — exceeds its
 * threshold (graph runs get the longer graph threshold; `0` disables).
 *
 * A run with a RUNNING child is exempt: waiting on delegated work emits no
 * tool or LLM progress of its own, so idle time measures the wait rather than
 * a stall, and killing the waiter discards the child's work along with it.
 * This does not blunt the watchdog — every child is swept on the same tick
 * under its own threshold, so a hung tree still dies at the leaves and the
 * parent becomes eligible again on the next tick once no child is running.
 */
export function sweepStuckSubAgentRuns(params: {
  runs: readonly StuckSweepRunView[];
  now: number;
  stuckKillThresholdMs: number;
  graphStuckKillThresholdMs: number;
  lastActivityFor: (sessionKey: string) => number | undefined;
}): {
  activeSubAgentRuns: number;
  stuckSubAgentRuns: number;
  kills: StuckKillDecision[];
} {
  let activeSubAgentRuns = 0;
  let stuckSubAgentRuns = 0;
  const kills: StuckKillDecision[] = [];
  const awaitingChildren = new Set(
    params.runs
      .filter((run) => run.status === "running" && run.parentRunId !== undefined)
      .map((run) => run.parentRunId as string),
  );

  for (const run of params.runs) {
    if (run.status !== "running") continue;
    activeSubAgentRuns++;

    const thresholdMs = run.graphId
      ? params.graphStuckKillThresholdMs
      : params.stuckKillThresholdMs;
    if (thresholdMs <= 0) continue;

    if (awaitingChildren.has(run.runId)) continue;

    const lastActivityAt = params.lastActivityFor(run.sessionKey) ?? run.startedAt;
    const idleMs = params.now - lastActivityAt;
    if (idleMs <= thresholdMs) continue;

    stuckSubAgentRuns++;
    kills.push({
      runId: run.runId,
      agentId: run.agentId,
      isGraphRun: !!run.graphId,
      runtimeMs: params.now - run.startedAt,
      idleMs,
      thresholdMs,
    });
  }

  return { activeSubAgentRuns, stuckSubAgentRuns, kills };
}
