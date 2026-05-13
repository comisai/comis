// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileExtractionConfigSchema } from "@comis/core";
import type { FileExtractionConfig, VisionProvider } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createPdfExtractor } from "./pdf-extractor.js";
import type { PdfExtractorDeps } from "./pdf-extractor.js";
import type { PdfPageRenderer } from "./pdf-page-renderer.js";

// ─── Test fixture: minimal valid PDF with "Hello, world!" text ──────────────
const HELLO_WORLD_PDF = Buffer.from(
  "JVBERi0xLjcKCjEgMCBvYmogICUgZW50cnkgcG9pbnQKPDwKICAvVHlwZSAvQ2F0YWxvZwog" +
  "IC9QYWdlcyAyIDAgUgo+PgplbmRvYmoKCjIgMCBvYmoKPDwKICAvVHlwZSAvUGFnZXMKICAv" +
  "TWVkaWFCb3ggWyAwIDAgMjAwIDIwMCBdCiAgL0NvdW50IDEKICAvS2lkcyBbIDMgMCBSIF0K" +
  "Pj4KZW5kb2JqCgozIDAgb2JqCjw8CiAgL1R5cGUgL1BhZ2UKICAvUGFyZW50IDIgMCBSCiAg" +
  "L1Jlc291cmNlcyA8PAogICAgL0ZvbnQgPDwKICAgICAgL0YxIDQgMCBSIAogICAgPj4KICA+" +
  "PgogIC9Db250ZW50cyA1IDAgUgo+PgplbmRvYmoKCjQgMCBvYmoKPDwKICAvVHlwZSAvRm9u" +
  "dAogIC9TdWJ0eXBlIC9UeXBlMQogIC9CYXNlRm9udCAvVGltZXMtUm9tYW4KPj4KZW5kb2Jq" +
  "Cgo1IDAgb2JqICAlIHBhZ2UgY29udGVudAo8PAogIC9MZW5ndGggNDQKPj4Kc3RyZWFtCkJU" +
  "CjcwIDUwIFRECi9GMSAxMiBUZgooSGVsbG8sIHdvcmxkISkgVGoKRVQKZW5kc3RyZWFtCmVu" +
  "ZG9iagoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDEwIDAwMDAwIG4g" +
  "CjAwMDAwMDAwNzkgMDAwMDAgbiAKMDAwMDAwMDE3MyAwMDAwMCBuIAowMDAwMDAwMzAxIDAw" +
  "MDAwIG4gCjAwMDAwMDAzODAgMDAwMDAgbiAKdHJhaWxlcgo8PAogIC9TaXplIDYKICAvUm9v" +
  "dCAxIDAgUgo+PgpzdGFydHhyZWYKNDkyCiUlRU9G",
  "base64",
);

// ─── Hoisted mock setup ─────────────────────────────────────────────────────
// vi.mock is hoisted. We mock the legacy build path that the factory actually imports.
// For "real PDF" tests, useRealPdfjs flag routes to actual pdfjs-dist.
// For controlled tests, we use mock functions.

const mockGetPage = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());
const mockDocumentPromise = vi.hoisted(() => vi.fn());
const useRealPdfjs = vi.hoisted(() => ({ value: false }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...real,
    getDocument: (opts: unknown) => {
      if (useRealPdfjs.value) {
        return real.getDocument(opts as Parameters<typeof real.getDocument>[0]);
      }
      return {
        promise: mockDocumentPromise(),
      };
    },
  };
});

// ─── Test helpers ───────────────────────────────────────────────────────────

function defaultConfig(overrides: Partial<FileExtractionConfig> = {}): FileExtractionConfig {
  return FileExtractionConfigSchema.parse(overrides);
}

function makeExtractor(
  configOverrides: Partial<FileExtractionConfig> = {},
  logger?: PdfExtractorDeps["logger"],
) {
  return createPdfExtractor({ config: defaultConfig(configOverrides), logger });
}

/**
 * Configure the mock pdfjs-dist for a successful PDF load.
 */
