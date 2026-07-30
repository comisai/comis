// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for document attachment handler.
 */

import type { Attachment, FileExtractionPort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import {
  processDocumentAttachment,
  type DocumentHandlerDeps,
  type DocumentBudgetState,
} from "./media-handler-document.js";
import type { MediaProcessorLogger } from "./media-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MediaProcessorLogger & { debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDocumentAttachment(url = "tg-file://doc1"): Attachment {
  return {
    type: "file",
    url,
    mimeType: "application/pdf",
    fileName: "report.pdf",
    sizeBytes: 50_000,
  };
}

function makeFileExtractor(overrides?: {
  fail?: boolean;
  errorKind?: string;
  text?: string;
  truncated?: boolean;
}): FileExtractionPort {
  return {
    supportedMimes: ["text/plain", "application/pdf"],
    extract: overrides?.fail
      ? vi.fn().mockResolvedValue(err({ kind: overrides.errorKind ?? "internal", message: "extraction failed" }))
      : vi.fn().mockResolvedValue(ok({
          text: overrides?.text ?? "Extracted document content",
          fileName: "report.pdf",
          mimeType: "application/pdf",
          extractedChars: (overrides?.text ?? "Extracted document content").length,
          truncated: overrides?.truncated ?? false,
          durationMs: 15,
          buffer: Buffer.from("fake-pdf"),
        })),
  };
}

function makeResolver(): (att: Attachment) => Promise<Buffer | null> {
  return vi.fn().mockResolvedValue(Buffer.from("fake-pdf-data"));
}

function makeBudget(totalExtractedChars = 0, maxTotalChars = 500_000): DocumentBudgetState {
  return { totalExtractedChars, maxTotalChars };
}

const buildHint = (att: Attachment) =>
  `[Attached: document "${att.fileName ?? "file"}" (${att.mimeType ?? "application/octet-stream"}) — use extract_document tool to read | url: ${att.url}]`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processDocumentAttachment", () => {
  it("returns hint text prefix when no extractor", async () => {
    const deps: DocumentHandlerDeps = {
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toContain('[Attached: document "report.pdf"');
    expect(result.fileExtraction).toBeUndefined();
  });

  it("skips when budget exhausted", async () => {
    const logger = makeLogger();
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor(),
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(500_000, 500_000), buildHint,
    );

    expect(result.textPrefix).toBeUndefined();
    expect(result.fileExtraction).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "budget-exhausted" }),
      "Document skipped: character budget exhausted",
    );
  });

  it("returns formatted XML block on successful extraction", async () => {
    const fileExtractor = makeFileExtractor();
    const deps: DocumentHandlerDeps = {
      fileExtractor,
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toContain("<file name=");
    expect(result.textPrefix).toContain("Extracted document content");
    expect(result.textPrefix).toContain("UNTRUSTED_");
    expect(result.fileExtraction).toBeDefined();
    expect(result.fileExtraction!.url).toBe("tg-file://doc1");
    expect(result.fileExtraction!.fileName).toBe("report.pdf");
    expect(result.fileExtraction!.extractedChars).toBe("Extracted document content".length);
    expect(result.extractedChars).toBe("Extracted document content".length);
  });

  it("surfaces actionable coverage metadata before a truncated document", async () => {
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor({
        text: `${"A".repeat(200_000)}\n[truncated at 200000 characters]`,
        truncated: true,
      }),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toMatch(
      /only a prefix.*extracted.*do not claim.*entire file.*split.*smaller files/isu,
    );
    expect(result.textPrefix).toMatch(/resending.*unchanged.*not.*increase coverage/isu);
    expect(result.textPrefix!.indexOf("Document extraction coverage"))
      .toBeLessThan(result.textPrefix!.indexOf("SECURITY NOTICE"));
  });

  it("bounds an inline document preview and points recovery at the durable source", async () => {
    const sourceText = Array.from(
      { length: 20_000 },
      (_, index) => `line ${index}: source detail`,
    ).join("\n");
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor({
        text: sourceText,
        truncated: true,
      }),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
      durableFilePath: "documents/current.txt",
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(),
      deps,
      { ...makeBudget(), maxInlinePrefixChars: 20_000 },
      buildHint,
    );

    expect(result.textPrefix!.length).toBeLessThanOrEqual(20_000);
    expect(result.textPrefix).toContain('path="documents/current.txt"');
    expect(result.textPrefix).toMatch(/use.*read.*offset.*limit/isu);
    expect(result.textPrefix).toMatch(/do not claim.*entire file.*until/isu);
    expect(result.textPrefix).not.toContain("split it into smaller files");
  });

  it("does not promise source recovery when a truncated document was not persisted", async () => {
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor({
        text: "A".repeat(80_000),
        truncated: true,
      }),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(),
      deps,
      { ...makeBudget(), maxInlinePrefixChars: 20_000 },
      buildHint,
    );

    expect(result.textPrefix!.length).toBeLessThanOrEqual(20_000);
    expect(result.textPrefix).toMatch(/split.*smaller files/isu);
    expect(result.textPrefix).not.toMatch(/full original.*stored/isu);
  });

  it("returns empty result when extraction fails", async () => {
    const logger = makeLogger();
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor({ fail: true, errorKind: "encrypted" }),
      resolveAttachment: makeResolver(),
      logger,
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toBeUndefined();
    expect(result.fileExtraction).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Document extraction failed; message pipeline continues",
        errorKind: "dependency",
      }),
      "Document extraction failed",
    );
  });

  it("returns empty result when resolve fails", async () => {
    const logger = makeLogger();
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor(),
      resolveAttachment: vi.fn().mockRejectedValue(new Error("network error")),
      logger,
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toBeUndefined();
    expect(result.fileExtraction).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty result when resolve returns null", async () => {
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor(),
      resolveAttachment: vi.fn().mockResolvedValue(null),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.textPrefix).toBeUndefined();
    expect(result.fileExtraction).toBeUndefined();
  });

  it("reports extractedChars for budget tracking", async () => {
    const text50 = "x".repeat(50);
    const deps: DocumentHandlerDeps = {
      fileExtractor: makeFileExtractor({ text: text50 }),
      resolveAttachment: makeResolver(),
      logger: makeLogger(),
    };

    const result = await processDocumentAttachment(
      makeDocumentAttachment(), deps, makeBudget(), buildHint,
    );

    expect(result.extractedChars).toBe(50);
  });
});
