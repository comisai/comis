// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  FileExtractionConfigSchema,
  DOCUMENT_MIME_WHITELIST,
  MediaConfigSchema,
  McpConfigSchema,
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

describe("McpServerEntrySchema transport inference", () => {
  // Case 1: Claude-Desktop-style stdio config (the smoking-gun case from
  //         the production log: yfinance MCP via Telegram).
  it("infers transport='stdio' when command is provided and transport is omitted", () => {
    const result = McpServerEntrySchema.parse({
      name: "yfinance",
      command: "npx",
      args: ["yfinance-mcp-ts"],
    });
    expect(result.transport).toBe("stdio");
    expect(result.command).toBe("npx");
    expect(result.args).toEqual(["yfinance-mcp-ts"]);
  });

  // Case 2: URL-only HTTP server config.
  it("infers transport='http' when url is provided and transport is omitted", () => {
    const result = McpServerEntrySchema.parse({
      name: "ctx7",
      url: "https://ctx7.example.com",
    });
    expect(result.transport).toBe("http");
    expect(result.url).toBe("https://ctx7.example.com");
  });

  // Case 3: Explicit transport always wins over inference.
  it("preserves explicit transport='sse' even when url is provided", () => {
    const result = McpServerEntrySchema.parse({
      name: "ctx7",
      url: "https://x.example.com",
      transport: "sse",
    });
    expect(result.transport).toBe("sse");
  });

  // Case 4: No inferable source — schema rejects. (NOTE: This case
  // already throws under the current schema because `transport` is
  // required-no-default; it will continue throwing after Task 2
  // because the preprocess returns the entry unchanged and the
  // enum validator then surfaces the error. The test pins the
  // behavior at both ends of the refactor.)
  it("rejects when transport, command, and url are all missing", () => {
    expect(() =>
      McpServerEntrySchema.parse({ name: "broken" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // WR-01 regression — schema must reject inconsistent command + url
  // combinations BEFORE the runtime gets a chance to silently ignore one
  // of them. Pre-fix the first matching inference branch (command -> stdio)
  // won and the unused url field passed through, silently ignored at
  // runtime by createTransport. Operator misconfiguration produced no
  // warning.
  // -------------------------------------------------------------------------
  it("rejects entries that supply BOTH command and url without an explicit transport (WR-01)", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "both",
        command: "npx",
        url: "https://example.com/mcp",
      }),
    ).toThrow(/Ambiguous MCP server config|command\b.*\burl|both \`command\` and \`url\`/i);
  });

  it("ACCEPTS entries with both command and url when an explicit transport='stdio' is given", () => {
    // The explicit transport disambiguates — the url becomes a no-op
    // by-design, surfaced via runtime ignore (matches the pre-fix
    // behaviour but the explicit-transport opts the operator IN).
    const result = McpServerEntrySchema.parse({
      name: "both-stdio",
      transport: "stdio",
      command: "npx",
      url: "https://example.com/mcp",
    });
    expect(result.transport).toBe("stdio");
    expect(result.command).toBe("npx");
    expect(result.url).toBe("https://example.com/mcp");
  });

  it("ACCEPTS entries with both command and url when an explicit transport='http' is given", () => {
    const result = McpServerEntrySchema.parse({
      name: "both-http",
      transport: "http",
      command: "npx",
      url: "https://example.com/mcp",
    });
    expect(result.transport).toBe("http");
    expect(result.url).toBe("https://example.com/mcp");
  });
});

// ---------------------------------------------------------------------------
// Phase 63-01 — additive safety-hardening fields (SAFETY-02/04/06/08).
//
// Five additive Zod fields land on McpConfigSchema (3) and McpServerEntrySchema
// (2). The tests pin both default values and validator rejection of bad inputs
// so the rest of phase 63 can rely on a stable schema contract.
// ---------------------------------------------------------------------------

describe("McpConfigSchema — Phase 63 safety hardening additive fields", () => {
  it("produces safety-hardening defaults from an empty input object", () => {
    const result = McpConfigSchema.parse({});
    expect(result.safetyAllowedEnvKeys).toEqual([]);
    expect(result.osvCheckEnabled).toBe(true);
    expect(result.osvCacheTtlMs).toBe(86_400_000);
  });

  it("accepts an operator-supplied safetyAllowedEnvKeys array verbatim", () => {
    const result = McpConfigSchema.parse({
      safetyAllowedEnvKeys: ["CUSTOM_CA_CERT_PATH", "MY_OPERATOR_KEY"],
    });
    expect(result.safetyAllowedEnvKeys).toEqual([
      "CUSTOM_CA_CERT_PATH",
      "MY_OPERATOR_KEY",
    ]);
  });

  it("accepts osvCheckEnabled=false for air-gapped opt-out", () => {
    const result = McpConfigSchema.parse({ osvCheckEnabled: false });
    expect(result.osvCheckEnabled).toBe(false);
  });

  it("rejects osvCacheTtlMs=0 because positive() is required", () => {
    expect(() => McpConfigSchema.parse({ osvCacheTtlMs: 0 })).toThrow();
  });

  it("rejects safetyAllowedEnvKeys entries that are empty strings", () => {
    expect(() =>
      McpConfigSchema.parse({ safetyAllowedEnvKeys: [""] }),
    ).toThrow();
  });
});

describe("McpServerEntrySchema — Phase 63 safety hardening additive fields", () => {
  it("parses without disablePlaintextSecretCheck or rlimits when both are omitted", () => {
    const result = McpServerEntrySchema.parse({
      name: "yfinance",
      transport: "stdio",
      command: "node",
    });
    expect(result.disablePlaintextSecretCheck).toBeUndefined();
    expect(result.rlimits).toBeUndefined();
  });

  it("accepts disablePlaintextSecretCheck=true as an opt-out escape hatch", () => {
    const result = McpServerEntrySchema.parse({
      name: "yfinance",
      transport: "stdio",
      command: "node",
      disablePlaintextSecretCheck: true,
    });
    expect(result.disablePlaintextSecretCheck).toBe(true);
  });

  it("accepts a partial rlimits override with only cpu set", () => {
    const result = McpServerEntrySchema.parse({
      name: "yfinance",
      transport: "stdio",
      command: "node",
      rlimits: { cpu: 600 },
    });
    expect(result.rlimits).toEqual({ cpu: 600 });
  });

  it("rejects rlimits.as values that are not positive integers", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "yfinance",
        transport: "stdio",
        command: "node",
        rlimits: { as: -1 },
      }),
    ).toThrow();
  });

  it("rejects rlimits.nofile values that are not positive integers", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "yfinance",
        transport: "stdio",
        command: "node",
        rlimits: { nofile: 0 },
      }),
    ).toThrow();
  });
});
