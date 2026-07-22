// SPDX-License-Identifier: Apache-2.0
/** Governed daemon execution of one claimed cron agent turn. */
import {
  classifyAgentTurnExecutionOutcome,
  createResolvedRequestContext,
  formatSessionKey,
  runWithContext,
  wrapExternalContent,
  type AgentExecutionAbortReason,
  type ClockPort,
  type ComisLogger,
  type ErrorKind,
  type EventMap,
  type PerAgentConfig,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  sanitizeAssistantResponse,
  type AgentExecutor,
} from "@comis/agent";
import { filterResponse } from "@comis/channels";
import { applyToolPolicy } from "@comis/skills";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  CronContinuationOutcome,
  CronDeliveryOutcome,
  CronRuntimeError,
  CronRuntimeExecutionInput,
  CronRuntimeOutcome,
} from "@comis/scheduler";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { createCronExecutionFence } from "./cron-execution-fence.js";
import { resolveCronTurnIdentity } from "./cron-root-registrar.js";

type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;
type AgentTurnJob = AgentTurnInput["job"];

interface SessionPolicyRequest {
  input: AgentTurnInput;
  sessionKey: SessionKey;
  signal: AbortSignal;
}

interface SessionPolicyPort {
  before(request: SessionPolicyRequest): Promise<Result<void, CronRuntimeError>>;
  after(request: SessionPolicyRequest): Promise<Result<void, CronRuntimeError>>;
}

export type CronWakeGateExecution =
  | { status: "woke"; durationMs: number; toolCalls: number; context?: string }
  | { status: "failed_open"; durationMs: number; toolCalls: number; errorKind: ErrorKind }
  | { status: "skip"; durationMs: number; toolCalls: number; deliver?: string }
  | { status: "unavailable"; reason: "wake_gate_disabled" | "wake_gate_unbound" };

interface CronDeliveryRequest {
  input: AgentTurnInput;
  text: string;
  target: NonNullable<AgentTurnJob["deliveryTarget"]>;
  signal: AbortSignal;
}

interface CronContinuationRequest {
  input: AgentTurnInput;
  sourceExecutionId: string;
  visibleText: string;
  delivery: CronDeliveryOutcome;
  signal: AbortSignal;
}

interface MetricSnapshot {
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  llmCalls: number;
}

export interface CronAgentTurnExecutorDeps {
  tenantId: string;
  agents: Record<string, PerAgentConfig>;
  clock: ClockPort;
  eventBus: Pick<TypedEventBus, "on" | "off">;
  getExecutor(agentId: string): AgentExecutor | undefined;
  assembleTools(agentId: string, sessionKey: SessionKey): Promise<AgentTool[]>;
  sessionPolicy: SessionPolicyPort;
  resolveWakeGateCapability(agentId: string): "enabled" | "disabled" | "unbound";
  runWakeGate(
    input: AgentTurnInput,
    sessionKey: SessionKey,
    signal: AbortSignal,
  ): Promise<CronWakeGateExecution>;
  deliverText(request: CronDeliveryRequest): Promise<CronDeliveryOutcome>;
  continueTurn(request: CronContinuationRequest): Promise<CronContinuationOutcome>;
  readMetrics(agentId: string, sessionKey: SessionKey): MetricSnapshot;
  idFactory(): string;
  logger: ComisLogger;
}

