// SPDX-License-Identifier: Apache-2.0
/** Serialized, typed heartbeat admission and execution coordinator. */
import type {
  AgentTurnExecutionOutcome,
  ClockPort,
  ComisLogger,
  ErrorKind,
  ModelResolutionSource,
  PlatformDeliveryOutcome,
  TimerHandle,
  TimerPort,
  TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type { SystemEventEntry } from "../system-events/system-event-types.js";
import {
  createHeartbeatPeriodicSchedule,
  type HeartbeatPeriodicConfig,
  type HeartbeatPeriodicConfigureOutcome,
  type HeartbeatPeriodicScheduleError,
} from "./periodic-schedule.js";
import { createHeartbeatWakeEventQueue } from "./wake-event-queue.js";
import { SystemEventWakeSchema, WakeRequestSchema } from "./wake-validation.js";

export const HEARTBEAT_MIN_WAKE_SPACING_MS = 30_000;
export const HEARTBEAT_FLOOD_WINDOW_MS = 60_000;
export const HEARTBEAT_FLOOD_MAX_STARTS = 5;
const HEARTBEAT_BUSY_RECHECK_MS = 1_000;
const HEARTBEAT_ROOT_RECHECK_MS = 60_000;
const HEARTBEAT_TASK_STORE_RECHECK_MS = 30_000;
const HEARTBEAT_RELEASE_BACKOFF_MS = 30_000;
const MAX_IDENTIFIER_BYTES = 256;

export type HeartbeatWakeTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "monitoring" };
export type HeartbeatWakeReason = "interval" | "manual" | "hook" | "wake" | "exec-event" | "cron" | "task";
export type HeartbeatWakeLane = "normal" | "task";
export type HeartbeatWakeTiming =
  | { readonly kind: "routine"; readonly notBeforeMs: number }
  | { readonly kind: "spacing_bypass"; readonly notBeforeMs: number };
export interface HeartbeatWakeRequest {
  readonly target: HeartbeatWakeTarget;
  readonly reason: HeartbeatWakeReason;
  readonly timing: HeartbeatWakeTiming;
}

export type HeartbeatWakeAdmissionOutcome =
  | {
      readonly status: "accepted";
      readonly disposition: "new_occurrence" | "occurrence_upgraded";
      readonly correlationId: string;
      readonly lane: HeartbeatWakeLane;
      readonly retainedReason: HeartbeatWakeReason;
    }
  | {
      readonly status: "coalesced";
      readonly correlationId: string;
      readonly lane: HeartbeatWakeLane;
      readonly retainedReason: HeartbeatWakeReason;
    };
export type HeartbeatWakeAdmissionError =
  | { readonly code: "invalid_request" | "invalid_target"; readonly errorKind: "validation" }
  | { readonly code: "not_accepting"; readonly errorKind: "precondition" };
export type SystemEventWakeAdmissionError = HeartbeatWakeAdmissionError
  | { readonly code: "queue_full"; readonly errorKind: "resource" };

export interface SystemEventWakeAdmissionRequest {
  readonly target: Extract<HeartbeatWakeTarget, { kind: "agent" }>;
  readonly reason: "hook" | "wake" | "exec-event" | "cron";
  readonly wakeMode: "now" | "next-heartbeat";
  readonly notBeforeMs: number;
  readonly event: {
    readonly trigger: "hook" | "wake" | "exec-event" | "cron";
    readonly contextKey: string;
    readonly text: string;
  };
}

export interface SystemEventWakeAdmissionOutcome {
  readonly queueDisposition: "accepted" | "accepted_oldest_dropped" | "duplicate";
  readonly wake: HeartbeatWakeAdmissionOutcome;
}

export type HeartbeatSuppressionReason =
  | "heartbeat_token"
  | "ack_under_threshold"
  | "empty_reply"
  | "response_filter"
  | "no_target"
  | "dm_policy"
  | "channel_not_ready"
  | "quiet_hours"
  | "visibility_filter"
  | "duplicate";
export type HeartbeatPreSendFailureReason =
  | "output_guard"
  | "target_precondition"
  | "cancelled";
export type HeartbeatDeliveryOutcome =
  | { readonly status: "not_requested" }
  | { readonly status: "suppressed"; readonly reason: HeartbeatSuppressionReason }
  | {
      readonly status: "pre_send_failed";
      readonly reason: HeartbeatPreSendFailureReason;
      readonly errorKind: ErrorKind;
    }
  | PlatformDeliveryOutcome;
