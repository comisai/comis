// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline Phase 1: Agent Resolution + Media Preprocessing.
 *
 * Resolves agent identity, constructs scoped session key, then runs audio
 * preflight + media preprocessing on the resolved message.
 *
 * @module
 */

import type { NormalizedMessage, SessionKey, ChannelPort } from "@comis/core";
// Session-key builder lives at packages/orchestrator/src/session-key/session-key-builder.ts.
// Orchestrator's own TS build cannot import its own published package name, so the import
// must use the relative path.
import { buildScopedSessionKey } from "../session-key/session-key-builder.js";
import type { AgentExecutor } from "@comis/agent";
import { isBotMentioned, isGroupMessage, compressAttachments } from "@comis/channels";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/**
 * Minimal deps for the resolve-and-preprocess phase.
 *
 * Covers both sub-phases — agent resolution and media preprocessing — with
 * `logger` shared across both; 8 unique fields total.
 */
export type ResolveAndPreprocessDeps = Pick<
  InboundPipelineDeps,
  // Agent resolution sub-phase:
  | "logger" // shared with preprocess
  | "eventBus"
  | "messageRouter"
  | "sessionManager"
  | "createExecutor"
  // Media preprocessing sub-phase:
  | "audioPreflight"
  | "preprocessMessage"
  | "autoReplyEngineConfig"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Resolved + preprocessed agent context from Phase 1. */
export interface ResolveAndPreprocessResult {
  agentId: string;
  executor: AgentExecutor;
  sessionKey: SessionKey;
  /** Message post-preprocessing (preprocess output replaces the original message). */
  processedMsg: NormalizedMessage;
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Resolve the agent + session key, then run audio preflight + media
 * preprocessing on the inbound message.
 *
 * Returns undefined if no executor is configured for the resolved agent
 * (early exit — message should be dropped; preprocess is not run).
 */
export async function resolveAndPreprocess(
  deps: ResolveAndPreprocessDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
): Promise<ResolveAndPreprocessResult | undefined> {
  // ===== Phase 1A: Agent resolution =====

  // 1. Resolve agent FIRST (only needs RoutableMessage, not SessionKey)
  const agentId = deps.messageRouter.resolve({
    channelType: msg.channelType,
    channelId: msg.channelId,
    senderId: msg.senderId,
    guildId: msg.metadata?.guildId as string | undefined,
  });

  // 2. Get executor (early exit if none)
  const executor = deps.createExecutor(agentId);
  if (!executor) {
    deps.logger.warn({ agentId, channelId: msg.channelId, hint: "Ensure agent executor is registered before processing messages", errorKind: "config" as const }, "No executor configured for agent");
    return undefined;
  }

  // 3. senderId is used directly (no cross-platform identity resolution)
  const effectiveMsg = msg;

  // 4. Build scoped session key (defaults to per-channel-peer DM scope).
  //    threadId is sourced from a channel-specific metadata key
  //    (`msteamsThreadId`) rather than the generic thread extractor, so only
  //    that channel's threads split into separate sessions — every other
  //    channel stays at threadId:undefined and keeps a thread-less key.
  const sessionKey = buildScopedSessionKey({
    msg: effectiveMsg,
    agentId,
    adapterChannelId: adapter.channelId,
    threadId: effectiveMsg.metadata.msteamsThreadId as string | undefined,
  });

  // 5. Emit message:received with the scoped session key
  deps.eventBus.emit("message:received", { message: msg, sessionKey });

  // Load or create session
  deps.sessionManager.loadOrCreate(sessionKey);

  // ===== Phase 1B: Audio preflight + media preprocessing =====

  let processedMsg = effectiveMsg;
  const channelType = adapter.channelType;

  // -------------------------------------------------------------------
  // AUDIO PREFLIGHT: Transcribe voice before mention gate
  // -------------------------------------------------------------------
  // Runs BEFORE preprocessMessage so:
  //   1. Preflight transcribes audio and sets att.transcription
  //   2. preprocessMessage sees att.transcription and skips re-transcription
  //   3. Auto-reply gate sees enriched text with transcript for mention detection
  //
  // Only run in group chats with mention-gated activation where:
  // - Message has audio attachments
  // - Bot is NOT already mentioned in text/metadata
  // - audioPreflight callback is available
  if (deps.audioPreflight) {
    const isGroup = isGroupMessage(msg);
    const isMentionGated = deps.autoReplyEngineConfig?.groupActivation === "mention-gated";
    const hasAudio = msg.attachments?.some(
      (a) => a.type === "audio" || a.mimeType?.startsWith("audio/"),
    );
    const alreadyMentioned = isBotMentioned(msg);

    if (isGroup && isMentionGated && hasAudio && !alreadyMentioned) {
      try {
        const preflightResult = await deps.audioPreflight(msg);
        if (preflightResult.transcribed) {
          processedMsg = preflightResult.message;
          deps.logger.debug({
            step: "audio-preflight",
            channelType,
            chatId: processedMsg.channelId,
          }, "Audio preflight transcription applied");
        }
      } catch (preflightErr) {
        deps.logger.warn(
          { err: preflightErr, channelId: msg.channelId, hint: "Audio preflight failed, voice message may be dropped by mention gate", errorKind: "internal" as const },
          "Audio preflight failed",
        );
      }
    }
  }

  // Preprocess media attachments (voice transcription, image analysis)
  // NOTE: processedMsg already set above (either original msg or preflight-enriched)
  if (deps.preprocessMessage) {
    try {
      processedMsg = await deps.preprocessMessage(processedMsg);
    } catch (preprocessErr) {
      deps.logger.warn(
        { err: preprocessErr, channelId: msg.channelId, hint: "Media preprocessing failed; proceeding with original message", errorKind: "internal" as const },
        "Media preprocessing failed, using original message",
      );
    }
  }

  // -------------------------------------------------------------------
  // Media compression (runs before auto-reply evaluation)
  // -------------------------------------------------------------------
  if (deps.autoReplyEngineConfig) {
    const beforeAttachments = processedMsg.attachments?.length ?? 0;
    processedMsg = compressAttachments(processedMsg);
    const afterAttachments = processedMsg.attachments?.length ?? 0;
    if (beforeAttachments !== afterAttachments) {
      deps.logger.debug({
        step: "media-compress",
        inputLen: beforeAttachments,
        outputLen: afterAttachments,
      }, "Attachments compressed");
    }
  }

  return { agentId, executor, sessionKey, processedMsg };
}
