/**
 * Inbound Pipeline Phase 2: Media Preprocessing.
 *
 * Handles audio preflight transcription, media preprocessing
 * (voice transcription, image analysis), and attachment compression.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { isBotMentioned, isGroupMessage } from "./auto-reply-engine.js";
import { compressAttachments } from "./media-compressor.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the preprocessing phase. */
export type PreprocessDeps = Pick<
  InboundPipelineDeps,
  "logger" | "audioPreflight" | "preprocessMessage" | "autoReplyEngineConfig"
>;

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Run audio preflight, media preprocessing, and attachment compression
 * on an inbound message.
 *
 * Returns the (potentially transformed) message after all preprocessing.
 */
export async function preprocessInboundMessage(
  deps: PreprocessDeps,
  msg: NormalizedMessage,
  channelType: string,
): Promise<NormalizedMessage> {
  let processedMsg = msg;

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

  return processedMsg;
}