export type HeartbeatTickError =
  | { readonly code: "invalid_input" | "invalid_target"; readonly errorKind: "validation" }
  | { readonly code: "not_bound" | "precondition_failed"; readonly errorKind: "precondition" }
  | { readonly code: "task_store_unavailable"; readonly errorKind: ErrorKind };
export type HeartbeatTickOutcome =
  | {
      readonly status: "skipped";
      readonly trigger: "interval" | "task";
      readonly reason: "empty_file" | "task_disabled" | "task_no_due" | "task_quiet_hours" | "task_daily_cap";
      readonly rootRunId: string | null;
      readonly durationMs: number;
      readonly gate?: "coordinator" | "store";
    }
  | {
      readonly status: "settled";
      readonly trigger: HeartbeatWakeReason;
      readonly rootRunId: string;
      readonly agentExecutionId: string;
      readonly execution: AgentTurnExecutionOutcome;
      readonly modelResolved: string;
      readonly modelResolutionSource: ModelResolutionSource;
      readonly metrics: { readonly totalTokens: number; readonly costUsd: number; readonly toolCalls: number; readonly llmCalls: number };
      readonly delivery: HeartbeatDeliveryOutcome;
      readonly durationMs: number;
      readonly sessionMaintenance: { readonly status: "not_required" | "completed" } | { readonly status: "failed"; readonly errorKind: ErrorKind };
      readonly eventBatch: { readonly status: "none" } | { readonly status: "consumed"; readonly entryCount: number };
    }
  | {
      readonly status: "unsettled";
      readonly trigger: HeartbeatWakeReason;
      readonly rootRunId: string;
      readonly agentExecutionId: null;
      readonly reason: "deadline_termination_unestablished";
      readonly errorKind: "timeout";
      readonly deliveryMayHaveStarted: boolean;
      readonly durationMs: number;
      readonly eventBatch: { readonly status: "none" } | { readonly status: "consumed"; readonly entryCount: number };
    }
  | {
      readonly status: "unsettled";
      readonly trigger: "task";
      readonly rootRunId: string;
      readonly agentExecutionId: string;
      readonly reason: "task_state_unsettled";
      readonly errorKind: ErrorKind;
      readonly deliveryMayHaveStarted: boolean;
      readonly durationMs: number;
      readonly eventBatch: { readonly status: "none" };
    };

export type MonitoringHeartbeatOutcome =
  | {
      readonly status: "settled";
      readonly trigger: Exclude<HeartbeatWakeReason, "task">;
      readonly checksRun: number;
      readonly checksFailed: number;
      readonly alertsRaised: number;
      readonly durationMs: number;
    }
  | {
      readonly status: "aborted" | "unsettled";
      readonly trigger: Exclude<HeartbeatWakeReason, "task">;
      readonly reason: "deadline" | "shutdown" | "target_removed" | "deadline_termination_unestablished";
      readonly errorKind: "timeout" | "precondition";
      readonly checksRun: number;
      readonly checksFailed: number;
      readonly alertsRaised: number;
      readonly durationMs: number;
      readonly checksCompleted?: number;
    };

export interface HeartbeatCoordinatorAgentRunInput {
  readonly correlationId: string;
  readonly target: Extract<HeartbeatWakeTarget, { kind: "agent" }>;
  readonly lane: HeartbeatWakeLane;
  readonly reason: HeartbeatWakeReason;
  readonly rootRunId: string;
  readonly eventBatch: readonly SystemEventEntry[];
  readonly signal: AbortSignal;
}
export interface HeartbeatCoordinatorMonitoringRunInput {
  readonly correlationId: string;
  readonly target: Extract<HeartbeatWakeTarget, { kind: "monitoring" }>;
  readonly reason: Exclude<HeartbeatWakeReason, "task">;
  readonly signal: AbortSignal;
}

interface RootRegistrationError {
  readonly errorKind: ErrorKind;
}

export interface HeartbeatWakeCoordinatorDeps {
  clock: ClockPort;
  timers: TimerPort;
  eventBus: Pick<TypedEventBus, "emit">;
  logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
  idFactory(): string;
  hasTarget(target: HeartbeatWakeTarget): boolean;
  isTargetBusy(target: HeartbeatWakeTarget): boolean;
  /** Cheap default-off task gate; the store transaction rechecks authority. */
  isTaskEnabled(agentId: string): boolean;
  /** True only when a periodic agent heartbeat has no executable workspace policy. */
  checkIntervalFileGate(agentId: string): Promise<Result<boolean, HeartbeatTickError>>;
  registerRoot(input: {
    correlationId: string;
    target: Extract<HeartbeatWakeTarget, { kind: "agent" }>;
    lane: HeartbeatWakeLane;
    reason: HeartbeatWakeReason;
  }): Promise<Result<{ rootRunId: string }, RootRegistrationError>>;
  releaseRoot(rootRunId: string): Promise<Result<void, RootRegistrationError>>;
  runAgent(input: HeartbeatCoordinatorAgentRunInput): Promise<Result<HeartbeatTickOutcome, HeartbeatTickError>>;
  runMonitoring(input: HeartbeatCoordinatorMonitoringRunInput): Promise<Result<MonitoringHeartbeatOutcome, HeartbeatTickError>>;
}

