// SPDX-License-Identifier: Apache-2.0
// @allow-throw: scheduler composition failures are caught by the daemon bootstrap boundary.
/** Per-agent cron, browser, and session-reset composition. */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type {
  AppContainer,
  ClockPort,
  ComputeDailyResetNextRun,
  ErrorKind,
  EventMap,
  SkillsConfig,
  TimerPort,
} from "@comis/core";
import {
  SkillsConfigSchema,
  createFileLock,
  emitObservationalEventSafely,
  safePath,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createSessionStore } from "@comis/memory";
import type { createSessionLifecycle, SessionResetScheduler } from "@comis/agent";
import { createSessionResetScheduler } from "@comis/agent";
import {
  computeNextRunAtMs,
  createCronAuthorityMaintenance,
  createCronScheduler,
  createCronStore,
  createExecutionTracker,
  createFollowupTaskStore,
  createTaskAuthorityMaintenance,
  reconcileCronOwnership,
  resolveCronAuthoringSchedule,
  resolveQuietHoursEndMs,
  type BuiltInCronJob,
  type CronScheduler,
  type CronSchedulerLifecycleError,
  type ExecutionTracker,
  type FollowupTaskStore,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";
import { createBrowserService, type BrowserService } from "@comis/skills";
import { createLateBoundCronRuntime, type CronRuntimeBinding } from "./cron-runtime-binding.js";
import {
  createCronMaintenanceController,
  type CronMaintenanceController,
} from "./cron-maintenance-controller.js";
import {
  createTaskMaintenanceController,
  type TaskMaintenanceController,
  type TaskMaintenanceRuntimeStatus,
} from "./task-maintenance-controller.js";
import { emitMemoryCostFeatureNotice } from "./setup-memory-cost-notice.js";

const DEFAULT_CRON_TIMEOUT_MS = 10 * 60 * 1_000;

export interface SchedulersResult {
  ownedCronSchedulers: Map<string, CronScheduler>;
  cronSchedulers: Map<string, CronScheduler>;
  executionTrackers: Map<string, ExecutionTracker>;
  followupTaskStores: Map<string, FollowupTaskStore>;
  taskBootId: string;
  taskRuntimeGate: TaskRuntimeGate;
  taskMaintenanceControllers: Map<string, TaskMaintenanceController>;
  bindTaskMaintenanceRuntime(control: {
    enterTaskMaintenance(agentId: string): Promise<Result<TaskMaintenanceRuntimeStatus, {
      readonly errorKind: ErrorKind;
      readonly message: string;
    }>>;
  }): void;
  cronMaintenanceControllers: Map<string, CronMaintenanceController>;
  browserServices: Map<string, BrowserService>;
  resetSchedulers: Map<string, SessionResetScheduler>;
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  getAgentCronAuthoringConfig: (agentId: string) => {
    defaultTimezone: string;
    maxConsecutiveDependencyErrors: number;
  };
  getAgentSchedulerSeed: (agentId: string) => Result<string, {
    code: "not_initialized";
    errorKind: "precondition";
    message: string;
  }>;
  getAgentBrowserService: (agentId: string) => BrowserService;
  cronRuntimeBinding: CronRuntimeBinding;
  activateCronSchedulers: () => Result<void, CronSchedulerLifecycleError>;
}

export interface TaskRuntimeGate {
  isEnabled(): boolean;
  disable(): { readonly changed: boolean };
}

export async function setupSchedulers(deps: {
  container: AppContainer;
  workspaceDirs: Map<string, string>;
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  schedulerLogger: ComisLogger;
  agentLogger: ComisLogger;
  skillsLogger: ComisLogger;
  subprocessEnv?: Record<string, string>;
  clock: ClockPort;
  timers: TimerPort;
}): Promise<SchedulersResult> {
  const {
    container,
    workspaceDirs,
    sessionStore,
    sessionManager,
    schedulerLogger,
    agentLogger,
    skillsLogger,
    subprocessEnv,
    clock,
    timers,
  } = deps;
  const agents = container.config.agents;
  const schedulerConfig = container.config.scheduler;
  const costFeaturesEnabled = container.config.memory?.enabled !== false;
  const cronRuntimeBinding = createLateBoundCronRuntime();
  const fileLock = createFileLock();
  const bootId = `daemon-${randomUUID()}`;
  const ownedCronSchedulers = new Map<string, CronScheduler>();
  const cronSchedulers = new Map<string, CronScheduler>();
  const executionTrackers = new Map<string, ExecutionTracker>();
  const followupTaskStores = new Map<string, FollowupTaskStore>();
  let taskRuntimeEnabled = schedulerConfig.tasks.enabled;
  const taskRuntimeGate: TaskRuntimeGate = {
    isEnabled: () => taskRuntimeEnabled,
    disable() {
      if (!taskRuntimeEnabled) return { changed: false };
      taskRuntimeEnabled = false;
      return { changed: true };
    },
  };
  const taskMaintenanceControllers = new Map<string, TaskMaintenanceController>();
  let taskMaintenanceRuntime: {
    enterTaskMaintenance(agentId: string): Promise<Result<TaskMaintenanceRuntimeStatus, {
      readonly errorKind: ErrorKind;
      readonly message: string;
    }>>;
  } | undefined;
  const cronMaintenanceControllers = new Map<string, CronMaintenanceController>();
  const cronAuthoringConfigs = new Map<string, {
    defaultTimezone: string;
    maxConsecutiveDependencyErrors: number;
  }>();
  const agentSchedulerSeeds = new Map<string, string>();

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const effectiveCron = agentConfig.scheduler?.cron ?? schedulerConfig.cron;
    const agentWorkspace = workspaceDirs.get(agentId);
    if (agentWorkspace === undefined) {
      throw new Error(`Workspace is not configured for scheduler agent "${agentId}"`);
    }
    const schedulerDir = safePath(agentWorkspace, ".scheduler");
    await fs.mkdir(schedulerDir, { recursive: true, mode: 0o700 });
    const storePath = safePath(schedulerDir, "cron-jobs.json");
    const storeLockPath = safePath(schedulerDir, "cron-jobs.lock");
    const ledgerPath = safePath(schedulerDir, "cron-executions.jsonl");
    const ledgerLockPath = safePath(schedulerDir, "cron-executions.lock");
    const taskStorePath = safePath(schedulerDir, "tasks.json");
    const taskStoreLockPath = safePath(schedulerDir, "tasks.lock");
    const taskStore = createFollowupTaskStore({
      filePath: taskStorePath,
      lockPath: taskStoreLockPath,
      fileLock,
      clock,
      idFactory: randomUUID,
      getRuntimeConfig: (runtimeAgentId) => {
        const quiet = resolveQuietHoursEndMs(container.config.scheduler.quietHours, clock.now());
        return {
          enabled: taskRuntimeGate.isEnabled()
            && container.config.agents[runtimeAgentId] !== undefined,
          preAcceptanceRetryLimit: container.config.scheduler.tasks.preAcceptanceRetryLimit,
          quietUntilMs: quiet.ok ? quiet.value : Number.NaN,
        };
      },
    });
    const taskAuthority = createTaskAuthorityMaintenance({
      directory: schedulerDir,
      storePath: taskStorePath,
      intentPath: safePath(schedulerDir, "tasks-reset-intent.json"),
      storeLockPath: taskStoreLockPath,
      fileLock,
      clock,
      idFactory: randomUUID,
    });
    const taskLogger = schedulerLogger.child({ agentId, submodule: "tasks" });
    const taskController = createTaskMaintenanceController({
      agentId,
      tenantId: container.config.tenantId,
      configuredEnabled: schedulerConfig.tasks.enabled,
      authority: taskAuthority,
      store: taskStore,
      // setupSchedulers is called only after the boot boundary owns the data-directory singleton lock.
      exclusiveDataDirLockOwned: () => true,
      reconcileOwnership: async () => {
        const taskRecoveryStartedAtMs = clock.now();
        const recoveredTaskOwnership = await taskStore.reconcileOwnership({
          currentBootId: bootId,
          exclusiveDataDirLockOwned: true,
        });
        const taskRecoveryFinishedAtMs = clock.now();
        if (!recoveredTaskOwnership.ok) {
          emitTaskOwnershipHealth({
            agentId,
            status: "failed",
            errorCode: recoveredTaskOwnership.error.code,
            errorKind: recoveredTaskOwnership.error.errorKind,
            durationMs: taskRecoveryFinishedAtMs - taskRecoveryStartedAtMs,
            timestamp: taskRecoveryFinishedAtMs,
          });
          schedulerLogger.error({
            agentId,
            code: recoveredTaskOwnership.error.code,
            step: "task_ownership_reconcile",
            hint: "Keep task admission closed and verify the daemon singleton lock before repairing claimed attempts.",
            errorKind: recoveredTaskOwnership.error.errorKind,
          }, "Follow-up task ownership reconciliation failed");
          return recoveredTaskOwnership;
        }
        const { recoveredAttempts, ...recoveryCounts } = recoveredTaskOwnership.value;
        emitTaskOwnershipHealth({
          agentId,
          status: "completed",
          ...recoveryCounts,
          durationMs: taskRecoveryFinishedAtMs - taskRecoveryStartedAtMs,
          timestamp: taskRecoveryFinishedAtMs,
        });
        for (const recovered of recoveredAttempts) {
          const unknownDelivery = recovered.outcome === "delivery_unknown";
          emitObservationalEventSafely(
            { eventBus: container.eventBus, logger: schedulerLogger },
            "scheduler:task_check_terminal",
            {
              agentId: recovered.agentId,
              attemptId: recovered.attemptId,
              rootRunId: recovered.rootRunId,
              correlationId: recovered.rootRunId,
              taskIds: recovered.taskIds,
              sourceExecutionIds: recovered.sourceExecutionIds,
              originTraceIds: recovered.originTraceIds,
              outcome: recovered.outcome,
              recovery: "ownership_recovery",
              errorKind: recovered.errorKind,
              deliveredChunks: unknownDelivery ? null : 0,
              failedChunks: unknownDelivery ? null : 0,
              ambiguousChunks: unknownDelivery ? null : 0,
              durationMs: Math.max(0, recovered.terminalAtMs - recovered.startedAtMs),
              timestamp: recovered.terminalAtMs,
            },
          );
        }
        schedulerLogger.info({
          agentId,
          ...recoveryCounts,
          durationMs: taskRecoveryFinishedAtMs - taskRecoveryStartedAtMs,
        }, "Follow-up task ownership reconciled");
        return recoveredTaskOwnership;
      },
      enterMaintenance: async (maintenanceAgentId) => {
        if (taskMaintenanceRuntime === undefined) {
          return err({
            errorKind: "precondition" as const,
            message: "Task maintenance runtime is not bound",
          });
        }
        return taskMaintenanceRuntime.enterTaskMaintenance(maintenanceAgentId);
      },
      emitReset: (reset) => {
        emitObservationalEventSafely(
          { eventBus: container.eventBus, logger: schedulerLogger },
          "scheduler:task_store_reset",
          reset,
        );
        schedulerLogger.info({
          agentId,
          operationId: reset.operationId,
          durationMs: reset.durationMs,
        }, "Task authority reset completed");
      },
      eventBus: container.eventBus,
      logger: taskLogger,
      clock,
    });
    taskMaintenanceControllers.set(agentId, taskController);
    const initializedTaskController = await taskController.initialize();
    if (!initializedTaskController.ok) {
      const taskStatus = await taskController.status();
      const initializationCode = taskStatus.ok
        ? taskStatus.value.lastError?.code ?? initializedTaskController.error.code
        : initializedTaskController.error.code;
      schedulerLogger.error({
        agentId,
        code: initializationCode,
        step: "task_store_initialize",
        hint: "Run comis tasks status, preserve the raw authority, and use guarded reset only after reviewing its digest.",
        errorKind: initializedTaskController.error.errorKind,
      }, "Follow-up task subsystem initialization failed");
    } else {
      const taskRecoveryFinishedAtMs = clock.now();
      followupTaskStores.set(agentId, taskStore);
      schedulerLogger.debug({ agentId, initializedAtMs: taskRecoveryFinishedAtMs }, "Follow-up task subsystem initialized");
    }
    const store = createCronStore({
      filePath: storePath,
      lockPath: storeLockPath,
      fileLock,
      clock,
      idFactory: randomUUID,
      maxAuthoredJobs: effectiveCron.maxJobs,
      maxConsecutiveDependencyErrors: effectiveCron.maxConsecutiveDependencyErrors,
    });
    let scheduler: CronScheduler | undefined;
    let tracker: ExecutionTracker | undefined;
    const cronLogger = schedulerLogger.child({ agentId });
    if (effectiveCron.enabled) {
      tracker = createExecutionTracker({
        logPath: ledgerPath,
        lockPath: ledgerLockPath,
        fileLock,
        idFactory: randomUUID,
        maxLogBytes: schedulerConfig.execution.maxLogBytes,
        retainedExecutions: schedulerConfig.execution.retainedExecutions,
      });
      scheduler = createCronScheduler({
        store,
        tracker,
        executor: cronRuntimeBinding.executor,
        rootRegistrar: cronRuntimeBinding.rootRegistrar,
        eventBus: container.eventBus,
        logger: cronLogger,
        clock,
        timers,
        bootId,
        idFactory: randomUUID,
        config: {
          maxRunsPerTick: effectiveCron.maxRunsPerTick,
          defaultTimeoutMs: agentConfig.operationModels?.cron?.timeout ?? DEFAULT_CRON_TIMEOUT_MS,
          staggerWindowMs: effectiveCron.staggerWindowMs,
        },
      });
      ownedCronSchedulers.set(agentId, scheduler);
    }

    const authority = createCronAuthorityMaintenance({
      directory: schedulerDir,
      storePath,
      ledgerPath,
      intentPath: safePath(schedulerDir, "cron-reset-intent.json"),
      storeLockPath,
      ledgerLockPath,
      fileLock,
      clock,
      idFactory: randomUUID,
    });
    cronAuthoringConfigs.set(agentId, {
      defaultTimezone: effectiveCron.defaultTimezone,
      maxConsecutiveDependencyErrors: effectiveCron.maxConsecutiveDependencyErrors,
    });
    const desiredBuiltIns = (): readonly BuiltInCronJob[] => effectiveCron.enabled
      ? buildDesiredBuiltIns({
          agentId,
          agentConfig,
          costFeaturesEnabled,
          nowMs: clock.now(),
          timezone: effectiveCron.defaultTimezone,
          maxConsecutiveDependencyErrors: effectiveCron.maxConsecutiveDependencyErrors,
        })
      : [];
    const currentTracker = tracker;
    const controller = createCronMaintenanceController({
      agentId,
      tenantId: container.config.tenantId,
      configuredEnabled: effectiveCron.enabled,
      authority,
      store,
      ...(tracker === undefined ? {} : { tracker }),
      ...(scheduler === undefined ? {} : { scheduler }),
      reconcileOwnership: async () => {
        if (currentTracker === undefined) {
          return err({ errorKind: "internal" as const, message: "Cron execution tracker is unavailable" });
        }
        const reconciliationStartedAtMs = clock.now();
        const ownership = await reconcileCronOwnership({
          store,
          tracker: currentTracker,
          eventBus: container.eventBus,
          logger: cronLogger,
          currentBootId: bootId,
          nowMs: clock.now(),
        });
        const timestamp = clock.now();
        if (!ownership.ok) {
          emitOwnershipHealth({
            agentId,
            status: "failed",
            errorCode: ownership.error.code,
            errorKind: ownership.error.errorKind,
            durationMs: timestamp - reconciliationStartedAtMs,
            timestamp,
          });
          schedulerLogger.error({
            agentId,
            ...(ownership.error.executionId === undefined
              ? {}
              : { executionId: ownership.error.executionId }),
            code: ownership.error.code,
            err: ownership.error.message,
            hint: "Preserve the cron store and execution ledger, then repair or deliberately reset both authority files",
            errorKind: ownership.error.errorKind,
          }, "Cron ownership reconciliation failed");
          return ownership;
        }
        emitOwnershipHealth({
          agentId,
          status: "completed",
          ...ownership.value,
          durationMs: timestamp - reconciliationStartedAtMs,
          timestamp,
        });
        schedulerLogger.info({
          agentId,
          ...ownership.value,
          durationMs: timestamp - reconciliationStartedAtMs,
        }, "Cron ownership reconciliation completed");
        return ownership;
      },
      desiredBuiltIns,
      dependenciesReady: () => cronRuntimeBinding.isBound(),
      onReady: (ready) => {
        agentSchedulerSeeds.set(agentId, ready.seed);
        if (ready.scheduler !== undefined && ready.tracker !== undefined) {
          cronSchedulers.set(agentId, ready.scheduler);
          executionTrackers.set(agentId, ready.tracker);
        }
      },
      onQuiesced: () => {
        cronSchedulers.delete(agentId);
        executionTrackers.delete(agentId);
        agentSchedulerSeeds.delete(agentId);
      },
      emitReset: (reset) => {
        const emitted = container.eventBus.emitSafely("scheduler:cron_store_reset", reset);
        if (emitted.failures.length > 0) {
          schedulerLogger.warn({
            agentId,
            event: "scheduler:cron_store_reset",
            subscriberFailures: emitted.failures.length,
            step: "event_emit",
            hint: "Inspect the failing reset-event subscriber; the reset authority files remain durable",
            errorKind: "internal" as const,
          }, "Cron reset event subscriber failed");
        }
        schedulerLogger.info({
          agentId,
          operationId: reset.operationId,
          target: reset.target,
          reactivated: reset.reactivated,
          durationMs: 0,
        }, "Cron authority reset completed");
      },
      eventBus: container.eventBus,
      logger: cronLogger,
      clock,
    });
    cronMaintenanceControllers.set(agentId, controller);
    const initialized = await controller.initialize();
    if (!initialized.ok) {
      schedulerLogger.error({
        agentId,
        code: initialized.error.code,
        err: initialized.error.message,
        hint: "Run comis cron status, preserve both authority files, then use the guarded reset only after reviewing their digests",
        errorKind: initialized.error.errorKind,
      }, "Per-agent cron subsystem initialization failed");
      continue;
    }
    schedulerLogger.debug({ agentId, builtInCount: desiredBuiltIns().length }, "Per-agent cron scheduler initialized");
  }

  emitMemoryCostFeatureNotice({ agents, costFeaturesEnabled, logger: schedulerLogger });

  function emitOwnershipHealth(
    payload: EventMap["scheduler:cron_ownership_reconciliation"],
  ): void {
    const emitted = container.eventBus.emitSafely("scheduler:cron_ownership_reconciliation", payload);
    if (emitted.failures.length === 0) return;
    schedulerLogger.warn({
      event: "scheduler:cron_ownership_reconciliation",
      subscriberFailures: emitted.failures.length,
      step: "event_emit",
      hint: "Inspect the failing health subscriber; the cron store and execution ledger remain authoritative",
      errorKind: "internal" as const,
    }, "Cron ownership health-event subscriber failed");
  }

  function emitTaskOwnershipHealth(
    payload: EventMap["scheduler:task_ownership_reconciliation"],
  ): void {
    const emitted = container.eventBus.emitSafely("scheduler:task_ownership_reconciliation", payload);
    if (emitted.failures.length === 0) return;
    schedulerLogger.warn({
      event: "scheduler:task_ownership_reconciliation",
      subscriberFailures: emitted.failures.length,
      step: "event_emit",
      hint: "Inspect the failing health subscriber; the follow-up task authority file remains authoritative.",
      errorKind: "internal" as const,
    }, "Follow-up task ownership health-event subscriber failed");
  }

  function getAgentCronScheduler(agentId: string): CronScheduler {
    const scheduler = cronSchedulers.get(agentId);
    if (scheduler === undefined) {
      throw new Error(`CronScheduler not enabled for agent "${agentId}"`);
    }
    return scheduler;
  }

  function getAgentCronAuthoringConfig(agentId: string): {
    defaultTimezone: string;
    maxConsecutiveDependencyErrors: number;
  } {
    const config = cronAuthoringConfigs.get(agentId);
    if (config === undefined) {
      throw new Error(`Cron authoring is not enabled for agent "${agentId}"`);
    }
    return config;
  }

  function getAgentSchedulerSeed(agentId: string): Result<string, {
    code: "not_initialized";
    errorKind: "precondition";
    message: string;
  }> {
    const seed = agentSchedulerSeeds.get(agentId);
    return seed === undefined
      ? err({
          code: "not_initialized",
          errorKind: "precondition",
          message: `Scheduler seed is not initialized for agent "${agentId}"`,
        })
      : ok(seed);
  }

  function activateCronSchedulers(): Result<void, CronSchedulerLifecycleError> {
    if (cronSchedulers.size > 0 && !cronRuntimeBinding.isBound()) {
      return err({
        code: "not_active",
        errorKind: "precondition",
        message: "Cron runtime dependencies must be bound before scheduler activation",
      });
    }
    const startedAtMs = clock.now();
    for (const [agentId, controller] of cronMaintenanceControllers) {
      const result = controller.activate();
      if (!result.ok) {
        schedulerLogger.error({
          agentId,
          err: result.error.message,
          hint: "Keep scheduler admission closed and repair runtime binding before activation",
          errorKind: result.error.errorKind,
        }, "Cron scheduler activation failed");
        continue;
      }
    }
    schedulerLogger.info({
      schedulerCount: cronSchedulers.size,
      durationMs: clock.now() - startedAtMs,
    }, "Cron schedulers activated");
    return ok(undefined);
  }

  const browserServices = new Map<string, BrowserService>();
  let browserPortOffset = 0;
  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const skills: SkillsConfig = agentConfig.skills ?? SkillsConfigSchema.parse({});
    if (!skills.builtinTools.browser) continue;
    const browserConfig = container.config.browser;
    browserServices.set(agentId, createBrowserService(
      { ...browserConfig, cdpPort: (browserConfig?.cdpPort ?? 9222) + browserPortOffset },
      subprocessEnv,
    ));
    browserPortOffset++;
    skillsLogger.info({ agentId }, "BrowserService created (idle until browser.start)");
  }

  function getAgentBrowserService(agentId: string): BrowserService {
    const service = browserServices.get(agentId);
    if (service === undefined) throw new Error(`Browser not enabled for agent "${agentId}"`);
    return service;
  }

  const resetSchedulers = new Map<string, SessionResetScheduler>();
  const computeDailyResetNextRun: ComputeDailyResetNextRun = (updatedAt, hour, timezone) =>
    computeNextRunAtMs({ kind: "cron", expr: `0 ${hour} * * *`, tz: timezone || "UTC" }, updatedAt);
  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const resetConfig = agentConfig.session?.resetPolicy;
    if (resetConfig === undefined || resetConfig.mode === "none") continue;
    const scheduler = createSessionResetScheduler({
      sessionStore,
      sessionManager,
      eventBus: container.eventBus,
      logger: agentLogger.child({ agentId, component: "session-reset" }),
      getConfig: () => container.config.agents[agentId]?.session?.resetPolicy,
      computeDailyResetNextRun,
      nowMs: clock.now.bind(clock),
      timers,
      listQueryScopes: () => [{ tenantId: container.config.tenantId, agentId }],
    });
    scheduler.start();
    resetSchedulers.set(agentId, scheduler);
    agentLogger.info({ agentId, mode: resetConfig.mode }, "Per-agent SessionResetScheduler started");
  }

  return {
    ownedCronSchedulers,
    cronSchedulers,
    executionTrackers,
    followupTaskStores,
    taskBootId: bootId,
    taskRuntimeGate,
    taskMaintenanceControllers,
    bindTaskMaintenanceRuntime(control) {
      taskMaintenanceRuntime = control;
    },
    cronMaintenanceControllers,
    browserServices,
    resetSchedulers,
    getAgentCronScheduler,
    getAgentCronAuthoringConfig,
    getAgentSchedulerSeed,
    getAgentBrowserService,
    cronRuntimeBinding,
    activateCronSchedulers,
  };
}

