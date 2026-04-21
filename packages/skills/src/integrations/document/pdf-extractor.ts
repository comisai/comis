// SPDX-License-Identifier: Apache-2.0
/**
 * PDF text extraction adapter -- createPdfExtractor() factory.
 *
 * Implements FileExtractionPort for application/pdf using pdfjs-dist.
 * Extracts text page-by-page with maxPages limit, encrypted PDF detection,
 * AbortController timeout protection, and lazy loading of pdfjs-dist.
 *
 * Security: isEvalSupported set to false (CVE-2024-4367 mitigation).
 *
 * @module
 */

import type {
  FileExtractionPort,
  FileExtractionInput,
  FileExtractionResult,
  FileExtractionError,
  FileExtractionConfig,
  VisionProvider,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { PdfPageRenderer } from "./pdf-page-renderer.js";
import { RENDER_SCALE, MAX_VISION_PAGES } from "./pdf-page-renderer.js";

/**
 * Dependencies for the PDF extractor factory.
 *
 * Mirrors FileExtractorDeps from file-extractor.ts, with the addition
 * of warn() for encrypted PDF detection logging.
 */
export interface PdfExtractorDeps {
  readonly config: FileExtractionConfig;
  readonly logger?: {
    debug?(obj: Record<string, unknown>, msg: string): void;
    warn?(obj: Record<string, unknown>, msg: string): void;
  };
  // Optional vision fallback for text-sparse PDF pages
  readonly visionProvider?: VisionProvider;
  readonly pdfPageRenderer?: PdfPageRenderer;
}

/**
 * Detect password-protected PDF errors from pdfjs-dist.
 *
 * pdfjs-dist does NOT export PasswordException, so we detect by checking
 * error.name and error.code properties instead of instanceof.
 * - code 1 = NEED_PASSWORD
 * - code 2 = INCORRECT_PASSWORD
 */
function isPasswordError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const obj = e as Record<string, unknown>;
  return (
    obj.name === "PasswordException" ||
    (typeof obj.code === "number" && (obj.code === 1 || obj.code === 2))
  );
}

/** Vision prompt for OCR fallback on text-sparse PDF pages. */
const VISION_PROMPT =
  "Extract all visible text from this PDF page image. Preserve the layout structure. Include text in tables, headers, footers, and image captions.";

/**
 * Create a FileExtractionPort adapter for PDF documents.
 *
 * The factory returns a FileExtractionPort implementation that extracts
 * text from PDF buffers using pdfjs-dist, loaded lazily via dynamic import.
 *
 * Extraction pipeline (in order):
 * 1. Resolve source (URL returns download_failed)
 * 2. Size check against config.maxBytes
 * 3. Lazy load pdfjs-dist via dynamic import
 * 4. AbortController timeout setup
 * 5. Load PDF document (isEvalSupported: false, verbosity: 0)
 * 6. Page-by-page text extraction (sequential, respects maxPages)
 * 7. Concatenate pages with "\n\n", truncate at maxChars
 * 8. Return FileExtractionResult with pageCount and totalPages
 * 9. Cleanup: pdf.destroy() in inner finally, clearTimeout in outer finally
 * 10. Error handling: encrypted detection, internal errors
 *
 * @param deps - Config and optional logger
 * @returns FileExtractionPort implementation for application/pdf
 */
