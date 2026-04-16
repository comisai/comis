/**
 * Media message preprocessor: Pre-execution media processing for voice, image,
 * and video attachments.
 *
 * Detects audio, image, and video attachments on NormalizedMessage, routes them
 * to the appropriate media adapters (TranscriptionPort for audio,
 * ImageAnalysisPort for images, describeVideo callback for video), and prepends
 * transcripts/analyses/descriptions to the message text.
 *
 * The preprocessor is designed for graceful degradation:
 * - Missing transcriber → audio hint injected for agent tool use
 * - Missing imageAnalyzer → image hint injected for agent tool use
 * - Missing describeVideo → video hint injected for agent tool use
 * - Missing fileExtractor → document hint injected for agent tool use
 * - Missing resolveAttachment → all media attachments skipped (no hints)
 * - Adapter errors → logged as warnings, original text preserved
 *
 * @module
 */

import type {
  NormalizedMessage,
  Attachment,
  TranscriptionPort,
  ImageAnalysisPort,
  FileExtractionPort,
  FileExtractionConfig,
  WrapExternalContentOptions,
} from "@comis/core";
import { DOCUMENT_MIME_WHITELIST } from "@comis/core";
import type { Result } from "@comis/shared";
import { processAudioAttachment } from "./media-handler-audio.js";
import { processImageAttachment } from "./media-handler-image.js";
import { processVideoAttachment } from "./media-handler-video.js";
import { processDocumentAttachment } from "./media-handler-document.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Logger interface for media preprocessor. */
export interface MediaProcessorLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies for the media message preprocessor. */
export interface MediaProcessorDeps {
  /** Transcription adapter (e.g., Whisper). Omit to skip voice processing. */
  readonly transcriber?: TranscriptionPort;
  /** Image analysis adapter (e.g., Claude Vision). Omit to skip image processing. */
  readonly imageAnalyzer?: ImageAnalysisPort;
  /** Function to resolve attachment URLs/protocols to raw Buffer data. */
  readonly resolveAttachment?: (attachment: Attachment) => Promise<Buffer | null>;
  /** Maximum allowed file size in bytes. Attachments exceeding this are skipped. */
  readonly maxMediaBytes?: number;
  /** When true, build ImageContent blocks instead of text descriptions for image attachments. */
  readonly visionAvailable?: boolean;
  /** Sanitize image buffer for API limits. Required when visionAvailable=true. */
  readonly sanitizeImage?: (buffer: Buffer, mimeType: string) => Promise<Result<{ buffer: Buffer; mimeType: string; width: number; height: number; originalBytes: number; sanitizedBytes: number }, string>>;
  /** Video description callback. Omit to skip video processing. */
  readonly describeVideo?: (
    video: Buffer,
    mimeType: string,
    prompt: string,
  ) => Promise<Result<{ text: string; provider: string; model: string }, Error>>;
  /** Maximum video description output characters (default: 500). */
  readonly maxVideoDescriptionChars?: number;
  /** Logger for preprocessing events. */
  readonly logger: MediaProcessorLogger;
  /** File extractor for document attachments (optional; documents silently skipped when absent). */
  readonly fileExtractor?: FileExtractionPort;
  /** File extraction config for budget limits. When absent, defaults apply. */
  readonly fileExtractionConfig?: Pick<FileExtractionConfig, "maxTotalChars">;
  /** Optional callback for suspicious content detection in external content. */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

/** Result of preprocessing a message. */
export interface PreprocessResult {
  /** The enriched message with transcriptions/analyses prepended to text. */
  message: NormalizedMessage;
  /** Transcription results (one per audio attachment). */
  transcriptions: Array<{ attachmentUrl: string; text: string; language?: string }>;
  /** Image analysis results (one per image attachment). */
  analyses: Array<{ attachmentUrl: string; description: string }>;
  /** Image content blocks for native multimodal injection (populated when visionAvailable=true). */
  imageContents: Array<{ type: "image"; data: string; mimeType: string }>;
  /** Video description results (one per video attachment). */
  videoDescriptions: Array<{ attachmentUrl: string; description: string }>;
  /** File extraction results (one per document attachment processed). */
  fileExtractions: FileExtractionMetric[];
}

/** Per-file extraction metrics. */
export interface FileExtractionMetric {
  url: string;
  fileName: string;
  mimeType: string;
  extractedChars: number;
  truncated: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Set of document-extractable MIME types for O(1) lookup. */
const DOCUMENT_MIMES = new Set<string>(DOCUMENT_MIME_WHITELIST);

/**
 * Classify an attachment as audio, image, video, document, or other based on
 * MIME type prefix and attachment type field.
 */
function classifyAttachment(att: Attachment): "audio" | "image" | "video" | "document" | "other" {
  // Check MIME type first (more specific)
  if (att.mimeType) {
    if (att.mimeType.startsWith("audio/")) return "audio";
    if (att.mimeType.startsWith("image/")) return "image";
    if (att.mimeType.startsWith("video/")) return "video";
    if (DOCUMENT_MIMES.has(att.mimeType)) return "document";
  }
  // Fall back to attachment type field
  if (att.type === "audio") return "audio";
  if (att.type === "image") return "image";
  if (att.type === "video") return "video";
  if (att.type === "file") return "document";
  return "other";
}

/**
 * Build a structured hint string for an attachment that was skipped because its
 * processor is absent. The hint tells the agent what was attached and which tool
 * to use for on-demand processing.
 */
function buildAttachmentHint(
  kind: "audio" | "image" | "video" | "document",
  att: Attachment,
  toolName: string,
): string {
  switch (kind) {
    case "audio": {
      const duration = att.durationMs ? `${att.durationMs}ms, ` : "";
      const mime = att.mimeType ?? "audio/ogg";
      return `[Attached: voice message (${duration}${mime}) — use ${toolName} tool to listen | url: ${att.url}]`;
    }
    case "image": {
      const mime = att.mimeType ?? "image/jpeg";
      const size = att.sizeBytes ? `, ${att.sizeBytes} bytes` : "";
      return `[Attached: image (${mime}${size}) — use ${toolName} tool to view | url: ${att.url}]`;
    }
    case "video": {
      const mime = att.mimeType ?? "video/mp4";
      const size = att.sizeBytes ? `, ${att.sizeBytes} bytes` : "";
      const duration = att.durationMs ? `, ${att.durationMs}ms` : "";
      return `[Attached: video (${mime}${size}${duration}) — use ${toolName} tool to view | url: ${att.url}]`;
    }
    case "document": {
      const fileName = att.fileName ?? "file";
      const mime = att.mimeType ?? "application/octet-stream";
      const size = att.sizeBytes ? `, ${att.sizeBytes} bytes` : "";
      return `[Attached: document "${fileName}" (${mime}${size}) — use ${toolName} tool to read | url: ${att.url}]`;
    }
  }
}

/**
 * Preprocess a NormalizedMessage, transcribing voice and analyzing image attachments.
 *
 * Enriches the message text with transcriptions and image analyses, while
 * preserving the original attachments for downstream consumers.
 *
 * @param deps - Media processor dependencies (adapters, resolver, logger)
 * @param msg - The incoming normalized message
 * @returns PreprocessResult with enriched message and individual results
 */
export async function preprocessMessage(
  deps: MediaProcessorDeps,
  msg: NormalizedMessage,
): Promise<PreprocessResult> {
  const transcriptions: PreprocessResult["transcriptions"] = [];
  const analyses: PreprocessResult["analyses"] = [];
  const imageContents: PreprocessResult["imageContents"] = [];
  const videoDescriptions: PreprocessResult["videoDescriptions"] = [];
  const fileExtractions: PreprocessResult["fileExtractions"] = [];

  // Short-circuit: no attachments to process
  if (!msg.attachments || msg.attachments.length === 0) {
    return { message: msg, transcriptions, analyses, imageContents, videoDescriptions, fileExtractions };
  }

  // Short-circuit: no resolver means we cannot fetch any media data
  if (!deps.resolveAttachment) {
    deps.logger.info("No resolveAttachment provided, skipping media preprocessing");
    return { message: msg, transcriptions, analyses, imageContents, videoDescriptions, fileExtractions };
  }

  const textPrefixes: string[] = [];
  const resolveAttachment = deps.resolveAttachment;

  const DEFAULT_MAX_TOTAL_CHARS = 500_000;
  const maxTotalChars = deps.fileExtractionConfig?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  let totalExtractedChars = 0;

  for (const att of msg.attachments) {
    // File size pre-check before download (applies to all types)
    if (deps.maxMediaBytes && att.sizeBytes && att.sizeBytes > deps.maxMediaBytes) {
      deps.logger.debug?.({
        url: att.url,
        sizeBytes: att.sizeBytes,
        maxBytes: deps.maxMediaBytes,
        reason: "oversized",
      }, "Attachment rejected: exceeds size limit");
      continue;
    }

    const kind = classifyAttachment(att);

    if (kind === "audio") {
      const r = await processAudioAttachment(att, { transcriber: deps.transcriber, resolveAttachment, logger: deps.logger }, (a) => buildAttachmentHint("audio", a, "transcribe_audio"));
      if (r.textPrefix) textPrefixes.push(r.textPrefix);
      if (r.transcription) transcriptions.push(r.transcription);
    } else if (kind === "image") {
      const r = await processImageAttachment(att, { imageAnalyzer: deps.imageAnalyzer, resolveAttachment, visionAvailable: deps.visionAvailable, sanitizeImage: deps.sanitizeImage, logger: deps.logger }, imageContents.length, (a) => buildAttachmentHint("image", a, "image_analyze"));
      if (r.textPrefix) textPrefixes.push(r.textPrefix);
      if (r.analysis) analyses.push(r.analysis);
      if (r.imageContent) imageContents.push(r.imageContent);
    } else if (kind === "video") {
      const r = await processVideoAttachment(att, { describeVideo: deps.describeVideo, resolveAttachment, maxVideoDescriptionChars: deps.maxVideoDescriptionChars, logger: deps.logger }, (a) => buildAttachmentHint("video", a, "describe_video"));
      if (r.textPrefix) textPrefixes.push(r.textPrefix);
      if (r.videoDescription) videoDescriptions.push(r.videoDescription);
    } else if (kind === "document") {
      const budgetState = { totalExtractedChars, maxTotalChars };
      const r = await processDocumentAttachment(att, { fileExtractor: deps.fileExtractor, resolveAttachment, logger: deps.logger, onSuspiciousContent: deps.onSuspiciousContent }, budgetState, (a) => buildAttachmentHint("document", a, "extract_document"));
      if (r.textPrefix) textPrefixes.push(r.textPrefix);
      if (r.fileExtraction) fileExtractions.push(r.fileExtraction);
      if (r.extractedChars) totalExtractedChars += r.extractedChars;
    }
    // 'other' attachments are silently skipped
  }

  // Build enriched text: prefixes joined by newlines, then original text
  const enrichedText =
    textPrefixes.length > 0 ? `${textPrefixes.join("\n")}\n\n${msg.text}` : msg.text;

  return {
    message: { ...msg, text: enrichedText },
    transcriptions,
    analyses,
    imageContents,
    videoDescriptions,
    fileExtractions,
  };
}
