// SPDX-License-Identifier: Apache-2.0
/** Atomic composition of the governed, volatile follow-up extraction path. */
import type {
  AppConfig,
  AppContainer,
  ClockPort,
  ComisLogger,
  ErrorKind,
  OutputGuardPort,
  TaskExtractionPort,
  TimerPort,
} from "@comis/core";
import { emitObservationalEventSafely } from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  type AgentExecutor,
  type BoundedAutonomyBudgetHolder,
  type OperationModelResolution,
} from "@comis/agent";
import type { LeaseManager } from "@comis/infra";
import {
  createTaskExtractionQueue,
  createTaskExtractionRunner,
  resolveEffectiveHeartbeatConfig,
  type FollowupTaskStore,
  type TaskExtractionRunnerOutcome,
} from "@comis/scheduler";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { createTaskExtractionModelRunner } from "./task-extraction-model-runner.js";
import { createTaskExtractionRootRegistrar } from "./task-extraction-root-registrar.js";

export interface FollowupTaskExtractionRuntimeDeps {
  readonly config: AppConfig;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly eventBus: AppContainer["eventBus"];
  readonly logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
  readonly taskStores: ReadonlyMap<string, FollowupTaskStore>;
  readonly workspaceDirs: ReadonlyMap<string, string>;
  readonly getExecutor: (agentId: string) => AgentExecutor | undefined;
  readonly leaseManager: Pick<LeaseManager, "mintLease" | "revoke">;
  readonly outputGuard: Pick<OutputGuardPort, "registerSecret">;
  readonly boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  readonly onTaskStoreChanged: (agentId: string) => Promise<Result<void, { readonly errorKind: ErrorKind }>>;
  readonly idFactory: () => string;
}

export interface FollowupTaskExtractionRuntime {
  readonly taskExtractionPort: TaskExtractionPort;
  closeAdmission(): { readonly droppedCount: number };
  abortActive(): { readonly activeCount: number };
  waitForIdle(): Promise<void>;
  status(): {
    readonly queue: ReturnType<ReturnType<typeof createTaskExtractionQueue>["getStatus"]>;
    readonly runner: ReturnType<ReturnType<typeof createTaskExtractionRunner>["getStatus"]>;
  };
}

export interface FollowupTaskExtractionSetupError {
  readonly code:
    | "feature_disabled"
    | "store_unavailable"
    | "workspace_unavailable"
    | "executor_unavailable"
    | "model_unavailable"
    | "root_services_unavailable"
    | "activation_failed";
  readonly errorKind: "precondition" | "config" | "internal";
  readonly message: string;
}

