// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline: Thin orchestrator for outbound delivery.
 *
 * Delegates to 3 focused phase modules (Phase 59 REFACTOR-02 inlined the
 * former execution-policy phase directly into the executeAndDeliver body —
 * 5 PolicyDeps fields already lived on ExecutionPipelineDeps, so the seam
 * was pure cosmetic):
 *   1. execution-execute — LLM execution with timeout, thinking filter, abort
 *   2. execution-filter  — response sanitization, filtering, media, voice, prefix
 *   3. execution-deliver — chunking, coalescing, block pacing, delivery
 *
 * The pre-execute send-policy gate, sender trust resolution, and elevated
 * reply routing are now an inline block at the head of executeAndDeliver
 * (Stage 1 marker below).
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { ChannelPort, NormalizedMessage, SessionKey, TypedEventBus, DeliveryQueuePort, DeliveryService } from "@comis/core";
import type { PerChannelStreamingConfig, StreamingConfig } from "@comis/core";
import { PerChannelStreamingConfigSchema } from "@comis/core";
import type { SendPolicyConfig, ElevatedReplyConfig } from "@comis/core";
import type { SendMessageOptions } from "@comis/core";
import { formatSessionKey, runWithContext, createDeliveryOrigin, systemNowMs } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { CommandDirectives } from "../commands/index.js";
// Relative path used because orchestrator cannot import its own published name.
import type { CommandQueue } from "../queue/command-queue.js";

import { isGroupMessage, evaluateSendPolicy, applySessionOverride } from "@comis/channels";
import type {
  BlockPacer,
  TypingLifecycleController,
  ChannelRegistry,
  SendOverrideStore,
  SendPolicyContext,
  VoiceResponsePipelineDeps,
} from "@comis/channels";
import type { RetryEngine } from "@comis/core";

// Pipeline-stage imports
// Note: Phase 59 REFACTOR-02 inlined the former send-policy phase body
// (formerly a sibling source file exporting one phase function +
// PolicyDeps + PolicyResult) directly into executeAndDeliver below. The
// 5 deps fields (eventBus, logger, sendPolicyConfig,
// getElevatedReplyConfig, channelRegistry) already live on
// ExecutionPipelineDeps — no interface change required.
import { executeLlm } from "./execution-execute.js";
import { filterExecutionResponse } from "./execution-filter.js";
import { deliverExecutionResponse } from "./execution-deliver.js";

