// SPDX-License-Identifier: Apache-2.0
import type {
  PerChannelStreamingConfig,
  SendMessageOptions,
  StreamingConfig,
} from "@comis/core";
import { PerChannelStreamingConfigSchema } from "@comis/core";

/** Metadata fields propagated when a follow-up stays in a channel thread. */
export const THREAD_PROPAGATION_KEYS = [
  "threadId",
  "telegramThreadId",
  "telegramIsForum",
  "telegramThreadScope",
] as const;

/** Build thread-related send options from inbound message metadata. */
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

/** Resolve per-channel overrides over global streaming defaults. */
export function resolveStreamingConfig(
  channelType: string,
  streamingConfig?: StreamingConfig,
): PerChannelStreamingConfig {
  if (!streamingConfig) return PerChannelStreamingConfigSchema.parse({});
  const perChannel = streamingConfig.perChannel[channelType];
  if (perChannel) return perChannel;
  return {
    ...PerChannelStreamingConfigSchema.parse({}),
    enabled: streamingConfig.enabled,
    chunkMode: streamingConfig.defaultChunkMode,
    chunkMinChars: streamingConfig.defaultChunkMinChars,
    deliveryTiming: streamingConfig.defaultDeliveryTiming,
    coalescer: streamingConfig.defaultCoalescer,
    typingMode: streamingConfig.defaultTypingMode,
    typingRefreshMs: streamingConfig.defaultTypingRefreshMs,
    typingCircuitBreakerThreshold: streamingConfig.defaultTypingCircuitBreakerThreshold,
    typingTtlMs: streamingConfig.defaultTypingTtlMs,
    useMarkdownIR: streamingConfig.defaultUseMarkdownIR,
    tableMode: streamingConfig.defaultTableMode,
    replyMode: streamingConfig.defaultReplyMode,
  };
}