function configureMockPdf(opts: {
  numPages: number;
  pageTexts?: string[];
  getPageDelay?: number;
}) {
  const { numPages, pageTexts = [], getPageDelay = 0 } = opts;

  mockGetPage.mockImplementation(async (pageNum: number) => {
    if (getPageDelay > 0) {
      await new Promise<void>((r) => setTimeout(r, getPageDelay));
    }
    const text = pageTexts[pageNum - 1] ?? "";
    return {
      getTextContent: async () => ({
        items: text
          ? [{ str: text, hasEOL: false, dir: "ltr", width: 100, height: 12, transform: [1, 0, 0, 1, 0, 0], fontName: "g_d0_f1" }]
          : [],
      }),
    };
  });

  mockDestroy.mockResolvedValue(undefined);
  mockDocumentPromise.mockResolvedValue({
    numPages,
    getPage: mockGetPage,
    destroy: mockDestroy,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createPdfExtractor", () => {
  it("supportedMimes contains only application/pdf", () => {
    const extractor = makeExtractor();
    expect(extractor.supportedMimes).toEqual(["application/pdf"]);
  });
});

describe("text extraction (real PDF)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = true;
  });

  afterEach(() => {
    useRealPdfjs.value = false;
  });

  it("extracts text from a simple PDF", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: HELLO_WORLD_PDF,
      mimeType: "application/pdf",
      fileName: "hello.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Hello");
    expect(result.value.pageCount).toBe(1);
    expect(result.value.totalPages).toBe(1);
    expect(result.value.mimeType).toBe("application/pdf");
    expect(result.value.fileName).toBe("hello.pdf");
    expect(result.value.truncated).toBe(false);
    expect(result.value.extractedChars).toBeGreaterThan(0);
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns internal error for corrupt/unparseable input", async () => {
    const extractor = makeExtractor();
    const randomBytes = Buffer.from("this is not a PDF file at all and never will be");
    const result = await extractor.extract({
      source: "buffer",
      buffer: randomBytes,
      mimeType: "application/pdf",
      fileName: "corrupt.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("internal");
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("returns size_exceeded for files over maxBytes", async () => {
    const extractor = makeExtractor({ maxBytes: 100 });
    const result = await extractor.extract({
      source: "buffer",
      buffer: HELLO_WORLD_PDF, // ~800 bytes > 100
      mimeType: "application/pdf",
      fileName: "large.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("size_exceeded");
    expect(result.error.message).toContain("100");
  });

  it("returns download_failed for URL source", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "url",
      url: "https://example.com/test.pdf",
      fileName: "test.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("download_failed");
  });

  it("defaults fileName to file.pdf when not provided", async () => {
    useRealPdfjs.value = true;
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: HELLO_WORLD_PDF,
      mimeType: "application/pdf",
    });
    useRealPdfjs.value = false;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileName).toBe("file.pdf");
  });
});

describe("pdf-extractor (mocked) - empty pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("returns empty text for a PDF with no text content", async () => {
    configureMockPdf({ numPages: 1, pageTexts: [] });
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "empty.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("");
    expect(result.value.pageCount).toBe(1);
    expect(result.value.truncated).toBe(false);
  });
});

describe("pdf-extractor (mocked) - page limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("extracts only maxPages pages from a multi-page document", async () => {
    configureMockPdf({
      numPages: 50,
      pageTexts: Array.from({ length: 50 }, (_, i) => `Page ${i + 1} content`),
    });
    const extractor = makeExtractor({ maxPages: 3 });
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "big.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mockGetPage).toHaveBeenCalledTimes(3);
    expect(mockGetPage).toHaveBeenCalledWith(1);
    expect(mockGetPage).toHaveBeenCalledWith(2);
    expect(mockGetPage).toHaveBeenCalledWith(3);
    expect(result.value.pageCount).toBe(3);
    expect(result.value.totalPages).toBe(50);
  });

  it("extracts all pages when numPages < maxPages", async () => {
    configureMockPdf({
      numPages: 2,
      pageTexts: ["Page 1", "Page 2"],
    });
    const extractor = makeExtractor({ maxPages: 20 });
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "short.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pageCount).toBe(2);
    expect(result.value.totalPages).toBe(2);
  });
});