export function createFollowupTaskExtractionRuntime(
  deps: FollowupTaskExtractionRuntimeDeps,
): Result<FollowupTaskExtractionRuntime, FollowupTaskExtractionSetupError> {
  const ready = validateDependencies(deps);
  if (!ready.ok) return ready;

  const rootRegistrar = createTaskExtractionRootRegistrar({
    tenantId: deps.config.tenantId,
    leaseManager: deps.leaseManager,
    outputGuard: deps.outputGuard,
    boundedAutonomyHolder: deps.boundedAutonomyHolder,
    logger: deps.logger,
  });
  const withModelSession = createTaskExtractionModelRunner({
    tenantId: deps.config.tenantId,
    clock: deps.clock,
    getExecutor: deps.getExecutor,
    getWorkspaceDir: (agentId) => deps.workspaceDirs.get(agentId),
    resolveModel: (agentId) => resolveTaskExtractionModel(deps.config, agentId),
    idFactory: () => allocateId(deps.idFactory, ""),
    logger: deps.logger,
  });
  const runner = createTaskExtractionRunner({
    clock: deps.clock,
    timers: deps.timers,
    idFactory: () => allocateId(deps.idFactory, "root-task-extract-"),
    getConfig: () => ({
      batchMax: deps.config.scheduler.tasks.batchMax,
      defaultWindowMs: deps.config.scheduler.tasks.defaultWindowMs,
    }),
    isEnabled: (agentId) => taskEnabled(deps.config, agentId),
    registerRoot: rootRegistrar.registerRoot,
    releaseRoot: rootRegistrar.releaseRoot,
    withModelSession,
    persistCandidates: async (agentId, candidates) => {
      const store = deps.taskStores.get(agentId);
      if (store === undefined) return err({ code: "not_bound", errorKind: "precondition" as const });
      const startedAtMs = deps.clock.now();
      const admitted = await store.admitCandidates({
        candidates,
        confidenceThreshold: deps.config.scheduler.tasks.confidenceThreshold,
      });
      const durationMs = Math.max(0, deps.clock.now() - startedAtMs);
      if (!admitted.ok) {
        deps.logger.error({
          agentId,
          candidateCount: candidates.length,
          step: "task_extraction_store",
          durationMs,
          errorCode: admitted.error.code,
          errorKind: admitted.error.errorKind,
          hint: "Inspect the agent task authority file and live task configuration; the volatile extraction batch is not replayed.",
        }, "Task extraction candidate persistence failed");
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "scheduler:task_store_degraded",
          {
            agentId,
            operation: "extraction_persist",
            errorCode: admitted.error.code,
            errorKind: admitted.error.errorKind,
            durationMs,
            timestamp: deps.clock.now(),
          },
        );
        return err({ code: admitted.error.code, errorKind: admitted.error.errorKind });
      }
      const createdCount = admitted.value.filter((entry) => entry.disposition === "created").length;
      const mergedCount = admitted.value.filter((entry) => entry.disposition === "merged").length;
      const rescan = await fromPromise(deps.onTaskStoreChanged(agentId));
      if (!rescan.ok || !rescan.value.ok) {
        let errorKind: ErrorKind = "internal";
        if (rescan.ok) {
          const outcome = rescan.value;
          if (!outcome.ok) errorKind = outcome.error.errorKind;
        }
        deps.logger.warn({
          agentId,
          step: "task_due_rescan",
          errorKind,
          hint: "Inspect the due-task schedule; persisted candidates remain authoritative and will rearm at restart",
        }, "Task extraction could not rearm due-task scheduling");
      }
      deps.logger.info({
        agentId,
        candidateCount: candidates.length,
        createdCount,
        mergedCount,
        durationMs,
      }, "Task extraction candidates persisted");
      return ok({
        createdCount,
        mergedCount,
        taskIds: unique(admitted.value.flatMap((entry) => "taskId" in entry ? [entry.taskId] : [])),
      });
    },
    onOutcome: (outcome) => observeOutcome(deps, outcome),
  });
  const queue = createTaskExtractionQueue({
    timers: deps.timers,
    idFactory: () => allocateId(deps.idFactory, "task-item-"),
    getConfig: (agentId) => {
      const heartbeat = resolveEffectiveHeartbeatConfig(
        deps.config.scheduler.heartbeat,
        deps.config.agents[agentId]?.scheduler?.heartbeat,
      );
      return {
        debounceMs: deps.config.scheduler.tasks.debounceMs,
        batchMax: deps.config.scheduler.tasks.batchMax,
        heartbeatIntervalMs: heartbeat.intervalMs,
      };
    },
    onBatch: (agentId, items) => runner.submit(agentId, items),
    onBatchFailed: (agentId, error, items) => {
      deps.logger.warn({
        agentId,
        itemCount: items.length,
        step: "task_extraction_queue_transfer",
        errorCode: error.code,
        errorKind: error.errorKind,
        hint: "Inspect the active extraction registry; the volatile batch was dropped and is not replayed.",
      }, "Task extraction queue transfer failed");
      emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "scheduler:task_extraction_failed", {
        agentId,
        rootRunId: null,
        itemCount: items.length,
        sourceExecutionIds: unique(items.map((item) => item.sourceExecutionId)),
        stage: "queue_transfer",
        errorKind: error.errorKind,
        durationMs: 0,
        timestamp: deps.clock.now(),
      });
    },
  });

  const runnerActivated = runner.activate();
  if (!runnerActivated.ok) {
    return err({ code: "activation_failed", errorKind: "internal", message: "Task extraction runner activation failed" });
  }
  const queueActivated = queue.activate();
  if (!queueActivated.ok) {
    runner.close();
    return err({ code: "activation_failed", errorKind: "internal", message: "Task extraction queue activation failed" });
  }

  const taskExtractionPort: TaskExtractionPort = {
    enqueue(turn) {
      const agentId = turn.origin.turnScope.conversation.agentId;
      if (!deps.config.scheduler.tasks.enabled) {
        return err({ code: "not_accepting", errorKind: "precondition" });
      }
      if (deps.config.agents[agentId] === undefined) {
        return err({ code: "invalid_turn", errorKind: "validation" });
      }
      return queue.enqueue(turn);
    },
  };
  return ok({
    taskExtractionPort,
    closeAdmission: () => queue.close(),
    abortActive: () => runner.close(),
    waitForIdle: () => runner.waitForIdle(),
    status: () => ({ queue: queue.getStatus(), runner: runner.getStatus() }),
  });
}

