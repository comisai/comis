// SPDX-License-Identifier: Apache-2.0
/** Model resolution, usage accounting, and cancellation for cron memory actions. */
import {
  tryGetContext,
  type ClockPort,
  type ComisLogger,
  type ErrorKind,
  type ModelOperationType,
  type OperationModels,
  type TypedEventBus,
} from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  type BoundedAutonomyBudgetHolder,
  type OperationModelResolution,
} from "@comis/agent";
import type {
  CronInternalActionName,
  CronRuntimeError,
  CronRuntimeExecutionInput,
  InternalActionExecution,
  SchedulerDiagnosticCounter,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";
import type {
  CronInternalActionMetrics,
  CronInternalActionResolution,
} from "./cron-internal-action-executor.js";

type InternalActionInput = Extract<CronRuntimeExecutionInput, { kind: "internal_action" }>;

interface CronMemoryAgentConfig {
  provider?: string;
  model?: string;
  operationModels?: OperationModels;
  memoryReview?: { enabled?: boolean };
  memoryLifecycle?: { enabled?: boolean };
  learning?: { enabled?: boolean };
}

export interface CronActionServiceError {
  errorKind: ErrorKind;
  message: string;
}

export interface CronActionModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  durationMs?: number;
}

export interface CronModelActionRequest {
  input: InternalActionInput;
  signal: AbortSignal;
  resolution: OperationModelResolution;
  onUsage(usage: CronActionModelUsage): void;
}

export interface CronKeylessActionRequest {
  input: InternalActionInput;
  signal: AbortSignal;
}

export type CronActionServiceReport =
  | { status: "completed"; counters: readonly SchedulerDiagnosticCounter[] }
  | { status: "failed"; errorKind: ErrorKind; counters: readonly SchedulerDiagnosticCounter[] };

type ActionCountersResult = Result<CronActionServiceReport, CronActionServiceError>;

export interface CronMemoryActionServicesDeps {
  agents: Record<string, CronMemoryAgentConfig>;
  clock: ClockPort;
  boundedAutonomyHolder: BoundedAutonomyBudgetHolder;
  executeMemoryReview(request: CronModelActionRequest): Promise<ActionCountersResult>;
  executeMemoryLifecycle(request: CronKeylessActionRequest): Promise<ActionCountersResult>;
  executeReflection(request: CronModelActionRequest): Promise<ActionCountersResult>;
  eventBus: Pick<TypedEventBus, "emit">;
  logger: ComisLogger;
}

export interface CronMemoryActionServices {
  resolveAction(
    action: CronInternalActionName,
    agentId: string,
  ): Result<CronInternalActionResolution, CronRuntimeError>;
  executeMemoryReview(input: InternalActionInput, signal: AbortSignal): Promise<Result<InternalActionExecution, CronRuntimeError>>;
  executeMemoryLifecycle(input: InternalActionInput, signal: AbortSignal): Promise<Result<InternalActionExecution, CronRuntimeError>>;
  executeReflection(input: InternalActionInput, signal: AbortSignal): Promise<Result<InternalActionExecution, CronRuntimeError>>;
  readMetrics(action: CronInternalActionName, rootRunId: string): CronInternalActionMetrics;
}