describe("pdf-extractor (mocked) - encrypted PDF detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("returns encrypted error for password-protected PDF", async () => {
    const pwError = Object.assign(new Error("No password given"), {
      name: "PasswordException",
      code: 1,
    });
    mockDocumentPromise.mockRejectedValueOnce(pwError);

    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "locked.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encrypted");
    expect(result.error.message).toContain("password-protected");
  });

  it("detects encrypted via error code when name is missing", async () => {
    const pwError = Object.assign(new Error("Incorrect password"), {
      code: 2,
    });
    mockDocumentPromise.mockRejectedValueOnce(pwError);

    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "locked2.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encrypted");
  });
});

describe("pdf-extractor (mocked) - timeout protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("returns timeout error when extraction exceeds timeoutMs", async () => {
    // Configure mock so getPage takes 50ms each, but timeout is 1ms.
    // The abort signal fires after 1ms. The first getPage takes 50ms,
    // so by the time page 1 completes, the abort signal is set.
    // The loop checks it before page 2.
    configureMockPdf({
      numPages: 5,
      pageTexts: ["a", "b", "c", "d", "e"],
      getPageDelay: 50,
    });

    const extractor = makeExtractor({ timeoutMs: 1 });
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "slow.pdf",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(result.error.message).toContain("timed out");
  });
});

describe("pdf-extractor (mocked) - truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("truncates text at maxChars with visible marker", async () => {
    const longText = "A".repeat(1000);
    configureMockPdf({ numPages: 1, pageTexts: [longText] });

    const extractor = makeExtractor({ maxChars: 100 });
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "long.pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.text).toContain("[truncated at 100 characters]");
    expect(result.value.text.startsWith("A".repeat(100))).toBe(true);
    // extractedChars includes the marker text
    expect(result.value.extractedChars).toBe(result.value.text.length);
  });
});

describe("pdf-extractor (mocked) - logger integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("logs at warn for encrypted PDFs", async () => {
    const pwError = Object.assign(new Error("No password given"), {
      name: "PasswordException",
      code: 1,
    });
    mockDocumentPromise.mockRejectedValueOnce(pwError);

    const mockWarn = vi.fn();
    const extractor = createPdfExtractor({
      config: defaultConfig(),
      logger: { warn: mockWarn },
    });
    await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "locked.pdf",
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "locked.pdf",
        hint: "PDF is password-protected",
        errorKind: "auth",
      }),
      expect.any(String),
    );
  });

  it("does not crash when logger is undefined", async () => {
    configureMockPdf({ numPages: 1, pageTexts: ["test"] });
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });
    // Should not throw
    expect(result.ok).toBe(true);
  });
});

// ─── Vision Fallback Tests ──────────────────────────────────────────────────

/**
 * Configure mock pdfjs-dist with page objects that include getViewport and render
 * methods needed for vision fallback testing.
 */
function configureMockPdfWithPages(opts: {
  numPages: number;
  pageTexts?: string[];
}) {
  const { numPages, pageTexts = [] } = opts;

  mockGetPage.mockImplementation(async (pageNum: number) => {
    const text = pageTexts[pageNum - 1] ?? "";
    return {
      getTextContent: async () => ({
        items: text
          ? [{ str: text, hasEOL: false, dir: "ltr", width: 100, height: 12, transform: [1, 0, 0, 1, 0, 0], fontName: "g_d0_f1" }]
          : [],
      }),
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({ promise: Promise.resolve() }),
    };
  });

  mockDestroy.mockResolvedValue(undefined);
  mockDocumentPromise.mockResolvedValue({
    numPages,
    getPage: mockGetPage,
    destroy: mockDestroy,
  });
}

