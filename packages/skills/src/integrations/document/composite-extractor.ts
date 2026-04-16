/**
 * Composite file extractor factory -- routes to text or PDF sub-extractor
 * based on MIME type.
 *
 * This is a thin routing wrapper that combines the text extractor and PDF
 * extractor behind a single FileExtractionPort interface.
 *
 * @module
 */

import type { FileExtractionPort, FileExtractionInput } from "@comis/core";

/**
 * Create a composite file extractor that routes to the appropriate sub-extractor.
 *
 * PDF MIME types are routed to `pdfExtractor`, all others to `textExtractor`.
 *
 * @param deps - Text and PDF sub-extractors
 * @returns A unified FileExtractionPort implementation
 */
export function createCompositeFileExtractor(deps: {
  textExtractor: FileExtractionPort;
  pdfExtractor: FileExtractionPort;
}): FileExtractionPort {
  const pdfMimes = new Set<string>(deps.pdfExtractor.supportedMimes);
  const supportedMimes = [
    ...deps.textExtractor.supportedMimes,
    ...deps.pdfExtractor.supportedMimes,
  ];

  return {
    supportedMimes,
    async extract(input: FileExtractionInput) {
      const mime =
        input.source === "buffer" ? input.mimeType : input.mimeType ?? "application/octet-stream";
      return pdfMimes.has(mime)
        ? deps.pdfExtractor.extract(input)
        : deps.textExtractor.extract(input);
    },
  };
}