function buildDesiredBuiltIns(input: {
  agentId: string;
  agentConfig: AppContainer["config"]["agents"][string];
  costFeaturesEnabled: boolean;
  nowMs: number;
  timezone: string;
  maxConsecutiveDependencyErrors: number;
}): BuiltInCronJob[] {
  const definitions: Array<{
    enabled: boolean;
    id: string;
    name: string;
    schedule: string;
    action: BuiltInCronJob["payload"]["action"];
  }> = [
    {
      enabled: input.costFeaturesEnabled && input.agentConfig.memoryReview?.enabled === true,
      id: `memory-review-${input.agentId}`,
      name: "Memory review",
      schedule: input.agentConfig.memoryReview?.schedule ?? "0 2 * * *",
      action: "memory_review",
    },
    {
      enabled: input.agentConfig.memoryLifecycle?.enabled === true,
      id: `memory-lifecycle-${input.agentId}`,
      name: "Memory lifecycle",
      schedule: input.agentConfig.memoryLifecycle?.schedule ?? "0 9 * * *",
      action: "memory_lifecycle",
    },
    {
      enabled: input.costFeaturesEnabled && input.agentConfig.learning?.enabled === true,
      id: `reflect-${input.agentId}`,
      name: "Reflection",
      schedule: input.agentConfig.learning?.reflect?.schedule ?? "0 3 * * *",
      action: "reflection",
    },
  ];
  return definitions.filter((definition) => definition.enabled).map((definition) => {
    const schedule = resolveCronAuthoringSchedule(
      { kind: "cron", expr: definition.schedule, tz: input.timezone },
      input.nowMs,
      input.timezone,
    );
    if (!schedule.ok) throw schedule.error;
    const nextRunAtMs = computeNextRunAtMs(schedule.value, input.nowMs);
    if (nextRunAtMs === undefined) throw new Error(`Built-in cron schedule has no next occurrence: ${definition.id}`);
    return {
      id: definition.id,
      name: definition.name,
      agentId: input.agentId,
      source: "built_in",
      schedule: schedule.value,
      lifecycle: {
        status: "scheduled",
        nextRunAtMs,
        consecutiveDependencyErrors: 0,
      },
      maxConsecutiveDependencyErrors: input.maxConsecutiveDependencyErrors,
      payload: { kind: "internal_action", action: definition.action },
    };
  });
}
