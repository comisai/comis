// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  FileExtractionConfigSchema,
  DOCUMENT_MIME_WHITELIST,
  MediaConfigSchema,
  McpServerEntrySchema,
} from "./schema-integrations.js";

describe("DOCUMENT_MIME_WHITELIST", () => {
  it("contains exactly 14 MIME types", () => {
    expect(DOCUMENT_MIME_WHITELIST.length).toBe(14);
  });

  it("includes all required document MIME types", () => {
    const required = [
      "text/plain",
      "text/csv",
      "text/markdown",
      "text/html",
      "text/xml",
      "application/json",
      "application/xml",
      "application/pdf",
      "text/yaml",
      "application/x-yaml",
      "text/javascript",
      "text/x-python",
      "text/x-typescript",
      "application/x-sh",
    ];
    for (const mime of required) {
      expect(DOCUMENT_MIME_WHITELIST).toContain(mime);
    }
  });

  it("contains no duplicates", () => {
    expect(new Set(DOCUMENT_MIME_WHITELIST).size).toBe(DOCUMENT_MIME_WHITELIST.length);
  });
});

describe("FileExtractionConfigSchema", () => {
  it("produces all defaults from empty input", () => {
    const result = FileExtractionConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.allowedMimes.length).toBe(14);
    expect(result.maxBytes).toBe(10_485_760);
    expect(result.maxChars).toBe(200_000);
    expect(result.maxTotalChars).toBe(500_000);
    expect(result.maxPages).toBe(20);
    expect(result.timeoutMs).toBe(30_000);
    expect(result.pdfImageFallback).toBe(false);
    expect(result.pdfImageFallbackThreshold).toBe(50);
  });

  it("allows explicit overrides", () => {
    const result = FileExtractionConfigSchema.parse({
      enabled: false,
      maxChars: 100_000,
      pdfImageFallback: true,
    });
    expect(result.enabled).toBe(false);
    expect(result.maxChars).toBe(100_000);
    expect(result.pdfImageFallback).toBe(true);
    // Other fields keep defaults
    expect(result.maxBytes).toBe(10_485_760);
    expect(result.maxTotalChars).toBe(500_000);
    expect(result.maxPages).toBe(20);
    expect(result.timeoutMs).toBe(30_000);
    expect(result.pdfImageFallbackThreshold).toBe(50);
  });

  it("rejects negative maxBytes", () => {
    expect(() => FileExtractionConfigSchema.parse({ maxBytes: -1 })).toThrow();
  });

  it("rejects non-integer maxChars", () => {
    expect(() => FileExtractionConfigSchema.parse({ maxChars: 1.5 })).toThrow();
  });

  it("allows zero pdfImageFallbackThreshold", () => {
    const result = FileExtractionConfigSchema.parse({ pdfImageFallbackThreshold: 0 });
    expect(result.pdfImageFallbackThreshold).toBe(0);
  });

  it("rejects unknown keys in strict mode", () => {
    expect(() => FileExtractionConfigSchema.parse({ unknownField: true })).toThrow();
  });
});

describe("MediaConfigSchema - documentExtraction nesting", () => {
  it("includes documentExtraction with defaults from empty input", () => {
    const result = MediaConfigSchema.parse({});
    expect(result.documentExtraction).toBeDefined();
    expect(result.documentExtraction.enabled).toBe(true);
    expect(result.documentExtraction.allowedMimes.length).toBe(14);
  });

  it("includes imageGeneration with defaults from empty input", () => {
    const result = MediaConfigSchema.parse({});
    expect(result.imageGeneration).toBeDefined();
    expect(result.imageGeneration.provider).toBe("fal");
    expect(result.imageGeneration.safetyChecker).toBe(true);
    expect(result.imageGeneration.maxPerHour).toBe(10);
    expect(result.imageGeneration.defaultSize).toBe("1024x1024");
    expect(result.imageGeneration.timeoutMs).toBe(60_000);
  });

  it("accepts explicit documentExtraction overrides", () => {
    const result = MediaConfigSchema.parse({
      documentExtraction: { maxPages: 10 },
    });
    expect(result.documentExtraction.maxPages).toBe(10);
    // Other fields have defaults
    expect(result.documentExtraction.enabled).toBe(true);
    expect(result.documentExtraction.maxBytes).toBe(10_485_760);
    expect(result.documentExtraction.maxChars).toBe(200_000);
  });
});

describe("McpServerEntrySchema", () => {
  it("accepts alphanumeric, hyphen, underscore names", () => {
    for (const name of ["context7", "gemini-image", "my_server", "abc_123-xyz", "A", "9"]) {
      expect(() =>
        McpServerEntrySchema.parse({ name, transport: "stdio", command: "npx" }),
      ).not.toThrow();
    }
  });

  it("rejects names with path-unsafe characters", () => {
    for (const name of ["nano banana", "my/server", "..", "has.dot", "name\\back", "name|pipe", ""]) {
      expect(() =>
        McpServerEntrySchema.parse({ name, transport: "stdio", command: "npx" }),
      ).toThrow();
    }
  });

  it("reports the allowed character set in the error message", () => {
    try {
      McpServerEntrySchema.parse({ name: "bad name", transport: "stdio", command: "npx" });
      throw new Error("expected parse to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/alphanumeric|hyphens|underscores/i);
    }
  });
});
