// SPDX-License-Identifier: Apache-2.0
/** Deterministic periodic-heartbeat phase ownership independent of direct wakes. */
import type { ClockPort, ComisLogger, ErrorKind, TimerHandle, TimerPort } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  resolveNextSchedulerPhaseAtMs,
  resolveSchedulerPhaseMs,
  type SchedulerPhaseError,
} from "../scheduler-phase.js";

const MAX_TIMER_SLICE_MS = 60_000;
const MAX_IDENTIFIER_BYTES = 256;

export type HeartbeatPeriodicScheduleError = {
  readonly code: "invalid_configuration" | "periodic_disabled" | "epoch_overflow";
  readonly errorKind: "validation" | "precondition";
  readonly message: string;
};

export interface HeartbeatPeriodicConfig {
  readonly agentId: string;
  readonly agentSchedulerSeed: string;
  readonly intervalMs: number;
  readonly enabled: boolean;
}

export type HeartbeatPeriodicConfigureOutcome =
  | { readonly status: "configured" | "armed" | "retained"; readonly nextDueAtMs: number }
  | { readonly status: "disabled"; readonly nextDueAtMs: null };

export interface HeartbeatPeriodicScheduleDeps {
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly submitInterval: (
    agentId: string,
    nominalDueAtMs: number,
  ) => Result<unknown, { readonly errorKind: ErrorKind; readonly message?: string }>;
  readonly logger?: Pick<ComisLogger, "warn" | "error">;
}

export interface HeartbeatPeriodicSchedule {
  activate(): Result<void, HeartbeatPeriodicScheduleError>;
  configure(
    config: HeartbeatPeriodicConfig,
  ): Result<HeartbeatPeriodicConfigureOutcome, HeartbeatPeriodicScheduleError>;
  getNextDueAtMs(agentId: string): Result<number, HeartbeatPeriodicScheduleError>;
  remove(agentId: string): boolean;
  shutdown(): void;
}

interface PeriodicState {
  readonly agentId: string;
  readonly agentSchedulerSeed: string;
  readonly intervalMs: number;
  readonly phaseMs: number;
  nextDueAtMs: number;
  timer?: TimerHandle;
}

