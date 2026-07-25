// SPDX-License-Identifier: Apache-2.0
/** Awaited daemon dispatcher for config-owned cron internal actions. */
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  runWithContext,
  type ClockPort,
  type ComisLogger,
  type ModelResolutionSource,
} from "@comis/core";
import {
  CronRuntimeOutcomeSchema,
  type CronInternalActionName,
  type CronRuntimeError,
  type CronRuntimeExecutionInput,
  type CronRuntimeOutcome,
  type InternalActionExecution,
} from "@comis/scheduler";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { resolveCronTurnIdentity } from "./cron-root-registrar.js";

type InternalActionInput = Extract<CronRuntimeExecutionInput, { kind: "internal_action" }>;

export interface CronInternalActionResolution {
  enabled: boolean;
  modelResolved: string | null;
  modelResolutionSource: ModelResolutionSource | null;
}

export interface CronInternalActionMetrics {
  totalTokens: number | null;
  costUsd: number | null;
  llmCalls: number;
}

type InternalActionService = (
  input: InternalActionInput,
  signal: AbortSignal,
) => Promise<Result<InternalActionExecution, CronRuntimeError>>;

export interface CronInternalActionExecutorDeps {
  tenantId: string;
  clock: ClockPort;
  idFactory: () => string;
  resolveAction: (
    action: CronInternalActionName,
    agentId: string,
  ) => Result<CronInternalActionResolution, CronRuntimeError>;
  executeMemoryReview: InternalActionService;
  executeMemoryLifecycle: InternalActionService;
  executeReflection: InternalActionService;
  /** Pure snapshot of usage already attributed to this occurrence root. */
  readMetrics: (
    action: CronInternalActionName,
    rootRunId: string,
  ) => CronInternalActionMetrics;
  logger: ComisLogger;
}

export type CronInternalActionExecutor = (
  input: InternalActionInput,
  signal: AbortSignal,
) => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;

export function createCronInternalActionExecutor(
  deps: CronInternalActionExecutorDeps,
): CronInternalActionExecutor {
  return async (input, signal) => {
    const resolved = deps.resolveAction(input.job.payload.action, input.job.agentId);
    if (!resolved.ok) return resolved;
    const action = input.job.payload.action;
    const model = resolved.value;
    if (!resolved.value.enabled) {
      return validateOutcome({
        kind: "internal_action",
        action,
        rootRunId: input.rootRunId,
        modelResolved: model.modelResolved,
        modelResolutionSource: model.modelResolutionSource,
        metrics: emptyMetrics(action),
        execution: { status: "skipped", reason: "configuration_disabled", counters: [] },
      });
    }
    if (signal.aborted) {
      return validateOutcome({
        kind: "internal_action",
        action,
        rootRunId: input.rootRunId,
        modelResolved: model.modelResolved,
        modelResolutionSource: model.modelResolutionSource,
        metrics: emptyMetrics(action),
        execution: {
          status: "aborted",
          abortReason: "pipeline_timeout",
          counters: [],
        },
      });
    }

    const context = buildContext(deps, input);
    if (!context.ok) return context;
    const startedAtMs = deps.clock.now();
    const invoked = await fromPromise(runWithContext(
      context.value,
      () => invokeAction(action, input, signal),
    ));
    const metrics = deps.readMetrics(action, input.rootRunId);
    if (!invoked.ok) {
      deps.logger.error({
        executionId: input.executionId,
        jobId: input.job.id,
        agentId: input.job.agentId,
        action,
        step: "internal_action",
        durationMs: deps.clock.now() - startedAtMs,
        errorKind: "internal" as const,
        hint: "Inspect the owning internal-action service; preserve the immutable cron terminal before considering replay",
      }, "Cron internal action rejected without settlement evidence");
      return validateOutcome({
        kind: "internal_action",
        action,
        rootRunId: input.rootRunId,
        modelResolved: model.modelResolved,
        modelResolutionSource: model.modelResolutionSource,
        metrics,
        execution: { status: "unknown", errorKind: "internal", counters: [] },
      });
    }
    // Service Result errors are permitted only before that service starts an
    // irreversible action. Once work begins, the service must return a closed
    // failed/aborted/unknown execution value with its counters.
    if (!invoked.value.ok) return invoked.value;

    const outcome = {
      kind: "internal_action" as const,
      action,
      rootRunId: input.rootRunId,
      modelResolved: model.modelResolved,
      modelResolutionSource: model.modelResolutionSource,
      metrics,
      execution: invoked.value.value,
    };
    const validated = validateOutcome(outcome);
    if (validated.ok) {
      deps.logger.info({
        executionId: input.executionId,
        jobId: input.job.id,
        agentId: input.job.agentId,
        action,
        status: invoked.value.value.status,
        durationMs: deps.clock.now() - startedAtMs,
      }, "Cron internal action settled");
    }
    return validated;
  };

  function invokeAction(
    action: CronInternalActionName,
    input: InternalActionInput,
    signal: AbortSignal,
  ): Promise<Result<InternalActionExecution, CronRuntimeError>> {
    switch (action) {
      case "memory_review": return deps.executeMemoryReview(input, signal);
      case "memory_lifecycle": return deps.executeMemoryLifecycle(input, signal);
      case "reflection": return deps.executeReflection(input, signal);
      default: {
        const _exhaustive: never = action;
        return Promise.resolve(err(runtimeError("invalid_input", "validation", `Unsupported internal action: ${String(_exhaustive)}`)));
      }
    }
  }
}

function buildContext(
  deps: CronInternalActionExecutorDeps,
  input: InternalActionInput,
) {
  const identity = resolveCronTurnIdentity(deps.tenantId, input.job);
  if (!identity.ok) {
    return err(runtimeError("invalid_input", "validation", "Cron internal action identity failed validation"));
  }
  const traceId = tryCatch(() => deps.idFactory());
  if (!traceId.ok) {
    return err(runtimeError("precondition_failed", "internal", "Cron internal action trace allocation failed"));
  }
  const endpoint = identity.value.turnScope.endpoint;
  const origin = tryCatch(() => createDeliveryOrigin({
    tenantId: deps.tenantId,
    userId: identity.value.turnScope.principal.principalId,
    channelType: endpoint.channelType,
    channelId: endpoint.conversationId,
  }));
  if (!origin.ok) {
    return err(runtimeError("invalid_input", "validation", "Cron internal action delivery origin failed validation"));
  }
  const context = createResolvedRequestContext({
    tenantId: deps.tenantId,
    userId: identity.value.turnScope.principal.principalId,
    sessionKey: identity.value.displaySessionKey,
    agentId: input.job.agentId,
    rootRunId: input.rootRunId,
    traceId: traceId.value,
    startedAt: deps.clock.now(),
    trustLevel: "user",
    learningEligible: false,
    channelType: endpoint.channelType,
    deliveryOrigin: origin.value,
    turnScope: identity.value.turnScope,
  });
  return context.ok
    ? context
    : err(runtimeError("invalid_input", "validation", "Cron internal action request context failed validation"));
}

function emptyMetrics(action: CronInternalActionName): CronInternalActionMetrics {
  return action === "memory_lifecycle"
    ? { totalTokens: null, costUsd: null, llmCalls: 0 }
    : { totalTokens: 0, costUsd: 0, llmCalls: 0 };
}

function validateOutcome(
  value: CronRuntimeOutcome,
): Result<CronRuntimeOutcome, CronRuntimeError> {
  const parsed = CronRuntimeOutcomeSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(runtimeError("dispatch_rejected", "validation", "Cron internal action produced invalid terminal evidence"));
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: CronRuntimeError["errorKind"],
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
