// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline: Pre-Execution Setup + Message Routing.
 *
 * Resolves typing lifecycle + streaming config, then routes through
 * steer/followup, queue, or direct execution.
 *
 * @module
 */

import type {
  ChannelPort,
  ConversationRef,
  EventMap,
  NormalizedMessage,
  SessionKey,
  PerChannelStreamingConfig,
  ResolvedTurnScope,
} from "@comis/core";
import {
  formatSessionKey,
  toSafeErrorLogString,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  tryGetContext,
  wrapExternalContent,
} from "@comis/core";
import type {
  AgentExecutor,
  InboundMessageProvenancePlan,
  RunHandle,
} from "@comis/agent";
import { fromPromise, tryCatch } from "@comis/shared";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import {
  createTypingController,
  createTypingLifecycleController,
  isGroupMessage,
  isBotMentioned,
} from "@comis/channels";
import type {
  TypingController,
  TypingLifecycleController,
  BlockPacer,
  SendOverrideStore,
} from "@comis/channels";
import { resolveStreamingConfig, executeAndDeliver } from "../execution/execution-pipeline.js";
import { emitObservationalEvent } from "../execution/execution-event-emitter.js";
import {
  createSourceTerminalScope,
  type SourceTerminalScope,
} from "../source-message-terminal.js";

// ---------------------------------------------------------------------------
// Per-platform typing refresh defaults
// ---------------------------------------------------------------------------

/**
 * Optimal typing indicator refresh intervals per platform.
 * Each value is set with margin before the platform's natural expiry.
 * IRC and Echo are intentionally omitted -- they default to typingMode "never".
 */
export const PLATFORM_TYPING_DEFAULTS: Record<string, number> = {
  telegram: 4000,   // 1s margin before 5s expiry
  discord:  8000,   // 2s margin before 10s expiry
  whatsapp: 8000,   // ~10s expiry
  signal:   4000,   // ~5s expiry
  line:     15000,  // 20s expiry (showLoadingAnimation)
  imessage: 4000,   // ~5s process-based expiry
};

const SDK_ABORT_SETTLE_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/**
 * Minimal deps for the setup-and-route phase.
 *
 * 23 unique fields: 4 shared between the former setup + route Pick<>s
 * (logger / eventBus / channelRegistry / streamingConfig), 1 unique to setup
 * (lifecycleReactionsEnabled), and 18 unique to route (the route set gained
 * the activityStreamPort + coordinatorFactory pass-through to execDeps).
 */
export type SetupAndRouteDeps = Pick<
  InboundPipelineDeps,
  // From inbound-setup.ts (5 fields; 4 shared with route):
  | "logger"
  | "eventBus"
  | "clock"
  | "channelRegistry"
  | "lifecycleReactionsEnabled"
  | "streamingConfig"
  // From inbound-route.ts (22 fields; 4 shared with setup):
  | "commandQueue"
  | "queueConfig"
  | "activeRunRegistry"
  | "sessionResolver"
  | "sendPolicyConfig"
  | "getElevatedReplyConfig"
  | "retryEngine"
  | "deliveryQueue"
  | "deliveryService"
  | "assembleToolsForAgent"
  | "voiceResponsePipeline"
  | "parseOutboundMedia"
  | "outboundMediaFetch"
  | "responsePrefixConfig"
  | "buildTemplateContext"
  | "getEnforceFinalTag"
  // Propagated onto execDeps for the pipeline gate (see execution-pipeline.ts).
  | "activityStreamPort"
  | "coordinatorFactory"
  | "taskCapture"
>;

// ---------------------------------------------------------------------------
// Helper functions (lifted verbatim from inbound-setup.ts:79-87)
// ---------------------------------------------------------------------------

/**
 * Determine if typing indicators should be shown in the current context.
 *
 * In DMs, always show typing. In group chats, only show typing when the
 * bot was mentioned or replied to (prevents unnecessary typing noise).
 */
function shouldShowTypingInGroup(msg: NormalizedMessage): boolean {
  if (!isGroupMessage(msg)) return true; // Not a group -- show typing
  return isBotMentioned(msg); // In group -- only if mentioned
}

/** Check if this execution was triggered by a heartbeat (suppress typing). */
function isHeartbeatExecution(msg: NormalizedMessage): boolean {
  return msg.metadata?.isHeartbeat === true;
}

