// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline Phase 4: Message Routing.
 *
 * Handles debounce buffering, group history injection, steer+followup
 * routing (SDK-native), command queue routing, and direct execution
 * fallback.
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import type { PerChannelStreamingConfig } from "@comis/core";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import type { BlockPacer } from "./block-pacer.js";
import type { TypingLifecycleController } from "./typing-lifecycle-controller.js";
import type { SendOverrideStore } from "./send-policy.js";
import { isGroupMessage } from "./auto-reply-engine.js";
import { executeAndDeliver } from "./execution-pipeline.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the routing phase. */
export type RouteDeps = Pick<
  InboundPipelineDeps,
  | "logger"
  | "eventBus"
  | "debounceBuffer"
  | "groupHistoryBuffer"
  | "sessionLabelStore"
  | "commandQueue"
  | "priorityScheduler"
  | "queueConfig"
  | "activeRunRegistry"
  | "streamingConfig"
  | "sendPolicyConfig"
  | "getElevatedReplyConfig"
  | "channelRegistry"
  | "retryEngine"
  | "deliveryQueue"
  | "followupTrigger"
  | "followupConfig"
  | "assembleToolsForAgent"
  | "voiceResponsePipeline"
  | "parseOutboundMedia"
  | "outboundMediaFetch"
  | "onTaskExtraction"
  | "responsePrefixConfig"
  | "buildTemplateContext"
  | "getEnforceFinalTag"
>;

// ---------------------------------------------------------------------------
// Priority lane assignment
// ---------------------------------------------------------------------------

import type { LaneAssignmentConfig } from "@comis/core";
import { isBotMentioned } from "./auto-reply-engine.js";

/**
 * Determine which priority lane a message should be assigned to.
 *
 * Priority order: follow-up messages -> heartbeat/scheduled -> DMs -> mentioned in group -> default.
 */
