// SPDX-License-Identifier: Apache-2.0
/** Deadline-bounded, timer-free monitoring runner owned by the wake coordinator. */
import type {
  ClockPort,
  ComisLogger,
  ErrorKind,
  TimerHandle,
  TimerPort,
  TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { SCHEDULER_TERMINATION_GRACE_MS } from "../cron/cron-runtime.js";
import type {
  HeartbeatWakeReason,
  MonitoringHeartbeatOutcome,
} from "./wake-coordinator.js";
import {
  HeartbeatSourceIdSchema,
  MonitoringSourceDiagnosticSchema,
  type HeartbeatSourcePort,
} from "./heartbeat-source.js";

type MonitoringTrigger = Exclude<HeartbeatWakeReason, "task">;

export type MonitoringHeartbeatError =
  | { readonly code: "invalid_input"; readonly errorKind: "validation" }
  | { readonly code: "not_bound" | "precondition_failed"; readonly errorKind: "precondition" };

export interface HeartbeatRunnerDeps {
  sources: readonly HeartbeatSourcePort[];
  clock: ClockPort;
  timers: TimerPort;
  eventBus: Pick<TypedEventBus, "emit">;
  logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
  staleMs: number;
}

export interface HeartbeatRunner {
  runOnce(
    trigger: MonitoringTrigger,
    signal: AbortSignal,
  ): Promise<Result<MonitoringHeartbeatOutcome, MonitoringHeartbeatError>>;
  registerSource(source: HeartbeatSourcePort): Result<void, MonitoringHeartbeatError>;
  unregisterSource(sourceId: string): boolean;
  isBusy(): boolean;
  shutdown(): void;
}

interface Snapshot {
  checksRun: number;
  checksCompleted: number;
  checksFailed: number;
  alertsRaised: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function isMonitoringTrigger(value: string): value is MonitoringTrigger {
  return value === "interval"
    || value === "manual"
    || value === "hook"
    || value === "wake"
    || value === "exec-event"
    || value === "cron";
}

/** Create a monitoring runner with no interval ownership or user-delivery surface. */
export function createHeartbeatRunner(deps: HeartbeatRunnerDeps): HeartbeatRunner {
  const sources = new Map<string, HeartbeatSourcePort>();
  let accepting = true;
  let busy = false;
  let activeController: AbortController | undefined;

  for (const source of deps.sources) {
    const registered = registerSource(source);
    if (!registered.ok) {
      accepting = false;
      break;
    }
  }

  return {
    runOnce,
    registerSource,
    unregisterSource(sourceId) {
      return sources.delete(sourceId);
    },
    isBusy: () => busy,
    shutdown() {
      accepting = false;
      activeController?.abort("shutdown");
    },
  };

  function registerSource(
    source: HeartbeatSourcePort,
  ): Result<void, MonitoringHeartbeatError> {
    if (!accepting) return err({ code: "not_bound", errorKind: "precondition" });
    const sourceId = HeartbeatSourceIdSchema.safeParse(source.id);
    if (!sourceId.success || sources.has(source.id)) {
      return err({ code: "invalid_input", errorKind: "validation" });
    }
    sources.set(source.id, source);
    return ok(undefined);
  }

  async function runOnce(
    trigger: MonitoringTrigger,
    signal: AbortSignal,
  ): Promise<Result<MonitoringHeartbeatOutcome, MonitoringHeartbeatError>> {
    if (!isMonitoringTrigger(trigger)) {
      return err({ code: "invalid_input", errorKind: "validation" });
    }
    if (!accepting || busy || signal.aborted || !Number.isSafeInteger(deps.staleMs) || deps.staleMs <= 0) {
      return err({ code: "precondition_failed", errorKind: "precondition" });
    }

    busy = true;
    const startedAtMs = deps.clock.now();
    const snapshot: Snapshot = {
      checksRun: 0,
      checksCompleted: 0,
      checksFailed: 0,
      alertsRaised: 0,
    };
    const controller = new AbortController();
    activeController = controller;
    const aborted = deferred<"aborted">();
    const onParentAbort = (): void => controller.abort(signal.reason ?? "shutdown");
    signal.addEventListener("abort", onParentAbort, { once: true });
    const onAbort = (): void => aborted.resolve("aborted");
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const deadline = deps.timers.setTimeout(() => controller.abort("deadline"), deps.staleMs);
    deadline.unref();

    const checks = runChecks(snapshot, controller.signal);
    const first = await Promise.race([
      checks.then(() => "settled" as const),
      aborted.promise,
    ]);
    if (first === "settled") {
      cleanup(deadline, signal, onParentAbort, controller.signal, onAbort);
      busy = false;
      activeController = undefined;
      const outcome = settledOutcome(trigger, snapshot, elapsed(startedAtMs));
      logCompletion(outcome);
      return ok(outcome);
    }

    deadline.cancel();
    const graceElapsed = deferred<"grace_elapsed">();
    const grace = deps.timers.setTimeout(
      () => graceElapsed.resolve("grace_elapsed"),
      SCHEDULER_TERMINATION_GRACE_MS,
    );
    grace.unref();
    const afterAbort = await Promise.race([
      checks.then(() => "settled" as const),
      graceElapsed.promise,
    ]);
    const abortReason = controller.signal.reason;
    if (afterAbort === "settled") {
      cleanup(grace, signal, onParentAbort, controller.signal, onAbort);
      busy = false;
      activeController = undefined;
      const outcome = abortedOutcome(
        trigger,
        abortReason === "deadline" ? "deadline" : abortReason === "target_removed" ? "target_removed" : "shutdown",
        snapshot,
        elapsed(startedAtMs),
      );
      logCompletion(outcome);
      return ok(outcome);
    }

    cleanup(grace, signal, onParentAbort, controller.signal, onAbort);
    void checks.finally(() => {
      busy = false;
      activeController = undefined;
      deps.logger.info({
        durationMs: elapsed(startedAtMs),
        checksRun: snapshot.checksRun,
        checksCompleted: snapshot.checksCompleted,
        checksFailed: snapshot.checksFailed,
        alertsRaised: snapshot.alertsRaised,
      }, "Monitoring heartbeat late settlement complete");
    });
    const outcome: MonitoringHeartbeatOutcome = {
      status: "unsettled",
      trigger,
      reason: "deadline_termination_unestablished",
      errorKind: "timeout",
      checksRun: snapshot.checksRun,
      checksCompleted: snapshot.checksCompleted,
      checksFailed: snapshot.checksFailed,
      alertsRaised: snapshot.alertsRaised,
      durationMs: elapsed(startedAtMs),
    };
    logCompletion(outcome);
    return ok(outcome);
  }

  async function runChecks(snapshot: Snapshot, signal: AbortSignal): Promise<void> {
    for (const source of sources.values()) {
      if (signal.aborted) break;
      snapshot.checksRun += 1;
      const invoked = await fromPromise(source.check(signal));
      snapshot.checksCompleted += 1;
      if (!invoked.ok) {
        recordFailure(source.id, "source_rejected", "dependency", snapshot);
        continue;
      }
      if (!invoked.value.ok) {
        recordFailure(source.id, invoked.value.error.code, invoked.value.error.errorKind, snapshot);
        continue;
      }
      const diagnostic = MonitoringSourceDiagnosticSchema.safeParse(invoked.value.value);
      if (!diagnostic.success) {
        recordFailure(source.id, "invalid_diagnostic", "validation", snapshot);
        continue;
      }
      if (diagnostic.data.level !== "ok") snapshot.alertsRaised += 1;
      deps.logger.debug({
        sourceId: source.id,
        level: diagnostic.data.level,
        diagnosticCode: diagnostic.data.code,
        counters: diagnostic.data.counters,
        step: "monitoring_source_check",
      }, "Monitoring source check complete");
    }
  }

  function recordFailure(
    sourceId: string,
    sourceErrorCode: string,
    errorKind: ErrorKind,
    snapshot: Snapshot,
  ): void {
    snapshot.checksFailed += 1;
    snapshot.alertsRaised += 1;
    deps.logger.error({
      sourceId,
      sourceErrorCode,
      step: "monitoring_source_check",
      errorKind,
      hint: "Inspect the classified monitoring adapter and its external dependency",
    }, "Monitoring source check failed");
  }

  function elapsed(startedAtMs: number): number {
    return Math.max(0, deps.clock.now() - startedAtMs);
  }

  function logCompletion(outcome: MonitoringHeartbeatOutcome): void {
    deps.logger.info({
      status: outcome.status,
      trigger: outcome.trigger,
      checksRun: outcome.checksRun,
      checksFailed: outcome.checksFailed,
      alertsRaised: outcome.alertsRaised,
      durationMs: outcome.durationMs,
    }, "Monitoring heartbeat execution complete");
  }
}

function cleanup(
  timer: TimerHandle,
  parentSignal: AbortSignal,
  onParentAbort: () => void,
  signal: AbortSignal,
  onAbort: () => void,
): void {
  timer.cancel();
  parentSignal.removeEventListener("abort", onParentAbort);
  signal.removeEventListener("abort", onAbort);
}

function settledOutcome(
  trigger: MonitoringTrigger,
  snapshot: Snapshot,
  durationMs: number,
): MonitoringHeartbeatOutcome {
  return {
    status: "settled",
    trigger,
    checksRun: snapshot.checksRun,
    checksFailed: snapshot.checksFailed,
    alertsRaised: snapshot.alertsRaised,
    durationMs,
  };
}

function abortedOutcome(
  trigger: MonitoringTrigger,
  reason: "deadline" | "shutdown" | "target_removed",
  snapshot: Snapshot,
  durationMs: number,
): MonitoringHeartbeatOutcome {
  return {
    status: "aborted",
    trigger,
    reason,
    errorKind: reason === "deadline" ? "timeout" : "precondition",
    checksRun: snapshot.checksRun,
    checksFailed: snapshot.checksFailed,
    alertsRaised: snapshot.alertsRaised,
    durationMs,
  };
}