/** Resolve a finite channel-ingress timestamp without allowing future time. */
function resolveIngressReceivedAt(): number {
  const now = systemNowMs();
  const startedAt = tryGetContext()?.startedAt;
  return startedAt !== undefined &&
    Number.isSafeInteger(startedAt) &&
    startedAt > 0
    ? Math.min(startedAt, now)
    : now;
}

// ---------------------------------------------------------------------------
// Setup and routing
// ---------------------------------------------------------------------------

/**
 * Resolve typing lifecycle + streaming config, then route the inbound message
 * through steer/followup, queue, or direct execution.
 *
 * Typing and streaming setup runs first. Routing then uses the resulting
 * controllers and configuration for the selected execution path.
 */
export async function setupAndRoute(
  deps: SetupAndRouteDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  turnScope: ResolvedTurnScope,
  conversationRef: ConversationRef,
  executor: AgentExecutor,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
  directives: Record<string, unknown> | undefined,
  inboundProvenancePlan: InboundMessageProvenancePlan,
  sourceTerminalScope?: SourceTerminalScope,
): Promise<void> {
  const terminalScope = sourceTerminalScope ?? createSourceTerminalScope(
    deps,
    originalMsg,
    adapter.channelType,
  );
  // Resolve typing lifecycle + streaming config. The local values flow into
  // routing below instead of being returned.
  //
  // Ack reactions are handled by the lifecycle reactor (when enabled); the
  // ackReactionConfig deps slot was removed since no ack reactions were sent
  // through this stage in production.

  const streamCfg: PerChannelStreamingConfig = resolveStreamingConfig(
    adapter.channelType,
    deps.streamingConfig,
  );

  // IRC and Echo default to typingMode "never" (no typing API) unless explicitly overridden
  const effectiveTypingMode =
    (adapter.channelType === "irc" || adapter.channelType === "echo") && streamCfg.typingMode === "thinking"
      ? "never" as const
      : streamCfg.typingMode;

  // Determine if typing indicators should activate
  let typingCtrl: TypingController | undefined;
  const shouldType =
    effectiveTypingMode !== "never" &&
    !isHeartbeatExecution(processedMsg) &&
    shouldShowTypingInGroup(originalMsg);

  if (shouldType) {
    const threadIdForTyping = processedMsg.metadata?.telegramThreadId != null
      ? String(processedMsg.metadata.telegramThreadId)
      : undefined;

    // Resolve per-platform refresh interval, falling back to per-channel config
    const refreshMs = PLATFORM_TYPING_DEFAULTS[adapter.channelType] ?? streamCfg.typingRefreshMs;

    typingCtrl = createTypingController(
      {
        mode: effectiveTypingMode,
        refreshMs,
        circuitBreakerThreshold: streamCfg.typingCircuitBreakerThreshold,
        ttlMs: streamCfg.typingTtlMs,
      },
      async (chatId: string) => {
        await adapter.platformAction("sendTyping", { chatId, threadId: threadIdForTyping });
      },
      { warn: (obj, message) => deps.logger.warn(obj, message) },
    );
  }

  // Wrap the raw TypingController in a lifecycle controller
  let typingLifecycle: TypingLifecycleController | undefined;
  let typingDisposed = false;
  if (typingCtrl) {
    const createdTypingLifecycle = createTypingLifecycleController(typingCtrl, {
      graceMs: 10_000,
      logger: { warn: (obj, message) => deps.logger.warn(obj, message) },
    });
    typingLifecycle = {
      controller: createdTypingLifecycle.controller,
      markRunComplete: () => createdTypingLifecycle.markRunComplete(),
      markDispatchIdle: () => createdTypingLifecycle.markDispatchIdle(),
      dispose: () => {
        if (typingDisposed) return;
        typingDisposed = true;
        createdTypingLifecycle.dispose();
      },
    };

    // 'instant' mode: start typing immediately before queue/execution
    if (streamCfg.typingMode === "instant") {
      typingLifecycle.controller.start(processedMsg.channelId);
      emitObservationalEvent(deps, "typing:started", {
        channelId: adapter.channelId,
        chatId: processedMsg.channelId,
        mode: streamCfg.typingMode,
        timestamp: systemNowMs(),
      });
    }
  }

  const releaseTypingOwnership = (): void => {
    if (!typingLifecycle || typingDisposed) return;
    const state = tryCatch(() => ({
      isActive: typingLifecycle?.controller.isActive === true,
      startedAt: typingLifecycle?.controller.startedAt ?? 0,
    }));
    const disposed = tryCatch(() => typingLifecycle?.dispose());
    if (!disposed.ok) {
      void tryCatch(() => deps.logger.warn({
        step: "typing-dispose",
        channelType: adapter.channelType,
        err: toSafeErrorLogString(disposed.error),
        errorKind: "internal" as const,
        hint: "Fix typing lifecycle disposal; the non-executed queue entry was still terminalized.",
      }, "Typing lifecycle discard cleanup failed"));
      return;
    }
    if (state.ok && state.value.isActive) {
      const timestamp = systemNowMs();
      emitObservationalEvent(deps, "typing:stopped", {
        channelId: adapter.channelId,
        chatId: processedMsg.channelId,
        durationMs: Math.max(0, timestamp - state.value.startedAt),
        timestamp,
      });
    }
  };

  // Route via steer/followup, queue, or direct execution using the streaming
  // and typing values resolved above.

  let typingOwnershipTransferred = false;
  try {
    const msg = processedMsg;

    // Debounce buffer + group history injection deps slots (debounceBuffer,
    // groupHistoryBuffer, sessionLabelStore) were never wired by the daemon;
    // their absent-mode (direct routing without coalescing or history injection)
    // IS the production code path. They have been removed.

    // Build narrow execution pipeline deps from the inbound pipeline deps
    const execDeps = {
      eventBus: deps.eventBus,
      logger: deps.logger,
      clock: deps.clock,
      streamingConfig: deps.streamingConfig,
      sendPolicyConfig: deps.sendPolicyConfig,
      getElevatedReplyConfig: deps.getElevatedReplyConfig,
      channelRegistry: deps.channelRegistry,
      retryEngine: deps.retryEngine,
      deliveryQueue: deps.deliveryQueue,
      deliveryService: deps.deliveryService,
      commandQueue: deps.commandQueue,
      assembleToolsForAgent: deps.assembleToolsForAgent,
      voiceResponsePipeline: deps.voiceResponsePipeline,
      parseOutboundMedia: deps.parseOutboundMedia,
      outboundMediaFetch: deps.outboundMediaFetch,
      responsePrefixConfig: deps.responsePrefixConfig,
      buildTemplateContext: deps.buildTemplateContext,
      enforceFinalTag: deps.getEnforceFinalTag?.(agentId),
      activityStreamPort: deps.activityStreamPort,
      coordinatorFactory: deps.coordinatorFactory,
      taskCapture: deps.taskCapture,
    };

    // -------------------------------------------------------------------
    // STEER+FOLLOWUP ROUTING
    // -------------------------------------------------------------------
    // Active-session lookup goes through BackgroundSessionResolver:
    // composite (agentId, channelType, channelId) supersedes the single-arg
    // formatted-key lookup so multi-agent / multi-channel sessions are
    // distinguishable. The original
    // `formattedKey = formatSessionKey(sessionKey)` is retained ONLY for
    // diagnostic log fields (the SessionKey may itself be richer than the
    // resolver's composite triple).
    if (deps.sessionResolver && deps.queueConfig) {
      const channelQueueConfig = deps.queueConfig.perChannel[adapter.channelType];
      const effectiveMode = channelQueueConfig?.mode ?? deps.queueConfig.defaultMode;

      if (effectiveMode === "steer+followup") {
        const formattedKey = formatSessionKey(sessionKey);
        const runHandle = deps.sessionResolver.resolveActiveSession(conversationRef);

        if (runHandle) {
          const messageText = wrapExternalContent(msg.text ?? "", { source: "unknown" });

          if (runHandle.isStreaming() && !runHandle.isCompacting()) {
            // Session is streaming -- inject via SDK steer
            try {
              await runHandle.steer(messageText);
              emitObservationalEvent(deps, "steer:injected", {
                sessionKey,
                channelType: adapter.channelType,
                agentId,
                timestamp: systemNowMs(),
              });
              deps.logger.debug(
                { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
                "Steer message injected into active session",
              );
              terminalScope.publish(
                "success",
                "forwarded",
                systemNowMs(),
              );
              return; // Message handled via steer -- do not enqueue
            } catch (steerErr) {
              deps.logger.warn(
                {
                  agentId,
                  err: toSafeErrorLogString(steerErr),
                  hint: "SDK session.steer() failed; message will be queued as follow-up",
                  errorKind: "internal" as const,
                },
                "Steer injection failed",
              );
              // Fall through to follow-up below
            }
          }

          if (runHandle.isCompacting()) {
            emitObservationalEvent(deps, "steer:rejected", {
              sessionKey,
              channelType: adapter.channelType,
              agentId,
              reason: "compacting",
              timestamp: systemNowMs(),
            });
            deps.logger.debug(
              { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
              "Steer rejected: session compacting",
            );
          } else {
            emitObservationalEvent(deps, "steer:rejected", {
              sessionKey,
              channelType: adapter.channelType,
              agentId,
              reason: "not_streaming",
              timestamp: systemNowMs(),
            });
            deps.logger.debug(
              { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
              "Steer rejected: session not streaming",
            );
          }

          // Queue as follow-up (session exists but steer not possible)
          try {
            await runHandle.followUp(messageText);
            emitObservationalEvent(deps, "steer:followup_queued", {
              sessionKey,
              channelType: adapter.channelType,
              agentId,
              reason: runHandle.isCompacting() ? "compacting" : "not_streaming",
              timestamp: systemNowMs(),
            });
            deps.logger.debug(
              { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
              "Message queued as follow-up via SDK",
            );
            terminalScope.publish(
              "success",
              "forwarded",
              systemNowMs(),
            );
            return; // Message handled via follow-up -- do not enqueue
          } catch (followUpErr) {
            deps.logger.warn(
              {
                agentId,
                err: toSafeErrorLogString(followUpErr),
                hint: "SDK session.followUp() failed; falling through to CommandQueue",
                errorKind: "internal" as const,
              },
              "Follow-up queue failed",
            );
            // Fall through to normal CommandQueue routing
          }
        }
        // No active run -- fall through to CommandQueue (first message for session)
      }
    }

    // -----------------------------------------------------------------------
    // Queue-mediated path: route through CommandQueue for serialization
    // -----------------------------------------------------------------------
    if (deps.commandQueue) {
      const enqueueResult = await deps.commandQueue.enqueue(sessionKey, msg, adapter.channelType, async (messages, execution) => {
        const effectiveMsg = messages[0]!;
        const executionTraceId = tryGetContext()?.traceId;
        const executionSessionKey = formatSessionKey(sessionKey);
        let cancellationStarted = false;
        let activeAbort: Promise<void> | undefined;
        let promptSubmittedListener:
          | ((event: EventMap["prompt:submitted"]) => void)
          | undefined;

        const logCancellationFailure = (
          error: Error,
          hint: string,
          message: string,
        ): void => {
          void tryCatch(() => deps.logger.warn({
            agentId,
            channelType: adapter.channelType,
            err: toSafeErrorLogString(error),
            hint,
            errorKind: "internal" as const,
          }, message));
        };

        const resolveActiveRun = (): RunHandle | undefined => {
          const sessionResolver = deps.sessionResolver;
          if (!sessionResolver) return undefined;
          const resolved = tryCatch(() => sessionResolver.resolveActiveSession(conversationRef));
          if (!resolved.ok) {
            logCancellationFailure(
              resolved.error,
              "Fix active-session resolution; queue cancellation could not reach the running SDK session",
              "Queue cancellation could not resolve the active session",
            );
            return undefined;
          }
          return resolved.value;
        };

        const abortResolvedRun = async (runHandle: RunHandle): Promise<void> => {
          const started = tryCatch(() => runHandle.abort());
          if (!started.ok) {
            logCancellationFailure(
              started.error,
              "Inspect the SDK session abort failure; the queue cancellation signal was still delivered to the handler",
              "Active SDK session abort failed",
            );
            return;
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            fromPromise(started.value).then((result) => ({
              kind: "settled" as const,
              result,
            })),
            new Promise<{ kind: "timeout" }>((resolve) => {
              timeout = systemSetTimeout(
                () => resolve({ kind: "timeout" }),
                SDK_ABORT_SETTLE_TIMEOUT_MS,
              );
            }),
          ]);
          if (timeout !== undefined) systemClearTimeout(timeout);
          if (settled.kind === "timeout") {
            void tryCatch(() => deps.logger.warn({
              agentId,
              channelType: adapter.channelType,
              durationMs: SDK_ABORT_SETTLE_TIMEOUT_MS,
              hint: "Inspect the SDK session abort implementation; queue cancellation continued after the bounded wait",
              errorKind: "timeout" as const,
            }, "Active SDK session abort timed out"));
            return;
          }
          if (!settled.result.ok) {
            logCancellationFailure(
              settled.result.error,
              "Inspect the SDK session abort failure; the queue cancellation signal was still delivered to the handler",
              "Active SDK session abort failed",
            );
          }
        };

        const removePromptSubmittedListener = (): void => {
          if (!promptSubmittedListener) return;
          const listener = promptSubmittedListener;
          promptSubmittedListener = undefined;
          const removed = tryCatch(() => deps.eventBus.off(
            "prompt:submitted",
            listener,
          ));
          if (!removed.ok) {
            logCancellationFailure(
              removed.error,
              "Fix EventBus listener cleanup; the completed queue turn no longer needs the cancellation fallback",
              "Queue cancellation listener cleanup failed",
            );
          }
        };

        const beginCancellation = (): void => {
          if (cancellationStarted) return;
          cancellationStarted = true;
          const activeRun = resolveActiveRun();
          if (activeRun) {
            activeAbort = abortResolvedRun(activeRun);
            return;
          }
          if (!deps.sessionResolver || !executionTraceId) return;

          const listener = (event: EventMap["prompt:submitted"]): void => {
            if (
              tryGetContext()?.traceId !== executionTraceId ||
              event.agentId !== agentId ||
              event.sessionKey !== executionSessionKey
            ) return;
            removePromptSubmittedListener();
            const registeredRun = resolveActiveRun();
            if (registeredRun) {
              activeAbort = abortResolvedRun(registeredRun);
            }
          };
          promptSubmittedListener = listener;
          const registered = tryCatch(() => deps.eventBus.on(
            "prompt:submitted",
            listener,
          ));
          if (!registered.ok) {
            promptSubmittedListener = undefined;
            logCancellationFailure(
              registered.error,
              "Fix EventBus listener registration; early queue cancellation could not wait for SDK run registration",
              "Queue cancellation fallback registration failed",
            );
          }
        };

        const onAbort = (): void => {
          beginCancellation();
        };

        execution.signal.addEventListener("abort", onAbort, { once: true });
        if (execution.signal.aborted) onAbort();
        let executionOwnsTyping = false;
        try {
          if (execution.signal.aborted) {
            releaseTypingOwnership();
            execution.sourceTerminalScope.publish(
              "aborted",
              "execution_completed",
              systemNowMs(),
            );
            return;
          }
          executionOwnsTyping = true;
          await executeAndDeliver(
            execDeps,
            adapter,
            effectiveMsg,
            originalMsg,
            executor,
            sessionKey,
            agentId,
            streamCfg,
            activePacers,
            sendOverrides,
            typingLifecycle,
            directives,
            execution.receivedAt,
            execution.sourceTerminalScope,
            execution.signal,
            execution.inboundProvenancePlans,
          );
        } finally {
          execution.signal.removeEventListener("abort", onAbort);
          removePromptSubmittedListener();
          if (activeAbort) await activeAbort;
          if (!executionOwnsTyping) releaseTypingOwnership();
        }
      }, terminalScope, releaseTypingOwnership, inboundProvenancePlan);
      if (!enqueueResult.ok) {
        deps.logger.warn({
          err: toSafeErrorLogString(enqueueResult.error),
          hint: "Check if command queue is shut down or overflow policy rejected the message",
          errorKind: "resource" as const,
          channelType: adapter.channelType,
        }, "Message enqueue failed");
        terminalScope.publish("error", "queue_rejected", systemNowMs());
      } else {
        typingOwnershipTransferred = true;
      }

      return;
    }

    // -----------------------------------------------------------------------
    // Direct execution path (fallback when commandQueue is not provided)
    // -----------------------------------------------------------------------
    typingOwnershipTransferred = true;
    await executeAndDeliver(
      execDeps,
      adapter,
      msg,
      originalMsg,
      executor,
      sessionKey,
      agentId,
      streamCfg,
      activePacers,
      sendOverrides,
      typingLifecycle,
      directives,
      resolveIngressReceivedAt(),
      terminalScope,
      undefined,
      [inboundProvenancePlan],
    );
  } finally {
    if (!typingOwnershipTransferred) releaseTypingOwnership();
  }
}
