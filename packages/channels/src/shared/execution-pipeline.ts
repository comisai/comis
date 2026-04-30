// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline: Thin orchestrator for outbound delivery.
 *
 * Delegates to 4 focused phase modules:
 *   1. execution-policy  — send policy gate, trust level, elevated reply routing
 *   2. execution-execute — LLM execution with timeout, thinking filter, abort
 *   3. execution-filter  — response sanitization, filtering, media, voice, prefix
 *   4. execution-deliver — chunking, coalescing, block pacing, delivery
 *
 * Keeps follow-up trigger logic here (needs full closure deps for re-enqueue).
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { ChannelPort, NormalizedMessage, SessionKey, TypedEventBus, DeliveryQueuePort } from "@comis/core";
import type { PerChannelStreamingConfig, StreamingConfig } from "@comis/core";
import type { SendPolicyConfig, ElevatedReplyConfig } from "@comis/core";
import type { SendMessageOptions } from "@comis/core";
import { formatSessionKey, runWithContext, createDeliveryOrigin } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { CommandDirectives } from "@comis/agent";
import type { CommandQueue } from "@comis/agent";
import type { FollowupTrigger } from "@comis/agent";

import type { BlockPacer } from "./block-pacer.js";
import type { TypingLifecycleController } from "./typing-lifecycle-controller.js";
import type { ChannelRegistry } from "./channel-registry.js";
import type { SendOverrideStore } from "./send-policy.js";
import type { RetryEngine } from "./retry-engine.js";
import type { VoiceResponsePipelineDeps } from "./voice-response-pipeline.js";

// Phase module imports
import { evaluateExecutionPolicy } from "./execution-policy.js";
import { executeLlm } from "./execution-execute.js";
import { filterExecutionResponse } from "./execution-filter.js";
import { deliverExecutionResponse } from "./execution-deliver.js";

// ---------------------------------------------------------------------------
// Platform-specific configuration
// ---------------------------------------------------------------------------

/** Maps channelType to the metadata key containing the platform message ID for reply-to. */
export const REPLY_TO_META_KEY: Record<string, string> = {
  telegram: "telegramMessageId",
  discord: "discordMessageId",
  slack: "slackTs",
  whatsapp: "whatsappMessageId",
};

/**
 * Metadata keys that carry thread context -- must be propagated to followup messages.
 * Mirror of TELEGRAM_THREAD_META_KEYS in thread-context.ts -- kept in sync via
 * cross-reference unit test.
 */
export const THREAD_PROPAGATION_KEYS = [
  "threadId", "telegramThreadId", "telegramIsForum", "telegramThreadScope",
] as const;

/**
 * Build thread-related SendMessageOptions from inbound message metadata.
 * Returns undefined when no thread context present.
 */
export function buildThreadSendOpts(
  metadata?: Record<string, unknown>,
): Pick<SendMessageOptions, "threadId" | "extra"> | undefined {
  const threadId = metadata?.threadId as string | undefined;
  if (!threadId) return undefined;
  return {
    threadId,
    extra: metadata?.telegramThreadScope
      ? { telegramThreadScope: metadata.telegramThreadScope }
      : undefined,
  };
}

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
  followupTrigger?: FollowupTrigger;
  followupConfig?: { maxFollowupRuns: number };
  commandQueue?: CommandQueue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  voiceResponsePipeline?: VoiceResponsePipelineDeps;
  parseOutboundMedia?: (text: string) => { text: string; mediaUrls: string[] };
  outboundMediaFetch?: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  /** Optional callback for task extraction after successful agent execution. */
  onTaskExtraction?: (conversationText: string, sessionKey: string, agentId: string) => Promise<void>;
  /** Response prefix config for template-based prefix/suffix on agent responses. */
  responsePrefixConfig?: { template: string; position: "prepend" | "append" };
  /** Template context builder for response prefix variables. */
  buildTemplateContext?: (agentId: string, channelType: string, msg: NormalizedMessage) => Record<string, string>;
  /** Wall-clock timeout for agent execution, in ms. Default: 600,000 (10 min). */
  executionTimeoutMs?: number;
  /** Delivery queue for crash-safe persistence. */
  deliveryQueue?: DeliveryQueuePort;
  /**
   * Per-instance set of in-flight outbound sendMessage promises. Threaded
   * through DeliverToChannelDeps so deliver-to-channel can register active
   * sends. Drained in stopAll() with a 5s deadline so SIGUSR2 cannot tear
   * down adapters mid-send. Created by the channel-manager factory; do not
   * pass externally.
   */
  inFlightSends?: Set<Promise<unknown>>;
  /** When true, only content inside <final> blocks reaches users. */
  enforceFinalTag?: boolean;
}

// ---------------------------------------------------------------------------
// Streaming config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve per-channel streaming configuration.
 *
 * Priority: per-channel override > global defaults > hardcoded defaults.
 */
