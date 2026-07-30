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
import { formatFileBlock, xmlEscapeAttr } from "./document/xml-block.js";
import type { MediaProcessorLogger, FileExtractionMetric } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";

/** Budget state for tracking character extraction limits across attachments. */
export interface DocumentBudgetState {
  totalExtractedChars: number;
  maxTotalChars: number;
  /** Maximum room remaining for this complete model-visible prefix. */
  maxInlinePrefixChars?: number;
}

/** Deps subset needed by the document handler. */
export interface DocumentHandlerDeps {
  readonly fileExtractor?: FileExtractionPort;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly logger: MediaProcessorLogger;
  /** Workspace-relative path of the persisted original attachment, when available. */
  readonly durableFilePath?: string;
  /** Optional callback for suspicious content detection. */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

/** Result produced by document processing. */
export interface DocumentHandlerResult {
  textPrefix?: string;
  fileExtraction?: FileExtractionMetric;
  extractedChars?: number;
}

interface DocumentPrefixInput {
  readonly text: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly upstreamTruncated: boolean;
  readonly extractedChars: number;
  readonly durableFilePath?: string;
  readonly maxChars: number;
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

function coverageNote(
  input: DocumentPrefixInput,
  inlineChars: number,
  incomplete: boolean,
): string | undefined {
  if (!incomplete) return undefined;
  const attrs = [
    'complete="false"',
    `extracted-chars="${input.extractedChars}"`,
    `inline-chars="${inlineChars}"`,
  ];
  if (input.durableFilePath !== undefined) {
    attrs.push(`path="${xmlEscapeAttr(input.durableFilePath)}"`);
    return `<document-extraction-coverage ${attrs.join(" ")}>
Only a preview is inline. The full original file is stored at the trusted workspace path above. Use the read tool with that path and offset/limit to recover every required section. Do not claim the entire file was read until the necessary ranges have been read.
</document-extraction-coverage>`;
  }
  return `<document-extraction-coverage ${attrs.join(" ")}>
Only a prefix was extracted. Do not claim the entire file was read. Resending the same unchanged file will not increase coverage; the omitted source is not available through conversation recovery tools. Ask the user to split it into smaller files when complete coverage is required.
</document-extraction-coverage>`;
}

function renderDocumentPrefix(
  input: DocumentPrefixInput,
  inlineChars: number,
  incomplete: boolean,
  reportSuspiciousContent = false,
): string {
  const fileBlock = formatFileBlock(
    input.text.slice(0, inlineChars),
    input.fileName,
    input.mimeType,
  );
  const wrapped = wrapExternalContent(fileBlock, {
    source: "document",
    onSuspiciousContent: reportSuspiciousContent
      ? input.onSuspiciousContent
      : undefined,
  });
  const note = coverageNote(input, inlineChars, incomplete);
  return note === undefined ? wrapped : `${note}\n${wrapped}`;
}

/**
 * Fit a structurally complete external-content block into the caller's exact
 * remaining message budget. Rebuilding the wrapper avoids slicing through its
 * security delimiter or the document XML.
 */
function buildDocumentPrefix(input: DocumentPrefixInput): string | undefined {
  const full = renderDocumentPrefix(
    input,
    input.text.length,
    input.upstreamTruncated,
  );
  if (full.length <= input.maxChars) {
    return renderDocumentPrefix(
      input,
      input.text.length,
      input.upstreamTruncated,
      true,
    );
  }

  let low = 0;
  let high = input.text.length;
  let bestInlineChars: number | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = renderDocumentPrefix(input, mid, true);
    if (candidate.length <= input.maxChars) {
      bestInlineChars = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return bestInlineChars === undefined
    ? undefined
    : renderDocumentPrefix(input, bestInlineChars, true, true);
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

  const prefix = buildDocumentPrefix({
    text: extractResult.value.text,
    fileName: extractResult.value.fileName,
    mimeType: extractResult.value.mimeType,
    upstreamTruncated: extractResult.value.truncated,
    extractedChars: extractResult.value.extractedChars,
    durableFilePath: deps.durableFilePath,
    maxChars: budgetState.maxInlinePrefixChars ?? Number.POSITIVE_INFINITY,
    onSuspiciousContent: deps.onSuspiciousContent,
  });

  deps.logger.debug?.({
    url: att.url,
    reason: "document-extracted",
    extractedChars: extractResult.value.extractedChars,
    truncated: extractResult.value.truncated,
    durationMs: extractResult.value.durationMs,
  }, "Document attachment extracted");

  return {
    textPrefix: prefix,
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
