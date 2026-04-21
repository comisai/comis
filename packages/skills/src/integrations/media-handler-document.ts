// SPDX-License-Identifier: Apache-2.0
/**
 * Document attachment handler for media preprocessor.
 *
 * Extracts document content via FileExtractionPort, formats as XML block,
 * wraps with security boundary, and tracks per-file extraction metrics.
 *
 * @module
 */

import type { Attachment, FileExtractionPort } from "@comis/core";
import { wrapExternalContent, type WrapExternalContentOptions } from "@comis/core";
import { formatFileBlock } from "./document/xml-block.js";
import type { MediaProcessorLogger, FileExtractionMetric } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";

/** Budget state for tracking character extraction limits across attachments. */
export interface DocumentBudgetState {
  totalExtractedChars: number;
  maxTotalChars: number;
}

/** Deps subset needed by the document handler. */
export interface DocumentHandlerDeps {
  readonly fileExtractor?: FileExtractionPort;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly logger: MediaProcessorLogger;
  /** Optional callback for suspicious content detection. */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

/** Result produced by document processing. */
export interface DocumentHandlerResult {
  textPrefix?: string;
  fileExtraction?: FileExtractionMetric;
  extractedChars?: number;
}

/**
 * Process a single document attachment.
 *
 * - If no extractor, returns hint text prefix.
 * - If budget exhausted, skips silently.
 * - Otherwise resolves + extracts + formats XML block.
 */
export async function processDocumentAttachment(
  att: Attachment,
  deps: DocumentHandlerDeps,
  budgetState: DocumentBudgetState,
  buildHint: (att: Attachment) => string,
): Promise<DocumentHandlerResult> {
  // Skip when no file extractor configured -- emit hint for agent awareness
  if (!deps.fileExtractor) {
    deps.logger.debug?.({ url: att.url, reason: "no-extractor" }, "Document skipped: no file extractor");
    return { textPrefix: buildHint(att) };
  }

  // Budget exhaustion check BEFORE download
  if (budgetState.totalExtractedChars >= budgetState.maxTotalChars) {
    deps.logger.debug?.({ url: att.url, reason: "budget-exhausted", totalExtractedChars: budgetState.totalExtractedChars, maxTotalChars: budgetState.maxTotalChars }, "Document skipped: character budget exhausted");
    return {};
  }

  // Download via SSRF-guarded resolver (same as audio/image/video)
  const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Document");
  if (!buffer) return {};

  // Extract text via FileExtractionPort
  const extractResult = await deps.fileExtractor.extract({
    source: "buffer",
    buffer,
    mimeType: att.mimeType ?? "application/octet-stream",
    fileName: att.fileName,
  });

  if (!extractResult.ok) {
    // Graceful failure -- WARN log, continue pipeline
    deps.logger.warn(
      { url: att.url, errorKind: "dependency" as const, error: extractResult.error.message, kind: extractResult.error.kind, hint: "Document extraction failed; message pipeline continues" },
      "Document extraction failed",
    );
    deps.logger.debug?.({ url: att.url, reason: "extraction-failed", err: extractResult.error.message, errorKind: extractResult.error.kind }, "Document extraction failed");
    return {};
  }

  // Format as XML block, then wrap as external content to prevent injection
  const fileBlock = formatFileBlock(extractResult.value.text, extractResult.value.fileName, extractResult.value.mimeType);
  const wrapped = wrapExternalContent(fileBlock, { source: "document", onSuspiciousContent: deps.onSuspiciousContent });

  deps.logger.debug?.({
    url: att.url,
    reason: "document-extracted",
    extractedChars: extractResult.value.extractedChars,
    truncated: extractResult.value.truncated,
    durationMs: extractResult.value.durationMs,
  }, "Document attachment extracted");

  return {
    textPrefix: wrapped,
    fileExtraction: {
      url: att.url,
      fileName: extractResult.value.fileName,
      mimeType: extractResult.value.mimeType,
      extractedChars: extractResult.value.extractedChars,
      truncated: extractResult.value.truncated,
      durationMs: extractResult.value.durationMs,
    },
    extractedChars: extractResult.value.extractedChars,
  };
}