function assignPriorityLane(
  msg: NormalizedMessage,
  laneConfig: LaneAssignmentConfig,
): { lane: string; reason: string } {
  // Follow-up messages
  if (msg.metadata?.isFollowup) {
    return { lane: laneConfig.followupLane, reason: "followup" };
  }
  // Heartbeat / scheduled
  if (msg.metadata?.isHeartbeat) {
    return { lane: laneConfig.scheduledLane, reason: "heartbeat" };
  }
  // DMs
  if (!isGroupMessage(msg)) {
    return { lane: laneConfig.dmLane, reason: "dm" };
  }
  // Group mention
  if (isBotMentioned(msg)) {
    return { lane: laneConfig.mentionLane, reason: "mention" };
  }
  // Default
  return { lane: laneConfig.defaultLane, reason: "default" };
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Route an inbound message through debounce, group history, steer+followup,
 * or command queue. Falls back to direct execution when no queue is present.
 *
 * This function handles the final routing decision and may call
 * `executeAndDeliver` directly or enqueue for later execution.
 */
export async function routeInboundMessage(
  deps: RouteDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  executor: AgentExecutor,
  streamCfg: PerChannelStreamingConfig,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
  typingLifecycle: TypingLifecycleController | undefined,
  directives: Record<string, unknown> | undefined,
): Promise<void> {
  let msg = processedMsg;

  // -------------------------------------------------------------------
  // DEBOUNCE BUFFER GATE
  // -------------------------------------------------------------------
  const isDebounced = msg.metadata?.isDebounced === true;
  if (!isDebounced && deps.debounceBuffer) {
    deps.logger.debug({
      step: "debounce-buffered",
      channelType: adapter.channelType,
      chatId: msg.channelId,
    }, "Message buffered for debounce");
    deps.debounceBuffer.push(sessionKey, msg, adapter.channelType);
    return; // Message is buffered; execution deferred to flush callback
  }

  // -------------------------------------------------------------------
  // GROUP HISTORY INJECTION
  // -------------------------------------------------------------------
  if (deps.groupHistoryBuffer) {
    const skFormatted = formatSessionKey(sessionKey);
    let effectiveText = msg.text ?? "";
    const sessionLabel = deps.sessionLabelStore?.getLabel(sessionKey);
    const history = deps.groupHistoryBuffer.getFormatted(skFormatted, sessionLabel);
    if (history) {
      effectiveText = `${history}\n---\n${effectiveText}`;
      deps.eventBus.emit("grouphistory:injected", {
        sessionKey: skFormatted,
        channelType: adapter.channelType,
        messageCount: deps.groupHistoryBuffer.depth(skFormatted),
        charCount: history.length,
        timestamp: Date.now(),
      });
      deps.logger.debug({
        step: "group-history-inject",
        itemCount: deps.groupHistoryBuffer.depth(skFormatted),
        inputLen: history.length,
      }, "Group history injected");
    }
    // Also push the current activating message to the buffer (for next activation's context)
    if (isGroupMessage(msg)) {
      deps.groupHistoryBuffer.push(skFormatted, msg);
    }
    // Create the effective message with injected history
    if (effectiveText !== (msg.text ?? "")) {
      msg = { ...msg, text: effectiveText };
    }
  }

  // Build narrow execution pipeline deps from the inbound pipeline deps
  const execDeps = {
    eventBus: deps.eventBus,
    logger: deps.logger,
    streamingConfig: deps.streamingConfig,
    sendPolicyConfig: deps.sendPolicyConfig,
    getElevatedReplyConfig: deps.getElevatedReplyConfig,
    channelRegistry: deps.channelRegistry,
    retryEngine: deps.retryEngine,
    deliveryQueue: deps.deliveryQueue,
    followupTrigger: deps.followupTrigger,
    followupConfig: deps.followupConfig,
    commandQueue: deps.commandQueue,
    assembleToolsForAgent: deps.assembleToolsForAgent,
    voiceResponsePipeline: deps.voiceResponsePipeline,
    parseOutboundMedia: deps.parseOutboundMedia,
    outboundMediaFetch: deps.outboundMediaFetch,
    onTaskExtraction: deps.onTaskExtraction,
    responsePrefixConfig: deps.responsePrefixConfig,
    buildTemplateContext: deps.buildTemplateContext,
    enforceFinalTag: deps.getEnforceFinalTag?.(agentId),
  };

  // -------------------------------------------------------------------
  // STEER+FOLLOWUP ROUTING
  // -------------------------------------------------------------------
  if (deps.activeRunRegistry && deps.queueConfig) {
    const channelQueueConfig = deps.queueConfig.perChannel[adapter.channelType];
    const effectiveMode = channelQueueConfig?.mode ?? deps.queueConfig.defaultMode;

    if (effectiveMode === "steer+followup") {
      const formattedKey = formatSessionKey(sessionKey);
      const runHandle = deps.activeRunRegistry.get(formattedKey);

      if (runHandle) {
        const messageText = msg.text ?? "";

        if (runHandle.isStreaming() && !runHandle.isCompacting()) {
          // Session is streaming -- inject via SDK steer
          try {
            await runHandle.steer(messageText);
            deps.eventBus.emit("steer:injected", {
              sessionKey,
              channelType: adapter.channelType,
              agentId,
              timestamp: Date.now(),
            });
            deps.logger.debug(
              { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
              "Steer message injected into active session",
            );
            return; // Message handled via steer -- do not enqueue
          } catch (steerErr) {
            deps.logger.warn(
              {
                agentId,
                err: steerErr instanceof Error ? steerErr : new Error(String(steerErr)),
                hint: "SDK session.steer() failed; message will be queued as follow-up",
                errorKind: "internal" as const,
              },
              "Steer injection failed",
            );
            // Fall through to follow-up below
          }
        }

        if (runHandle.isCompacting()) {
          deps.eventBus.emit("steer:rejected", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: "compacting",
            timestamp: Date.now(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Steer rejected: session compacting",
          );
        } else {
          deps.eventBus.emit("steer:rejected", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: "not_streaming",
            timestamp: Date.now(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Steer rejected: session not streaming",
          );
        }

        // Queue as follow-up (session exists but steer not possible)
        try {
          await runHandle.followUp(messageText);
          deps.eventBus.emit("steer:followup_queued", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: runHandle.isCompacting() ? "compacting" : "not_streaming",
            timestamp: Date.now(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Message queued as follow-up via SDK",
          );
          return; // Message handled via follow-up -- do not enqueue
        } catch (followUpErr) {
          deps.logger.warn(
            {
              agentId,
              err: followUpErr instanceof Error ? followUpErr : new Error(String(followUpErr)),
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
    // Determine priority lane
    let laneName: string | undefined;
    if (deps.priorityScheduler && deps.queueConfig?.priorityEnabled) {
      const laneConfig = deps.queueConfig.laneAssignment;
      const assignment = assignPriorityLane(msg, laneConfig);
      laneName = assignment.lane;
      deps.eventBus.emit("priority:lane_assigned", {
        sessionKey,
        channelType: adapter.channelType,
        lane: assignment.lane,
        reason: assignment.reason,
        timestamp: Date.now(),
      });
    }

    const enqueueResult = await deps.commandQueue.enqueue(sessionKey, msg, adapter.channelType, async (messages) => {
      const effectiveMsg = messages[0]!;
      await executeAndDeliver(execDeps, adapter, effectiveMsg, originalMsg, executor, sessionKey, agentId, streamCfg, activePacers, sendOverrides, typingLifecycle, directives);
    }, laneName);
    if (!enqueueResult.ok) {
      deps.logger.warn({
        err: enqueueResult.error.message,
        hint: "Check if command queue is shut down or overflow policy rejected the message",
        errorKind: "resource" as const,
        channelType: adapter.channelType,
      }, "Message enqueue failed");
    }

    return;
  }

  // -----------------------------------------------------------------------
  // Direct execution path (fallback when commandQueue is not provided)
  // -----------------------------------------------------------------------
  await executeAndDeliver(execDeps, adapter, msg, originalMsg, executor, sessionKey, agentId, streamCfg, activePacers, sendOverrides, typingLifecycle, directives);
}
