// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline: Thin orchestrator for outbound delivery.
 *
 * Delegates policy/routing, LLM execution, response filtering, and delivery
 * to focused phase modules while retaining exact-once lifecycle ownership.
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey, TypedEventBus, DeliveryQueuePort, DeliveryService, ErrorKind } from "@comis/core";
import type { PerChannelStreamingConfig, StreamingConfig } from "@comis/core";
import { ERROR_KINDS } from "@comis/core";
import type { SendPolicyConfig, ElevatedReplyConfig } from "@comis/core";
import { formatSessionKey, tryGetContext, systemNowMs, narrowChatType, toSafeErrorLogString } from "@comis/core";
import type { ComisLogger } from "@comis/core";
// The orchestrator imports ONLY the core activity port + types (never
// the @comis/observability implementation). The ActivityStreamPort
// impl + the per-channel renderer are injected at the daemon composition root.
import type {
  ActivityStreamPort,
  TurnActivityContext,
  TurnOutcome,
} from "@comis/core";
import type { ActivityTurnCoordinator } from "./activity-turn-coordinator.js";
import type { Result } from "@comis/shared";
import { fromPromise, tryCatch } from "@comis/shared";
import type { AgentExecutor, InboundMessageProvenancePlan } from "@comis/agent";
// Relative path used because orchestrator cannot import its own published name.
import type { CommandQueue } from "../queue/command-queue.js";

import type {
  BlockPacer,
  TypingLifecycleController,
  ChannelRegistry,
  SendOverrideStore,
  VoiceResponsePipelineDeps,
} from "@comis/channels";
import type { RetryEngine } from "@comis/core";

import { executeLlm } from "./execution-execute.js";
import {
  filterExecutionResponse,
} from "./execution-filter.js";
import { deliverExecutionResponse } from "./execution-deliver.js";
import { emitObservationalEvent } from "./execution-event-emitter.js";
import { createMediaDeliveryFailureReceipt } from "./execution-media-receipt.js";
import { runExecutionPolicy } from "./execution-policy.js";
import { mapAbortToTurnOutcome } from "./turn-outcome-mapper.js";
import {
  classifyExecutionAbortReason,
  classifyExecutionFinishReason,
  type LifecycleOutcome,
} from "./execution-lifecycle-outcome.js";
import {
  createSourceTerminalScope,
  type SourceTerminalScope,
} from "../source-message-terminal.js";

export {
  buildThreadSendOpts,
  resolveStreamingConfig,
  THREAD_PROPAGATION_KEYS,
} from "./execution-routing-config.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Narrow deps interface for the execution pipeline. */
export interface ExecutionPipelineDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
  streamingConfig?: StreamingConfig;
  sendPolicyConfig?: SendPolicyConfig;
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  channelRegistry?: ChannelRegistry;
  retryEngine?: RetryEngine;
  commandQueue?: CommandQueue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  voiceResponsePipeline?: VoiceResponsePipelineDeps;
  parseOutboundMedia?: (text: string) => { text: string; mediaUrls: string[] };
  outboundMediaFetch?: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Wall-clock timeout for agent execution, in ms. Default: 600,000 (10 min). */
  executionTimeoutMs?: number;
  /** Delivery queue for crash-safe persistence. */
  deliveryQueue?: DeliveryQueuePort;
  /**
   * DeliveryService constructed once at the daemon composition root
   * (setup-channels.ts). Every callsite in execution-deliver.ts uses
   * `deps.deliveryService.deliverToChannel(...)` instead of a
   * free-standing standalone export.
   */
  deliveryService: DeliveryService;
  /** When true, only content inside <final> blocks reaches users. */
  enforceFinalTag?: boolean;
  /**
   * The orchestrator-facing activity stream port. Injected at
   * the daemon composition root (the observability `createActivityStream` impl).
   * Optional — when absent (or `coordinatorFactory` is absent) the turn runs
   * with no activity coordinator. The orchestrator depends ONLY
   * on this core port shape; it never imports `@comis/observability`.
   */
  activityStreamPort?: ActivityStreamPort;
  /**
   * Per-turn coordinator factory. `executeAndDeliver` calls this once
   * per turn with the turn's {@link TurnActivityContext}, returning an unstarted
   * {@link ActivityTurnCoordinator}; the pipeline `start()`s it on turn begin and
   * `finalize(outcome)`s it after delivery (gated on the delivery receipt). The
   * factory captures the per-channel renderer + TimerPort/ClockPort/logger at the
   * composition root and resolves the renderer by `ctx.channelType`.
   * Optional — present only when activity rendering is wired for the turn.
   */
  coordinatorFactory?: (ctx: TurnActivityContext) => ActivityTurnCoordinator;
}

