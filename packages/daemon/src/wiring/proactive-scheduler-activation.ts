// SPDX-License-Identifier: Apache-2.0
/** One activation gate for configured heartbeat phases and initialized cron timers. */
import type {
  ComisLogger,
  ErrorKind,
  HeartbeatConfig,
  PerAgentConfig,
} from "@comis/core";
import {
  resolveEffectiveHeartbeatConfig,
  type CronSchedulerLifecycleError,
  type HeartbeatPeriodicConfig,
  type HeartbeatPeriodicConfigureOutcome,
  type HeartbeatPeriodicScheduleError,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";

interface SeedError {
  readonly errorKind: ErrorKind;
  readonly message: string;
}

interface CoordinatorLifecycle {
  configurePeriodicHeartbeat(
    config: HeartbeatPeriodicConfig,
  ): Result<HeartbeatPeriodicConfigureOutcome, HeartbeatPeriodicScheduleError>;
  activate(): Result<void, HeartbeatPeriodicScheduleError>;
  shutdown(): void;
}

export interface ProactiveSchedulerActivationDeps {
  agents: Record<string, PerAgentConfig>;
  globalHeartbeatConfig: HeartbeatConfig;
  getAgentSchedulerSeed(agentId: string): Result<string, SeedError>;
  coordinator: CoordinatorLifecycle;
  activateCronSchedulers(): Result<void, CronSchedulerLifecycleError>;
  logger: Pick<ComisLogger, "info" | "error">;
}

export interface ProactiveSchedulerActivationError {
  readonly code:
    | "heartbeat_configuration_failed"
    | "heartbeat_activation_failed"
    | "cron_activation_failed";
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export function activateProactiveSchedulers(
  deps: ProactiveSchedulerActivationDeps,
): Result<void, ProactiveSchedulerActivationError> {
  for (const [agentId, agentConfig] of Object.entries(deps.agents)) {
    const effective = resolveEffectiveHeartbeatConfig(
      deps.globalHeartbeatConfig,
      agentConfig.scheduler?.heartbeat,
    );
    const seed = deps.getAgentSchedulerSeed(agentId);
    if (!seed.ok) {
      return configurationFailure(agentId, seed.error.errorKind, seed.error.message);
    }
    const configured = deps.coordinator.configurePeriodicHeartbeat({
      agentId,
      agentSchedulerSeed: seed.value,
      intervalMs: effective.intervalMs,
      enabled: effective.enabled,
    });
    if (!configured.ok) {
      return configurationFailure(
        agentId,
        configured.error.errorKind,
        configured.error.message,
      );
    }
  }

  const heartbeatActivated = deps.coordinator.activate();
  if (!heartbeatActivated.ok) {
    deps.coordinator.shutdown();
    deps.logger.error({
      step: "heartbeat_activation",
      errorKind: heartbeatActivated.error.errorKind,
      hint: "Keep proactive admission closed and repair heartbeat phase configuration before restart",
    }, "Heartbeat coordinator activation failed");
    return err({
      code: "heartbeat_activation_failed",
      errorKind: heartbeatActivated.error.errorKind,
      message: heartbeatActivated.error.message,
    });
  }

  const cronActivated = deps.activateCronSchedulers();
  if (!cronActivated.ok) {
    deps.coordinator.shutdown();
    deps.logger.error({
      step: "cron_activation",
      errorKind: cronActivated.error.errorKind,
      hint: "Heartbeat admission was rolled back; repair cron runtime binding before restart",
    }, "Cron scheduler activation failed");
    return err({
      code: "cron_activation_failed",
      errorKind: cronActivated.error.errorKind,
      message: cronActivated.error.message,
    });
  }

  deps.logger.info({
    agentCount: Object.keys(deps.agents).length,
    durationMs: 0,
  }, "Proactive schedulers activated");
  return ok(undefined);

  function configurationFailure(
    agentId: string,
    errorKind: ErrorKind,
    message: string,
  ): Result<never, ProactiveSchedulerActivationError> {
    deps.coordinator.shutdown();
    deps.logger.error({
      agentId,
      step: "heartbeat_phase_configuration",
      errorKind,
      hint: "Repair the persisted scheduler seed or heartbeat interval before restart",
    }, "Heartbeat phase configuration failed");
    return err({ code: "heartbeat_configuration_failed", errorKind, message });
  }
}