function validateDependencies(
  deps: FollowupTaskExtractionRuntimeDeps,
): Result<void, FollowupTaskExtractionSetupError> {
  if (!deps.config.scheduler.tasks.enabled) {
    return err({ code: "feature_disabled", errorKind: "precondition", message: "Task extraction is not enabled" });
  }
  if (deps.boundedAutonomyHolder.current === undefined) {
    return err({ code: "root_services_unavailable", errorKind: "precondition", message: "Task extraction root services are unavailable" });
  }
  for (const agentId of Object.keys(deps.config.agents)) {
    if (!deps.taskStores.has(agentId)) {
      return err({ code: "store_unavailable", errorKind: "precondition", message: "A task authority store is unavailable" });
    }
    if (deps.workspaceDirs.get(agentId) === undefined) {
      return err({ code: "workspace_unavailable", errorKind: "precondition", message: "An agent workspace is unavailable" });
    }
    const executor = tryCatch(() => deps.getExecutor(agentId));
    if (!executor.ok || executor.value === undefined) {
      return err({ code: "executor_unavailable", errorKind: "precondition", message: "An agent executor is unavailable" });
    }
    const resolution = tryCatch(() => resolveTaskExtractionModel(deps.config, agentId));
    if (!resolution.ok || resolution.value.model.length === 0) {
      return err({ code: "model_unavailable", errorKind: "config", message: "A task extraction model is unavailable" });
    }
  }
  return ok(undefined);
}

function resolveTaskExtractionModel(
  config: AppConfig,
  agentId: string,
): Pick<OperationModelResolution, "model" | "source" | "timeoutMs" | "timeoutSource"> {
  const agent = config.agents[agentId];
  if (agent === undefined) {
    return {
      model: "",
      source: "agent_primary",
      timeoutMs: 0,
      timeoutSource: "builtin_default",
    };
  }
  return resolveOperationModel({
    operationType: "taskExtraction",
    agentProvider: agent.provider,
    agentModel: agent.model,
    operationModels: agent.operationModels,
    providerFamily: resolveProviderFamily(agent.provider),
    agentPromptTimeoutMs: agent.promptTimeout.promptTimeoutMs,
  });
}

function taskEnabled(config: AppConfig, agentId: string): boolean {
  return config.scheduler.tasks.enabled && config.agents[agentId] !== undefined;
}

function allocateId(idFactory: () => string, prefix: string): string {
  const allocated = tryCatch(idFactory);
  return allocated.ok ? `${prefix}${allocated.value}` : "";
}

function observeOutcome(
  deps: FollowupTaskExtractionRuntimeDeps,
  outcome: TaskExtractionRunnerOutcome,
): void {
  if (outcome.status === "dropped") {
    deps.logger.warn({
      agentId: outcome.agentId,
      rootRunId: outcome.rootRunId,
      itemCount: outcome.itemCount,
      stage: outcome.stage,
      releaseErrorKind: outcome.releaseErrorKind,
      errorKind: outcome.errorKind,
      hint: "Inspect the rooted extraction trajectory; the volatile batch is dropped and is not safe to replay.",
    }, "Task extraction batch dropped");
  } else if (outcome.releaseErrorKind !== undefined) {
    deps.logger.warn({
      agentId: outcome.agentId,
      rootRunId: outcome.rootRunId,
      itemCount: outcome.itemCount,
      releaseErrorKind: outcome.releaseErrorKind,
      errorKind: outcome.releaseErrorKind,
      hint: "Inspect bounded-autonomy root ownership; candidate persistence is already authoritative.",
    }, "Task extraction root release remained unsettled");
  }
  if (outcome.status === "persisted") {
    const { status: _status, ...evidence } = outcome;
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "scheduler:task_extraction_completed",
      { ...evidence, timestamp: deps.clock.now() },
    );
    return;
  }
  const { status: _status, ...evidence } = outcome;
  emitObservationalEventSafely(
    { eventBus: deps.eventBus, logger: deps.logger },
    "scheduler:task_extraction_failed",
    { ...evidence, timestamp: deps.clock.now() },
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
