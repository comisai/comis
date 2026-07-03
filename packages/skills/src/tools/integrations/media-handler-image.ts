// SPDX-License-Identifier: Apache-2.0
/**
 * Image attachment handler for media preprocessor.
 *
 * Handles two paths:
 * - Vision-direct: sanitize image buffer and produce ImageContent block
 * - Analyzer fallback: text description via ImageAnalysisPort
 *
 * @module
 */

import type { Attachment, ImageAnalysisPort } from "@comis/core";
import { wrapExternalContent, type WrapExternalContentOptions } from "@comis/core";
import type { Result } from "@comis/shared";
import { fileTypeFromBuffer } from "file-type";
import type { MediaProcessorLogger } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";

/**
 * MEDIA-TYPE: determine the VERIFIED image MIME from the actual bytes.
 * Telegram's `.jpg` file_path mislabels PNG bytes as image/jpeg, and the model vision API rejects
 * a declared type that mismatches the bytes (Anthropic 400 "specified image/jpeg, but the image
 * appears to be image/png"). The buffer-only resolve seam (`resolveMediaAttachment`) discards the
 * resolver's sniffed type, so we sniff here — the consumer that pairs the buffer with the media_type
 * for the request. Sniffed image type wins; fall back to the declared type (then image/jpeg).
 */
async function verifiedImageMime(buffer: Buffer, declared: string | undefined): Promise<string> {
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed?.mime.startsWith("image/")) return sniffed.mime;
  return declared ?? "image/jpeg";
}

/** Deps subset needed by the image handler. */
export interface ImageHandlerDeps {
  readonly imageAnalyzer?: ImageAnalysisPort;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly visionAvailable?: boolean;
  readonly sanitizeImage?: (buffer: Buffer, mimeType: string) => Promise<Result<{ buffer: Buffer; mimeType: string; width: number; height: number; originalBytes: number; sanitizedBytes: number }, string>>;
  readonly logger: MediaProcessorLogger;
  /** Optional callback for suspicious content detection. */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

/** Result produced by image processing. */
export interface ImageHandlerResult {
  textPrefix?: string;
  analysis?: { attachmentUrl: string; description: string };
  imageContent?: { type: "image"; data: string; mimeType: string };
}

/**
 * Process a single image attachment.
 *
 * - When visionAvailable=true: sanitize + produce ImageContent block.
 * - When visionAvailable=false/undefined: analyze via ImageAnalysisPort fallback.
 * - No analyzer: returns hint text prefix.
 */
export async function processImageAttachment(
  att: Attachment,
  deps: ImageHandlerDeps,
  imageContentCount: number,
  buildHint: (att: Attachment) => string,
): Promise<ImageHandlerResult> {
  // Vision-direct path: produce ImageContent blocks instead of text descriptions
  if (deps.visionAvailable === true) {
    // Cap imageContents at 10 per message
    if (imageContentCount >= 10) {
      deps.logger.warn({ url: att.url, limit: 10, hint: "Image content limit reached; excess images will not be processed", errorKind: "validation" as const }, "Image content limit reached, skipping remaining images");
      return {};
    }

    if (!deps.sanitizeImage) {
      deps.logger.debug?.({ url: att.url, reason: "no-sanitizer" }, "Image skipped: visionAvailable but no sanitizeImage");
      return {};
    }

    const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Image");
    if (!buffer) return {};

    const sanitizeResult = await deps.sanitizeImage(buffer, await verifiedImageMime(buffer, att.mimeType));
    if (sanitizeResult.ok) {
      deps.logger.debug?.({
        url: att.url,
        reason: "vision-direct",
        originalBytes: sanitizeResult.value.originalBytes,
        sanitizedBytes: sanitizeResult.value.sanitizedBytes,
      }, "Image prepared for vision-direct injection");
      return {
        imageContent: {
          type: "image",
          data: sanitizeResult.value.buffer.toString("base64"),
          mimeType: sanitizeResult.value.mimeType,
        },
      };
    } else {
      deps.logger.warn({ url: att.url, error: sanitizeResult.error, hint: "Image failed sanitization; skipping for vision-direct injection", errorKind: "validation" as const }, "Image sanitization failed, skipping");
    }

    // Do NOT fall through to analyzer path -- image was in vision-direct mode
    return {};
  }

  // Fallback: text description via imageAnalyzer
  if (!deps.imageAnalyzer) {
    deps.logger.debug?.({ url: att.url, reason: "no-analyzer" }, "Image skipped: no analyzer");
    return { textPrefix: buildHint(att) };
  }

  const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Image");
  if (!buffer) return {};

  try {
    const result = await deps.imageAnalyzer.analyze(buffer, "Describe this image in detail", {
      mimeType: await verifiedImageMime(buffer, att.mimeType),
    });

    if (result.ok) {
      deps.logger.info({ url: att.url }, "Image attachment analyzed");
      deps.logger.debug?.({ url: att.url, mimeType: att.mimeType, reason: "vision" }, "Image attachment analyzed");
      const wrapped = wrapExternalContent(
        `[Image analysis]: ${result.value}`,
        { source: "vision", onSuspiciousContent: deps.onSuspiciousContent },
      );
      return {
        textPrefix: wrapped,
        analysis: { attachmentUrl: att.url, description: result.value },
      };
    } else {
      deps.logger.warn({ url: att.url, error: result.error.message, hint: "Vision API analysis failed; image description unavailable", errorKind: "dependency" as const }, "Image analysis failed");
      deps.logger.debug?.({ url: att.url, reason: "vision-failed", err: result.error.message }, "Image analysis failed");
    }
  } catch (e) {
    deps.logger.warn({ url: att.url, error: String(e), hint: "Unexpected error during vision analysis; image description unavailable", errorKind: "internal" as const }, "Image analysis threw unexpectedly");
    deps.logger.debug?.({ url: att.url, reason: "vision-failed", err: String(e) }, "Image analysis threw unexpectedly");
  }

  return {};
}