export function createCronMemoryActionServices(
  deps: CronMemoryActionServicesDeps,
): CronMemoryActionServices {
  const metricsByActionRoot = new Map<string, CronInternalActionMetrics>();

  const resolveAction = (
    action: CronInternalActionName,
    agentId: string,
  ): Result<CronInternalActionResolution, CronRuntimeError> => {
    const config = deps.agents[agentId];
    if (config === undefined) {
      return err(runtimeError(
        "precondition_failed",
        "config",
        "Cron internal action agent configuration is unavailable",
      ));
    }
    if (action === "memory_lifecycle") {
      return ok({
        enabled: config.memoryLifecycle?.enabled === true,
        modelResolved: null,
        modelResolutionSource: null,
      });
    }
    const operationType: ModelOperationType = action === "memory_review"
      ? "cron"
      : "skillSynthesis";
    const resolution = resolveOperationModel({
      operationType,
      agentProvider: config.provider ?? "anthropic",
      agentModel: config.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: config.operationModels ?? {},
      providerFamily: resolveProviderFamily(config.provider ?? "anthropic"),
    });
    return ok({
      enabled: action === "memory_review"
        ? config.memoryReview?.enabled === true
        : config.learning?.enabled === true,
      modelResolved: resolution.model,
      modelResolutionSource: resolution.source,
    });
  };

  return {
    resolveAction,
    executeMemoryReview(input, signal) {
      return executeModelAction("memory_review", input, signal, deps.executeMemoryReview);
    },
    executeMemoryLifecycle,
    executeReflection(input, signal) {
      return executeModelAction("reflection", input, signal, deps.executeReflection);
    },
    readMetrics(action, rootRunId) {
      return metricsByActionRoot.get(metricKey(action, rootRunId)) ?? emptyMetrics(action);
    },
  };

  async function executeMemoryLifecycle(
    input: InternalActionInput,
    signal: AbortSignal,
  ): Promise<Result<InternalActionExecution, CronRuntimeError>> {
    const state = resolveAction("memory_lifecycle", input.job.agentId);
    if (!state.ok) return state;
    metricsByActionRoot.set(metricKey("memory_lifecycle", input.rootRunId), emptyMetrics("memory_lifecycle"));
    if (!state.value.enabled) {
      return ok({ status: "skipped", reason: "configuration_disabled", counters: [] });
    }
    if (signal.aborted) {
      return ok({ status: "aborted", abortReason: "pipeline_timeout", counters: [] });
    }
    const result = await deps.executeMemoryLifecycle({ input, signal });
    if (!result.ok) {
      return ok({ status: "failed", errorKind: result.error.errorKind, counters: [] });
    }
    return executionFromReport(result.value);
  }

  async function executeModelAction(
    action: "memory_review" | "reflection",
    input: InternalActionInput,
    schedulerSignal: AbortSignal,
    execute: (request: CronModelActionRequest) => Promise<ActionCountersResult>,
  ): Promise<Result<InternalActionExecution, CronRuntimeError>> {
    const state = resolveAction(action, input.job.agentId);
    if (!state.ok) return state;
    if (!state.value.enabled) {
      return ok({ status: "skipped", reason: "configuration_disabled", counters: [] });
    }
    const config = deps.agents[input.job.agentId];
    if (config === undefined) return err(runtimeError("precondition_failed", "config", "Cron action configuration disappeared"));
    const operationType: ModelOperationType = action === "memory_review" ? "cron" : "skillSynthesis";
    const resolution = resolveOperationModel({
      operationType,
      agentProvider: config.provider ?? "anthropic",
      agentModel: config.model ?? "anthropic:claude-sonnet-4-20250514",
      operationModels: config.operationModels ?? {},
      providerFamily: resolveProviderFamily(config.provider ?? "anthropic"),
    });
    const key = metricKey(action, input.rootRunId);
    metricsByActionRoot.set(key, emptyMetrics(action));
    const controller = new AbortController();
    const abortFromScheduler = (): void => controller.abort(schedulerSignal.reason);
    if (schedulerSignal.aborted) controller.abort(schedulerSignal.reason);
    else schedulerSignal.addEventListener("abort", abortFromScheduler, { once: true });
    let budgetExceeded = false;
    const onUsage = (usage: CronActionModelUsage): void => {
      const previous = metricsByActionRoot.get(key) ?? emptyMetrics(action);
      const totalTokens = usage.inputTokens + usage.outputTokens;
      metricsByActionRoot.set(key, {
        totalTokens: (previous.totalTokens ?? 0) + totalTokens,
        costUsd: (previous.costUsd ?? 0) + usage.cost.total,
        llmCalls: previous.llmCalls + 1,
      });
      emitUsage(input, action, resolution, usage, totalTokens);
      const budget = deps.boundedAutonomyHolder.current?.reserveBudget(
        input.rootRunId,
        resolution.provider,
        resolution.modelId,
        usage.cost.total,
        totalTokens,
      );
      if (budget?.kind === "exceeded") {
        budgetExceeded = true;
        controller.abort();
      }
    };

    try {
      const result = await execute({ input, signal: controller.signal, resolution, onUsage });
      if (budgetExceeded) {
        return ok({ status: "aborted", abortReason: "budget_exceeded", counters: [] });
      }
      if (schedulerSignal.aborted) {
        return ok({ status: "aborted", abortReason: "pipeline_timeout", counters: [] });
      }
      if (!result.ok) {
        return ok({ status: "failed", errorKind: result.error.errorKind, counters: [] });
      }
      return executionFromReport(result.value);
    } finally {
      schedulerSignal.removeEventListener("abort", abortFromScheduler);
    }
  }

  function emitUsage(
    input: InternalActionInput,
    action: "memory_review" | "reflection",
    resolution: OperationModelResolution,
    usage: CronActionModelUsage,
    totalTokens: number,
  ): void {
    const context = tryGetContext();
    deps.eventBus.emit("observability:token_usage", {
      timestamp: deps.clock.now(),
      traceId: context?.traceId ?? input.executionId,
      agentId: input.job.agentId,
      channelId: `cron-${action}`,
      executionId: input.executionId,
      provider: resolution.provider,
      model: resolution.modelId,
      tokens: { prompt: usage.inputTokens, completion: usage.outputTokens, total: totalTokens },
      cost: usage.cost,
      latencyMs: usage.durationMs ?? 0,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      sessionKey: context?.sessionKey ?? `cron-job-${input.job.id}`,
      savedVsUncached: 0,
      cacheEligible: false,
      warmupTurn: false,
      pendingCacheInvestmentUsd: 0,
    });
  }
}

function executionFromReport(report: CronActionServiceReport): Result<InternalActionExecution, CronRuntimeError> {
  switch (report.status) {
    case "completed":
      return ok({ status: "completed", counters: [...report.counters] });
    case "failed":
      return ok({ status: "failed", errorKind: report.errorKind, counters: [...report.counters] });
    default: {
      const _exhaustive: never = report;
      return _exhaustive;
    }
  }
}

function metricKey(action: CronInternalActionName, rootRunId: string): string {
  return `${action}:${rootRunId}`;
}

function emptyMetrics(action: CronInternalActionName): CronInternalActionMetrics {
  return action === "memory_lifecycle"
    ? { totalTokens: null, costUsd: null, llmCalls: 0 }
    : { totalTokens: 0, costUsd: 0, llmCalls: 0 };
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: CronRuntimeError["errorKind"],
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
