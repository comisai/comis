// SPDX-License-Identifier: Apache-2.0
/** Atomic composition of inferred-task capture, scheduling, checking, and delivery. */
import type {
  AppConfig,
  AppContainer,
  ChannelPort,
  ClockPort,
  ComisLogger,
  DeliveredAssistantHistoryPort,
  DeliveryService,
  ErrorKind,
  OutputGuardPort,
  TaskExtractionPort,
  TimerPort,
} from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  type AgentExecutor,
  type BoundedAutonomyBudgetHolder,
} from "@comis/agent";
import type { LeaseManager } from "@comis/infra";
import {
  createTaskDueSchedule,
  type FollowupTaskStore,
  type HeartbeatCoordinatorAgentRunInput,
  type HeartbeatTickError,
  type HeartbeatTickOutcome,
  type TaskDueSchedule,
  type TaskDueScheduleDeps,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";
import { createTaskHeartbeatAgentTurnExecutor } from "./task-heartbeat-agent-turn-executor.js";
import { createTaskSettledDelivery } from "./task-settled-delivery.js";
import {
  createFollowupTaskExtractionRuntime,
} from "./setup-followup-task-extraction.js";

export interface FollowupTaskRuntimeDeps {
  readonly config: AppConfig;
  readonly bootId: string;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly eventBus: AppContainer["eventBus"];
  readonly logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
  readonly taskStores: ReadonlyMap<string, FollowupTaskStore>;
  readonly workspaceDirs: ReadonlyMap<string, string>;
  readonly getExecutor: (agentId: string) => AgentExecutor | undefined;
  readonly adaptersByType: ReadonlyMap<string, ChannelPort>;
  readonly deliveryService: DeliveryService;
  readonly deliveredHistory: DeliveredAssistantHistoryPort;
  readonly leaseManager: Pick<LeaseManager, "mintLease" | "revoke">;
  readonly outputGuard: Pick<OutputGuardPort, "registerSecret" | "scan">;
  readonly boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  readonly submitTaskWake: TaskDueScheduleDeps["submitTaskWake"];
  readonly idFactory: () => string;
}

export interface FollowupTaskRuntime {
  readonly taskExtractionPort: TaskExtractionPort;
  activate(): Promise<Result<void, FollowupTaskRuntimeError>>;
  executeTaskTurn(
    input: HeartbeatCoordinatorAgentRunInput,
  ): Promise<Result<HeartbeatTickOutcome, HeartbeatTickError>>;
  requestRescan(agentId: string): Promise<Result<void, { readonly errorKind: ErrorKind }>>;
  enterMaintenance(agentId: string): {
    readonly taskCheckActiveCount: number;
    readonly extractionActiveCount: number;
    readonly droppedExtractionCount: number;
  };
  disable(): {
    readonly taskCheckActiveCount: number;
    readonly extractionActiveCount: number;
    readonly droppedExtractionCount: number;
  };
  closeAdmission(): { readonly droppedCount: number };
  abortActive(): { readonly activeCount: number };
  waitForIdle(): Promise<void>;
  shutdown(): void;
}

export type FollowupTaskRuntimeError =
  | { readonly code: "extraction_unavailable"; readonly errorKind: "precondition" | "config" | "internal" }
  | { readonly code: "schedule_activation_failed"; readonly errorKind: ErrorKind };

export function createFollowupTaskRuntime(
  deps: FollowupTaskRuntimeDeps,
): Result<FollowupTaskRuntime, FollowupTaskRuntimeError> {
  const schedules = new Map<string, TaskDueSchedule>();
  const activeTaskChecks = new Map<string, number>();
  const maintenanceAgents = new Set<string>();
  for (const [agentId, store] of deps.taskStores) {
    schedules.set(agentId, createTaskDueSchedule({
      agentId,
      clock: deps.clock,
      timers: deps.timers,
      store,
      submitTaskWake: deps.submitTaskWake,
      logger: deps.logger,
    }));
  }

  const extraction = createFollowupTaskExtractionRuntime({
    config: deps.config,
    clock: deps.clock,
    timers: deps.timers,
    eventBus: deps.eventBus,
    logger: deps.logger,
    taskStores: deps.taskStores,
    workspaceDirs: deps.workspaceDirs,
    getExecutor: deps.getExecutor,
    leaseManager: deps.leaseManager,
    outputGuard: deps.outputGuard,
    boundedAutonomyHolder: deps.boundedAutonomyHolder,
    onTaskStoreChanged: async (agentId) => {
      const schedule = schedules.get(agentId);
      if (schedule === undefined) return err({ errorKind: "precondition" as const });
      const rescanned = await schedule.requestRescan();
      return rescanned.ok ? ok(undefined) : err({ errorKind: rescanned.error.errorKind });
    },
    idFactory: deps.idFactory,
  });
  if (!extraction.ok) {
    return err({ code: "extraction_unavailable", errorKind: extraction.error.errorKind });
  }
  const extractionRuntime = extraction.value;

  const delivery = createTaskSettledDelivery({
    clock: deps.clock,
    adaptersByType: deps.adaptersByType,
    deliveryService: deps.deliveryService,
    outputGuard: deps.outputGuard,
    deliveredHistory: deps.deliveredHistory,
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  const executeClaimedTask = createTaskHeartbeatAgentTurnExecutor({
    tenantId: deps.config.tenantId,
    bootId: deps.bootId,
    agents: deps.config.agents,
    globalHeartbeatConfig: deps.config.scheduler.heartbeat,
    taskConfig: deps.config.scheduler.tasks,
    clock: deps.clock,
    eventBus: deps.eventBus,
    getStore: (agentId) => deps.taskStores.get(agentId),
    getExecutor: deps.getExecutor,
    getWorkspaceDir: (agentId) => deps.workspaceDirs.get(agentId),
    resolveModel: (_agentId, config) => resolveOperationModel({
      operationType: "heartbeat",
      agentProvider: config.provider,
      agentModel: config.model,
      operationModels: config.operationModels,
      providerFamily: resolveProviderFamily(config.provider),
      agentPromptTimeoutMs: config.promptTimeout.promptTimeoutMs,
    }),
    delivery,
    idFactory: deps.idFactory,
    logger: deps.logger,
  });

  async function activate(): Promise<Result<void, FollowupTaskRuntimeError>> {
    for (const [agentId, schedule] of schedules) {
      const activated = await schedule.activate();
      if (activated.ok) continue;
      for (const active of schedules.values()) active.shutdown();
      extractionRuntime.closeAdmission();
      extractionRuntime.abortActive();
      deps.logger.error({
        agentId,
        step: "task_due_schedule_activation",
        errorKind: activated.error.errorKind,
        hint: "Restore the strict task store before enabling inferred follow-up tasks",
      }, "Task due schedule activation failed");
      return err({ code: "schedule_activation_failed", errorKind: activated.error.errorKind });
    }
    return ok(undefined);
  }

  async function executeTaskTurn(
    input: HeartbeatCoordinatorAgentRunInput,
  ): Promise<Result<HeartbeatTickOutcome, HeartbeatTickError>> {
    const agentId = input.target.agentId;
    if (maintenanceAgents.has(agentId)) {
      return err({ code: "not_bound", errorKind: "precondition" });
    }
    activeTaskChecks.set(agentId, (activeTaskChecks.get(agentId) ?? 0) + 1);
    try {
      const result = await executeClaimedTask(input);
      if (result.ok && result.value.status !== "unsettled") {
        const schedule = schedules.get(agentId);
        const rescanned = schedule === undefined
          ? err({ code: "not_accepting" as const, errorKind: "precondition" as const })
          : await schedule.requestRescan();
        if (!rescanned.ok) {
          deps.logger.warn({
            agentId,
            rootRunId: input.rootRunId,
            step: "task_due_rescan",
            errorKind: rescanned.error.errorKind,
            hint: "Inspect the due-task schedule; durable task state will rearm at restart",
          }, "Task check could not rearm due scheduling");
        }
      }
      return result;
    } finally {
      const remaining = (activeTaskChecks.get(agentId) ?? 1) - 1;
      if (remaining === 0) activeTaskChecks.delete(agentId);
      else activeTaskChecks.set(agentId, remaining);
    }
  }

  return ok({
    taskExtractionPort: extractionRuntime.taskExtractionPort,
    activate,
    executeTaskTurn,
    async requestRescan(agentId) {
      const schedule = schedules.get(agentId);
      if (schedule === undefined) return err({ errorKind: "precondition" as const });
      const rescanned = await schedule.requestRescan();
      return rescanned.ok ? ok(undefined) : err({ errorKind: rescanned.error.errorKind });
    },
    enterMaintenance(agentId) {
      maintenanceAgents.add(agentId);
      schedules.get(agentId)?.shutdown();
      const dropped = extractionRuntime.closeAdmission();
      const active = extractionRuntime.abortActive();
      return {
        taskCheckActiveCount: activeTaskChecks.get(agentId) ?? 0,
        extractionActiveCount: active.activeCount,
        droppedExtractionCount: dropped.droppedCount,
      };
    },
    disable() {
      for (const schedule of schedules.values()) schedule.shutdown();
      const dropped = extractionRuntime.closeAdmission();
      const active = extractionRuntime.abortActive();
      let taskCheckActiveCount = 0;
      for (const count of activeTaskChecks.values()) taskCheckActiveCount += count;
      return {
        taskCheckActiveCount,
        extractionActiveCount: active.activeCount,
        droppedExtractionCount: dropped.droppedCount,
      };
    },
    closeAdmission() {
      for (const schedule of schedules.values()) schedule.shutdown();
      return extractionRuntime.closeAdmission();
    },
    abortActive: extractionRuntime.abortActive,
    waitForIdle: extractionRuntime.waitForIdle,
    shutdown() {
      for (const schedule of schedules.values()) schedule.shutdown();
      extractionRuntime.closeAdmission();
      extractionRuntime.abortActive();
    },
  });
}