export function createHeartbeatPeriodicSchedule(
  deps: HeartbeatPeriodicScheduleDeps,
): HeartbeatPeriodicSchedule {
  const states = new Map<string, PeriodicState>();
  let active = false;
  let closed = false;

  function activate(): Result<void, HeartbeatPeriodicScheduleError> {
    if (closed) {
      return err(periodicError(
        "periodic_disabled",
        "precondition",
        "Periodic heartbeat schedule is closed",
      ));
    }
    if (active) return ok(undefined);
    active = true;
    for (const state of states.values()) arm(state);
    return ok(undefined);
  }

  function configure(
    config: HeartbeatPeriodicConfig,
  ): Result<HeartbeatPeriodicConfigureOutcome, HeartbeatPeriodicScheduleError> {
    const valid = validateConfig(config);
    if (!valid.ok) return valid;
    const existing = states.get(config.agentId);
    if (!config.enabled) {
      existing?.timer?.cancel();
      states.delete(config.agentId);
      return ok({ status: "disabled", nextDueAtMs: null });
    }
    if (closed) {
      return err(periodicError(
        "periodic_disabled",
        "precondition",
        "Periodic heartbeat schedule is not accepting configuration",
      ));
    }
    if (
      existing !== undefined
      && existing.agentSchedulerSeed === config.agentSchedulerSeed
      && existing.intervalMs === config.intervalMs
    ) {
      return ok({
        status: active ? "retained" : "configured",
        nextDueAtMs: existing.nextDueAtMs,
      });
    }

    const phase = resolveSchedulerPhaseMs(
      config.agentSchedulerSeed,
      "agent",
      config.agentId,
      config.intervalMs,
    );
    if (!phase.ok) return err(mapPhaseError(phase.error));
    const next = resolveNextSchedulerPhaseAtMs(phase.value, config.intervalMs, deps.clock.now());
    if (!next.ok) return err(mapPhaseError(next.error));

    existing?.timer?.cancel();
    const state: PeriodicState = {
      agentId: config.agentId,
      agentSchedulerSeed: config.agentSchedulerSeed,
      intervalMs: config.intervalMs,
      phaseMs: phase.value,
      nextDueAtMs: next.value,
    };
    states.set(config.agentId, state);
    arm(state);
    return ok({
      status: active ? "armed" : "configured",
      nextDueAtMs: state.nextDueAtMs,
    });
  }

  function arm(state: PeriodicState): void {
    state.timer?.cancel();
    state.timer = undefined;
    if (!active || closed || states.get(state.agentId) !== state) return;
    const delayMs = Math.min(
      MAX_TIMER_SLICE_MS,
      Math.max(0, state.nextDueAtMs - deps.clock.now()),
    );
    const handle = deps.timers.setTimeout(() => {
      if (state.timer === handle) state.timer = undefined;
      onTimer(state);
    }, delayMs);
    handle.unref();
    state.timer = handle;
  }

  function onTimer(state: PeriodicState): void {
    if (!active || closed || states.get(state.agentId) !== state) return;
    const nowMs = deps.clock.now();
    if (nowMs < state.nextDueAtMs) {
      arm(state);
      return;
    }
    const dueAtMs = state.nextDueAtMs;
    const next = resolveNextSchedulerPhaseAtMs(state.phaseMs, state.intervalMs, dueAtMs);
    if (!next.ok) {
      states.delete(state.agentId);
      deps.logger?.error({
        agentId: state.agentId,
        step: "periodic_phase_advance",
        errorKind: next.error.errorKind,
        hint: "Reduce the heartbeat interval or reset the scheduler seed before the safe epoch limit.",
      }, "Periodic heartbeat phase could not advance");
      return;
    }
    state.nextDueAtMs = next.value;
    arm(state);

    const submitted = tryCatch(() => deps.submitInterval(state.agentId, dueAtMs));
    let errorKind: ErrorKind;
    if (!submitted.ok) {
      errorKind = "internal";
    } else {
      const admission = submitted.value;
      if (admission.ok) return;
      errorKind = admission.error.errorKind;
    }
    deps.logger?.warn({
      agentId: state.agentId,
      nominalDueAtMs: dueAtMs,
      step: "periodic_admission",
      errorKind,
      hint: "Inspect heartbeat target configuration; the next nominal phase remains armed.",
    }, "Periodic heartbeat occurrence was not admitted");
  }

  function getNextDueAtMs(agentId: string): Result<number, HeartbeatPeriodicScheduleError> {
    const state = states.get(agentId);
    return state === undefined
      ? err(periodicError(
          "periodic_disabled",
          "precondition",
          "Periodic heartbeat is not enabled for the agent",
        ))
      : ok(state.nextDueAtMs);
  }

  function remove(agentId: string): boolean {
    const state = states.get(agentId);
    if (state === undefined) return false;
    state.timer?.cancel();
    states.delete(agentId);
    return true;
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    active = false;
    for (const state of states.values()) state.timer?.cancel();
    states.clear();
  }

  return { activate, configure, getNextDueAtMs, remove, shutdown };
}

function validateConfig(
  config: HeartbeatPeriodicConfig,
): Result<void, HeartbeatPeriodicScheduleError> {
  if (
    !byteBounded(config.agentId)
    || !byteBounded(config.agentSchedulerSeed)
    || !Number.isSafeInteger(config.intervalMs)
    || config.intervalMs <= 0
  ) {
    return err(periodicError(
      "invalid_configuration",
      "validation",
      "Periodic heartbeat configuration is invalid",
    ));
  }
  return ok(undefined);
}

function byteBounded(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES;
}

function mapPhaseError(error: SchedulerPhaseError): HeartbeatPeriodicScheduleError {
  return periodicError(
    error.code === "epoch_overflow" ? "epoch_overflow" : "invalid_configuration",
    error.errorKind,
    error.message,
  );
}

function periodicError(
  code: HeartbeatPeriodicScheduleError["code"],
  errorKind: HeartbeatPeriodicScheduleError["errorKind"],
  message: string,
): HeartbeatPeriodicScheduleError {
  return { code, errorKind, message };
}