function createMockVisionProvider(overrides?: Partial<VisionProvider>): VisionProvider {
  return {
    id: "test-vision",
    capabilities: ["image"],
    describeImage: vi.fn().mockResolvedValue(ok({ text: "OCR result", provider: "test", model: "test-model" })),
    ...overrides,
  };
}

function createMockRenderer(overrides?: Partial<PdfPageRenderer>): PdfPageRenderer {
  return {
    available: true,
    render: vi.fn().mockResolvedValue(ok(Buffer.from("mock-png"))),
    ...overrides,
  };
}

describe("pdf-extractor (mocked) - vision fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealPdfjs.value = false;
  });

  it("skips vision fallback when pdfImageFallback is false", async () => {
    // Page text is below threshold (5 chars < 50 default threshold)
    configureMockPdfWithPages({ numPages: 1, pageTexts: ["Hello"] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: false }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("Hello");
    expect(mockVision.describeImage).not.toHaveBeenCalled();
    expect(mockRenderer.render).not.toHaveBeenCalled();
  });

  it("triggers vision fallback for sparse pages", async () => {
    // 5 chars is below default threshold of 50
    configureMockPdfWithPages({ numPages: 1, pageTexts: ["Hello"] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("[Vision OCR]: OCR result");
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);
    expect(mockVision.describeImage).toHaveBeenCalledTimes(1);
  });

  it("supplements sparse text with vision when sparse text > 0", async () => {
    configureMockPdfWithPages({ numPages: 1, pageTexts: ["Header"] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both sparse text and vision text should be present
    expect(result.value.text).toContain("Header");
    expect(result.value.text).toContain("[Vision OCR]: OCR result");
  });

  it("uses vision text alone when page text is empty", async () => {
    configureMockPdfWithPages({ numPages: 1, pageTexts: [] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Vision text alone, without the "[Vision OCR]:" prefix
    expect(result.value.text).toBe("OCR result");
    expect(result.value.text).not.toContain("[Vision OCR]:");
  });

  it("gracefully degrades when renderer fails", async () => {
    configureMockPdfWithPages({ numPages: 1, pageTexts: ["Sparse"] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer({
      render: vi.fn().mockResolvedValue(err(new Error("canvas failed"))),
    });

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Falls back to sparse text
    expect(result.value.text).toBe("Sparse");
    expect(mockVision.describeImage).not.toHaveBeenCalled();
  });

  it("gracefully degrades when visionProvider fails", async () => {
    configureMockPdfWithPages({ numPages: 1, pageTexts: ["Sparse"] });
    const mockVision = createMockVisionProvider({
      describeImage: vi.fn().mockResolvedValue(err(new Error("API error"))),
    });
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Falls back to sparse text
    expect(result.value.text).toBe("Sparse");
  });

  it("respects MAX_VISION_PAGES limit", async () => {
    // 10 sparse pages, all below threshold
    configureMockPdfWithPages({
      numPages: 10,
      pageTexts: Array.from({ length: 10 }, () => "x"),
    });
    const mockDescribeImage = vi.fn().mockResolvedValue(
      ok({ text: "OCR text", provider: "test", model: "test-model" }),
    );
    const mockVision = createMockVisionProvider({
      describeImage: mockDescribeImage,
    });
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    // Only 5 vision calls (MAX_VISION_PAGES = 5)
    expect(mockDescribeImage).toHaveBeenCalledTimes(5);
  });

  it("does not trigger vision for text-rich pages", async () => {
    // Page text is 200 chars, above default threshold of 50
    const richText = "A".repeat(200);
    configureMockPdfWithPages({ numPages: 1, pageTexts: [richText] });
    const mockVision = createMockVisionProvider();
    const mockRenderer = createMockRenderer();

    const extractor = createPdfExtractor({
      config: defaultConfig({ pdfImageFallback: true }),
      visionProvider: mockVision,
      pdfPageRenderer: mockRenderer,
    });

    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(richText);
    expect(mockVision.describeImage).not.toHaveBeenCalled();
    expect(mockRenderer.render).not.toHaveBeenCalled();
  });
});