interface Occurrence {
  correlationId: string;
  target: HeartbeatWakeTarget;
  lane: HeartbeatWakeLane;
  reason: HeartbeatWakeReason;
  timingKind: HeartbeatWakeTiming["kind"];
  notBeforeMs: number;
  sealed: boolean;
  started: boolean;
  controller?: AbortController;
}

interface TargetState {
  target: HeartbeatWakeTarget;
  pending: Partial<Record<HeartbeatWakeLane, Occurrence>>;
  selected?: Occurrence;
  timer?: TimerHandle;
  lastStartedAtMs?: number;
  starts: number[];
}

const REASON_PRIORITY: Readonly<Record<HeartbeatWakeReason, number>> = {
  interval: 1,
  manual: 2,
  hook: 2,
  wake: 2,
  "exec-event": 3,
  cron: 3,
  task: 4,
};

function byteBounded(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES;
}

function targetKey(target: HeartbeatWakeTarget): string {
  return target.kind === "monitoring"
    ? "10:monitoring"
    : `5:agent${Buffer.byteLength(target.agentId, "utf8")}:${target.agentId}`;
}

function laneFor(reason: HeartbeatWakeReason): HeartbeatWakeLane {
  return reason === "task" ? "task" : "normal";
}

/** Create the sole serializer for heartbeat admissions, target starts, and event cutoffs. */
export function createHeartbeatWakeCoordinator(deps: HeartbeatWakeCoordinatorDeps) {
  let accepting = false;
  let closed = false;
  const targets = new Map<string, TargetState>();
  const removedTargets = new Set<string>();
  const closedTaskAgents = new Set<string>();
  const activeDispatches = new Set<Promise<void>>();
  const eventQueue = createHeartbeatWakeEventQueue();
  const periodicSchedule = createHeartbeatPeriodicSchedule({
    clock: deps.clock,
    timers: deps.timers,
    logger: deps.logger,
    submitInterval: (agentId, nominalDueAtMs) => submitWake({
      target: { kind: "agent", agentId },
      reason: "interval",
      timing: { kind: "routine", notBeforeMs: nominalDueAtMs },
    }),
  });

  function activate(): Result<void, HeartbeatPeriodicScheduleError> {
    if (closed) {
      return err({
        code: "periodic_disabled",
        errorKind: "precondition",
        message: "Heartbeat coordinator is closed",
      });
    }
    if (accepting) return ok(undefined);
    accepting = true;
    const activated = periodicSchedule.activate();
    if (!activated.ok) accepting = false;
    return activated;
  }

  function stateFor(target: HeartbeatWakeTarget): TargetState {
    const key = targetKey(target);
    let state = targets.get(key);
    if (state === undefined) {
      state = { target, pending: {}, starts: [] };
      targets.set(key, state);
    }
    return state;
  }

  function targetAvailable(target: HeartbeatWakeTarget): boolean {
    return !removedTargets.has(targetKey(target)) && deps.hasTarget(target);
  }

  function mintCorrelationId(): string | undefined {
    const id = deps.idFactory();
    return byteBounded(id) ? id : undefined;
  }

  function emitAdmission(outcome: HeartbeatWakeAdmissionOutcome, target: HeartbeatWakeTarget): void {
    deps.eventBus.emit("scheduler:heartbeat_wake_admitted", {
      correlationId: outcome.correlationId,
      target,
      lane: outcome.lane,
      retainedReason: outcome.retainedReason,
      disposition: outcome.status === "coalesced" ? "coalesced" : outcome.disposition,
      timestamp: deps.clock.now(),
    });
  }

  function upsertWake(
    request: HeartbeatWakeRequest,
    forcedCorrelationId?: string,
  ): Result<HeartbeatWakeAdmissionOutcome, HeartbeatWakeAdmissionError> {
    const state = stateFor(request.target);
    const lane = laneFor(request.reason);
    const existing = state.pending[lane];
    if (existing === undefined) {
      const correlationId = forcedCorrelationId ?? mintCorrelationId();
      if (correlationId === undefined) {
        return err({ code: "not_accepting", errorKind: "precondition" });
      }
      const occurrence: Occurrence = {
        correlationId,
        target: request.target,
        lane,
        reason: request.reason,
        timingKind: request.timing.kind,
        notBeforeMs: request.timing.notBeforeMs,
        sealed: false,
        started: false,
      };
      state.pending[lane] = occurrence;
      armTarget(state);
      const outcome: HeartbeatWakeAdmissionOutcome = {
        status: "accepted",
        disposition: "new_occurrence",
        correlationId,
        lane,
        retainedReason: occurrence.reason,
      };
      emitAdmission(outcome, request.target);
      return ok(outcome);
    }

    const higherPriority = REASON_PRIORITY[request.reason] > REASON_PRIORITY[existing.reason];
    const earlier = request.timing.notBeforeMs < existing.notBeforeMs;
    const bypassUpgrade = request.timing.kind === "spacing_bypass" && existing.timingKind === "routine";
    if (higherPriority) existing.reason = request.reason;
    if (earlier) existing.notBeforeMs = request.timing.notBeforeMs;
    if (bypassUpgrade) existing.timingKind = "spacing_bypass";
    if (higherPriority || earlier || bypassUpgrade) {
      armTarget(state);
      const outcome: HeartbeatWakeAdmissionOutcome = {
        status: "accepted",
        disposition: "occurrence_upgraded",
        correlationId: existing.correlationId,
        lane,
        retainedReason: existing.reason,
      };
      emitAdmission(outcome, request.target);
      return ok(outcome);
    }
    const outcome: HeartbeatWakeAdmissionOutcome = {
      status: "coalesced",
      correlationId: existing.correlationId,
      lane,
      retainedReason: existing.reason,
    };
    emitAdmission(outcome, request.target);
    return ok(outcome);
  }

  function armTarget(state: TargetState): void {
    if (!accepting || state.selected?.started === true) return;
    const due = state.selected?.notBeforeMs
      ?? Math.min(
        state.pending.task?.notBeforeMs ?? Number.POSITIVE_INFINITY,
        state.pending.normal?.notBeforeMs ?? Number.POSITIVE_INFINITY,
      );
    state.timer?.cancel();
    state.timer = undefined;
    if (!Number.isFinite(due)) return;
    const key = targetKey(state.target);
    const handle = deps.timers.setTimeout(() => {
      if (state.timer === handle) state.timer = undefined;
      const dispatched = dispatchTarget(key);
      activeDispatches.add(dispatched);
      void dispatched.then(() => {
        activeDispatches.delete(dispatched);
      }, () => {
        activeDispatches.delete(dispatched);
        deps.logger.error({
          targetKind: state.target.kind,
          step: "heartbeat_dispatch",
          errorKind: "internal" as const,
          hint: "Inspect the heartbeat coordinator; the target remains serialized until settlement.",
        }, "Heartbeat coordinator dispatch rejected");
      });
    }, Math.max(0, due - deps.clock.now()));
    handle.unref();
    state.timer = handle;
  }

  function emitDeferral(
    occurrence: Occurrence,
    reason: "session_busy" | "spacing_deferred" | "flood_deferred" | "root_unavailable" | "task_store_unavailable",
    nextEligibleAtMs: number,
    errorKind?: ErrorKind,
  ): void {
    deps.eventBus.emit("scheduler:heartbeat_wake_deferred", {
      correlationId: occurrence.correlationId,
      target: occurrence.target,
      lane: occurrence.lane,
      reason,
      nextEligibleAtMs,
      ...(errorKind === undefined ? {} : { errorKind }),
      timestamp: deps.clock.now(),
    });
  }

  function terminalStatus(outcome: HeartbeatTickOutcome | MonitoringHeartbeatOutcome):
  "settled" | "skipped" | "aborted" | "unsettled" {
    return outcome.status;
  }

  function emitTerminal(
    occurrence: Occurrence,
    status: "settled" | "skipped" | "aborted" | "unsettled" | "failed_before_side_effect" | "cancelled_before_start",
    entryCount: number,
    durationMs: number,
    errorKind?: ErrorKind,
    cancellationReason?: "shutdown" | "target_removed" | "feature_disabled" | "maintenance",
  ): void {
    deps.eventBus.emit("scheduler:heartbeat_wake_terminal", {
      correlationId: occurrence.correlationId,
      target: occurrence.target,
      lane: occurrence.lane,
      retainedReason: occurrence.reason,
      status,
      ...(cancellationReason === undefined ? {} : { cancellationReason }),
      eventEntryCount: entryCount,
      durationMs,
      ...(errorKind === undefined ? {} : { errorKind }),
      timestamp: deps.clock.now(),
    });
  }

  function selectEligible(state: TargetState, nowMs: number): Occurrence | undefined {
    const task = state.pending.task;
    if (task !== undefined && task.notBeforeMs <= nowMs) return task;
    const normal = state.pending.normal;
    return normal !== undefined && normal.notBeforeMs <= nowMs ? normal : undefined;
  }

  function deferOccurrence(
    state: TargetState,
    occurrence: Occurrence,
    reason: "session_busy" | "spacing_deferred" | "flood_deferred",
    nextEligibleAtMs: number,
  ): void {
    occurrence.notBeforeMs = nextEligibleAtMs;
    emitDeferral(occurrence, reason, nextEligibleAtMs);
    armTarget(state);
  }

  async function dispatchTarget(key: string): Promise<void> {
    const state = targets.get(key);
    if (state === undefined || !accepting) return;
    if (state.selected?.started === true) return;
    const nowMs = deps.clock.now();
    let occurrence = state.selected;
    if (occurrence === undefined) {
      occurrence = selectEligible(state, nowMs);
      if (occurrence === undefined) {
        armTarget(state);
        return;
      }
      state.pending[occurrence.lane] = undefined;
      state.selected = occurrence;
      occurrence.sealed = true;
      eventQueue.seal(key, occurrence.correlationId);
    }

    state.starts = state.starts.filter((startedAt) => startedAt > nowMs - HEARTBEAT_FLOOD_WINDOW_MS);
    if (state.starts.length >= HEARTBEAT_FLOOD_MAX_STARTS) {
      const nextEligibleAtMs = state.starts[0]! + HEARTBEAT_FLOOD_WINDOW_MS;
      deferOccurrence(state, occurrence, "flood_deferred", nextEligibleAtMs);
      return;
    }
    if (
      occurrence.timingKind === "routine"
      && state.lastStartedAtMs !== undefined
      && nowMs < state.lastStartedAtMs + HEARTBEAT_MIN_WAKE_SPACING_MS
    ) {
      deferOccurrence(
        state,
        occurrence,
        "spacing_deferred",
        state.lastStartedAtMs + HEARTBEAT_MIN_WAKE_SPACING_MS,
      );
      return;
    }
    if (deps.isTargetBusy(occurrence.target)) {
      deferOccurrence(state, occurrence, "session_busy", nowMs + HEARTBEAT_BUSY_RECHECK_MS);
      return;
    }

    if (
      occurrence.target.kind === "agent"
      && occurrence.lane === "task"
      && !deps.isTaskEnabled(occurrence.target.agentId)
    ) {
      const consumed = eventQueue.consume(key, occurrence.correlationId);
      emitTerminal(occurrence, "skipped", consumed, 0);
      state.selected = undefined;
      armTarget(state);
      return;
    }

    if (occurrence.target.kind === "agent" && occurrence.reason === "interval") {
      const gateStartedAtMs = deps.clock.now();
      const gatedBoundary = await fromPromise(
        deps.checkIntervalFileGate(occurrence.target.agentId),
      );
      if (!accepting || targets.get(key) !== state || state.selected !== occurrence) return;
      if (!gatedBoundary.ok || !gatedBoundary.value.ok) {
        let errorKind: ErrorKind = "internal";
        if (gatedBoundary.ok) {
          const gateResult = gatedBoundary.value;
          if (!gateResult.ok) errorKind = gateResult.error.errorKind;
        }
        const consumed = eventQueue.consume(key, occurrence.correlationId);
        emitTerminal(
          occurrence,
          "failed_before_side_effect",
          consumed,
          Math.max(0, deps.clock.now() - gateStartedAtMs),
          errorKind,
        );
        state.selected = undefined;
        armTarget(state);
        return;
      }
      if (gatedBoundary.value.value) {
        const consumed = eventQueue.consume(key, occurrence.correlationId);
        emitTerminal(
          occurrence,
          "skipped",
          consumed,
          Math.max(0, deps.clock.now() - gateStartedAtMs),
        );
        state.selected = undefined;
        armTarget(state);
        return;
      }
    }

    let rootRunId: string | undefined;
    if (occurrence.target.kind === "agent") {
      const registeredBoundary = await fromPromise(deps.registerRoot({
        correlationId: occurrence.correlationId,
        target: occurrence.target,
        lane: occurrence.lane,
        reason: occurrence.reason,
      }));
      if (!accepting || targets.get(key) !== state || state.selected !== occurrence) {
        if (registeredBoundary.ok && registeredBoundary.value.ok) {
          await releaseRegisteredRoot(registeredBoundary.value.value.rootRunId, occurrence.correlationId);
        }
        return;
      }
      if (!registeredBoundary.ok) {
        occurrence.notBeforeMs = deps.clock.now() + HEARTBEAT_ROOT_RECHECK_MS;
        emitDeferral(occurrence, "root_unavailable", occurrence.notBeforeMs, "internal");
        armTarget(state);
        return;
      }
      if (!registeredBoundary.value.ok) {
        occurrence.notBeforeMs = deps.clock.now() + HEARTBEAT_ROOT_RECHECK_MS;
        emitDeferral(
          occurrence,
          "root_unavailable",
          occurrence.notBeforeMs,
          registeredBoundary.value.error.errorKind,
        );
        armTarget(state);
        return;
      }
      rootRunId = registeredBoundary.value.value.rootRunId;
    }

    occurrence.started = true;
    const controller = new AbortController();
    occurrence.controller = controller;
    const startedAtMs = deps.clock.now();
    const previousLastStartedAtMs = state.lastStartedAtMs;
    state.lastStartedAtMs = startedAtMs;
    state.starts.push(startedAtMs);
    const eventBatch = eventQueue.claim(key, occurrence.correlationId);
    const runOccurrence = (): Promise<Result<HeartbeatTickOutcome | MonitoringHeartbeatOutcome, HeartbeatTickError>> =>
      occurrence.target.kind === "agent"
      ? deps.runAgent({
          correlationId: occurrence.correlationId,
          target: occurrence.target,
          lane: occurrence.lane,
          reason: occurrence.reason,
          rootRunId: rootRunId!,
          eventBatch,
          signal: controller.signal,
        })
      : deps.runMonitoring({
          correlationId: occurrence.correlationId,
          target: occurrence.target,
          reason: occurrence.reason as Exclude<HeartbeatWakeReason, "task">,
          signal: controller.signal,
        });
    const resolved = await fromPromise(runOccurrence());
    const durationMs = Math.max(0, deps.clock.now() - startedAtMs);
    if (
      resolved.ok
      && !resolved.value.ok
      && resolved.value.error.code === "task_store_unavailable"
      && occurrence.lane === "task"
      && rootRunId !== undefined
    ) {
      const released = await releaseRegisteredRoot(rootRunId, occurrence.correlationId);
      if (!released) {
        emitTerminal(occurrence, "unsettled", 0, durationMs, resolved.value.error.errorKind);
        return;
      }
      rootRunId = undefined;
      state.starts.pop();
      state.lastStartedAtMs = previousLastStartedAtMs;
      occurrence.started = false;
      occurrence.controller = undefined;
      occurrence.notBeforeMs = deps.clock.now() + HEARTBEAT_TASK_STORE_RECHECK_MS;
      emitDeferral(
        occurrence,
        "task_store_unavailable",
        occurrence.notBeforeMs,
        resolved.value.error.errorKind,
      );
      armTarget(state);
      return;
    }
    let retainRegisteredRoot = false;
    if (!resolved.ok) {
      const consumed = eventQueue.consume(key, occurrence.correlationId);
      emitTerminal(occurrence, "unsettled", consumed, durationMs, "internal");
    } else if (!resolved.value.ok) {
      const releasedCount = rearmReleasedEvents(state, key, occurrence);
      emitTerminal(
        occurrence,
        "failed_before_side_effect",
        releasedCount,
        durationMs,
        resolved.value.error.errorKind,
      );
    } else {
      const consumed = eventQueue.consume(key, occurrence.correlationId);
      retainRegisteredRoot = resolved.value.value.status === "unsettled";
      emitTerminal(
        occurrence,
        terminalStatus(resolved.value.value),
        consumed,
        resolved.value.value.durationMs,
        "errorKind" in resolved.value.value ? resolved.value.value.errorKind : undefined,
      );
    }
    if (retainRegisteredRoot) return;
    if (rootRunId !== undefined) {
      await releaseRegisteredRoot(rootRunId, occurrence.correlationId);
    }
    state.selected = undefined;
    armTarget(state);
  }

  function rearmReleasedEvents(state: TargetState, key: string, occurrence: Occurrence): number {
    let destination = state.pending.normal;
    if (destination === undefined) {
      const correlationId = mintCorrelationId();
      if (correlationId === undefined) return eventQueue.consume(key, occurrence.correlationId);
      destination = {
        correlationId,
        target: occurrence.target,
        lane: "normal",
        reason: occurrence.reason,
        timingKind: "routine",
        notBeforeMs: deps.clock.now() + HEARTBEAT_RELEASE_BACKOFF_MS,
        sealed: false,
        started: false,
      };
      state.pending.normal = destination;
      emitAdmission({
        status: "accepted",
        disposition: "new_occurrence",
        correlationId,
        lane: "normal",
        retainedReason: destination.reason,
      }, occurrence.target);
    }
    const releasedCount = eventQueue.rebindClaimed(
      key,
      occurrence.correlationId,
      destination.correlationId,
    );
    armTarget(state);
    return releasedCount;
  }

  function submitWake(value: HeartbeatWakeRequest): Result<HeartbeatWakeAdmissionOutcome, HeartbeatWakeAdmissionError> {
    if (!accepting) return err({ code: "not_accepting", errorKind: "precondition" });
    const parsed = WakeRequestSchema.safeParse(value);
    if (!parsed.success) return err({ code: "invalid_request", errorKind: "validation" });
    if (
      parsed.data.reason === "task"
      && parsed.data.target.kind === "agent"
      && closedTaskAgents.has(parsed.data.target.agentId)
    ) return err({ code: "not_accepting", errorKind: "precondition" });
    if (!targetAvailable(parsed.data.target)) return err({ code: "invalid_target", errorKind: "validation" });
    return upsertWake(parsed.data);
  }

  function admitSystemEventWake(
    value: SystemEventWakeAdmissionRequest,
  ): Result<SystemEventWakeAdmissionOutcome, SystemEventWakeAdmissionError> {
    if (!accepting) return err({ code: "not_accepting", errorKind: "precondition" });
    const parsed = SystemEventWakeSchema.safeParse(value);
    if (!parsed.success) return err({ code: "invalid_request", errorKind: "validation" });
    if (!targetAvailable(parsed.data.target)) return err({ code: "invalid_target", errorKind: "validation" });
    if (parsed.data.wakeMode === "next-heartbeat") {
      const nextPeriodic = periodicSchedule.getNextDueAtMs(parsed.data.target.agentId);
      if (!nextPeriodic.ok) return err({ code: "not_accepting", errorKind: "precondition" });
      if (parsed.data.notBeforeMs !== nextPeriodic.value) {
        return err({ code: "invalid_request", errorKind: "validation" });
      }
    }

    const state = stateFor(parsed.data.target);
    const existing = state.pending.normal;
    const tentativeCorrelationId = existing?.correlationId ?? mintCorrelationId();
    if (tentativeCorrelationId === undefined) {
      return err({ code: "not_accepting", errorKind: "precondition" });
    }
    const admittedAtMs = deps.clock.now();
    const queueResult = eventQueue.admit(targetKey(parsed.data.target), tentativeCorrelationId, {
      text: parsed.data.event.text,
      contextKey: parsed.data.event.contextKey,
      trigger: parsed.data.event.trigger,
      enqueuedAt: admittedAtMs,
    });
    if (queueResult.status === "queue_full") return err({ code: "queue_full", errorKind: "resource" });

    const wake = upsertWake({
      target: parsed.data.target,
      reason: parsed.data.reason,
      timing: {
        kind: parsed.data.reason === "cron" && parsed.data.wakeMode === "now"
          ? "spacing_bypass"
          : "routine",
        notBeforeMs: parsed.data.notBeforeMs,
      },
    }, tentativeCorrelationId);
    if (!wake.ok) {
      eventQueue.cancelPending(targetKey(parsed.data.target), tentativeCorrelationId);
      return wake;
    }
    return ok({ queueDisposition: queueResult.status, wake: wake.value });
  }

  function closeTaskLane(
    agentId: string,
    reason: "feature_disabled" | "maintenance",
  ): { cancelledCount: number; activeCount: number } {
    closedTaskAgents.add(agentId);
    const key = targetKey({ kind: "agent", agentId });
    const state = targets.get(key);
    if (state === undefined) return { cancelledCount: 0, activeCount: 0 };
    let cancelledCount = 0;
    const pending = state.pending.task;
    if (pending !== undefined) {
      const removed = eventQueue.cancelPending(key, pending.correlationId);
      emitTerminal(pending, "cancelled_before_start", removed, 0, "precondition", reason);
      state.pending.task = undefined;
      cancelledCount += 1;
    }
    let activeCount = 0;
    const selected = state.selected;
    if (selected?.lane === "task") {
      if (selected.started) {
        activeCount = 1;
      } else {
        const removed = eventQueue.consume(key, selected.correlationId);
        emitTerminal(selected, "cancelled_before_start", removed, 0, "precondition", reason);
        state.selected = undefined;
        cancelledCount += 1;
      }
    }
    armTarget(state);
    return { cancelledCount, activeCount };
  }

  function closeAdmission(): { activeCount: number; cancelledCount: number } {
    if (!closed) {
      closed = true;
      accepting = false;
      periodicSchedule.shutdown();
    }
    let activeCount = 0;
    let cancelledCount = 0;
    for (const [key, state] of targets) {
      state.timer?.cancel();
      state.timer = undefined;
      for (const lane of ["task", "normal"] as const) {
        const occurrence = state.pending[lane];
        if (occurrence === undefined) continue;
        const removed = eventQueue.cancelPending(key, occurrence.correlationId);
        emitTerminal(occurrence, "cancelled_before_start", removed, 0, "precondition", "shutdown");
        state.pending[lane] = undefined;
        cancelledCount += 1;
      }
      if (state.selected !== undefined && !state.selected.started) {
        const removed = eventQueue.consume(key, state.selected.correlationId);
        emitTerminal(state.selected, "cancelled_before_start", removed, 0, "precondition", "shutdown");
        state.selected = undefined;
        cancelledCount += 1;
      } else if (state.selected?.started === true) {
        activeCount += 1;
      }
    }
    return { activeCount, cancelledCount };
  }

  async function waitForIdle(): Promise<void> {
    while (activeDispatches.size > 0) {
      await Promise.allSettled([...activeDispatches]);
    }
  }

  function abortActive(): { activeCount: number } {
    let activeCount = 0;
    for (const state of targets.values()) {
      if (state.selected?.started !== true) continue;
      activeCount += 1;
      state.selected.controller?.abort("shutdown");
    }
    return { activeCount };
  }

  function shutdown(): void {
    closeAdmission();
    abortActive();
  }

  function removeTarget(target: HeartbeatWakeTarget): boolean {
    const key = targetKey(target);
    const state = targets.get(key);
    const removedPeriodic = target.kind === "agent" && periodicSchedule.remove(target.agentId);
    if (state === undefined && !removedPeriodic) return false;
    removedTargets.add(key);
    if (state === undefined) return true;
    state.timer?.cancel();
    state.timer = undefined;
    for (const lane of ["task", "normal"] as const) {
      const occurrence = state.pending[lane];
      if (occurrence === undefined) continue;
      const removed = eventQueue.cancelPending(key, occurrence.correlationId);
      emitTerminal(occurrence, "cancelled_before_start", removed, 0, "precondition", "target_removed");
      state.pending[lane] = undefined;
    }
    if (state.selected !== undefined && !state.selected.started) {
      const removed = eventQueue.consume(key, state.selected.correlationId);
      emitTerminal(state.selected, "cancelled_before_start", removed, 0, "precondition", "target_removed");
      state.selected = undefined;
    } else {
      state.selected?.controller?.abort();
    }
    if (state.selected === undefined) targets.delete(key);
    return true;
  }

  async function releaseRegisteredRoot(rootRunId: string, correlationId: string): Promise<boolean> {
    const released = await fromPromise(deps.releaseRoot(rootRunId));
    if (released.ok && released.value.ok) return true;
    let errorKind: ErrorKind = "internal";
    if (released.ok) {
      const outcome = released.value;
      if (!outcome.ok) errorKind = outcome.error.errorKind;
    }
    deps.logger.warn({
      correlationId,
      step: "heartbeat_root_release",
      errorKind,
      hint: "Inspect root lease ownership; the heartbeat terminal is already immutable.",
    }, "Heartbeat root release failed");
    return false;
  }

  function configurePeriodicHeartbeat(
    config: HeartbeatPeriodicConfig,
  ): Result<HeartbeatPeriodicConfigureOutcome, HeartbeatPeriodicScheduleError> {
    if (config.enabled) removedTargets.delete(targetKey({ kind: "agent", agentId: config.agentId }));
    return periodicSchedule.configure(config);
  }

  function getNextPeriodicPhaseMs(
    agentId: string,
  ): Result<number, HeartbeatPeriodicScheduleError> {
    return periodicSchedule.getNextDueAtMs(agentId);
  }

  return {
    activate,
    submitWake,
    admitSystemEventWake,
    configurePeriodicHeartbeat,
    getNextPeriodicPhaseMs,
    closeTaskLane,
    closeAdmission,
    waitForIdle,
    abortActive,
    removeTarget,
    shutdown,
  };
}