// ---------------------------------------------------------------------------
// Platform-specific configuration
// ---------------------------------------------------------------------------

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
  // No global streaming config provided — return the per-channel schema defaults.
  // (Schema is the SSOT per AGENTS.md §6.4; no inline literals.)
  //
  // Documented deviation (CRIT-05): ROADMAP Phase 50 Success Criterion #3 and
  // REQUIREMENTS.md both phrase the fix as "routes through
  // `StreamingConfigSchema.parse({})` and `PerChannelStreamingConfigSchema.parse({})`".
  // The `StreamingConfigSchema.parse({})` lane is satisfied at AppConfig parse
  // time (operator YAML → AppConfig in packages/core/src/config); inside this
  // resolver we only use `PerChannelStreamingConfigSchema.parse({})` because
  // the resolver's return type is `PerChannelStreamingConfig`, not
  // `StreamingConfig` (see RESEARCH Anti-Pattern §3).
  if (!streamingConfig) {
    return PerChannelStreamingConfigSchema.parse({});
  }

  // Per-channel override wins over globals.
  const perChannel = streamingConfig.perChannel[channelType];
  if (perChannel) return perChannel;

  // No per-channel override — merge schema defaults with global default* fields.
  return {
    ...PerChannelStreamingConfigSchema.parse({}),
    enabled: streamingConfig.enabled,
    chunkMode: streamingConfig.defaultChunkMode,
    chunkMinChars: streamingConfig.defaultChunkMinChars,                                  // CRIT-05
    deliveryTiming: streamingConfig.defaultDeliveryTiming,
    coalescer: streamingConfig.defaultCoalescer,
    typingMode: streamingConfig.defaultTypingMode,
    typingRefreshMs: streamingConfig.defaultTypingRefreshMs,
    typingCircuitBreakerThreshold: streamingConfig.defaultTypingCircuitBreakerThreshold,  // CRIT-05
    typingTtlMs: streamingConfig.defaultTypingTtlMs,                                      // CRIT-05
    useMarkdownIR: streamingConfig.defaultUseMarkdownIR,
    tableMode: streamingConfig.defaultTableMode,
    replyMode: streamingConfig.defaultReplyMode,
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
  const receivedAt = systemNowMs();

  /** Emit diagnostic:message_processed with current lifecycle state. */
  function emitDiagnostic(tokensUsed: number, cost: number, finishReason: string): void {
    deps.eventBus.emit("diagnostic:message_processed", {
      messageId: effectiveMsg.id,
      channelId: effectiveMsg.channelId,
      channelType: adapter.channelType,
      agentId,
      sessionKey: formatSessionKey(sessionKey),
      receivedAt,
      executionDurationMs: systemNowMs() - receivedAt,
      deliveryDurationMs: 0,
      totalDurationMs: systemNowMs() - receivedAt,
      tokensUsed,
      cost,
      success: true,
      finishReason,
      timestamp: systemNowMs(),
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

  // ===================================================================
  // Stage 1: Send policy gate, trust level, elevated reply routing
  // (Inlined from the former send-policy phase module in Phase 59
  // REFACTOR-02 — 5 deps fields already lived on ExecutionPipelineDeps.)
  // ===================================================================

  // Capability-driven config lookup (falls back to hardcoded maps)
  const caps = deps.channelRegistry?.getCapabilities(adapter.channelType);
  const metaKey = caps?.replyToMetaKey;
  // In DMs, skip reply-to -- quoting the user's own message adds noise in 1-on-1 chats.
  const replyTo =
    isGroupMessage(originalMsg) && metaKey && originalMsg.metadata?.[metaKey]
      ? String(originalMsg.metadata[metaKey])
      : undefined;

  // Resolve sender trust level from elevatedReply config (defaults to "user")
  let trustLevel: "guest" | "user" | "admin" = "user";
  if (deps.getElevatedReplyConfig) {
    const elevCfg = deps.getElevatedReplyConfig(agentId);
    if (elevCfg?.enabled) {
      const senderId = effectiveMsg.senderId;
      const mapped = elevCfg.senderTrustMap[senderId] ?? elevCfg.defaultTrustLevel;
      if (mapped === "admin" || mapped === "user" || mapped === "guest") {
        trustLevel = mapped;
      }
    }
  }

  // -------------------------------------------------------------------
  // SEND POLICY GATE (checked once before any delivery path)
  // -------------------------------------------------------------------
  if (deps.sendPolicyConfig?.enabled) {
    const policyCtx: SendPolicyContext = {
      channelId: adapter.channelId,
      channelType: adapter.channelType,
      chatType: originalMsg.chatType ?? "dm",
    };
    let policyDecision = evaluateSendPolicy(policyCtx, deps.sendPolicyConfig);

    // Apply per-session override
    const overrideKey = formatSessionKey(sessionKey);
    const override = sendOverrides.get(overrideKey);
    policyDecision = applySessionOverride(policyDecision, override);

    if (!policyDecision.allowed) {
      deps.eventBus.emit("sendpolicy:denied", {
        channelId: adapter.channelId,
        channelType: adapter.channelType,
        chatType: policyCtx.chatType,
        reason: policyDecision.reason,
        timestamp: systemNowMs(),
      });
      deps.logger.info(
        { channelId: adapter.channelId, reason: policyDecision.reason },
        "Send policy denied outbound message",
      );

      // Still execute the agent (for session history), just skip sending.
      // (Silent-execute path preserved verbatim from pre-inline pipeline —
      // one of two executor.execute call sites; see RESEARCH §B.4 + §LM-15.)
      const policyResult = await runWithContext({
        traceId: randomUUID(),
        tenantId: sessionKey.tenantId,
        userId: sessionKey.userId,
        sessionKey: formatSessionKey(sessionKey),
        startedAt: systemNowMs(),
        trustLevel,
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

    deps.eventBus.emit("sendpolicy:allowed", {
      channelId: adapter.channelId,
      channelType: adapter.channelType,
      chatType: policyCtx.chatType,
      reason: policyDecision.reason,
      timestamp: systemNowMs(),
    });
  }

  // -------------------------------------------------------------------
  // ELEVATED REPLY MODE (mutates effectiveMsg via parameter rebind)
  // -------------------------------------------------------------------
  if (deps.getElevatedReplyConfig) {
    const elevConfig = deps.getElevatedReplyConfig(agentId);
    if (elevConfig?.enabled) {
      const senderId = effectiveMsg.senderId;
      const tl = elevConfig.senderTrustMap[senderId] ?? elevConfig.defaultTrustLevel;
      const modelRoute = elevConfig.trustModelRoutes[tl];
      if (modelRoute) {
        deps.eventBus.emit("elevated:model_routed", {
          sessionKey: formatSessionKey(sessionKey),
          senderTrustLevel: tl,
          modelRoute,
          agentId,
          timestamp: systemNowMs(),
        });
        effectiveMsg = {
          ...effectiveMsg,
          metadata: {
            ...(effectiveMsg.metadata ?? {}),
            modelRoute,
          },
        };
      }
      const promptOverride = elevConfig.trustPromptOverrides[tl];
      if (promptOverride) {
        effectiveMsg = {
          ...effectiveMsg,
          metadata: {
            ...(effectiveMsg.metadata ?? {}),
            systemPromptOverride: promptOverride,
          },
        };
      }
    }
  }

  // Stage 2: LLM execution with timeout, thinking filter, abort signal
  const execResult = await executeLlm(
    deps, adapter, effectiveMsg, sessionKey, agentId, executor,
    trustLevel, blockStreamCfg, replyTo, typingLifecycle,
    tools, directives,
  );

  try {
    if (execResult.timedOut) {
      emitDiagnostic(0, 0, "timeout");
      return;
    }

    // Signal execution complete for thinking mode
    if (typingLifecycle && blockStreamCfg.typingMode !== "message") {
      typingLifecycle.markRunComplete();
    }

    // Stage 3: Response sanitization, filtering, media, voice, prefix
    const filterResult = await filterExecutionResponse(
      deps, adapter, effectiveMsg, originalMsg, sessionKey, agentId,
      execResult.result, execResult.accumulated, replyTo,
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

    // Stage 4: Chunking, coalescing, block pacing, delivery
    await deliverExecutionResponse(
      deps, adapter, effectiveMsg, filterResult.text,
      blockStreamCfg, activePacers, replyTo,
      execResult.deliverySignal, typingLifecycle,
    );

    // Emit message:sent event with the cleaned response content
    deps.eventBus.emit("message:sent", {
      channelId: effectiveMsg.channelId,
      messageId: "block-delivery",
      content: filterResult.text,
    });

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
          chatId: effectiveMsg.channelId,
          durationMs: systemNowMs() - startedAt,
          timestamp: systemNowMs(),
        });
      }
    }
  }
}

