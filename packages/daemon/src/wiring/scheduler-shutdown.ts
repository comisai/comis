// SPDX-License-Identifier: Apache-2.0
/** One drain/cancel/classification gate for all daemon-owned scheduled work. */
import type { ClockPort, ComisLogger, TimerPort } from "@comis/core";
import {
  SCHEDULER_SHUTDOWN_DRAIN_MS,
  SCHEDULER_TERMINATION_GRACE_MS,
} from "@comis/scheduler";

export interface SchedulerShutdownParticipant {
  readonly name: string;
  closeAdmission(): { readonly activeCount: number; readonly cancelledCount: number };
  waitForIdle(): Promise<void>;
  abortActive(): { readonly activeCount: number };
  finalizeShutdown(): void;
}

export interface SchedulerShutdownOutcome {
  readonly status: "drained" | "cancelled_settled" | "unsettled";
  readonly activeAtClose: number;
  readonly cancelledBeforeStart: number;
  readonly cancellationRequested: number;
}

interface SchedulerShutdownDeps {
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly logger: Pick<ComisLogger, "info" | "warn">;
  readonly participants: readonly SchedulerShutdownParticipant[];
}

/** Keep dependencies live through drain and termination classification, then close them once. */
export function createSchedulerShutdown(deps: SchedulerShutdownDeps): {
  run(): Promise<SchedulerShutdownOutcome>;
} {
  let runPromise: Promise<SchedulerShutdownOutcome> | undefined;
  return {
    run() {
      runPromise ??= runShutdown();
      return runPromise;
    },
  };

  async function runShutdown(): Promise<SchedulerShutdownOutcome> {
    const startedAtMs = deps.clock.now();
    let activeAtClose = 0;
    let cancelledBeforeStart = 0;
    for (const participant of deps.participants) {
      const closed = participant.closeAdmission();
      activeAtClose += closed.activeCount;
      cancelledBeforeStart += closed.cancelledCount;
    }

    // The same observer is retained across both deadlines. A timeout classifies
    // ownership; it does not detach or replace any participant's late observer.
    const allIdle = Promise.allSettled(deps.participants.map((participant) => participant.waitForIdle()));
    const drained = await settlesBefore(allIdle, SCHEDULER_SHUTDOWN_DRAIN_MS);
    if (drained) {
      finalizeAll();
      const outcome: SchedulerShutdownOutcome = {
        status: "drained",
        activeAtClose,
        cancelledBeforeStart,
        cancellationRequested: 0,
      };
      logCompletion(outcome, startedAtMs);
      return outcome;
    }

    let cancellationRequested = 0;
    for (const participant of deps.participants) {
      cancellationRequested += participant.abortActive().activeCount;
    }
    const cancelledSettled = await settlesBefore(allIdle, SCHEDULER_TERMINATION_GRACE_MS);
    finalizeAll();
    const outcome: SchedulerShutdownOutcome = {
      status: cancelledSettled ? "cancelled_settled" : "unsettled",
      activeAtClose,
      cancelledBeforeStart,
      cancellationRequested,
    };
    if (!cancelledSettled) {
      deps.logger.warn({
        participantCount: deps.participants.length,
        activeAtClose,
        cancellationRequested,
        durationMs: Math.max(0, deps.clock.now() - startedAtMs),
        step: "scheduler_shutdown_classification",
        errorKind: "timeout" as const,
        hint: "Inspect durable cron and task ownership during the next boot reconciliation",
      }, "Scheduled work remained unsettled at shutdown classification");
    }
    logCompletion(outcome, startedAtMs);
    return outcome;
  }

  async function settlesBefore(settlement: Promise<unknown>, delayMs: number): Promise<boolean> {
    let deadlineReached!: () => void;
    const deadline = new Promise<void>((resolve) => { deadlineReached = resolve; });
    const handle = deps.timers.setTimeout(deadlineReached, delayMs);
    handle.unref();
    const first = await Promise.race([
      settlement.then(() => "settled" as const),
      deadline.then(() => "deadline" as const),
    ]);
    handle.cancel();
    return first === "settled";
  }

  function finalizeAll(): void {
    for (const participant of deps.participants) participant.finalizeShutdown();
  }

  function logCompletion(outcome: SchedulerShutdownOutcome, startedAtMs: number): void {
    deps.logger.info({
      ...outcome,
      participantCount: deps.participants.length,
      durationMs: Math.max(0, deps.clock.now() - startedAtMs),
      step: "scheduler_shutdown_classification",
    }, "Scheduled work shutdown classification complete");
  }
}
