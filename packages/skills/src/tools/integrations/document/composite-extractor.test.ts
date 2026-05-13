// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for composite file extractor factory.
 */

import type {
  FileExtractionPort,
  FileExtractionInput,
  FileExtractionResult,
  FileExtractionError,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createCompositeFileExtractor } from "./composite-extractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextExtractor(
  overrides?: Partial<FileExtractionPort>,
): FileExtractionPort {
  return {
    supportedMimes: ["text/plain", "text/csv", "text/markdown"],
    extract: vi.fn().mockResolvedValue(
      ok({
        text: "text content",
        fileName: "file.txt",
        mimeType: "text/plain",
        extractedChars: 12,
        truncated: false,
        durationMs: 5,
        buffer: Buffer.from("text content"),
      }),
    ),
    ...overrides,
  };
}

function makePdfExtractor(
  overrides?: Partial<FileExtractionPort>,
): FileExtractionPort {
  return {
    supportedMimes: ["application/pdf"],
    extract: vi.fn().mockResolvedValue(
      ok({
        text: "pdf content",
        fileName: "file.pdf",
        mimeType: "application/pdf",
        extractedChars: 11,
        truncated: false,
        durationMs: 50,
        buffer: Buffer.from("fake-pdf"),
        pageCount: 1,
        totalPages: 1,
      }),
    ),
    ...overrides,
  };
}

function makeBufferInput(
  mimeType: string,
  overrides?: Partial<Extract<FileExtractionInput, { source: "buffer" }>>,
): FileExtractionInput {
  return {
    source: "buffer",
    buffer: Buffer.from("test"),
    mimeType,
    fileName: "test-file",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCompositeFileExtractor", () => {
  it("routes application/pdf to pdfExtractor", async () => {
    const textExtractor = makeTextExtractor();
    const pdfExtractor = makePdfExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    const result = await composite.extract(makeBufferInput("application/pdf"));

    expect(result.ok).toBe(true);
    expect(pdfExtractor.extract).toHaveBeenCalledOnce();
    expect(textExtractor.extract).not.toHaveBeenCalled();
  });

  it("routes text/plain to textExtractor", async () => {
    const textExtractor = makeTextExtractor();
    const pdfExtractor = makePdfExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    const result = await composite.extract(makeBufferInput("text/plain"));

    expect(result.ok).toBe(true);
    expect(textExtractor.extract).toHaveBeenCalledOnce();
    expect(pdfExtractor.extract).not.toHaveBeenCalled();
  });

  it("routes text/csv to textExtractor", async () => {
    const textExtractor = makeTextExtractor();
    const pdfExtractor = makePdfExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    const result = await composite.extract(makeBufferInput("text/csv"));

    expect(result.ok).toBe(true);
    expect(textExtractor.extract).toHaveBeenCalledOnce();
    expect(pdfExtractor.extract).not.toHaveBeenCalled();
  });

  it("supportedMimes contains all MIME types from both sub-extractors", () => {
    const textExtractor = makeTextExtractor();
    const pdfExtractor = makePdfExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    expect(composite.supportedMimes).toContain("text/plain");
    expect(composite.supportedMimes).toContain("text/csv");
    expect(composite.supportedMimes).toContain("text/markdown");
    expect(composite.supportedMimes).toContain("application/pdf");
    expect(composite.supportedMimes).toHaveLength(4);
  });

  it("passes through pdfExtractor error when it returns err", async () => {
    const pdfExtractor = makePdfExtractor({
      extract: vi.fn().mockResolvedValue(
        err({ kind: "encrypted", message: "PDF is password-protected", fileName: "secret.pdf" }),
      ),
    });
    const textExtractor = makeTextExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    const result = await composite.extract(makeBufferInput("application/pdf"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("encrypted");
      expect(result.error.message).toBe("PDF is password-protected");
    }
    expect(pdfExtractor.extract).toHaveBeenCalledOnce();
  });

  it("passes through textExtractor error when it returns err", async () => {
    const textExtractor = makeTextExtractor({
      extract: vi.fn().mockResolvedValue(
        err({ kind: "encoding_error", message: "Failed to decode", fileName: "bad.txt" }),
      ),
    });
    const pdfExtractor = makePdfExtractor();
    const composite = createCompositeFileExtractor({ textExtractor, pdfExtractor });

    const result = await composite.extract(makeBufferInput("text/plain"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("encoding_error");
      expect(result.error.message).toBe("Failed to decode");
    }
    expect(textExtractor.extract).toHaveBeenCalledOnce();
  });
});