export function createCronAgentTurnExecutor(deps: CronAgentTurnExecutorDeps) {
  return async function executeCronAgentTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): Promise<Result<CronRuntimeOutcome, CronRuntimeError>> {
    const agentConfig = deps.agents[input.job.agentId];
    const executor = deps.getExecutor(input.job.agentId);
    if (agentConfig === undefined || executor === undefined) {
      return err(runtimeError(
        "precondition_failed",
        "config",
        "Cron agent or executor is not bound",
      ));
    }
    const identity = resolveCronTurnIdentity(deps.tenantId, input.job);
    if (!identity.ok) {
      return err(runtimeError("invalid_input", "validation", identity.error.message));
    }
    const sessionKey = identity.value.displaySessionKey;
    const context = createResolvedRequestContext({
      tenantId: deps.tenantId,
      userId: sessionKey.userId,
      sessionKey,
      agentId: input.job.agentId,
      rootRunId: input.rootRunId,
      traceId: input.executionId,
      startedAt: deps.clock.now(),
      trustLevel: "user",
      learningEligible: false,
      channelType: "scheduler",
      turnScope: identity.value.turnScope,
    });
    if (!context.ok) {
      return err(runtimeError("invalid_input", "validation", context.error.message));
    }

    return runWithContext(context.value, async () => {
      const gate = await resolveWakeGate(input, sessionKey, signal);
      if (!gate.ok || gate.value.terminal !== undefined) {
        return gate.ok ? ok(gate.value.terminal!) : gate;
      }

      const resolution = resolveOperationModel({
        operationType: "cron",
        agentProvider: agentConfig.provider,
        agentModel: agentConfig.model,
        operationModels: agentConfig.operationModels,
        providerFamily: resolveProviderFamily(agentConfig.provider),
        ...(input.job.payload.model === undefined
          ? {}
          : { invocationOverride: input.job.payload.model }),
        agentPromptTimeoutMs: agentConfig.promptTimeout.promptTimeoutMs,
      });
      if (signal.aborted) {
        const agentExecutionId = deps.idFactory();
        deps.logger.info({
          executionId: input.executionId,
          agentExecutionId,
          jobId: input.job.id,
          agentId: input.job.agentId,
          durationMs: 0,
          executionStatus: "aborted",
          deliveryStatus: "not_requested",
        }, "Cron agent turn execution complete");
        return ok(agentOutcome({
          input,
          sessionKey,
          agentExecutionId,
          execution: classifyAgentTurnExecutionOutcome({
            finishReason: "prompt_timeout",
            abortReason: "pipeline_timeout",
          }),
          resolution,
          metrics: emptyMetrics(),
          wakeGate: gate.value.wakeGate,
          delivery: { status: "not_requested" },
          continuation: skippedContinuation(input.job.continuationMode, "execution_not_completed"),
        }));
      }
      const assembled = await fromPromise(deps.assembleTools(input.job.agentId, sessionKey));
      if (!assembled.ok) {
        deps.logger.error({
          executionId: input.executionId,
          jobId: input.job.id,
          agentId: input.job.agentId,
          step: "tool_assembly",
          errorKind: "internal" as const,
          hint: "Inspect cron agent tool assembly before retrying this occurrence",
        }, "Cron agent tool assembly rejected");
        return err(runtimeError("precondition_failed", "internal", "Cron agent tool assembly rejected"));
      }
      const tools = intersectToolPolicies(assembled.value, agentConfig, input.job);
      const policyRequest = { input, sessionKey, signal };
      const prepared = await deps.sessionPolicy.before(policyRequest);
      if (!prepared.ok) return prepared;
      if (signal.aborted) {
        return ok(agentOutcome({
          input,
          sessionKey,
          agentExecutionId: deps.idFactory(),
          execution: classifyAgentTurnExecutionOutcome({
            finishReason: "prompt_timeout",
            abortReason: "pipeline_timeout",
          }),
          resolution,
          metrics: emptyMetrics(),
          wakeGate: gate.value.wakeGate,
          delivery: { status: "not_requested" },
          continuation: skippedContinuation(input.job.continuationMode, "execution_not_completed"),
        }));
      }

      const effectiveTimeoutMs = Math.min(
        resolution.timeoutMs,
        input.job.payload.timeoutSeconds === undefined
          ? resolution.timeoutMs
          : input.job.payload.timeoutSeconds * 1_000,
      );
      const cacheRetention = strictestRetention(
        resolution.cacheRetention ?? agentConfig.cacheRetention,
        agentConfig.cacheRetention,
        input.job.cacheRetention,
      );
      const messageId = deps.idFactory();
      const startedAt = deps.clock.now();
      const beforeMetrics = deps.readMetrics(input.job.agentId, sessionKey);
      let abortReason: AgentExecutionAbortReason | undefined;
      const formattedSessionKey = formatSessionKey(sessionKey);
      const onAborted = (event: EventMap["execution:aborted"]): void => {
        if (
          event.agentId === input.job.agentId
          && formatSessionKey(event.sessionKey) === formattedSessionKey
        ) abortReason = event.reason;
      };
      deps.eventBus.on("execution:aborted", onAborted as never);

      const framedMessage = wrapExternalContent(input.job.payload.message, { source: "api" });
      const message = {
        id: messageId,
        text: gate.value.context === undefined
          ? framedMessage
          : `${framedMessage}\n\nWake-gate context:\n${wrapExternalContent(gate.value.context, { source: "api" })}`,
        senderId: sessionKey.userId,
        channelId: sessionKey.channelId,
        channelType: "scheduler",
        timestamp: input.scheduledForMs,
        attachments: [],
        metadata: {
          cronJobId: input.job.id,
          cronExecutionId: input.executionId,
        },
      };
      const executed = await fromPromise(executor.execute(
        message,
        sessionKey,
        tools,
        undefined,
        input.job.agentId,
        undefined,
        undefined,
        {
          operationType: "cron",
          signal,
          model: resolution.model,
          cacheRetention,
          promptTimeout: {
            promptTimeoutMs: effectiveTimeoutMs,
            retryPromptTimeoutMs: effectiveTimeoutMs,
            source: resolution.timeoutSource,
          },
        },
      ));
      const agentExecutionId = executed.ok ? executed.value.executionId : messageId;
      deps.eventBus.off("execution:aborted", onAborted as never);

      const persisted = await deps.sessionPolicy.after(policyRequest);
      const durationMs = Math.max(0, deps.clock.now() - startedAt);
      if (!executed.ok || !persisted.ok) {
        const measured = metricDelta(beforeMetrics, deps.readMetrics(input.job.agentId, sessionKey));
        const failureKind = !persisted.ok ? persisted.error.errorKind : "internal";
        deps.logger.error({
          executionId: input.executionId,
          agentExecutionId,
          jobId: input.job.id,
          agentId: input.job.agentId,
          durationMs,
          step: !persisted.ok ? "session_reconcile_after" : "agent_execute",
          errorKind: failureKind,
          hint: "Inspect the rooted cron trajectory and preserve the immutable occurrence as unknown",
        }, "Cron agent turn did not return complete terminal evidence");
        return ok(agentOutcome({
          input,
          sessionKey,
          agentExecutionId,
          execution: { status: "unknown", errorKind: failureKind },
          resolution,
          metrics: { durationMs, ...measured },
          wakeGate: gate.value.wakeGate,
          delivery: { status: "not_requested" },
          continuation: skippedContinuation(input.job.continuationMode, "execution_not_completed"),
        }));
      }

      const execution = classifyAgentTurnExecutionOutcome({
        finishReason: executed.value.finishReason,
        abortReason: abortReason ?? (signal.aborted ? "pipeline_timeout" : undefined),
        errorKind: executed.value.terminalErrorKind,
      });
      const metrics = {
        durationMs,
        totalTokens: executed.value.tokensUsed.total,
        costUsd: executed.value.cost.total,
        toolCalls: executed.value.stepsExecuted,
        llmCalls: executed.value.llmCalls,
      };
      const visible = execution.status === "completed"
        ? filterResponse(sanitizeAssistantResponse(executed.value.response))
        : { shouldDeliver: false, cleanedText: "" };
      const fence = createCronExecutionFence(signal);
      let delivery: CronDeliveryOutcome = { status: "not_requested" };
      if (input.job.deliveryTarget !== undefined && execution.status === "completed") {
        if (!visible.shouldDeliver) {
          delivery = { status: "suppressed", reason: "response_filter" };
        } else if (!fence.enter("platform_delivery")) {
          delivery = cancelledDelivery();
        } else {
          const delivered = await fromPromise(deps.deliverText({
            input,
            text: visible.cleanedText,
            target: input.job.deliveryTarget,
            signal,
          }));
          fence.leave("platform_delivery");
          delivery = delivered.ok ? delivered.value : unknownDelivery(deps.clock.now());
        }
      }

      let continuation = skippedContinuation(input.job.continuationMode, "execution_not_completed");
      if (input.job.continuationMode === "none") {
        continuation = { mode: "none", status: "not_requested" };
      } else if (execution.status === "completed" && visible.shouldDeliver) {
        const originEligible = input.job.continuationMode !== "origin_history"
          || delivery.status === "accepted";
        if (!originEligible) {
          continuation = { mode: "origin_history", status: "skipped", reason: "delivery_not_accepted" };
        } else if (!fence.enter("continuation")) {
          continuation = { mode: input.job.continuationMode, status: "failed", errorKind: "precondition" };
        } else {
          const continued = await fromPromise(deps.continueTurn({
            input,
            sourceExecutionId: agentExecutionId,
            visibleText: visible.cleanedText,
            delivery,
            signal,
          }));
          fence.leave("continuation");
          continuation = continued.ok
            ? continued.value
            : { mode: input.job.continuationMode, status: "failed", errorKind: "internal" };
        }
      } else if (execution.status === "completed") {
        continuation = skippedContinuation(input.job.continuationMode, "visible_text_unavailable");
      }
      fence.dispose();

      deps.logger.info({
        executionId: input.executionId,
        agentExecutionId,
        jobId: input.job.id,
        agentId: input.job.agentId,
        durationMs,
        executionStatus: execution.status,
        deliveryStatus: delivery.status,
      }, "Cron agent turn execution complete");
      return ok(agentOutcome({
        input,
        sessionKey,
        agentExecutionId,
        execution,
        resolution,
        metrics,
        wakeGate: gate.value.wakeGate,
        delivery,
        continuation,
      }));
    });
  };

  async function resolveWakeGate(
    input: AgentTurnInput,
    sessionKey: SessionKey,
    signal: AbortSignal,
  ): Promise<Result<{
    wakeGate: { status: "not_configured" } | { status: "woke"; durationMs: number; toolCalls: number } | { status: "failed_open"; durationMs: number; toolCalls: number; errorKind: ErrorKind };
    context?: string;
    terminal?: CronRuntimeOutcome;
  }, CronRuntimeError>> {
    if (input.job.wakeGate === undefined) return ok({ wakeGate: { status: "not_configured" } });
    const capability = deps.resolveWakeGateCapability(input.job.agentId);
    if (capability !== "enabled") {
      return ok({
        wakeGate: { status: "not_configured" },
        terminal: {
          kind: "agent_turn_pre_model_skip",
          rootRunId: input.rootRunId,
          reason: capability === "disabled" ? "wake_gate_disabled" : "wake_gate_unbound",
          errorKind: "precondition",
          continuation: { mode: "none", status: "not_requested" },
        },
      });
    }
    const ran = await fromPromise(deps.runWakeGate(input, sessionKey, signal));
    if (!ran.ok) {
      return err(runtimeError("dispatch_rejected", "dependency", "Cron wake gate rejected"));
    }
    if (ran.value.status === "unavailable") {
      return ok({
        wakeGate: { status: "not_configured" },
        terminal: {
          kind: "agent_turn_pre_model_skip",
          rootRunId: input.rootRunId,
          reason: ran.value.reason,
          errorKind: "precondition",
          continuation: { mode: "none", status: "not_requested" },
        },
      });
    }
    if (ran.value.status === "skip") {
      const fence = createCronExecutionFence(signal);
      let delivery: CronDeliveryOutcome = { status: "not_requested" };
      if (ran.value.deliver !== undefined && input.job.deliveryTarget !== undefined) {
        if (!fence.enter("platform_delivery")) {
          delivery = cancelledDelivery();
        } else {
          const delivered = await fromPromise(deps.deliverText({
            input,
            text: ran.value.deliver,
            target: input.job.deliveryTarget,
            signal,
          }));
          fence.leave("platform_delivery");
          delivery = delivered.ok ? delivered.value : unknownDelivery(deps.clock.now());
        }
      }
      fence.dispose();
      return ok({
        wakeGate: { status: "not_configured" },
        terminal: {
          kind: "wake_gate_skip",
          rootRunId: input.rootRunId,
          durationMs: ran.value.durationMs,
          toolCalls: ran.value.toolCalls,
          delivery,
          continuation: skippedContinuation(input.job.continuationMode, "execution_not_completed"),
        },
      });
    }
    if (ran.value.status === "failed_open") {
      return ok({
        wakeGate: {
          status: "failed_open",
          durationMs: ran.value.durationMs,
          toolCalls: ran.value.toolCalls,
          errorKind: ran.value.errorKind,
        },
      });
    }
    return ok({
      wakeGate: {
        status: "woke",
        durationMs: ran.value.durationMs,
        toolCalls: ran.value.toolCalls,
      },
      ...(ran.value.context === undefined ? {} : { context: ran.value.context }),
    });
  }
}

