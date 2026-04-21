// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

// ─── File Extraction ──────────────────────────────────────────────

/**
 * Classification of a file based on its MIME type.
 *
 * - `"document"`: Extractable text content in the MIME whitelist (PDF, plain text, CSV, etc.)
 * - `"binary"`: Known binary format (images, audio, video, archives) — not text-extractable
 * - `"unknown"`: Unrecognized MIME type — classification cannot be determined
 */
export type FileClassification = "document" | "binary" | "unknown";

/**
 * Error categories for file extraction failures.
 */
export type FileExtractionErrorKind =
  | "timeout"
  | "encrypted"
  | "size_exceeded"
  | "unsupported_mime"
  | "encoding_error"
  | "corrupt"
  | "download_failed"
  | "internal";

/**
 * Structured error returned by FileExtractionPort on failure.
 */
export interface FileExtractionError {
  readonly kind: FileExtractionErrorKind;
  readonly message: string;
  readonly mimeType?: string;
  readonly fileName?: string;
}

/**
 * Input for file extraction. Discriminated union on the `source` field.
 *
 * - `"buffer"`: Extract from an in-memory buffer (mimeType required).
 * - `"url"`: Extract from a remote URL (mimeType optional, may need detection).
 */
export type FileExtractionInput =
  | {
      readonly source: "buffer";
      readonly buffer: Buffer;
      readonly mimeType: string;
      readonly fileName?: string;
      readonly sizeBytes?: number;
    }
  | {
      readonly source: "url";
      readonly url: string;
      readonly mimeType?: string;
      readonly fileName?: string;
      readonly sizeBytes?: number;
    };

/**
 * Result of a successful file extraction.
 */
export interface FileExtractionResult {
  /** Extracted text content. */
  readonly text: string;
  /** File name (original or detected). */
  readonly fileName: string;
  /** MIME type of the source file. */
  readonly mimeType: string;
  /** Number of characters in the extracted text. */
  readonly extractedChars: number;
  /** Whether the text was truncated to fit maxChars. */
  readonly truncated: boolean;
  /** Time taken for extraction in milliseconds. */
  readonly durationMs: number;
  /** Original file buffer for downstream re-use. */
  readonly buffer: Buffer;
  /** Number of pages extracted (for paginated formats like PDF). */
  readonly pageCount?: number;
  /** Total pages in the document (may differ from pageCount if maxPages limit applied). */
  readonly totalPages?: number;
}

/**
 * FileExtractionPort: Hexagonal boundary for document text extraction services.
 *
 * Adapters implement this interface to extract text content from document files
 * (PDF, plain text, CSV, etc.). The port accepts both in-memory buffers and
 * remote URLs as input sources.
 */
export interface FileExtractionPort {
  /**
   * Extract text content from a document file.
   *
   * @param input - File source (buffer or URL) with metadata
   * @returns Extraction result with text and metrics, or a structured error
   */
  extract(
    input: FileExtractionInput,
  ): Promise<Result<FileExtractionResult, FileExtractionError>>;

  /** MIME types this adapter can extract text from. */
  readonly supportedMimes: ReadonlyArray<string>;
}
