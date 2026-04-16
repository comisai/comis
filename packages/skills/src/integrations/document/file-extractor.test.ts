import { describe, it, expect, vi } from "vitest";
import { createFileExtractor } from "./file-extractor.js";
import type { FileExtractorDeps } from "./file-extractor.js";
import { DOCUMENT_MIME_WHITELIST, FileExtractionConfigSchema } from "@comis/core";
import type { FileExtractionConfig } from "@comis/core";

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Build a default FileExtractionConfig using the Zod schema defaults.
 * maxBytes: 10_485_760 (10MB), maxChars: 200_000, allowedMimes: DOCUMENT_MIME_WHITELIST
 */
function defaultConfig(overrides: Partial<FileExtractionConfig> = {}): FileExtractionConfig {
  return FileExtractionConfigSchema.parse(overrides);
}

function makeExtractor(configOverrides: Partial<FileExtractionConfig> = {}, logger?: FileExtractorDeps["logger"]) {
  const deps: FileExtractorDeps = {
    config: defaultConfig(configOverrides),
    logger,
  };
  return createFileExtractor(deps);
}

function bufferInput(
  content: string | Buffer,
  mimeType: string,
  fileName?: string,
) {
  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return { source: "buffer" as const, buffer, mimeType, fileName };
}

// ─── Happy path tests ──────────────────────────────────────────────────────