function intersectToolPolicies(
  tools: AgentTool[],
  config: PerAgentConfig,
  job: AgentTurnJob,
): AgentTool[] {
  const agentPolicy = config.skills?.toolPolicy;
  const agentBounded = agentPolicy === undefined
    ? tools
    : applyToolPolicy(tools, agentPolicy).tools;
  return job.toolPolicy === undefined
    ? agentBounded
    : applyToolPolicy(agentBounded, job.toolPolicy).tools;
}

function strictestRetention(
  ...values: Array<"none" | "short" | "long" | undefined>
): "none" | "short" | "long" {
  const rank = { none: 0, short: 1, long: 2 } as const;
  let selected: "none" | "short" | "long" = "long";
  for (const value of values) {
    if (value !== undefined && rank[value] < rank[selected]) selected = value;
  }
  return selected;
}

function skippedContinuation(
  mode: AgentTurnJob["continuationMode"],
  reason: "execution_not_completed" | "visible_text_unavailable",
): CronContinuationOutcome {
  if (mode === "none") return { mode: "none", status: "not_requested" };
  if (mode === "heartbeat_excerpt") return { mode, status: "skipped", reason };
  return {
    mode,
    status: "skipped",
    reason: reason === "execution_not_completed"
      ? "execution_not_completed"
      : "delivery_not_accepted",
  };
}

