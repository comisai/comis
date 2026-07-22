// SPDX-License-Identifier: Apache-2.0
/** Governed execution of one coordinator-claimed agent heartbeat turn. */
import {
  classifyAgentTurnExecutionOutcome,
  createResolvedRequestContext,
  formatSessionKey,
  runWithContext,
  type AgentExecutionAbortReason,
  type ClockPort,
  type ComisLogger,
  type ErrorKind,
  type EventMap,
  type HeartbeatConfig,
  type ModelResolutionSource,
  type PerAgentConfig,
  type PerAgentHeartbeatConfig,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import {
  sanitizeAssistantResponse,
  type AgentExecutor,
  type OperationModelResolution,
} from "@comis/agent";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
import {
  buildHeartbeatPrompt,
  processHeartbeatResponse,
  resolveEffectiveHeartbeatConfig,
  type HeartbeatCoordinatorAgentRunInput,
  type HeartbeatDeliveryOutcome,
  type HeartbeatMemoryStats,
  type HeartbeatTickError,
  type HeartbeatTickOutcome,
} from "@comis/scheduler";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type { HeartbeatSettledDeliveryRequest } from "./heartbeat-settled-delivery.js";

type HeartbeatModelResolution = Pick<
  OperationModelResolution,
  "model" | "source" | "timeoutMs" | "timeoutSource" | "cacheRetention"
>;

interface SessionMaintenanceError {
  readonly errorKind: ErrorKind;
}

export interface HeartbeatAgentTurnExecutorDeps {
  tenantId: string;
  agents: Record<string, PerAgentConfig>;
  globalHeartbeatConfig: HeartbeatConfig;
  clock: ClockPort;
  eventBus: Pick<TypedEventBus, "on" | "off">;
  getExecutor(agentId: string): AgentExecutor | undefined;
  assembleTools(
    agentId: string,
    sessionKey: SessionKey,
    heartbeatPolicy: PerAgentHeartbeatConfig | undefined,
  ): Promise<AgentTool[]>;
  resolveModel(agentId: string, config: PerAgentConfig): HeartbeatModelResolution;
  getMemoryStats(agentId: string, tenantId: string): HeartbeatMemoryStats | undefined;
  deliver(request: HeartbeatSettledDeliveryRequest): Promise<HeartbeatDeliveryOutcome>;
  pruneAcknowledgedTurn(
    agentId: string,
    sessionKey: SessionKey,
  ): Promise<Result<void, SessionMaintenanceError>>;
  idFactory(): string;
  logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
}

/** Create the daemon boundary that turns one claimed heartbeat into a settled outcome. */
export function createHeartbeatAgentTurnExecutor(deps: HeartbeatAgentTurnExecutorDeps) {
  return async function executeHeartbeatAgentTurn(
    input: HeartbeatCoordinatorAgentRunInput,
  ): Promise<Result<HeartbeatTickOutcome, HeartbeatTickError>> {
    if (input.lane === "task" || input.reason === "task") {
      return err({ code: "not_bound", errorKind: "precondition" });
    }
    const agentId = input.target.agentId;
    const agentConfig = deps.agents[agentId];
    const executor = deps.getExecutor(agentId);
    if (agentConfig === undefined || executor === undefined) {
      return err({ code: "not_bound", errorKind: "precondition" });
    }

    const identity = resolveInternalTurnIdentity({
      tenantId: deps.tenantId,
      agentId,
      originKind: "scheduler",
      instanceId: "heartbeat",
      conversationId: agentId,
      principalId: `scheduler-heartbeat-${agentId}`,
    });
    if (!identity.ok) return err({ code: "invalid_target", errorKind: "validation" });
    const sessionKey = identity.value.displaySessionKey;
    const context = createResolvedRequestContext({
      tenantId: deps.tenantId,
      userId: sessionKey.userId,
      sessionKey,
      agentId,
      rootRunId: input.rootRunId,
      traceId: input.correlationId,
      startedAt: deps.clock.now(),
      trustLevel: "user",
      learningEligible: false,
      channelType: "scheduler",
      turnScope: identity.value.turnScope,
    });
    if (!context.ok) return err({ code: "invalid_input", errorKind: "validation" });

    return runWithContext(context.value, async () => {
      const config = resolveEffectiveHeartbeatConfig(
        deps.globalHeartbeatConfig,
        agentConfig.scheduler?.heartbeat,
      );
      const resolution = deps.resolveModel(agentId, agentConfig);
      const assembled = await fromPromise(deps.assembleTools(
        agentId,
        sessionKey,
        agentConfig.scheduler?.heartbeat,
      ));
      if (!assembled.ok) {
        deps.logger.error({
          agentId,
          correlationId: input.correlationId,
          step: "heartbeat_tool_assembly",
          errorKind: "internal" as const,
          hint: "Inspect heartbeat tool assembly before retrying the released event batch",
        }, "Heartbeat tool assembly rejected");
        return err({ code: "precondition_failed", errorKind: "precondition" });
      }

      const startedAt = deps.clock.now();
      const agentExecutionId = deps.idFactory();
      const prompt = buildHeartbeatPrompt(
        input.reason,
        input.eventBatch,
        config,
        deps.getMemoryStats(agentId, deps.tenantId),
        startedAt,
      );
      const message = {
        id: agentExecutionId,
        channelId: sessionKey.channelId,
        channelType: "scheduler",
        senderId: sessionKey.userId,
        text: prompt,
        timestamp: startedAt,
        attachments: [],
        metadata: {
          trigger: "heartbeat",
          isScheduled: true,
          triggerKind: input.reason,
          correlationId: input.correlationId,
          lightContext: config.lightContext ?? false,
        },
      };

      let abortReason: AgentExecutionAbortReason | undefined;
      const formattedSessionKey = formatSessionKey(sessionKey);
      const onAborted = (event: EventMap["execution:aborted"]): void => {
        if (event.agentId === agentId && formatSessionKey(event.sessionKey) === formattedSessionKey) {
          abortReason = event.reason;
        }
      };
      deps.eventBus.on("execution:aborted", onAborted as never);
      const executed = input.signal.aborted
        ? undefined
        : await fromPromise(executor.execute(
            message,
            sessionKey,
            assembled.value,
            undefined,
            agentId,
            undefined,
            undefined,
            {
              operationType: "heartbeat",
              signal: input.signal,
              model: resolution.model,
              cacheRetention: resolution.cacheRetention,
              promptTimeout: {
                promptTimeoutMs: resolution.timeoutMs,
                retryPromptTimeoutMs: resolution.timeoutMs,
                source: resolution.timeoutSource,
              },
            },
          ));
      deps.eventBus.off("execution:aborted", onAborted as never);
      const durationMs = Math.max(0, deps.clock.now() - startedAt);
      const eventBatch = input.eventBatch.length === 0
        ? { status: "none" as const }
        : { status: "consumed" as const, entryCount: input.eventBatch.length };

      if (executed === undefined) {
        return settle({
          input,
          agentExecutionId,
          resolution,
          execution: classifyAgentTurnExecutionOutcome({
            finishReason: "prompt_timeout",
            abortReason: "pipeline_timeout",
          }),
          metrics: emptyMetrics(),
          delivery: { status: "not_requested" },
          sessionMaintenance: { status: "not_required" },
          eventBatch,
          durationMs,
        });
      }
      if (!executed.ok) {
        deps.logger.error({
          agentId,
          correlationId: input.correlationId,
          agentExecutionId,
          durationMs,
          step: "heartbeat_agent_execute",
          errorKind: "internal" as const,
          hint: "Inspect the rooted heartbeat trajectory; the claimed event batch remains consumed",
        }, "Heartbeat agent execution did not return terminal evidence");
        return settle({
          input,
          agentExecutionId,
          resolution,
          execution: { status: "unknown", errorKind: "internal" },
          metrics: emptyMetrics(),
          delivery: { status: "not_requested" },
          sessionMaintenance: { status: "not_required" },
          eventBatch,
          durationMs,
        });
      }

      const execution = classifyAgentTurnExecutionOutcome({
        finishReason: executed.value.finishReason,
        abortReason: abortReason ?? (input.signal.aborted ? "pipeline_timeout" : undefined),
      });
      const metrics = {
        totalTokens: executed.value.tokensUsed.total,
        costUsd: executed.value.cost.total,
        toolCalls: executed.value.stepsExecuted,
        llmCalls: executed.value.llmCalls,
      };
      if (execution.status !== "completed") {
        return settle({
          input,
          agentExecutionId,
          resolution,
          execution,
          metrics,
          delivery: { status: "not_requested" },
          sessionMaintenance: { status: "not_required" },
          eventBatch,
          durationMs,
        });
      }

      const sanitized = sanitizeAssistantResponse(executed.value.response);
      const response = processHeartbeatResponse({
        responseText: sanitized,
        responsePrefix: config.responsePrefix,
        ackMaxChars: config.ackMaxChars ?? 300,
        hasMedia: /^MEDIA:/mu.test(sanitized),
      });
      let sessionMaintenance: Extract<HeartbeatTickOutcome, { status: "settled" }>["sessionMaintenance"] = {
        status: "not_required",
      };
      if (response.kind === "acknowledged_ok") {
        const pruned = await fromPromise(deps.pruneAcknowledgedTurn(agentId, sessionKey));
        if (!pruned.ok) {
          sessionMaintenance = { status: "failed", errorKind: "internal" };
        } else if (!pruned.value.ok) {
          sessionMaintenance = { status: "failed", errorKind: pruned.value.error.errorKind };
        } else {
          sessionMaintenance = { status: "completed" };
        }
      }

      let delivery: HeartbeatDeliveryOutcome;
      if (response.kind === "empty") {
        delivery = { status: "suppressed", reason: "empty_reply" };
      } else if (response.kind === "acknowledged_ok" && !config.showOk) {
        delivery = { status: "suppressed", reason: "visibility_policy" };
      } else if (response.kind === "alert" && response.level === "alert" && !config.showAlerts) {
        delivery = { status: "suppressed", reason: "visibility_policy" };
      } else if (config.target === undefined) {
        delivery = { status: "not_requested" };
      } else {
        const delivered = await fromPromise(deps.deliver({
          correlationId: input.correlationId,
          agentId,
          endpoint: config.target,
          text: response.text,
          level: response.kind === "acknowledged_ok" ? "ok" : response.level,
          allowDm: config.allowDm,
          signal: input.signal,
        }));
        delivery = delivered.ok ? delivered.value : unknownDelivery(deps.clock.now());
      }

      return settle({
        input,
        agentExecutionId,
        resolution,
        execution,
        metrics,
        delivery,
        sessionMaintenance,
        eventBatch,
        durationMs,
      });
    });
  };

  function settle(input: {
    input: HeartbeatCoordinatorAgentRunInput;
    agentExecutionId: string;
    resolution: HeartbeatModelResolution;
    execution: Extract<HeartbeatTickOutcome, { status: "settled" }>["execution"];
    metrics: Extract<HeartbeatTickOutcome, { status: "settled" }>["metrics"];
    delivery: HeartbeatDeliveryOutcome;
    sessionMaintenance: Extract<HeartbeatTickOutcome, { status: "settled" }>["sessionMaintenance"];
    eventBatch: Extract<HeartbeatTickOutcome, { status: "settled" }>["eventBatch"];
    durationMs: number;
  }): Result<HeartbeatTickOutcome, HeartbeatTickError> {
    deps.logger.info({
      agentId: input.input.target.agentId,
      correlationId: input.input.correlationId,
      agentExecutionId: input.agentExecutionId,
      durationMs: input.durationMs,
      executionStatus: input.execution.status,
      deliveryStatus: input.delivery.status,
    }, "Heartbeat agent turn execution complete");
    return ok({
      status: "settled",
      trigger: input.input.reason,
      rootRunId: input.input.rootRunId,
      agentExecutionId: input.agentExecutionId,
      execution: input.execution,
      modelResolved: input.resolution.model,
      modelResolutionSource: input.resolution.source as ModelResolutionSource,
      metrics: input.metrics,
      delivery: input.delivery,
      durationMs: input.durationMs,
      sessionMaintenance: input.sessionMaintenance,
      eventBatch: input.eventBatch,
    });
  }
}

function emptyMetrics(): Extract<HeartbeatTickOutcome, { status: "settled" }>["metrics"] {
  return { totalTokens: 0, costUsd: 0, toolCalls: 0, llmCalls: 0 };
}

function unknownDelivery(settledAtMs: number): HeartbeatDeliveryOutcome {
  return {
    status: "unknown",
    errorKind: "dependency",
    deliveredChunks: 0,
    failedChunks: 1,
    ambiguousChunks: 1,
    settledAtMs,
  };
}