export function resolveStreamingConfig(
  channelType: string,
  streamingConfig?: StreamingConfig,
): PerChannelStreamingConfig {
  const global = streamingConfig;
  if (!global) {
    return {
      enabled: true,
      chunkMode: "paragraph",
      chunkMinChars: 100,
      deliveryTiming: { mode: "natural", minMs: 800, maxMs: 2500, jitterMs: 200, firstBlockDelayMs: 0 },
      coalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      typingMode: "thinking",
      typingRefreshMs: 6000,
      typingCircuitBreakerThreshold: 3,
      typingTtlMs: 60000,
      useMarkdownIR: true,
      tableMode: "code",
      replyMode: "first",
    };
  }
  const perChannel = global.perChannel[channelType];
  if (perChannel) return perChannel;
  return {
    enabled: global.enabled,
    chunkMode: global.defaultChunkMode,
    chunkMinChars: 100,
    deliveryTiming: global.defaultDeliveryTiming,
    coalescer: global.defaultCoalescer,
    typingMode: global.defaultTypingMode,
    typingRefreshMs: global.defaultTypingRefreshMs,
    typingCircuitBreakerThreshold: 3,
    typingTtlMs: 60000,
    useMarkdownIR: global.defaultUseMarkdownIR ?? true,
    tableMode: global.defaultTableMode ?? "code",
    replyMode: global.defaultReplyMode ?? "first",
  };
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
): Promise<void> {
  // Track lifecycle timing for diagnostic:message_processed event
  const receivedAt = Date.now();

  /** Emit diagnostic:message_processed with current lifecycle state. */
  function emitDiagnostic(tokensUsed: number, cost: number, finishReason: string): void {
    deps.eventBus.emit("diagnostic:message_processed", {
      messageId: effectiveMsg.id,
      channelId: effectiveMsg.channelId,
      channelType: adapter.channelType,
      agentId,
      sessionKey: formatSessionKey(sessionKey),
      receivedAt,
      executionDurationMs: Date.now() - receivedAt,
      deliveryDurationMs: 0,
      totalDurationMs: Date.now() - receivedAt,
      tokensUsed,
      cost,
      success: true,
      finishReason,
      timestamp: Date.now(),
    });
  }

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

  // Phase 1: Send policy gate, trust level, elevated reply routing
  const policy = evaluateExecutionPolicy(
    deps, adapter, effectiveMsg, originalMsg, sessionKey, agentId, sendOverrides,
  );

  if (!policy.allowed) {
    // Still execute the agent (for session history), just skip sending
    const policyResult = await runWithContext({
      traceId: randomUUID(),
      tenantId: sessionKey.tenantId,
      userId: sessionKey.userId,
      sessionKey: formatSessionKey(sessionKey),
      startedAt: Date.now(),
      trustLevel: policy.trustLevel,
      channelType: adapter.channelType,
      deliveryOrigin: createDeliveryOrigin({
        channelType: adapter.channelType,
        channelId: effectiveMsg.channelId,
        userId: sessionKey.userId,
        threadId: effectiveMsg.metadata?.threadId as string | undefined,
        tenantId: sessionKey.tenantId,
      }),
    }, () => executor.execute(effectiveMsg, sessionKey, tools, undefined, agentId, directives as CommandDirectives | undefined, undefined, { operationType: "interactive" as const }));
    emitDiagnostic(policyResult.tokensUsed.total, policyResult.cost.total, policyResult.finishReason);
    return;
  }

  // Phase 2: LLM execution with timeout, thinking filter, abort signal
  const execResult = await executeLlm(
    deps, adapter, policy.effectiveMsg, sessionKey, agentId, executor,
    policy.trustLevel, blockStreamCfg, policy.replyTo, typingLifecycle,
    tools, directives,
  );

  try {
    if (execResult.timedOut) {
      emitDiagnostic(0, 0, "timeout");
      return;
    }

    // Follow-up trigger check — stays in orchestrator for closure access
    handleFollowupTrigger(deps, adapter, policy.effectiveMsg, sessionKey, agentId, executor,
      execResult.result, execResult.finishReason, blockStreamCfg, activePacers, sendOverrides);

    // Signal execution complete for thinking mode
    if (typingLifecycle && blockStreamCfg.typingMode !== "message") {
      typingLifecycle.markRunComplete();
    }

    // Phase 3: Response sanitization, filtering, media, voice, prefix
    const filterResult = await filterExecutionResponse(
      deps, adapter, policy.effectiveMsg, originalMsg, sessionKey, agentId,
      execResult.result, execResult.accumulated, policy.replyTo,
      execResult.resourceAborted, execResult.abortReason, execResult.finishReason,
    );

    if (!filterResult.deliver) {
      if (filterResult.reason === "filtered") {
        emitDiagnostic(execResult.tokensUsed, execResult.cost, "filtered");
      } else if (filterResult.reason === "voice_delivered") {
        emitDiagnostic(execResult.tokensUsed, execResult.cost, execResult.finishReason);
      } else {
        emitDiagnostic(execResult.tokensUsed, execResult.cost, execResult.finishReason);
      }
      return;
    }

    // Phase 4: Chunking, coalescing, block pacing, delivery
    await deliverExecutionResponse(
      deps, adapter, policy.effectiveMsg, filterResult.text,
      blockStreamCfg, activePacers, policy.replyTo,
      execResult.deliverySignal, typingLifecycle,
    );

    // Emit message:sent event with the cleaned response content
    deps.eventBus.emit("message:sent", {
      channelId: policy.effectiveMsg.channelId,
      messageId: "block-delivery",
      content: filterResult.text,
    });

    // Task extraction: extract commitments/follow-ups from the conversation (non-blocking)
    if (deps.onTaskExtraction && filterResult.text) {
      deps.onTaskExtraction(filterResult.text, formatSessionKey(sessionKey), agentId).catch(
        (err: unknown) => {
          deps.logger.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "Task extraction callback error (non-blocking)",
          );
        },
      );
    }

    // Emit diagnostic:message_processed for full lifecycle tracking
    emitDiagnostic(execResult.tokensUsed, execResult.cost, execResult.finishReason);
  } finally {
    // Cleanup event listeners from execution phase
    execResult.cleanup();

    // Ensure typing is always stopped on error/completion
    if (typingLifecycle) {
      const wasActive = typingLifecycle.controller.isActive;
      const startedAt = typingLifecycle.controller.startedAt;
      typingLifecycle.dispose();
      if (wasActive) {
        deps.eventBus.emit("typing:stopped", {
          channelId: adapter.channelId,
          chatId: policy.effectiveMsg.channelId,
          durationMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Follow-up trigger (kept in orchestrator for closure deps access)
// ---------------------------------------------------------------------------

/** Check and enqueue follow-up if trigger conditions are met. */
function handleFollowupTrigger(
  deps: ExecutionPipelineDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  executor: AgentExecutor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  diagFinishReason: string,
  blockStreamCfg: PerChannelStreamingConfig,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
): void {
  if (!deps.followupTrigger || !deps.commandQueue) return;

  const resultMeta: Record<string, unknown> = {};
  const resMeta = (result as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
  if (resMeta?.needs_followup) resultMeta.needs_followup = true;
  if (resMeta?.compaction_triggered) resultMeta.compaction_triggered = true;
  if (diagFinishReason === "compaction") resultMeta.compaction_triggered = true;

  if (!deps.followupTrigger.shouldFollowup(resultMeta)) return;

  const chainId = (effectiveMsg.metadata?.followupChainId as string) ?? randomUUID();
  const currentDepth = deps.followupTrigger.getChainDepth(chainId);
  const maxDepth = deps.followupConfig?.maxFollowupRuns ?? 3;

  if (currentDepth >= maxDepth) {
    deps.eventBus.emit("followup:depth_exceeded", {
      sessionKey: formatSessionKey(sessionKey),
      chainId,
      maxDepth,
      timestamp: Date.now(),
    });
    return;
  }

  const newDepth = deps.followupTrigger.incrementChain(chainId);

  const threadMeta: Record<string, unknown> = {};
  for (const key of THREAD_PROPAGATION_KEYS) {
    if (effectiveMsg.metadata?.[key] != null) {
      threadMeta[key] = effectiveMsg.metadata[key];
    }
  }

  const followupMsg = deps.followupTrigger.createFollowupMessage(
    sessionKey, adapter.channelType, effectiveMsg.channelId,
    resultMeta.compaction_triggered ? "compaction" : "tool_result",
    chainId, newDepth,
    Object.keys(threadMeta).length > 0 ? threadMeta : undefined,
  );

  deps.eventBus.emit("followup:enqueued", {
    sessionKey: formatSessionKey(sessionKey),
    channelType: adapter.channelType,
    reason: resultMeta.compaction_triggered ? "compaction" : "tool_result",
    chainId,
    chainDepth: newDepth,
    timestamp: Date.now(),
  });

  // Re-enqueue follow-up through command queue (fire-and-forget)
  deps.commandQueue.enqueue(sessionKey, followupMsg, adapter.channelType, async (messages) => {
    const fMsg = messages[0]!;
    await executeAndDeliver(deps, adapter, fMsg, fMsg, executor, sessionKey, agentId, blockStreamCfg, activePacers, sendOverrides, undefined);
  }).then((enqueueResult) => {
    if (!enqueueResult.ok) {
      deps.logger.warn({
        err: enqueueResult.error.message,
        hint: "Check if command queue is shut down or overflow policy rejected the message",
        errorKind: "resource" as const,
        channelType: adapter.channelType,
      }, "Follow-up enqueue failed");
    }
  }).catch((e: unknown) => {
    deps.logger.warn({
      err: e instanceof Error ? e.message : String(e),
      hint: "Unexpected error during follow-up enqueue",
      errorKind: "internal" as const,
      channelType: adapter.channelType,
    }, "Follow-up enqueue failed");
  });
}