function cancelledDelivery(): CronDeliveryOutcome {
  return { status: "pre_send_failed", reason: "cancelled", errorKind: "precondition" };
}

function unknownDelivery(settledAtMs: number): CronDeliveryOutcome {
  return {
    status: "unknown",
    errorKind: "internal",
    deliveredChunks: 0,
    failedChunks: 1,
    ambiguousChunks: 1,
    settledAtMs,
  };
}

function emptyMetrics(): MetricSnapshot & { durationMs: number } {
  return { durationMs: 0, totalTokens: 0, costUsd: 0, toolCalls: 0, llmCalls: 0 };
}

function metricDelta(before: MetricSnapshot, after: MetricSnapshot): MetricSnapshot {
  return {
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
    toolCalls: Math.max(0, after.toolCalls - before.toolCalls),
    llmCalls: Math.max(0, after.llmCalls - before.llmCalls),
  };
}

function agentOutcome(input: {
  input: AgentTurnInput;
  sessionKey: SessionKey;
  agentExecutionId: string;
  execution: Extract<CronRuntimeOutcome, { kind: "agent_turn" }>["outcome"]["execution"];
  resolution: ReturnType<typeof resolveOperationModel>;
  metrics: Extract<CronRuntimeOutcome, { kind: "agent_turn" }>["outcome"]["metrics"];
  wakeGate: Extract<CronRuntimeOutcome, { kind: "agent_turn" }>["outcome"]["wakeGate"];
  delivery: CronDeliveryOutcome;
  continuation: CronContinuationOutcome;
}): CronRuntimeOutcome {
  return {
    kind: "agent_turn",
    outcome: {
      agentExecutionId: input.agentExecutionId,
      rootRunId: input.input.rootRunId,
      sessionKey: input.sessionKey,
      execution: input.execution,
      modelResolved: input.resolution.model,
      modelResolutionSource: input.resolution.source,
      metrics: input.metrics,
      wakeGate: input.wakeGate,
      delivery: input.delivery,
      continuation: input.continuation,
    },
  };
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: ErrorKind,
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
