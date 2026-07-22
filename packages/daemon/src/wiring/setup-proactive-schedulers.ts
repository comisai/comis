// SPDX-License-Identifier: Apache-2.0
/** Atomic construction, late binding, activation, and shutdown for proactive work. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createConversationRef,
  formatSessionKey,
  resolveCronWakeGateEnabled,
  safePath,
  type ChannelPort,
  type DeliveredAssistantHistoryPort,
  type DeliveryService,
  type ErrorKind,
  type TaskExtractionPort,
} from "@comis/core";
import {
  createDeliveredAssistantHistoryAdapter,
  isHeartbeatContentEffectivelyEmpty,
  pruneAcknowledgedHeartbeatTurn,
  resolveOperationModel,
  resolveProviderFamily,
} from "@comis/agent";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import {
  createHeartbeatWakeCoordinator,
  isInQuietHours,
  resolveEffectiveHeartbeatConfig,
} from "@comis/scheduler";
import { applyToolPolicy } from "@comis/skills";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { BootContext, ProactiveSchedulersHandle } from "../daemon-types.js";
import { createCronAgentTurnExecutor } from "./cron-agent-turn-executor.js";
import { createCronContinuationExecutor } from "./cron-continuation-executor.js";
import { createCronHeartbeatDispatcher } from "./cron-heartbeat-dispatcher.js";
import { createCronInternalActionExecutor } from "./cron-internal-action-executor.js";
import { createCronMemoryActionRunners } from "./cron-memory-action-runners.js";
import { createCronMemoryActionServices } from "./cron-memory-action-services.js";
import { createCronOriginHistoryContinuation } from "./cron-origin-history-continuation.js";
import { createCronRootRegistrar } from "./cron-root-registrar.js";
import { createDaemonCronRuntimeExecutor } from "./cron-runtime-executor.js";
import { createCronSessionPolicy } from "./cron-session-policy.js";
import { createCronSettledDelivery } from "./cron-settled-delivery.js";
import { createCronWakeGateAdapter } from "./cron-wake-gate-adapter.js";
import { createHeartbeatAgentTurnExecutor } from "./heartbeat-agent-turn-executor.js";
import { createHeartbeatRootRegistrar } from "./heartbeat-root-registrar.js";
import { createHeartbeatSettledDelivery } from "./heartbeat-settled-delivery.js";
import { activateProactiveSchedulers } from "./proactive-scheduler-activation.js";
import type { SchedulerCorePortBindings } from "./scheduler-core-port-bindings.js";
import {
  createFollowupTaskRuntime,
  type FollowupTaskRuntime,
} from "./setup-followup-task-runtime.js";
import { setupMonitoring } from "./setup-health.js";
import { buildReflectionCronDeps } from "./setup-channels/setup-channels-skill-synthesis-deps.js";

type ProactiveBootSlice = Pick<BootContext,
  | "container" | "clock" | "timers" | "schedulerLogger" | "workspaceDirs"
  | "sessionResolver" | "getExecutor" | "piSessionAdapters" | "assembleToolsForAgent"
  | "memoryApi" | "memoryAdapter" | "sessionStore" | "lcdStore" | "contextBrowse"
  | "entityStore" | "causalStore" | "memoryLifecycleStore" | "outcomeStore"
  | "learnedSkillStore" | "sharedLeaseManager" | "boundedAutonomyBudgetHolder"
  | "capEndpointHandle"
  | "cronRuntimeBinding" | "activateCronSchedulers" | "getAgentSchedulerSeed"
  | "followupTaskStores" | "taskBootId" | "taskRuntimeGate"
  | "wakeGateRunnerRef" | "costTrackers" | "stepCounters" | "oauthManagers"
>;

export interface SetupProactiveSchedulersDeps {
  readonly runtime: ProactiveBootSlice;
  readonly adaptersByType: ReadonlyMap<string, ChannelPort>;
  readonly deliveryService: DeliveryService;
  readonly schedulerCorePortBindings: SchedulerCorePortBindings;
}

export interface SetupProactiveSchedulersError {
  readonly code: "dependency_unavailable" | "task_runtime_unavailable" | "port_binding_failed" | "activation_failed";
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export async function setupProactiveSchedulers(
  deps: SetupProactiveSchedulersDeps,
): Promise<Result<ProactiveSchedulersHandle, SetupProactiveSchedulersError>> {
  const runtime = deps.runtime;
  const taskRuntimeGate = runtime.taskRuntimeGate;
  if (taskRuntimeGate === undefined) {
    return err({
      code: "dependency_unavailable",
      errorKind: "precondition",
      message: "Task runtime gate is unavailable",
    });
  }
  if (!requiresAgentProactiveRuntime(runtime)) {
    return setupQuiescentProactiveSchedulers(deps);
  }
  const required = resolveRequiredRuntime(runtime);
  if (!required.ok) return required;
  const tasksEnabled = runtime.container.config.scheduler.tasks.enabled;
  const taskStores = runtime.followupTaskStores;
  const taskBootId = runtime.taskBootId;
  const taskOwnership = taskStores === undefined || taskBootId === undefined
    ? undefined
    : { stores: taskStores, bootId: taskBootId };
  if (tasksEnabled && taskOwnership === undefined) {
    return err({
      code: "task_runtime_unavailable",
      errorKind: "precondition",
      message: "Follow-up task ownership state is unavailable",
    });
  }

  const { heartbeatRunner, duplicateDetector } = setupMonitoring({
    container: runtime.container,
    schedulerLogger: runtime.schedulerLogger,
    clock: runtime.clock,
    timers: runtime.timers,
  });
  if (duplicateDetector === undefined) {
    return err({
      code: "dependency_unavailable",
      errorKind: "precondition",
      message: "Heartbeat duplicate detector is unavailable",
    });
  }
  const historyState = { accepting: true };
  const history = createDeliveredAssistantHistoryAdapter({
    resolveSessionManager: (agentId) => required.value.piSessionAdapters.get(agentId),
    isAccepting: () => historyState.accepting,
  });
  const disabledTaskExtraction: TaskExtractionPort = {
    enqueue: () => err({ code: "not_accepting", errorKind: "precondition" }),
  };

  const heartbeatDelivery = createHeartbeatSettledDelivery({
    tenantId: runtime.container.config.tenantId,
    clock: runtime.clock,
    adaptersByType: deps.adaptersByType,
    deliveryService: deps.deliveryService,
    outputGuard: required.value.capEndpointHandle.outputGuard,
    duplicateDetector,
    isQuietHours: quietHoursResolver(runtime),
    criticalBypass: runtime.container.config.scheduler.quietHours.criticalBypass,
    logger: runtime.schedulerLogger,
  });
  const heartbeatAgentTurn = createHeartbeatAgentTurnExecutor({
    tenantId: runtime.container.config.tenantId,
    agents: runtime.container.config.agents,
    globalHeartbeatConfig: runtime.container.config.scheduler.heartbeat,
    clock: runtime.clock,
    eventBus: runtime.container.eventBus,
    getExecutor: (agentId) => required.value.getExecutor(agentId),
    assembleTools: async (agentId, sessionKey, heartbeatPolicy) => {
      const assembled = await required.value.assembleToolsForAgent(agentId, { sessionKey });
      const agentPolicy = runtime.container.config.agents[agentId]?.skills?.toolPolicy;
      const agentBounded = agentPolicy === undefined
        ? assembled
        : applyToolPolicy(assembled, agentPolicy).tools;
      return heartbeatPolicy?.toolPolicy === undefined
        ? agentBounded
        : applyToolPolicy(agentBounded, heartbeatPolicy.toolPolicy).tools;
    },
    resolveModel: (_agentId, config) => resolveOperationModel({
      operationType: "heartbeat",
      agentProvider: config.provider,
      agentModel: config.model,
      operationModels: config.operationModels,
      providerFamily: resolveProviderFamily(config.provider),
      agentPromptTimeoutMs: config.promptTimeout.promptTimeoutMs,
    }),
    getMemoryStats: (agentId, tenantId) => {
      const stats = runtime.memoryApi.stats(tenantId, agentId);
      return stats.totalEntries === 0 || stats.oldestCreatedAt === null
        ? undefined
        : {
            totalEntries: stats.totalEntries,
            oldestEntryAgeDays: Math.floor((runtime.clock.now() - stats.oldestCreatedAt) / 86_400_000),
          };
    },
    deliver: heartbeatDelivery,
    pruneAcknowledgedTurn: async (agentId, sessionKey) => {
      const adapter = required.value.piSessionAdapters.get(agentId);
      if (adapter === undefined) return err({ errorKind: "precondition" as const });
      const locked = await adapter.withSession(
        sessionKey,
        async (manager) => pruneAcknowledgedHeartbeatTurn(manager),
      );
      if (!locked.ok) return err({ errorKind: "resource" as const });
      return locked.value;
    },
    idFactory: randomUUID,
    logger: runtime.schedulerLogger,
  });
  const heartbeatRoot = createHeartbeatRootRegistrar({
    tenantId: runtime.container.config.tenantId,
    leaseManager: required.value.sharedLeaseManager,
    outputGuard: required.value.capEndpointHandle.outputGuard,
    boundedAutonomyHolder: required.value.boundedAutonomyBudgetHolder,
    idFactory: randomUUID,
    logger: runtime.schedulerLogger,
  });
  let taskRuntime: FollowupTaskRuntime | undefined;
  const coordinator = createHeartbeatWakeCoordinator({
    clock: runtime.clock,
    timers: runtime.timers,
    eventBus: runtime.container.eventBus,
    logger: runtime.schedulerLogger,
    idFactory: randomUUID,
    hasTarget: (target) => target.kind === "monitoring"
      ? heartbeatRunner !== undefined
      : runtime.container.config.agents[target.agentId] !== undefined,
    isTargetBusy: (target) => target.kind === "monitoring"
      ? (heartbeatRunner?.isBusy() ?? false)
      : isAgentTargetBusy(runtime, target.agentId),
    isTaskEnabled: () => taskRuntimeGate.isEnabled(),
    checkIntervalFileGate: (agentId) => checkIntervalFileGate(runtime, agentId),
    registerRoot: heartbeatRoot.register,
    releaseRoot: heartbeatRoot.release,
    runAgent: (input) => {
      if (input.lane !== "task") return heartbeatAgentTurn(input);
      if (taskRuntime === undefined) {
        return Promise.resolve(err({ code: "not_bound", errorKind: "precondition" as const }));
      }
      return taskRuntime.executeTaskTurn(input);
    },
    runMonitoring: (input) => heartbeatRunner === undefined
      ? Promise.resolve(err({ code: "not_bound", errorKind: "precondition" }))
      : heartbeatRunner.runOnce(input.reason, input.signal),
  });
  if (tasksEnabled && taskOwnership !== undefined) {
    const composedTaskRuntime = createFollowupTaskRuntime({
      config: runtime.container.config,
      bootId: taskOwnership.bootId,
      clock: runtime.clock,
      timers: runtime.timers,
      eventBus: runtime.container.eventBus,
      logger: runtime.schedulerLogger,
      taskStores: taskOwnership.stores,
      workspaceDirs: required.value.workspaceDirs,
      getExecutor: required.value.getExecutor,
      adaptersByType: deps.adaptersByType,
      deliveryService: deps.deliveryService,
      deliveredHistory: history,
      leaseManager: required.value.sharedLeaseManager,
      outputGuard: required.value.capEndpointHandle.outputGuard,
      boundedAutonomyHolder: required.value.boundedAutonomyBudgetHolder,
      submitTaskWake: (request) => coordinator.submitWake(request),
      idFactory: randomUUID,
    });
    if (!composedTaskRuntime.ok) {
      coordinator.shutdown();
      heartbeatRunner?.shutdown();
      historyState.accepting = false;
      return err({
        code: "task_runtime_unavailable",
        errorKind: composedTaskRuntime.error.errorKind,
        message: "Follow-up task runtime could not be constructed",
      });
    }
    taskRuntime = composedTaskRuntime.value;
  }

  const deliveryDeps = {
    clock: runtime.clock,
    adaptersByType: deps.adaptersByType,
    deliveryService: deps.deliveryService,
    outputGuard: required.value.capEndpointHandle.outputGuard,
    isQuietHours: cronQuietHoursResolver(runtime),
    logger: runtime.schedulerLogger,
  };
  const cronDelivery = createCronSettledDelivery(deliveryDeps);
  const originHistory = createCronOriginHistoryContinuation({ history, logger: runtime.schedulerLogger });
  const continuation = createCronContinuationExecutor({
    continueOriginHistory: originHistory,
    resolveNextPeriodicPhaseMs: (agentId) => coordinator.getNextPeriodicPhaseMs(agentId),
    coordinator,
    logger: runtime.schedulerLogger,
  });
  const sessionPolicy = createCronSessionPolicy({
    tenantId: runtime.container.config.tenantId,
    clock: runtime.clock,
    contextStore: runtime.lcdStore,
    piSessionAdapters: required.value.piSessionAdapters,
    logger: runtime.schedulerLogger,
  });
  const runWakeGate = createCronWakeGateAdapter({
    getRunner: () => runtime.wakeGateRunnerRef?.ref,
  });
  const cronAgentTurn = createCronAgentTurnExecutor({
    tenantId: runtime.container.config.tenantId,
    agents: runtime.container.config.agents,
    clock: runtime.clock,
    eventBus: runtime.container.eventBus,
    getExecutor: (agentId) => required.value.getExecutor(agentId),
    assembleTools: (agentId, sessionKey) => required.value.assembleToolsForAgent(agentId, { sessionKey }),
    sessionPolicy,
    resolveWakeGateCapability: (agentId) => {
      const agent = runtime.container.config.agents[agentId];
      const effectiveCron = agent?.scheduler?.cron ?? runtime.container.config.scheduler.cron;
      const enabled = resolveCronWakeGateEnabled(effectiveCron.wakeGate, agent?.autonomy?.script);
      if (!enabled) return "disabled";
      return runtime.wakeGateRunnerRef?.ref === undefined ? "unbound" : "enabled";
    },
    runWakeGate,
    deliverText: ({ input, text, target, signal }) => cronDelivery({
      executionId: input.executionId,
      jobId: input.job.id,
      text,
      target,
      signal,
    }),
    continueTurn: continuation,
    readMetrics: (agentId, sessionKey) => {
      const cost = runtime.costTrackers?.get(agentId)?.getBySession(formatSessionKey(sessionKey));
      return {
        totalTokens: cost?.totalTokens ?? 0,
        costUsd: cost?.totalCost ?? 0,
        toolCalls: runtime.stepCounters?.get(agentId)?.getCount() ?? 0,
        llmCalls: 0,
      };
    },
    idFactory: randomUUID,
    logger: runtime.schedulerLogger,
  });
  const reflection = buildReflectionCronDeps({
    container: runtime.container,
    tenantId: runtime.container.config.tenantId,
    sessionStore: runtime.sessionStore,
    lcdStore: runtime.lcdStore,
    contextBrowse: runtime.contextBrowse,
    outcomeStore: runtime.outcomeStore,
    learnedSkillStore: runtime.learnedSkillStore,
    memoryApi: runtime.memoryApi,
  });
  const actionRunners = createCronMemoryActionRunners({
    container: runtime.container,
    tenantId: runtime.container.config.tenantId,
    clock: runtime.clock,
    logger: runtime.schedulerLogger,
    workspaceDirs: required.value.workspaceDirs,
    memoryAdapter: runtime.memoryAdapter,
    sessionStore: runtime.sessionStore,
    lcdStore: runtime.lcdStore,
    contextBrowse: runtime.contextBrowse,
    entityStore: runtime.entityStore,
    causalStore: runtime.causalStore,
    memoryLifecycleStore: runtime.memoryLifecycleStore,
    memoryApi: runtime.memoryApi,
    reflection,
    resolveAccessToken: async (agentId, provider) => {
      const manager = runtime.oauthManagers?.get(agentId);
      if (manager === undefined) return undefined;
      const token = await manager.getApiKey(provider, {
        oauthProfiles: runtime.container.config.agents[agentId]?.oauthProfiles,
      });
      return token.ok ? token.value : undefined;
    },
  });
  const actionServices = createCronMemoryActionServices({
    agents: runtime.container.config.agents,
    clock: runtime.clock,
    boundedAutonomyHolder: required.value.boundedAutonomyBudgetHolder,
    ...actionRunners,
    eventBus: runtime.container.eventBus,
    logger: runtime.schedulerLogger,
  });
  const internalAction = createCronInternalActionExecutor({
    tenantId: runtime.container.config.tenantId,
    clock: runtime.clock,
    idFactory: randomUUID,
    ...actionServices,
    logger: runtime.schedulerLogger,
  });
  const heartbeatDispatcher = createCronHeartbeatDispatcher({
    clock: runtime.clock,
    coordinator,
    resolveNextPeriodicPhaseMs: (agentId) => coordinator.getNextPeriodicPhaseMs(agentId),
    logger: runtime.schedulerLogger,
  });
  const cronExecutor = createDaemonCronRuntimeExecutor({
    ...deliveryDeps,
    dispatchHeartbeatEvent: heartbeatDispatcher,
    executeAgentTurn: cronAgentTurn,
    executeInternalAction: internalAction,
    logger: runtime.schedulerLogger,
  });
  const cronRoot = createCronRootRegistrar({
    tenantId: runtime.container.config.tenantId,
    leaseManager: required.value.sharedLeaseManager,
    outputGuard: required.value.capEndpointHandle.outputGuard,
    boundedAutonomyHolder: required.value.boundedAutonomyBudgetHolder,
    logger: runtime.schedulerLogger,
  });

  required.value.cronRuntimeBinding.bind({ executor: cronExecutor, rootRegistrar: cronRoot });
  const portsBound = taskRuntime === undefined
    ? deps.schedulerCorePortBindings.bind({
        taskExtractionPort: disabledTaskExtraction,
        deliveredAssistantHistoryPort: history,
      })
    : deps.schedulerCorePortBindings.bind({
        taskExtractionPort: taskRuntime.taskExtractionPort,
        deliveredAssistantHistoryPort: history,
      });
  if (!portsBound.ok) {
    taskRuntime?.shutdown();
    coordinator.shutdown();
    heartbeatRunner?.shutdown();
    historyState.accepting = false;
    return err({
      code: "port_binding_failed",
      errorKind: portsBound.error.errorKind,
      message: "Scheduler core ports could not be bound",
    });
  }
  const activated = activateProactiveSchedulers({
    agents: runtime.container.config.agents,
    globalHeartbeatConfig: runtime.container.config.scheduler.heartbeat,
    getAgentSchedulerSeed: required.value.getAgentSchedulerSeed,
    coordinator,
    activateCronSchedulers: required.value.activateCronSchedulers,
    logger: runtime.schedulerLogger,
  });
  if (!activated.ok) {
    taskRuntime?.shutdown();
    historyState.accepting = false;
    coordinator.shutdown();
    heartbeatRunner?.shutdown();
    deps.schedulerCorePortBindings.close();
    return err({
      code: "activation_failed",
      errorKind: activated.error.errorKind,
      message: activated.error.message,
    });
  }
  if (taskRuntime !== undefined) {
    const taskActivated = await taskRuntime.activate();
    if (!taskActivated.ok) {
      taskRuntime.shutdown();
      historyState.accepting = false;
      coordinator.shutdown();
      heartbeatRunner?.shutdown();
      deps.schedulerCorePortBindings.close();
      return err({
        code: "activation_failed",
        errorKind: taskActivated.error.errorKind,
        message: "Follow-up task schedules could not be activated",
      });
    }
  }

  let finalized = false;
  const closeAdmission = (): { activeCount: number; cancelledCount: number } => {
    const coordinatorStatus = coordinator.closeAdmission();
    const taskStatus = taskRuntime?.closeAdmission();
    return {
      activeCount: coordinatorStatus.activeCount,
      cancelledCount: coordinatorStatus.cancelledCount + (taskStatus?.droppedCount ?? 0),
    };
  };
  const waitForIdle = async (): Promise<void> => {
    await Promise.all([
      coordinator.waitForIdle(),
      taskRuntime?.waitForIdle() ?? Promise.resolve(),
    ]);
  };
  const abortActive = (): { activeCount: number } => {
    const coordinatorStatus = coordinator.abortActive();
    const taskStatus = taskRuntime?.abortActive();
    heartbeatRunner?.shutdown();
    return { activeCount: coordinatorStatus.activeCount + (taskStatus?.activeCount ?? 0) };
  };
  const finalizeShutdown = (): void => {
    if (finalized) return;
    finalized = true;
    taskRuntime?.shutdown();
    coordinator.shutdown();
    heartbeatRunner?.shutdown();
    historyState.accepting = false;
    deps.schedulerCorePortBindings.close();
    required.value.cronRuntimeBinding.close();
  };
  const disableTasks = (): ReturnType<ProactiveSchedulersHandle["disableTasks"]> => {
    const startedAtMs = runtime.clock.now();
    const gate = taskRuntimeGate.disable();
    if (!gate.changed) {
      return {
        changed: false,
        cancelledBeforeStartCount: 0,
        activeTaskCheckCount: 0,
        activeExtractionCount: 0,
        droppedExtractionCount: 0,
      };
    }
    const taskStatus = taskRuntime?.disable();
    let cancelledBeforeStartCount = 0;
    let coordinatorActiveCount = 0;
    for (const agentId of Object.keys(runtime.container.config.agents)) {
      const lane = coordinator.closeTaskLane(agentId, "feature_disabled");
      cancelledBeforeStartCount += lane.cancelledCount;
      coordinatorActiveCount += lane.activeCount;
    }
    const status = {
      changed: true,
      cancelledBeforeStartCount,
      activeTaskCheckCount: Math.max(
        coordinatorActiveCount,
        taskStatus?.taskCheckActiveCount ?? 0,
      ),
      activeExtractionCount: taskStatus?.extractionActiveCount ?? 0,
      droppedExtractionCount: taskStatus?.droppedExtractionCount ?? 0,
    } as const;
    runtime.schedulerLogger.info({
      step: "task_feature_disable",
      ...status,
      durationMs: Math.max(0, runtime.clock.now() - startedAtMs),
    }, "Follow-up task runtime disabled");
    return status;
  };

  return ok({
    coordinator,
    heartbeatRunner,
    duplicateDetector,
    requestTaskRescan: (agentId) => taskRuntime === undefined
      ? Promise.resolve(err({ errorKind: "precondition" as const }))
      : taskRuntime.requestRescan(agentId),
    async enterTaskMaintenance(agentId) {
      const lane = coordinator.closeTaskLane(agentId, "maintenance");
      const runtimeStatus = taskRuntime?.enterMaintenance(agentId);
      return ok({
        taskCheckActiveCount: Math.max(lane.activeCount, runtimeStatus?.taskCheckActiveCount ?? 0),
        extractionActiveCount: runtimeStatus?.extractionActiveCount ?? 0,
      });
    },
    disableTasks,
    closeAdmission,
    waitForIdle,
    abortActive,
    finalizeShutdown,
    shutdown() {
      closeAdmission();
      abortActive();
      finalizeShutdown();
    },
  });
}

function requiresAgentProactiveRuntime(runtime: ProactiveBootSlice): boolean {
  if (runtime.container.config.scheduler.tasks.enabled) return true;
  for (const agent of Object.values(runtime.container.config.agents)) {
    const cron = agent.scheduler?.cron ?? runtime.container.config.scheduler.cron;
    const heartbeat = resolveEffectiveHeartbeatConfig(
      runtime.container.config.scheduler.heartbeat,
      agent.scheduler?.heartbeat,
    );
    if (cron.enabled || heartbeat.enabled) return true;
  }
  return false;
}

function setupQuiescentProactiveSchedulers(
  deps: SetupProactiveSchedulersDeps,
): Result<ProactiveSchedulersHandle, SetupProactiveSchedulersError> {
  const runtime = deps.runtime;
  if (runtime.getAgentSchedulerSeed === undefined || runtime.activateCronSchedulers === undefined) {
    return err({
      code: "dependency_unavailable",
      errorKind: "precondition",
      message: "Scheduler initialization state is unavailable",
    });
  }
  const { heartbeatRunner, duplicateDetector } = setupMonitoring({
    container: runtime.container,
    schedulerLogger: runtime.schedulerLogger,
    clock: runtime.clock,
    timers: runtime.timers,
  });
  if (duplicateDetector === undefined) {
    return err({
      code: "dependency_unavailable",
      errorKind: "precondition",
      message: "Heartbeat duplicate detector is unavailable",
    });
  }
  const coordinator = createHeartbeatWakeCoordinator({
    clock: runtime.clock,
    timers: runtime.timers,
    eventBus: runtime.container.eventBus,
    logger: runtime.schedulerLogger,
    idFactory: randomUUID,
    hasTarget: (target) => target.kind === "monitoring" && heartbeatRunner !== undefined,
    isTargetBusy: (target) => target.kind === "monitoring" && (heartbeatRunner?.isBusy() ?? false),
    isTaskEnabled: () => false,
    checkIntervalFileGate: async () => err({ code: "not_bound", errorKind: "precondition" }),
    registerRoot: async () => err({ errorKind: "precondition" }),
    releaseRoot: async () => err({ errorKind: "precondition" }),
    runAgent: async () => err({ code: "not_bound", errorKind: "precondition" }),
    runMonitoring: (input) => heartbeatRunner === undefined
      ? Promise.resolve(err({ code: "not_bound", errorKind: "precondition" }))
      : heartbeatRunner.runOnce(input.reason, input.signal),
  });
  const taskExtractionPort: TaskExtractionPort = {
    enqueue: () => err({ code: "not_accepting", errorKind: "precondition" }),
  };
  const deliveredAssistantHistoryPort: DeliveredAssistantHistoryPort = {
    append: async () => err({ code: "not_accepting", errorKind: "precondition" }),
  };
  const bound = deps.schedulerCorePortBindings.bind({
    taskExtractionPort,
    deliveredAssistantHistoryPort,
  });
  if (!bound.ok) {
    coordinator.shutdown();
    heartbeatRunner?.shutdown();
    return err({
      code: "port_binding_failed",
      errorKind: bound.error.errorKind,
      message: "Scheduler core ports could not be bound",
    });
  }
  const activated = activateProactiveSchedulers({
    agents: runtime.container.config.agents,
    globalHeartbeatConfig: runtime.container.config.scheduler.heartbeat,
    getAgentSchedulerSeed: runtime.getAgentSchedulerSeed,
    coordinator,
    activateCronSchedulers: runtime.activateCronSchedulers,
    logger: runtime.schedulerLogger,
  });
  if (!activated.ok) {
    heartbeatRunner?.shutdown();
    deps.schedulerCorePortBindings.close();
    return err({
      code: "activation_failed",
      errorKind: activated.error.errorKind,
      message: activated.error.message,
    });
  }
  let finalized = false;
  const closeAdmission = (): { activeCount: number; cancelledCount: number } => coordinator.closeAdmission();
  const waitForIdle = (): Promise<void> => coordinator.waitForIdle();
  const abortActive = (): { activeCount: number } => {
    const status = coordinator.abortActive();
    heartbeatRunner?.shutdown();
    return status;
  };
  const finalizeShutdown = (): void => {
    if (finalized) return;
    finalized = true;
    coordinator.shutdown();
    heartbeatRunner?.shutdown();
    deps.schedulerCorePortBindings.close();
  };
  function disableTasks(): ReturnType<ProactiveSchedulersHandle["disableTasks"]> {
    const changed = runtime.taskRuntimeGate?.disable().changed ?? false;
    return {
      changed,
      cancelledBeforeStartCount: 0,
      activeTaskCheckCount: 0,
      activeExtractionCount: 0,
      droppedExtractionCount: 0,
    };
  }
  return ok({
    coordinator,
    heartbeatRunner,
    duplicateDetector,
    requestTaskRescan: async () => err({ errorKind: "precondition" as const }),
    async enterTaskMaintenance(agentId) {
      const lane = coordinator.closeTaskLane(agentId, "maintenance");
      return ok({ taskCheckActiveCount: lane.activeCount, extractionActiveCount: 0 });
    },
    disableTasks,
    closeAdmission,
    waitForIdle,
    abortActive,
    finalizeShutdown,
    shutdown() {
      closeAdmission();
      abortActive();
      finalizeShutdown();
    },
  });
}

function resolveRequiredRuntime(runtime: ProactiveBootSlice): Result<{
  workspaceDirs: NonNullable<ProactiveBootSlice["workspaceDirs"]>;
  getExecutor: NonNullable<ProactiveBootSlice["getExecutor"]>;
  piSessionAdapters: NonNullable<ProactiveBootSlice["piSessionAdapters"]>;
  assembleToolsForAgent: NonNullable<ProactiveBootSlice["assembleToolsForAgent"]>;
  sharedLeaseManager: NonNullable<ProactiveBootSlice["sharedLeaseManager"]>;
  boundedAutonomyBudgetHolder: NonNullable<ProactiveBootSlice["boundedAutonomyBudgetHolder"]>;
  capEndpointHandle: NonNullable<ProactiveBootSlice["capEndpointHandle"]>;
  cronRuntimeBinding: NonNullable<ProactiveBootSlice["cronRuntimeBinding"]>;
  activateCronSchedulers: NonNullable<ProactiveBootSlice["activateCronSchedulers"]>;
  getAgentSchedulerSeed: NonNullable<ProactiveBootSlice["getAgentSchedulerSeed"]>;
}, SetupProactiveSchedulersError> {
  const {
    workspaceDirs,
    getExecutor,
    piSessionAdapters,
    assembleToolsForAgent,
    sharedLeaseManager,
    boundedAutonomyBudgetHolder,
    capEndpointHandle,
    cronRuntimeBinding,
    activateCronSchedulers,
    getAgentSchedulerSeed,
  } = runtime;
  if (
    workspaceDirs === undefined
    || getExecutor === undefined
    || piSessionAdapters === undefined
    || assembleToolsForAgent === undefined
    || sharedLeaseManager === undefined
    || boundedAutonomyBudgetHolder === undefined
    || capEndpointHandle === undefined
    || cronRuntimeBinding === undefined
    || activateCronSchedulers === undefined
    || getAgentSchedulerSeed === undefined
  ) {
    return err({
      code: "dependency_unavailable",
      errorKind: "precondition",
      message: "Proactive scheduler dependency is unavailable",
    });
  }
  return ok({
    workspaceDirs,
    getExecutor,
    piSessionAdapters,
    assembleToolsForAgent,
    sharedLeaseManager,
    boundedAutonomyBudgetHolder,
    capEndpointHandle,
    cronRuntimeBinding,
    activateCronSchedulers,
    getAgentSchedulerSeed,
  });
}

function isAgentTargetBusy(runtime: ProactiveBootSlice, agentId: string): boolean {
  const identity = resolveInternalTurnIdentity({
    tenantId: runtime.container.config.tenantId,
    agentId,
    originKind: "scheduler",
    instanceId: "heartbeat",
    conversationId: agentId,
    principalId: `scheduler-heartbeat-${agentId}`,
  });
  if (!identity.ok) return true;
  const conversationRef = createConversationRef(identity.value.turnScope.conversation);
  return !conversationRef.ok || runtime.sessionResolver?.hasActiveSession(conversationRef.value) === true;
}

async function checkIntervalFileGate(
  runtime: ProactiveBootSlice,
  agentId: string,
): Promise<Result<boolean, { code: "invalid_target"; errorKind: "validation" }>> {
  const workspace = runtime.workspaceDirs?.get(agentId);
  if (workspace === undefined) return err({ code: "invalid_target", errorKind: "validation" });
  const loaded = await tryReadHeartbeatFile(safePath(workspace, "HEARTBEAT.md"));
  if (!loaded.ok) return ok(false);
  return ok(isHeartbeatContentEffectivelyEmpty(loaded.value));
}

async function tryReadHeartbeatFile(path: string): Promise<Result<string, Error>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error("Heartbeat file read failed"));
  }
}

function quietHoursResolver(runtime: ProactiveBootSlice) {
  return (nowMs: number): Result<boolean, { errorKind: "config" }> => {
    const quiet = tryCatch(() => isInQuietHours(runtime.container.config.scheduler.quietHours, nowMs));
    return quiet.ok ? quiet : err({ errorKind: "config" });
  };
}

function cronQuietHoursResolver(runtime: ProactiveBootSlice) {
  return (nowMs: number): Result<boolean, { code: "precondition_failed"; errorKind: "config"; message: string }> => {
    const quiet = tryCatch(() => isInQuietHours(runtime.container.config.scheduler.quietHours, nowMs));
    return quiet.ok
      ? quiet
      : err({ code: "precondition_failed", errorKind: "config", message: "Quiet-hours configuration is invalid" });
  };
}