// ---------------------------------------------------------------------------
// Main execution pipeline (thin orchestrator)
// ---------------------------------------------------------------------------

/**
 * Execute a message with block streaming delivery.
 *
 * Orchestrates 4 phases: policy -> execute -> filter -> deliver.
 */
export async function executeAndDeliver(
  deps: ExecutionPipelineDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  executor: AgentExecutor,
  sessionKey: SessionKey,
  agentId: string,
  blockStreamCfg: PerChannelStreamingConfig,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
  typingLifecycle?: TypingLifecycleController,
  directives?: Record<string, unknown>,
  ingressReceivedAt?: number,
  sourceTerminalScope?: SourceTerminalScope,
  queueSignal?: AbortSignal,
  inboundProvenancePlans: readonly InboundMessageProvenancePlan[] = [],
): Promise<void> {
  // Track lifecycle timing for diagnostic:message_processed event
  const executionEnteredAt = systemNowMs();
  const receivedAt =
    ingressReceivedAt !== undefined &&
    Number.isSafeInteger(ingressReceivedAt) &&
    ingressReceivedAt > 0
      ? Math.min(ingressReceivedAt, executionEnteredAt)
      : executionEnteredAt;
  let executionStartedAt: number | undefined;
  let executionCompletedAt: number | undefined;
  let diagnosticEmitted = false;
  let knownUsage: {
    tokensUsed: number;
    cost: number;
    finishReason: string;
    toolCalls: number | null;
    llmCalls: number | null;
  } | undefined;
  let rejectionStage: "execution" | "delivery" = "execution";
  let rejectionErrorKind: ErrorKind = "internal";
  let workspacePolicyHash: string | undefined;
  let coordinator: ActivityTurnCoordinator | undefined;
  let coordinatorStarted = false;
  let coordinatorFinalized = false;
  let executionCleanup: (() => void) | undefined;
  const terminalScope = sourceTerminalScope ?? createSourceTerminalScope(
    deps,
    effectiveMsg,
    adapter.channelType,
  );

  function logContainedFailure(
    error: Error,
    cleanupStep: string,
    hint: string,
    message: string,
  ): void {
    // Logging must not turn an already-contained observability/cleanup failure
    // into the primary turn failure.
    tryCatch(() => deps.logger.warn({
      err: toSafeErrorLogString(error),
      cleanupStep,
      hint,
      errorKind: "internal" as const,
    }, message));
  }

  function classifyRejectionError(error: Error, fallback: ErrorKind): ErrorKind {
    const classified = tryCatch(() => {
      if (typeof error === "object" && error !== null && "errorKind" in error) {
        const candidate = (error as { errorKind?: unknown }).errorKind;
        if (typeof candidate === "string") {
          return ERROR_KINDS.find((kind) => kind === candidate) ?? fallback;
        }
      }
      return fallback;
    });
    return classified.ok ? classified.value : fallback;
  }

  /** Emit diagnostic:message_processed once without coupling observers to the turn. */
  function emitDiagnostic(
    tokensUsed: number,
    cost: number,
    finishReason: string,
    outcome: LifecycleOutcome,
    callCounts: { toolCalls: number | null; llmCalls: number | null },
    completedAt = systemNowMs(),
  ): void {
    if (diagnosticEmitted) return;
    diagnosticEmitted = true;
    const boundedCompletedAt = Math.max(receivedAt, completedAt);
    const boundedExecutionCompletedAt = Math.min(
      boundedCompletedAt,
      Math.max(receivedAt, executionCompletedAt ?? boundedCompletedAt),
    );
    const boundedExecutionStartedAt = Math.min(
      boundedExecutionCompletedAt,
      Math.max(receivedAt, executionStartedAt ?? boundedExecutionCompletedAt),
    );
    const executionDurationMs = boundedExecutionCompletedAt - boundedExecutionStartedAt;
    const totalDurationMs = boundedCompletedAt - receivedAt;
    emitObservationalEvent(deps, "diagnostic:message_processed", {
        messageId: effectiveMsg.id,
        channelId: effectiveMsg.channelId,
        channelType: adapter.channelType,
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        // Carry the turn's trajectory id so the Verified Learning correction
        // writer can record the prior completed trajectory for a single-agent turn
        // off the payload without depending on subscriber-time ALS. The inbound
        // context retains the trajectory traceId throughout the turn; absent only
        // on direct non-entry calls (the writer then fails closed).
        traceId: tryGetContext()?.traceId,
        ...(workspacePolicyHash === undefined ? {} : { workspacePolicyHash }),
        toolCalls: callCounts.toolCalls,
        llmCalls: callCounts.llmCalls,
        status: outcome.status,
        ...(outcome.failureStage !== undefined ? { failureStage: outcome.failureStage } : {}),
        ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
        receivedAt,
        executionDurationMs,
        deliveryDurationMs: boundedCompletedAt - boundedExecutionCompletedAt,
        totalDurationMs,
        tokensUsed,
        cost,
        finishReason,
        timestamp: boundedCompletedAt,
      });
    terminalScope.publish(
      outcome.status,
      "execution_completed",
      boundedCompletedAt,
    );
  }

  async function finalizeCoordinator(outcome: TurnOutcome): Promise<void> {
    if (!coordinator || !coordinatorStarted || coordinatorFinalized) return;
    coordinatorFinalized = true;
    const finalized = await fromPromise(coordinator.finalize(outcome));
    if (!finalized.ok) {
      logContainedFailure(
        finalized.error,
        "coordinator_finalize",
        "Check the activity renderer; the authoritative delivery lifecycle and any primary failure were preserved",
        "Activity coordinator finalization failed",
      );
    }
  }

  async function stopForQueueAbort(): Promise<boolean> {
    if (!queueSignal?.aborted) return false;
    const usage = knownUsage ?? {
      tokensUsed: 0,
      cost: 0,
      finishReason: "aborted",
      toolCalls: null,
      llmCalls: null,
    };
    emitDiagnostic(
      usage.tokensUsed,
      usage.cost,
      usage.finishReason,
      { status: "aborted" },
      { toolCalls: usage.toolCalls, llmCalls: usage.llmCalls },
    );
    await finalizeCoordinator({ kind: "aborted", reason: "user_cancel" });
    return true;
  }

  const pipelineResult = await fromPromise((async (): Promise<void> => {

  // Resolve tools for this agent.
  // Pass sessionKey so setup-tools can thread the session's persistent
  // FileStateTracker (per SessionTrackerRegistry) through the assembled
  // tool pipeline -- keeps cross-turn file read state alive and removes
  // the [not_read] bootstrap trap for seeded workspace files.
  const tools = deps.assembleToolsForAgent
    ? await deps.assembleToolsForAgent(agentId, { sessionKey })
    : undefined;
  if (tools) {
    deps.logger.debug(
      { agentId, toolCount: tools.length },
      "Tools assembled for agent",
    );
  }
  if (await stopForQueueAbort()) return;

  let policy;
  try {
    policy = await runExecutionPolicy({
      deps,
      adapter,
      effectiveMsg,
      originalMsg,
      executor,
      sessionKey,
      agentId,
      sendOverrides,
      ...(tools === undefined ? {} : { tools }),
      ...(directives === undefined ? {} : { directives }),
      inboundProvenancePlans,
      onExecutionStart: () => { executionStartedAt = systemNowMs(); },
      onExecutionComplete: () => { executionCompletedAt = systemNowMs(); },
    });
  } catch (error) {
    emitDiagnostic(
      0,
      0,
      "error",
      { status: "error", failureStage: "execution", errorKind: "internal" },
      { toolCalls: null, llmCalls: null },
      executionCompletedAt,
    );
    // @allow-throw: inbound channel boundary converts executor rejection to its user-visible degraded response.
    throw error;
  }
  effectiveMsg = policy.effectiveMsg;
  const { replyTo, trustLevel } = policy;
  if (policy.kind === "denied") {
    const policyResult = policy.result;
    workspacePolicyHash = policyResult.workspacePolicyHash;
    knownUsage = {
      tokensUsed: policyResult.tokensUsed.total,
      cost: policyResult.cost.total,
      finishReason: policyResult.finishReason,
      toolCalls: policyResult.stepsExecuted,
      llmCalls: policyResult.llmCalls,
    };
    if (await stopForQueueAbort()) return;
    const policyLifecycle = classifyExecutionFinishReason(policyResult.finishReason);
    emitDiagnostic(
      policyResult.tokensUsed.total,
      policyResult.cost.total,
      policyResult.finishReason,
      policyLifecycle.status === "success" ? { status: "filtered" } : policyLifecycle,
      { toolCalls: policyResult.stepsExecuted, llmCalls: policyResult.llmCalls },
    );
    return;
  }

  // ===================================================================
  // Per-turn activity coordinator. Construct ONE coordinator for
  // this turn (after the send-policy gate — denied turns deliver nothing, so
  // they get no coordinator) and subscribe it to the activity stream BEFORE
  // execution so it observes every tool:*/model:* event emitted during the
  // run. The coordinator is finalized after delivery (gated on the delivery
  // receipt) and disposed in the finally (aborted/error turns still
  // unsubscribe). Active only when BOTH the stream port and the factory are
  // injected (the daemon composition root supplies them); otherwise the turn
  // runs without the activity coordinator.
  // ===================================================================
  if (deps.activityStreamPort && deps.coordinatorFactory) {
    const traceId = tryGetContext()?.traceId ?? formatSessionKey(sessionKey);
    const turnCtx: TurnActivityContext = {
      agentId,
      sessionKey: formatSessionKey(sessionKey),
      traceId,
      channelType: adapter.channelType,
      channelKey: effectiveMsg.channelId,
      chatType: narrowChatType(effectiveMsg.chatType ?? "dm"),
      inboundMessageId: effectiveMsg.id,
      threadId: effectiveMsg.metadata?.threadId as string | undefined,
      replyTo,
      rendererKey: `${agentId}:${adapter.channelType}:${effectiveMsg.channelId}`,
    };
    coordinator = deps.coordinatorFactory(turnCtx);
    coordinator.start(turnCtx);
    coordinatorStarted = true;
  }

  // Stage 2: LLM execution with timeout, thinking filter, abort signal
    const execResult = await (async () => {
      try {
        executionStartedAt = systemNowMs();
        const completed = await executeLlm(
          deps, adapter, effectiveMsg, sessionKey, agentId, executor,
          trustLevel, blockStreamCfg, replyTo, typingLifecycle,
          tools, directives,
          inboundProvenancePlans,
        );
        executionCompletedAt = systemNowMs();
        return completed;
      } catch (error) {
        executionCompletedAt = systemNowMs();
        emitDiagnostic(
          0,
          0,
          "error",
          { status: "error", failureStage: "execution", errorKind: "internal" },
          { toolCalls: null, llmCalls: null },
          executionCompletedAt,
        );
        await finalizeCoordinator({
          kind: "failure",
          errorKind: "internal",
          failedEvents: [],
        });
        // @allow-throw: inbound channel boundary converts executor rejection to its user-visible degraded response.
        throw error;
      }
    })();
    executionCleanup = execResult.cleanup;

    const callCounts = {
      toolCalls: execResult.result?.stepsExecuted ?? null,
      llmCalls: execResult.result?.llmCalls ?? null,
    };
    workspacePolicyHash = execResult.result?.workspacePolicyHash;
    knownUsage = {
      tokensUsed: execResult.tokensUsed,
      cost: execResult.cost,
      finishReason: execResult.finishReason,
      ...callCounts,
    };
    if (await stopForQueueAbort()) return;

    if (execResult.timedOut) {
      emitDiagnostic(
        0,
        0,
        "timeout",
        { status: "timeout", failureStage: "execution", errorKind: "timeout" },
        { toolCalls: null, llmCalls: null },
      );
      // Aborted turn (timeout): the renderer keeps the diagnostic trail.
      await finalizeCoordinator({ kind: "aborted", reason: "timeout" });
      return;
    }
    rejectionStage = "delivery";
    rejectionErrorKind = "internal";

    const readExecutionLifecycle = (): LifecycleOutcome => {
      const abortReason = execResult.currentAbortReason();
      return abortReason !== undefined
        ? classifyExecutionAbortReason(abortReason)
        : classifyExecutionFinishReason(execResult.result!.finishReason);
    };

    const readCoordinatorExecutionOutcome = (): TurnOutcome | undefined => {
      const executionLifecycle = readExecutionLifecycle();
      const currentAbortReason = execResult.currentAbortReason();
      const abortOutcome = mapAbortToTurnOutcome({
        finishReason: execResult.finishReason,
        resourceAborted: execResult.resourceAborted,
        abortReason: currentAbortReason,
      });
      return executionLifecycle.status === "error"
        ? abortOutcome ?? {
            kind: "failure",
            errorKind: executionLifecycle.errorKind ?? "internal",
            failedEvents: [],
          }
        : executionLifecycle.status === "timeout"
          ? { kind: "aborted", reason: "timeout" }
          : executionLifecycle.status === "aborted"
            ? { kind: "aborted", reason: "user_cancel" }
            : undefined;
    };

    // Signal execution complete for thinking mode
    if (typingLifecycle && blockStreamCfg.typingMode !== "message") {
      typingLifecycle.markRunComplete();
    }

    // Stage 3: Response sanitization, filtering, media, voice, prefix
    const filterResult = await filterExecutionResponse(
      deps, adapter, effectiveMsg, originalMsg, sessionKey, agentId,
      execResult.result, execResult.accumulated, replyTo,
      execResult.resourceAborted, execResult.currentAbortReason(), execResult.finishReason,
      (kind) => { rejectionErrorKind = kind; },
      queueSignal,
    );

    if (await stopForQueueAbort()) return;

    if (!filterResult.deliver) {
      const executionLifecycle = readExecutionLifecycle();
      const mediaDeliveryFailed = (filterResult.mediaDelivery?.failed ?? 0) > 0;
      // Text delivery is skipped here. Filtered/empty turns remain silent;
      // successful voice/media sends carry a receipt below so the renderer
      // finalizes only after their attachment delivery has completed.
      const silentReason: "NO_REPLY" | "SILENT" =
        filterResult.reason === "filtered" ? "NO_REPLY" : "SILENT";
      const lifecycleOutcome: LifecycleOutcome = executionLifecycle.status !== "success"
        ? executionLifecycle
        : mediaDeliveryFailed
          ? { status: "error", failureStage: "delivery", errorKind: "platform" }
          : filterResult.reason === "filtered"
            ? { status: "filtered" }
            : executionLifecycle;
      const completedAt = filterResult.completedAtMs ?? systemNowMs();
      const nonTextDeliveredChunks = filterResult.mediaDelivery?.delivered ?? 0;
      const nonTextDelivery = !mediaDeliveryFailed && executionLifecycle.status === "success"
        ? filterResult.reason === "voice_delivered"
          ? {
              ok: true as const,
              deliveredChunks: 1 + nonTextDeliveredChunks,
              ...(filterResult.receipt.kind === "tracked"
                ? { lastChunkMessageId: filterResult.receipt.messageId }
                : {}),
              deliveredAtMs: completedAt,
            }
          : filterResult.reason === "media_only" &&
              nonTextDeliveredChunks > 0
            ? {
                ok: true as const,
                deliveredChunks: nonTextDeliveredChunks,
                ...(filterResult.mediaDelivery?.lastReceipt?.kind === "tracked"
                  ? { lastChunkMessageId: filterResult.mediaDelivery.lastReceipt.messageId }
                  : {}),
                deliveredAtMs: completedAt,
              }
            : undefined
        : undefined;
      const mediaFailureReceipt = mediaDeliveryFailed && filterResult.mediaDelivery !== undefined
        ? createMediaDeliveryFailureReceipt(
            filterResult.mediaDelivery,
            undefined,
            filterResult.reason === "voice_delivered" ? 1 : 0,
          )
        : undefined;
      emitDiagnostic(
        execResult.tokensUsed,
        execResult.cost,
        execResult.finishReason,
        lifecycleOutcome,
        callCounts,
        completedAt,
      );
      // A resource abort that produced no deliverable text is a TRUTHFUL
      // failure, not a silent delete — the operator must see the stop (the
      // ~150-read loop incident produced no useful reply and was hidden).
      await finalizeCoordinator(
        readCoordinatorExecutionOutcome()
          ?? (mediaFailureReceipt !== undefined
            ? {
                kind: "failure",
                errorKind: "platform",
                failedEvents: [],
                deliveryReceipt: mediaFailureReceipt,
              }
            : nonTextDelivery
              ? { kind: "success", trivial: false, delivery: nonTextDelivery }
              : { kind: "silent", reason: silentReason }),
      );
      return;
    }

    // Stage 4: Chunking, coalescing, block pacing, delivery. The inbound
    // context already carries resolved agent/session identity, and the queue
    // preserves that scope through execution and delivery.
    rejectionErrorKind = "platform";
    const deliverySignal = queueSignal === undefined
      ? execResult.deliverySignal
      : AbortSignal.any([execResult.deliverySignal, queueSignal]);
    const deliveryReceipt = await deliverExecutionResponse(
      deps, adapter, effectiveMsg, filterResult.text,
      blockStreamCfg, activePacers, replyTo,
      deliverySignal, typingLifecycle,
    );

    if (await stopForQueueAbort()) return;

    // Emit message:sent with the REAL last-chunk message id from the receipt
    // (replaces the prior synthetic placeholder id). On a delivery
    // failure, or when nothing was delivered (visibleReplies suppression =>
    // deliveredChunks 0, empty id), there is no real message to announce, so
    // the message:sent emit is skipped — downstream subscribers only ever see
    // a real platform message id.
    rejectionErrorKind = "internal";
    if (deliveryReceipt.ok && deliveryReceipt.value.lastChunkMessageId) {
      emitObservationalEvent(deps, "message:sent", {
        channelType: adapter.channelType,
        channelId: effectiveMsg.channelId,
        messageId: deliveryReceipt.value.lastChunkMessageId,
        content: filterResult.text,
        sourceChannelType: originalMsg.channelType,
        sourceChannelId: originalMsg.channelId,
        sourceMessageId: originalMsg.id,
      });
    }

    const coordinatorExecutionOutcome = readCoordinatorExecutionOutcome();
    const mediaDeliveryFailed = (filterResult.mediaDelivery?.failed ?? 0) > 0;
    const mediaFailureReceipt = mediaDeliveryFailed && filterResult.mediaDelivery !== undefined
      ? createMediaDeliveryFailureReceipt(filterResult.mediaDelivery, deliveryReceipt)
      : undefined;
    const executionLifecycle = readExecutionLifecycle();
    const deliveryLifecycle: LifecycleOutcome = executionLifecycle.status !== "success"
      ? executionLifecycle
      : mediaDeliveryFailed
        ? { status: "error", failureStage: "delivery", errorKind: "platform" }
      : deliveryReceipt.ok
        ? deliveryReceipt.value.deliveredChunks > 0
          ? { status: "success" }
          : { status: "filtered" }
        : {
            status: "error",
            failureStage: "delivery",
            errorKind: deliveryReceipt.error.errorKind,
          };
    emitDiagnostic(
      execResult.tokensUsed,
      execResult.cost,
      execResult.finishReason,
      deliveryLifecycle,
      callCounts,
      deliveryReceipt.ok
        ? deliveryReceipt.value.deliveredAtMs
        : deliveryReceipt.error.failedAtMs,
    );

    // Finalize only after the authoritative lifecycle event is visible. A
    // renderer/coordinator failure is contained by finalizeCoordinator so it
    // cannot reclassify an already-delivered turn or trigger inbound fallback.
    if (coordinatorExecutionOutcome) {
      // Partial text may have delivered, but the run was stopped — render the
      // truthful failure, not a success.
      await finalizeCoordinator(coordinatorExecutionOutcome);
    } else if (mediaFailureReceipt !== undefined) {
      await finalizeCoordinator({
        kind: "failure",
        errorKind: "platform",
        failedEvents: [],
        deliveryReceipt: mediaFailureReceipt,
      });
    } else if (deliveryReceipt.ok) {
      await finalizeCoordinator({
        kind: "success",
        trivial: false,
        delivery: deliveryReceipt.value,
      });
    } else {
      await finalizeCoordinator({
        kind: "failure",
        errorKind: deliveryReceipt.error.errorKind,
        failedEvents: [],
        deliveryReceipt: deliveryReceipt.error,
      });
    }
  })());

  if (!pipelineResult.ok) {
    const failureKind = classifyRejectionError(pipelineResult.error, rejectionErrorKind);
    const usage = knownUsage ?? {
      tokensUsed: 0,
      cost: 0,
      finishReason: "error",
      toolCalls: null,
      llmCalls: null,
    };
    emitDiagnostic(
      usage.tokensUsed,
      usage.cost,
      usage.finishReason,
      { status: "error", failureStage: rejectionStage, errorKind: failureKind },
      { toolCalls: usage.toolCalls, llmCalls: usage.llmCalls },
    );
    await finalizeCoordinator({
      kind: "failure",
      errorKind: failureKind,
      failedEvents: [],
    });
  }

  function runCleanupStep(cleanupStep: string, cleanup: () => void): void {
    const cleaned = tryCatch(cleanup);
    if (!cleaned.ok) {
      logContainedFailure(
        cleaned.error,
        cleanupStep,
        "Inspect the named cleanup handler; later cleanup steps and the primary turn outcome were preserved",
        "Execution pipeline cleanup failed",
      );
    }
  }

  // Snapshot typing state independently so a broken getter cannot prevent
  // disposal of the coordinator, execution listeners, or typing lifecycle.
  let typingWasActive = false;
  let typingStartedAt = 0;
  if (typingLifecycle) {
    const typingState = tryCatch(() => ({
      isActive: typingLifecycle.controller.isActive,
      startedAt: typingLifecycle.controller.startedAt,
    }));
    if (typingState.ok) {
      typingWasActive = typingState.value.isActive;
      typingStartedAt = typingState.value.startedAt;
    } else {
      logContainedFailure(
        typingState.error,
        "typing_state",
        "Inspect the typing controller state getters; remaining cleanup still ran",
        "Typing cleanup state read failed",
      );
    }
  }

  if (coordinator) {
    runCleanupStep("coordinator_dispose", () => coordinator?.dispose());
  }
  if (executionCleanup) {
    runCleanupStep("execution_cleanup", executionCleanup);
  }
  if (typingLifecycle) {
    runCleanupStep("typing_dispose", () => typingLifecycle.dispose());
    if (typingWasActive) {
      runCleanupStep("typing_stopped_event", () => {
        const timestamp = systemNowMs();
        emitObservationalEvent(deps, "typing:stopped", {
          channelId: adapter.channelId,
          chatId: effectiveMsg.channelId,
          durationMs: timestamp - typingStartedAt,
          timestamp,
        });
      });
    }
  }

  if (!pipelineResult.ok) {
    // @allow-throw: the inbound channel boundary converts the preserved primary rejection to its user-visible degraded response.
    throw pipelineResult.error;
  }
}
