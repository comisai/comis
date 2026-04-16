/**
 * Video attachment handler for media preprocessor.
 *
 * Resolves video attachment, describes via callback, truncates description,
 * and returns result for orchestrator collection.
 *
 * @module
 */

import type { Attachment } from "@comis/core";
import type { Result } from "@comis/shared";
import type { MediaProcessorLogger } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";

/** Deps subset needed by the video handler. */
export interface VideoHandlerDeps {
  readonly describeVideo?: (
    video: Buffer,
    mimeType: string,
    prompt: string,
  ) => Promise<Result<{ text: string; provider: string; model: string }, Error>>;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly maxVideoDescriptionChars?: number;
  readonly logger: MediaProcessorLogger;
}

/** Result produced by video processing. */
export interface VideoHandlerResult {
  textPrefix?: string;
  videoDescription?: { attachmentUrl: string; description: string };
}

/**
 * Process a single video attachment.
 *
 * - If no describer, returns hint text prefix.
 * - Otherwise resolves + describes via callback with truncation.
 */
export async function processVideoAttachment(
  att: Attachment,
  deps: VideoHandlerDeps,
  buildHint: (att: Attachment) => string,
): Promise<VideoHandlerResult> {
  if (!deps.describeVideo) {
    deps.logger.debug?.({ url: att.url, reason: "no-video-describer" },
      "Video skipped: no describer");
    return { textPrefix: buildHint(att) };
  }

  const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Video");
  if (!buffer) return {};

  try {
    const result = await deps.describeVideo(
      buffer,
      att.mimeType ?? "video/mp4",
      "Describe this video concisely.",
    );

    if (result.ok) {
      const maxChars = deps.maxVideoDescriptionChars ?? 500;
      const description = result.value.text.length > maxChars
        ? result.value.text.slice(0, maxChars).trimEnd()
        : result.value.text;
      deps.logger.info({ url: att.url, provider: result.value.provider }, "Video attachment described");
      deps.logger.debug?.({ url: att.url, mimeType: att.mimeType, reason: "video-described", provider: result.value.provider, model: result.value.model }, "Video attachment described");
      return {
        textPrefix: `[Video description]: ${description}`,
        videoDescription: { attachmentUrl: att.url, description },
      };
    } else {
      deps.logger.warn({ url: att.url, error: result.error.message, hint: "Video description API call failed; original text preserved", errorKind: "dependency" as const }, "Video description failed");
      deps.logger.debug?.({ url: att.url, reason: "video-failed", err: result.error.message }, "Video description failed");
    }
  } catch (e) {
    deps.logger.warn({ url: att.url, error: String(e), hint: "Unexpected error during video description; original text preserved", errorKind: "internal" as const }, "Video description threw unexpectedly");
    deps.logger.debug?.({ url: att.url, reason: "video-failed", err: String(e) }, "Video description threw unexpectedly");
  }

  return {};
}
