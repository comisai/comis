/**
 * File extraction adapter — createFileExtractor() factory.
 *
 * Composes all helper modules (binary-detector, file-classifier, text-decoder)
 * into a complete FileExtractionPort implementation for text-based file formats.
 *
 * Supported: TXT, CSV, MD, HTML, XML, JSON, YAML, JavaScript, TypeScript,
 *            Python, Shell scripts, and other text-based MIME types.
 * Excluded: PDF (handled by the dedicated PDF extractor), images, audio, video, archives, Office formats.
 *
 * @module
 */

import type {
  FileExtractionPort,
  FileExtractionInput,
  FileExtractionResult,
  FileExtractionError,
  FileExtractionConfig,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

import { classifyFile } from "./file-classifier.js";
import { decodeTextBuffer } from "./text-decoder.js";
import { isBinaryContent } from "./binary-detector.js";

/**
 * Text-extractable MIME types supported by this adapter.
 *
 * PDF is explicitly excluded — it requires a dedicated PDF extraction
 * pipeline. All types here are pure text or structured text
 * formats that can be decoded via the text-decoder encoding pipeline.
 */
const TEXT_MIMES: readonly string[] = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "text/yaml",
  "application/x-yaml",
  "text/javascript",
  "text/x-python",
  "text/x-typescript",
  "application/x-sh",
] as const;

/**
 * Dependencies for the file extractor factory.
 */
export interface FileExtractorDeps {
  readonly config: FileExtractionConfig;
  readonly logger?: {
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Create a FileExtractionPort adapter for text-based file formats.
 *
 * The factory builds a Set<string> from config.allowedMimes for O(1)
 * MIME type lookups and returns a FileExtractionPort implementation.
 *
 * The extraction pipeline (in order):
 * 1. Resolve source (buffer vs URL — URL returns download_failed)
 * 2. Size check against config.maxBytes
 * 3. MIME classification (binary/unknown → unsupported_mime)
 * 4. Binary content detection (null bytes and non-printable ratio)
 * 5. Text decoding (BOM → UTF-8 → chardet → iconv → fallback)
 * 6. Truncation at config.maxChars with visible marker
 * 7. Return successful FileExtractionResult
 *
 * @param deps - Config and optional logger
 * @returns FileExtractionPort implementation
 */
export function createFileExtractor(deps: FileExtractorDeps): FileExtractionPort {
  const { config } = deps;
  const allowedMimes = new Set<string>(config.allowedMimes);

  return {
    supportedMimes: TEXT_MIMES,

    async extract(
      input: FileExtractionInput,
    ): Promise<Result<FileExtractionResult, FileExtractionError>> {
      const start = Date.now();

      // 1. Resolve source
      if (input.source === "url") {
        return err({
          kind: "download_failed",
          message: "URL-based extraction requires resolver (not available)",
          fileName: input.fileName,
        });
      }

      const buffer = input.buffer;
      const mimeType = input.mimeType;
      const fileName = input.fileName;

      // 2. Size check
      if (buffer.length > config.maxBytes) {
        return err({
          kind: "size_exceeded",
          message: `File size ${buffer.length} exceeds limit of ${config.maxBytes} bytes`,
          fileName,
          mimeType,
        });
      }

      // 3. MIME classification
      const classification = classifyFile(mimeType, allowedMimes);

      if (classification === "binary") {
        deps.logger?.debug?.({ mimeType, fileName, reason: "binary" }, "File rejected: binary MIME");
        return err({
          kind: "unsupported_mime",
          message: `Binary file type not extractable: ${mimeType}`,
          fileName,
          mimeType,
        });
      }

      if (classification === "unknown") {
        deps.logger?.debug?.({ mimeType, fileName, reason: "unknown-mime" }, "File rejected: unknown MIME");
        return err({
          kind: "unsupported_mime",
          message: `Unsupported file type: ${mimeType ?? "unknown"}`,
          fileName,
          mimeType,
        });
      }

      // 4. Binary content detection
      if (isBinaryContent(buffer)) {
        deps.logger?.debug?.({ mimeType, fileName, reason: "binary-content" }, "File rejected: binary content");
        return err({
          kind: "corrupt",
          message: "File contains non-printable binary content",
          fileName,
          mimeType,
        });
      }

      // 5. Text decoding
      let rawText: string;
      try {
        rawText = decodeTextBuffer(buffer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err({
          kind: "encoding_error",
          message: `Encoding detection/conversion failed: ${message}`,
          fileName,
          mimeType,
        });
      }

      // 6. Truncation
      let text = rawText;
      let truncated = false;

      if (text.length > config.maxChars) {
        text = text.slice(0, config.maxChars) + `\n[truncated at ${config.maxChars} characters]`;
        truncated = true;
      }

      // 7. Return success
      return ok({
        text,
        fileName: fileName ?? "file",
        mimeType: mimeType ?? "text/plain",
        extractedChars: text.length,
        truncated,
        durationMs: Date.now() - start,
        buffer,
      });
    },
  };
}
