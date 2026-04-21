// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline Phase 3: Response Filtering.
 *
 * Handles response sanitization, response filtering (NO_REPLY/HEARTBEAT_OK
 * suppression), outbound media delivery, voice response pipeline, and
 * response prefix application.
 *
 * Follow-up trigger logic stays in the orchestrator (needs full closure deps).
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import { sanitizeAssistantResponse, extractFinalTagContent } from "@comis/agent";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import { buildThreadSendOpts } from "./execution-pipeline.js";
import { filterResponse } from "./response-filter.js";
import { executeVoiceResponse } from "./voice-response-pipeline.js";
import { deliverOutboundMedia } from "./outbound-media-handler.js";
import { applyPrefix } from "./prefix-template.js";
import { buildAbortSummary } from "./abort-summary.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the filter phase. */
export type FilterDeps = Pick<
  ExecutionPipelineDeps,
  | "eventBus"
  | "logger"
  | "voiceResponsePipeline"
  | "parseOutboundMedia"
  | "outboundMediaFetch"
  | "enforceFinalTag"
  | "responsePrefixConfig"
  | "buildTemplateContext"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of the filter phase. */
export type FilterResult =
  | { deliver: true; text: string }
  | { deliver: false; reason: string };

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Sanitize and filter the response, deliver outbound media, and run
 * voice response pipeline.
 *
 * Returns either text to deliver or a reason why delivery was skipped.
 */