export function createPdfExtractor(deps: PdfExtractorDeps): FileExtractionPort {
  return {
    supportedMimes: ["application/pdf"],

    async extract(
      input: FileExtractionInput,
    ): Promise<Result<FileExtractionResult, FileExtractionError>> {
      const start = Date.now();

      // 1. Resolve source -- URL not supported yet (deferred)
      if (input.source === "url") {
        return err({
          kind: "download_failed",
          message: "URL-based extraction requires resolver (not available)",
          fileName: input.fileName,
        });
      }

      const { buffer, mimeType } = input;
      const fileName = input.fileName ?? "file.pdf";

      // 2. Size check
      if (buffer.length > deps.config.maxBytes) {
        return err({
          kind: "size_exceeded",
          message: `File size ${buffer.length} exceeds limit of ${deps.config.maxBytes} bytes`,
          fileName,
          mimeType,
        });
      }

      // 3. Lazy load pdfjs-dist legacy build (cold-start avoidance)
      // The legacy build is required for Node.js -- the main build uses DOMMatrix
      // which is only available in browser environments.
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

      // 4. AbortController timeout setup
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.config.timeoutMs);

      try {
        // 5. Load PDF document
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(buffer),
          isEvalSupported: false, // SECURITY: CVE-2024-4367 mitigation
          verbosity: 0, // Suppress "Setting up fake worker" warning
        });
        const pdf = await loadingTask.promise;

        try {
          // 6. Page-by-page extraction (sequential -- NOT Promise.all)
          const pagesToExtract = Math.min(pdf.numPages, deps.config.maxPages);
          const texts: string[] = [];
          let visionPagesUsed = 0;

          for (let i = 1; i <= pagesToExtract; i++) {
            // Check abort signal BETWEEN pages
            if (controller.signal.aborted) {
              return err({
                kind: "timeout",
                message: `PDF extraction timed out after ${deps.config.timeoutMs}ms`,
                fileName,
                mimeType,
              });
            }

            const page = await pdf.getPage(i);
            const content = await page.getTextContent();

            // Filter TextItem vs TextMarkedContent
            // Use inline type guard with explicit cast to avoid brittle
            // import path for TextItem under NodeNext resolution.
            const pageText = (content.items as readonly Record<string, unknown>[])
              .filter((item): item is Record<string, unknown> & { str: string; hasEOL: boolean } =>
                typeof item === "object" && item !== null && "str" in item,
              )
              .map((item) => item.str + (item.hasEOL ? "\n" : ""))
              .join("");

            deps.logger?.debug?.({
              pageNum: i,
              textChars: pageText.length,
              sparse: pageText.length < deps.config.pdfImageFallbackThreshold,
            }, "PDF page extracted");

            // Vision fallback for text-sparse pages
            if (
              deps.config.pdfImageFallback &&
              deps.visionProvider &&
              deps.pdfPageRenderer &&
              pageText.length < deps.config.pdfImageFallbackThreshold &&
              visionPagesUsed < MAX_VISION_PAGES
            ) {
              const renderResult = await deps.pdfPageRenderer.render(page, RENDER_SCALE);
              if (renderResult.ok) {
                const visionResult = await deps.visionProvider.describeImage({
                  image: renderResult.value,
                  prompt: VISION_PROMPT,
                  mimeType: "image/png",
                });
                if (visionResult.ok) {
                  texts.push(
                    pageText.length > 0
                      ? `${pageText}\n[Vision OCR]: ${visionResult.value.text}`
                      : visionResult.value.text,
                  );
                  visionPagesUsed++;
                  deps.logger?.debug?.({
                    pageNum: i,
                    visionChars: visionResult.value.text.length,
                  }, "PDF page vision fallback applied");
                  continue;
                }
                // Vision failed -- fall through to push sparse text
                deps.logger?.debug?.({
                  pageNum: i,
                  err: visionResult.error,
                }, "PDF page vision fallback failed, using sparse text");
              } else {
                // Render failed -- fall through to push sparse text
                deps.logger?.debug?.({
                  pageNum: i,
                  err: renderResult.error,
                }, "PDF page render failed, using sparse text");
              }
            }

            texts.push(pageText);
          }

          // 7. Concatenate and truncate
          let text = texts.join("\n\n");
          let truncated = false;

          if (text.length > deps.config.maxChars) {
            text =
              text.slice(0, deps.config.maxChars) +
              `\n[truncated at ${deps.config.maxChars} characters]`;
            truncated = true;
          }

          // 8. Return success
          return ok({
            text,
            fileName,
            mimeType,
            extractedChars: text.length,
            truncated,
            durationMs: Date.now() - start,
            buffer,
            pageCount: pagesToExtract,
            totalPages: pdf.numPages,
          });
        } finally {
          // 9. Cleanup: destroy PDFDocumentProxy (prevents memory leak)
          await pdf.destroy();
        }
      } catch (e: unknown) {
        // 10. Error handling
        if (isPasswordError(e)) {
          deps.logger?.warn?.(
            { fileName, hint: "PDF is password-protected", errorKind: "auth" },
            "Encrypted PDF detected",
          );
          return err({
            kind: "encrypted",
            message: "PDF is password-protected",
            fileName,
            mimeType,
          });
        }

        const message = e instanceof Error ? e.message : String(e);
        deps.logger?.debug?.(
          { fileName, err: e },
          `PDF extraction failed: ${message}`,
        );
        return err({
          kind: "internal",
          message: `PDF extraction failed: ${message}`,
          fileName,
          mimeType,
        });
      } finally {
        // 9. Cleanup: clear timeout in outermost finally
        clearTimeout(timer);
      }
    },
  };
}