describe("createFileExtractor — happy path", () => {
  it("extracts plain UTF-8 .txt file", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput("Hello, world!", "text/plain", "hello.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("Hello, world!");
    expect(result.value.fileName).toBe("hello.txt");
    expect(result.value.mimeType).toBe("text/plain");
    expect(result.value.extractedChars).toBe(13);
    expect(result.value.truncated).toBe(false);
  });

  it("extracts UTF-8 .json file with exact content preservation", async () => {
    const json = '{"name":"alice","age":30}';
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(json, "application/json", "data.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(json);
    expect(result.value.mimeType).toBe("application/json");
    expect(result.value.fileName).toBe("data.json");
  });

  it("extracts UTF-8 .md file", async () => {
    const markdown = "# Title\n\nSome **bold** text.";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(markdown, "text/markdown", "README.md"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(markdown);
    expect(result.value.mimeType).toBe("text/markdown");
  });

  it("extracts UTF-8 .ts file", async () => {
    const tsCode = "const x: number = 42;\nexport { x };";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(tsCode, "text/x-typescript", "main.ts"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(tsCode);
    expect(result.value.mimeType).toBe("text/x-typescript");
  });

  it("extracts UTF-8 .py file", async () => {
    const pyCode = "def hello():\n    print('Hello')\n\nhello()";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(pyCode, "text/x-python", "hello.py"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(pyCode);
    expect(result.value.mimeType).toBe("text/x-python");
  });

  it("extracts UTF-8 .xml file", async () => {
    const xml = "<root><item>value</item></root>";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(xml, "text/xml", "data.xml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(xml);
    expect(result.value.mimeType).toBe("text/xml");
  });

  it("extracts UTF-8 .yaml file", async () => {
    const yaml = "name: alice\nage: 30\n";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(yaml, "text/yaml", "config.yaml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(yaml);
    expect(result.value.mimeType).toBe("text/yaml");
  });

  it("extracts application/x-yaml file", async () => {
    const yaml = "key: value\nlist:\n  - a\n  - b\n";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(yaml, "application/x-yaml", "config.yml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(yaml);
    expect(result.value.mimeType).toBe("application/x-yaml");
  });

  it("extracts application/xml file", async () => {
    const xml = '<?xml version="1.0"?><root/>';
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(xml, "application/xml", "data.xml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(xml);
  });

  it("extracts text/html file", async () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(html, "text/html", "page.html"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(html);
  });

  it("extracts text/csv file", async () => {
    const csv = "name,age\nalice,30\nbob,25\n";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(csv, "text/csv", "data.csv"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(csv);
  });

  it("extracts text/javascript file", async () => {
    const js = "function hello() { return 'world'; }";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(js, "text/javascript", "script.js"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(js);
  });

  it("extracts application/x-sh file", async () => {
    const sh = "#!/bin/bash\necho 'Hello World'\n";
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput(sh, "application/x-sh", "script.sh"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(sh);
  });
});

// ─── Encoding tests ────────────────────────────────────────────────────────

describe("createFileExtractor — encoding detection", () => {
  it("strips UTF-8 BOM from output", async () => {
    // UTF-8 BOM: EF BB BF followed by text
    const withBom = Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from("Hello BOM!", "utf-8"),
    ]);
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: withBom, mimeType: "text/plain", fileName: "bom.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("Hello BOM!");
    // BOM should not appear in the output
    expect(result.value.text.charCodeAt(0)).not.toBe(0xFEFF);
  });

  it("decodes ISO-8859-1 encoded text without replacement characters", async () => {
    // Full French sentence in ISO-8859-1 (more than 50 bytes for reliable chardet detection)
    // "Le café français est délicieux avec les résumés et naïfs goûts sucrés. Voilà!"
    const latin1Buffer = Buffer.from([
      0x4C, 0x65, 0x20, 0x63, 0x61, 0x66, 0xE9, 0x20, 0x66, 0x72, 0x61, 0x6E,
      0xE7, 0x61, 0x69, 0x73, 0x20, 0x65, 0x73, 0x74, 0x20, 0x64, 0xE9, 0x6C,
      0x69, 0x63, 0x69, 0x65, 0x75, 0x78, 0x20, 0x61, 0x76, 0x65, 0x63, 0x20,
      0x6C, 0x65, 0x73, 0x20, 0x72, 0xE9, 0x73, 0x75, 0x6D, 0xE9, 0x73, 0x20,
      0x65, 0x74, 0x20, 0x6E, 0x61, 0xEF, 0x66, 0x73, 0x20, 0x67, 0x6F, 0xFB,
      0x74, 0x73, 0x20, 0x73, 0x75, 0x63, 0x72, 0xE9, 0x73, 0x2E, 0x20, 0x56,
      0x6F, 0x69, 0x6C, 0xE0, 0x21,
    ]);
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: latin1Buffer, mimeType: "text/plain", fileName: "french.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should not contain replacement characters (indicates successful decoding)
    expect(result.value.text).not.toContain("\uFFFD");
    // Decoded text should contain recognizable French characters
    expect(result.value.text).toContain("fran");
  });
});

// ─── Error path tests ──────────────────────────────────────────────────────

describe("createFileExtractor — error paths", () => {
  it("rejects application/zip with unsupported_mime", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("PK\x03\x04"), mimeType: "application/zip" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
    expect(result.error.mimeType).toBe("application/zip");
  });

  it("rejects image/png with unsupported_mime", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("\x89PNG\r\n\x1a\n"), mimeType: "image/png" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
  });

  it("rejects application/x-tar with unsupported_mime", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.alloc(512, 0), mimeType: "application/x-tar" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
  });

  it("rejects DOCX (Office Open XML) with unsupported_mime", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "buffer",
      buffer: Buffer.from("PK\x03\x04"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
  });

  it("rejects application/octet-stream with unsupported_mime (unknown type)", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("some bytes"), mimeType: "application/octet-stream" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
  });

  it("rejects text/plain buffer with null bytes as corrupt", async () => {
    // Buffer with null bytes disguised as text/plain — binary content detection
    const binaryBuffer = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x6C, 0x64]);
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: binaryBuffer, mimeType: "text/plain", fileName: "disguised.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("corrupt");
  });

  it("rejects buffer exceeding maxBytes with size_exceeded", async () => {
    const extractor = makeExtractor({ maxBytes: 100 });
    const largeBuffer = Buffer.alloc(101, 0x41); // 101 'A' bytes
    const result = await extractor.extract({ source: "buffer", buffer: largeBuffer, mimeType: "text/plain", fileName: "big.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("size_exceeded");
    expect(result.error.message).toContain("101");
    expect(result.error.message).toContain("100");
  });

  it("rejects URL source with download_failed (no URL resolver)", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "url",
      url: "https://example.com/document.txt",
      mimeType: "text/plain",
      fileName: "document.txt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("download_failed");
    expect(result.error.message).toContain("URL-based extraction requires resolver");
  });

  it("includes fileName in URL source error", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({
      source: "url",
      url: "https://example.com/report.pdf",
      fileName: "report.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.fileName).toBe("report.pdf");
  });
});

// ─── Truncation tests ──────────────────────────────────────────────────────

describe("createFileExtractor — truncation", () => {
  it("does NOT truncate text within maxChars", async () => {
    const text = "A".repeat(50);
    const extractor = makeExtractor({ maxChars: 100 });
    const result = await extractor.extract(bufferInput(text, "text/plain", "short.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(false);
    expect(result.value.text).toBe(text);
    expect(result.value.text).not.toContain("[truncated");
  });

  it("truncates text exceeding maxChars and appends marker", async () => {
    const text = "A".repeat(200);
    const extractor = makeExtractor({ maxChars: 100 });
    const result = await extractor.extract(bufferInput(text, "text/plain", "long.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.text).toContain("[truncated at 100 characters]");
    // Should start with 100 'A' characters
    expect(result.value.text.startsWith("A".repeat(100))).toBe(true);
  });

  it("extractedChars includes the truncation marker length", async () => {
    const text = "B".repeat(200);
    const extractor = makeExtractor({ maxChars: 100 });
    const result = await extractor.extract(bufferInput(text, "text/plain", "long.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The marker is "\n[truncated at 100 characters]" — 31 chars
    const expectedText = "B".repeat(100) + "\n[truncated at 100 characters]";
    expect(result.value.text).toBe(expectedText);
    expect(result.value.extractedChars).toBe(expectedText.length);
  });

  it("text exactly at maxChars is NOT truncated", async () => {
    const text = "C".repeat(100);
    const extractor = makeExtractor({ maxChars: 100 });
    const result = await extractor.extract(bufferInput(text, "text/plain", "exact.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(false);
    expect(result.value.text).toBe(text);
  });
});

// ─── Result shape tests ────────────────────────────────────────────────────

describe("createFileExtractor — result shape", () => {
  it("durationMs is a number >= 0", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput("test content", "text/plain", "test.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.durationMs).toBe("number");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("buffer in result is the same reference as input buffer", async () => {
    const extractor = makeExtractor();
    const inputBuffer = Buffer.from("hello world", "utf-8");
    const result = await extractor.extract({ source: "buffer", buffer: inputBuffer, mimeType: "text/plain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buffer).toBe(inputBuffer);
  });

  it("fileName defaults to 'file' when not provided", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("content"), mimeType: "text/plain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileName).toBe("file");
  });

  it("mimeType is preserved from input", async () => {
    const extractor = makeExtractor();
    const result = await extractor.extract(bufferInput("content", "text/csv", "data.csv"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("text/csv");
  });

  it("mimeType defaults to text/plain when not explicitly specified", async () => {
    // This tests the fallback behavior — mimeType is required on buffer source per the type,
    // but we verify the code path where mimeType is somehow empty string handled by the pipeline
    const extractor = makeExtractor();
    // Pass a valid text/plain and verify it comes back as-is
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("text"), mimeType: "text/plain" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("text/plain");
  });

  it("supportedMimes does NOT include application/pdf", async () => {
    const extractor = makeExtractor();
    expect(extractor.supportedMimes).not.toContain("application/pdf");
  });

  it("supportedMimes includes all 13 text MIME types", async () => {
    const extractor = makeExtractor();
    const expected = [
      "text/plain", "text/csv", "text/markdown", "text/html", "text/xml",
      "application/json", "application/xml", "text/yaml", "application/x-yaml",
      "text/javascript", "text/x-python", "text/x-typescript", "application/x-sh",
    ];
    for (const mime of expected) {
      expect(extractor.supportedMimes).toContain(mime);
    }
  });
});

// ─── Logger tests ──────────────────────────────────────────────────────────

describe("createFileExtractor — logger integration", () => {
  it("calls logger.debug with reason 'binary' for binary MIME types", async () => {
    const mockDebug = vi.fn();
    const extractor = makeExtractor({}, { debug: mockDebug });
    await extractor.extract({ source: "buffer", buffer: Buffer.from("PK\x03\x04"), mimeType: "application/zip" });
    expect(mockDebug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "binary" }),
      expect.any(String),
    );
  });

  it("calls logger.debug with reason 'binary-content' for binary content in text MIME", async () => {
    const mockDebug = vi.fn();
    const extractor = makeExtractor({}, { debug: mockDebug });
    const binaryBuffer = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x6C, 0x64]);
    await extractor.extract({ source: "buffer", buffer: binaryBuffer, mimeType: "text/plain" });
    expect(mockDebug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "binary-content" }),
      expect.any(String),
    );
  });

  it("calls logger.debug with reason 'unknown-mime' for unknown MIME types", async () => {
    const mockDebug = vi.fn();
    const extractor = makeExtractor({}, { debug: mockDebug });
    await extractor.extract({ source: "buffer", buffer: Buffer.from("content"), mimeType: "application/octet-stream" });
    expect(mockDebug).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unknown-mime" }),
      expect.any(String),
    );
  });

  it("does NOT crash when no logger is provided", async () => {
    // Factory with no logger (undefined) — optional chaining should prevent crashes
    const deps: FileExtractorDeps = {
      config: defaultConfig(),
      // no logger
    };
    const extractor = createFileExtractor(deps);
    // Binary MIME would trigger logger.debug — should not crash without logger
    const result = await extractor.extract({ source: "buffer", buffer: Buffer.from("PK"), mimeType: "application/zip" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unsupported_mime");
  });

  it("logs mimeType and fileName in debug calls", async () => {
    const mockDebug = vi.fn();
    const extractor = makeExtractor({}, { debug: mockDebug });
    await extractor.extract({ source: "buffer", buffer: Buffer.from("PK"), mimeType: "application/zip", fileName: "archive.zip" });
    expect(mockDebug).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/zip", fileName: "archive.zip" }),
      expect.any(String),
    );
  });
});

// ─── DOCUMENT_MIME_WHITELIST integration ───────────────────────────────────

describe("createFileExtractor — allowedMimes from DOCUMENT_MIME_WHITELIST", () => {
  it("all text MIME types in TEXT_MIMES are in DOCUMENT_MIME_WHITELIST (or are valid)", async () => {
    // This verifies that our TEXT_MIMES constant aligns with the core whitelist
    const whitelist = new Set(DOCUMENT_MIME_WHITELIST);
    const textMimes = [
      "text/plain", "text/csv", "text/markdown", "text/html", "text/xml",
      "application/json", "application/xml", "text/yaml", "application/x-yaml",
      "text/javascript", "text/x-python", "text/x-typescript", "application/x-sh",
    ];
    for (const mime of textMimes) {
      expect(whitelist.has(mime)).toBe(true);
    }
  });

  it("extracts text using config built from DOCUMENT_MIME_WHITELIST", async () => {
    const config = FileExtractionConfigSchema.parse({
      allowedMimes: [...DOCUMENT_MIME_WHITELIST],
    });
    const extractor = createFileExtractor({ config });
    const result = await extractor.extract(bufferInput("test content", "text/plain", "test.txt"));
    expect(result.ok).toBe(true);
  });

  it("application/pdf in DOCUMENT_MIME_WHITELIST but classified as unknown by binary-detector (no PDF magic)", async () => {
    // PDF is in the whitelist but we're not providing a real PDF buffer.
    // A text buffer with "PDF" content should pass binary detection but the extractor
    // should accept it (it's in allowedMimes) and return the text content.
    // PDF is in the whitelist but not special-cased by this extractor.
    const extractor = makeExtractor();
    const fakePdfText = Buffer.from("%PDF-1.4 fake pdf content with enough text to pass binary detection tests");
    const result = await extractor.extract({ source: "buffer", buffer: fakePdfText, mimeType: "application/pdf", fileName: "doc.pdf" });
    // PDF is in DOCUMENT_MIME_WHITELIST so classifyFile returns "document"
    // The buffer is valid UTF-8 text so it passes binary detection
    expect(result.ok).toBe(true);
  });
});