export async function filterExecutionResponse(
  deps: FilterDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  accumulated: string,
  replyTo: string | undefined,
  resourceAborted: boolean,
  abortReason: string | undefined,
  diagFinishReason: string,
): Promise<FilterResult> {
  // Sanitize raw SDK output via the response sanitization pipeline.
  let response: string;
  if (result.response) {
    response = sanitizeAssistantResponse(result.response, { enforceFinalTag: deps.enforceFinalTag });
  } else if (accumulated) {
    // When falling back to accumulated text (result.response empty),
    // the accumulated buffer contains text from ALL intermediate turns — including
    // narration/commentary on tool-call turns (e.g. "Step 1 done...", "Plan: 1...").
    // Try extracting only <final> content first to strip narration.
    const finalOnly = extractFinalTagContent(accumulated);
    response = finalOnly || accumulated;
  } else {
    response = "";
  }

  if (!response && deps.enforceFinalTag) {
    deps.logger.warn({
      agentId: effectiveMsg.metadata?.agentId,
      hint: "Model did not use <final> tags; response suppressed by enforceFinalTag",
      errorKind: "validation" as const,
    }, "enforceFinalTag produced empty response");
  }
  if (!response) {
    // Resource aborts with empty response
    if (resourceAborted) {
      deps.logger.warn({
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        finishReason: diagFinishReason,
        abortReason,
        hint: "Resource abort produced empty response; sending accomplishment-aware notification to user",
        errorKind: "resource" as const,
      }, "Resource abort with empty response");

      const summary = buildAbortSummary(result);
      const message = summary
        ? `I ran out of processing budget. Here's what I completed:\n${summary}\n\nTo continue, send your next message or use +500k for more budget.`
        : "I've reached my processing limit for this request. Please try again or break the task into smaller steps.";

      await adapter.sendMessage(
        effectiveMsg.channelId,
        message,
        { replyTo },
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
      ).catch(() => { /* adapter logs internally */ });

      return { deliver: false, reason: "resource_abort_empty" };
    }

    // Normal completion with empty response — the LLM finished (finishReason "stop")
    // but produced no deliverable text. This happens when recovery text isn't
    // propagated through result.response, or when Gemini returns thinking-only content.
    // Send a canned acknowledgment so the user is never left with zero feedback.
    if (diagFinishReason === "stop") {
      deps.logger.warn({
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        hint: "LLM finished normally but produced empty response after all recovery paths; sending canned acknowledgment",
        errorKind: "dependency" as const,
      }, "Empty response on normal completion — sending fallback acknowledgment");

       
      await adapter.sendMessage(
        effectiveMsg.channelId,
        "I completed the requested operations but wasn't able to generate a summary. Please check the results or ask me to continue.",
        { replyTo },
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
      ).catch(() => { /* adapter logs internally */ });

      return { deliver: false, reason: "empty_stop_ack" };
    }

    deps.logger.debug({
      step: "empty-response",
      chatId: effectiveMsg.channelId,
      reason: diagFinishReason,
    }, "Empty response, skipping delivery");
    return { deliver: false, reason: "empty" };
  }

  // Response filter: strip <reply> tags, suppress NO_REPLY, HEARTBEAT_OK, empty
  const filter = filterResponse(response);
  deps.logger.debug({
    step: "response-filter",
    inputLen: response.length,
    outputLen: filter.cleanedText.length,
    success: filter.shouldDeliver,
    reason: filter.suppressedBy ?? "delivered",
  }, "Response filter applied");
  if (!filter.shouldDeliver) {
    deps.eventBus.emit("response:filtered", {
      channelId: adapter.channelId,
      suppressedBy: filter.suppressedBy!,
      timestamp: Date.now(),
    });
    return { deliver: false, reason: "filtered" };
  }

  // Use cleaned text (reply tags stripped) for delivery
  let finalDeliveryText = filter.cleanedText;

  // -------------------------------------------------------------------
  // OUTBOUND MEDIA PIPELINE
  // -------------------------------------------------------------------
  if (deps.parseOutboundMedia && deps.outboundMediaFetch) {
    const parsed = deps.parseOutboundMedia(finalDeliveryText);

    if (parsed.mediaUrls.length > 0) {
      deps.logger.debug({
        step: "outbound-media",
        mediaCount: parsed.mediaUrls.length,
        chatId: effectiveMsg.channelId,
      }, "MEDIA: directives found in response");

      const mediaResult = await deliverOutboundMedia(parsed.mediaUrls, {
        fetchUrl: deps.outboundMediaFetch,
        adapter,
        channelId: effectiveMsg.channelId,
        logger: deps.logger,
        sendOptions: buildThreadSendOpts(effectiveMsg.metadata),
      });

      deps.logger.debug({
        step: "outbound-media-delivered",
        delivered: mediaResult.delivered,
        failed: mediaResult.failed,
      }, "Outbound media delivery complete");

      finalDeliveryText = parsed.text;
    }
  }

  // -------------------------------------------------------------------
  // VOICE RESPONSE PIPELINE
  // -------------------------------------------------------------------
  if (deps.voiceResponsePipeline) {
    const voiceResult = await executeVoiceResponse(deps.voiceResponsePipeline, {
      responseText: finalDeliveryText,
      originalMessage: originalMsg,
      adapter,
      channelType: adapter.channelType,
      channelId: effectiveMsg.channelId,
      sendOptions: buildThreadSendOpts(effectiveMsg.metadata),
    });

    if (voiceResult.ok && voiceResult.value.voiceSent) {
      deps.logger.info(
        { channelType: adapter.channelType, chatId: effectiveMsg.channelId },
        "Voice response delivered, skipping text delivery",
      );
      deps.eventBus.emit("message:sent", {
        channelId: effectiveMsg.channelId,
        messageId: "voice-delivery",
        content: finalDeliveryText,
      });
      return { deliver: false, reason: "voice_delivered" };
    }
    if (!voiceResult.ok) {
      deps.logger.warn(
        {
          channelType: adapter.channelType,
          chatId: effectiveMsg.channelId,
          err: voiceResult.error.message,
          hint: "Voice response pipeline returned error, falling back to text delivery",
          errorKind: "internal" as const,
        },
        "Voice response pipeline error",
      );
    }
  }

  // If text is empty after stripping MEDIA: lines
  if (!finalDeliveryText.trim()) {
    deps.eventBus.emit("message:sent", {
      channelId: effectiveMsg.channelId,
      messageId: "media-only-delivery",
      content: finalDeliveryText,
    });
    return { deliver: false, reason: "media_only" };
  }

  // === RESPONSE PREFIX ===
  if (deps.responsePrefixConfig?.template && deps.buildTemplateContext) {
    const templateCtx = deps.buildTemplateContext(agentId, adapter.channelType, effectiveMsg);
    finalDeliveryText = applyPrefix(finalDeliveryText, deps.responsePrefixConfig, templateCtx);
  }

  return { deliver: true, text: finalDeliveryText };
}
