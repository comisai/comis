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

  // Case 4: No inferable source — schema rejects. The preprocess
  // returns the entry unchanged when nothing can be inferred and
  // the enum validator then surfaces the error.
  it("rejects when transport, command, and url are all missing", () => {
    expect(() =>
      McpServerEntrySchema.parse({ name: "broken" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Regression — schema must reject inconsistent command + url combinations
  // BEFORE the runtime gets a chance to silently ignore one of them. The
  // first matching inference branch (command -> stdio) won and the unused
  // url field passed through, silently ignored at runtime by createTransport.
  // Operator misconfiguration produced no warning.
  // -------------------------------------------------------------------------
  it("rejects entries that supply BOTH command and url without an explicit transport", () => {
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
// Additive safety-hardening fields.
//
// Five additive Zod fields land on McpConfigSchema (3) and McpServerEntrySchema
// (2). The tests pin both default values and validator rejection of bad inputs
// so downstream code can rely on a stable schema contract.
// ---------------------------------------------------------------------------

describe("McpConfigSchema — safety hardening additive fields", () => {
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

describe("McpServerEntrySchema — safety hardening additive fields", () => {
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

// ---------------------------------------------------------------------------
// Additive reliability fields (keepalive, circuit breaker). Combined
// schema + tests because the new fields are not on the inferred type
// pre-patch — `result.keepaliveIntervalMs` would be a TS error if tests
// preceded the schema change.
// ---------------------------------------------------------------------------

describe("McpConfigSchema — reliability additive fields", () => {
  it("produces reliability defaults from an empty input object", () => {
    const result = McpConfigSchema.parse({});
    // keepaliveIntervalMs is now optional (no Zod default); transport-aware default
    // is resolved at runtime by resolveDefaultKeepaliveIntervalMs (MCPX-02).
    expect(result.keepaliveIntervalMs).toBeUndefined();
    expect(result.circuitBreakerThreshold).toBe(3);
    expect(result.circuitBreakerCooldownMs).toBe(60_000);
  });
  it("accepts keepaliveIntervalMs: 0 to disable the ticker", () => {
    expect(McpConfigSchema.parse({ keepaliveIntervalMs: 0 }).keepaliveIntervalMs).toBe(0);
  });
  it("rejects negative keepaliveIntervalMs", () => {
    expect(() => McpConfigSchema.parse({ keepaliveIntervalMs: -1 })).toThrow();
  });
  it("rejects circuitBreakerThreshold = 0 (positive required)", () => {
    expect(() => McpConfigSchema.parse({ circuitBreakerThreshold: 0 })).toThrow();
  });
  it("rejects circuitBreakerCooldownMs = 0 (positive required)", () => {
    expect(() => McpConfigSchema.parse({ circuitBreakerCooldownMs: 0 })).toThrow();
  });
});

describe("McpServerEntrySchema — per-server reliability overrides", () => {
  it("accepts an explicit keepaliveIntervalMs override", () => {
    const result = McpServerEntrySchema.parse({
      name: "test",
      transport: "stdio",
      command: "/usr/bin/test",
      keepaliveIntervalMs: 60_000,
    });
    expect(result.keepaliveIntervalMs).toBe(60_000);
  });
  it("leaves keepaliveIntervalMs undefined when override omitted", () => {
    const result = McpServerEntrySchema.parse({
      name: "test",
      transport: "stdio",
      command: "/usr/bin/test",
    });
    expect(result.keepaliveIntervalMs).toBeUndefined();
  });
  it("accepts per-server circuit-breaker overrides", () => {
    const result = McpServerEntrySchema.parse({
      name: "test",
      transport: "stdio",
      command: "/usr/bin/test",
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 30_000,
    });
    expect(result.circuitBreakerThreshold).toBe(5);
    expect(result.circuitBreakerCooldownMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Per-server OAuth opt-in fields. Two additive optional fields land on
// McpServerEntrySchema: `auth` (enum none/bearer/oauth) and an `oauth`
// strictObject (authorizationEndpoint URL fallback, scope, Stripe-Account).
// Combined schema + tests because the accept tests reference `result.auth` /
// `result.oauth`, which would be TS errors on the pre-patch inferred type.
// The reject tests pin strictObject + enum tampering defence.
// ---------------------------------------------------------------------------

describe("McpServerEntrySchema — OAuth opt-in fields", () => {
  it("accepts auth='oauth' with an oauth block (scope only)", () => {
    const result = McpServerEntrySchema.parse({
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      auth: "oauth",
      oauth: { scope: "read" },
    });
    expect(result.auth).toBe("oauth");
    expect(result.oauth).toEqual({ scope: "read" });
  });

  it("accepts the full oauth block (authorizationEndpoint + scope + stripeAccount)", () => {
    const result = McpServerEntrySchema.parse({
      name: "stripe",
      url: "https://mcp.stripe.com/mcp",
      auth: "oauth",
      oauth: {
        authorizationEndpoint: "https://connect.stripe.com/oauth/authorize",
        scope: "read_write",
        stripeAccount: "acct_1",
      },
    });
    expect(result.oauth).toEqual({
      authorizationEndpoint: "https://connect.stripe.com/oauth/authorize",
      scope: "read_write",
      stripeAccount: "acct_1",
    });
  });

  it("accepts auth='none' and auth='bearer'", () => {
    for (const auth of ["none", "bearer"] as const) {
      const result = McpServerEntrySchema.parse({
        name: "srv",
        url: "https://example.com/mcp",
        auth,
      });
      expect(result.auth).toBe(auth);
    }
  });

  it("leaves auth/oauth undefined when both omitted", () => {
    const result = McpServerEntrySchema.parse({
      name: "srv",
      url: "https://example.com/mcp",
    });
    expect(result.auth).toBeUndefined();
    expect(result.oauth).toBeUndefined();
  });

  // Tampering: enum rejects a bogus auth value.
  it("rejects auth values outside {none,bearer,oauth}", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "srv",
        url: "https://example.com/mcp",
        auth: "bogus",
      }),
    ).toThrow();
  });

  // Tampering: strictObject rejects unknown keys inside oauth.
  it("rejects unknown keys inside the oauth block (strictObject)", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "srv",
        url: "https://example.com/mcp",
        auth: "oauth",
        oauth: { foo: 1 },
      }),
    ).toThrow();
  });

  it("rejects a non-URL authorizationEndpoint", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "srv",
        url: "https://example.com/mcp",
        auth: "oauth",
        oauth: { authorizationEndpoint: "not-a-url" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MCPX-02: keepaliveIntervalMs Zod schema default removed.
//
// Currently McpConfigSchema.keepaliveIntervalMs has .default(180_000) at
// schema-integrations.ts:208, so omitting the field returns 180000.
// Plan 04-03 removes the .default() and makes the field .optional() so
// startKeepaliveTicker can resolve a transport-aware default instead.
// ---------------------------------------------------------------------------

describe("McpConfigSchema — MCPX-02 keepaliveIntervalMs default removed", () => {
  it("keepaliveIntervalMs is undefined when omitted from config (no Zod default)", () => {
    const result = McpConfigSchema.parse({ servers: [] });
    // RED: currently returns 180000 because of .default(180_000) at schema-integrations.ts:208.
    // GREEN (Plan 04-03): returns undefined after .default() is removed and
    // the field becomes .optional().
    expect(result.keepaliveIntervalMs).toBeUndefined();
  });
});

describe("McpServerEntrySchema — bundle provenance + archive", () => {
  it("persists _bundleSource when supplied (provenance marker survives parse)", () => {
    const result = McpServerEntrySchema.parse({
      name: "x",
      transport: "stdio",
      command: "npx",
      _bundleSource: "my-skill",
    });
    expect(result._bundleSource).toBe("my-skill");
  });

  it("parses a baseline entry without _bundleSource (no regression on existing fixtures)", () => {
    const result = McpServerEntrySchema.parse({
      name: "x",
      transport: "stdio",
      command: "npx",
    });
    expect(result._bundleSource).toBeUndefined();
    expect(result._bundleArchive).toBeUndefined();
  });

  it("persists a recursive _bundleArchive (a McpServerEntry inside a McpServerEntry, z.lazy)", () => {
    const result = McpServerEntrySchema.parse({
      name: "x",
      transport: "http",
      url: "https://example.com/mcp",
      _bundleSource: "skill-b",
      _bundleArchive: {
        name: "x",
        transport: "stdio",
        command: "npx",
        _bundleSource: "skill-a",
      },
    });
    expect(result._bundleArchive).toBeDefined();
    expect(result._bundleArchive?.name).toBe("x");
    expect(result._bundleArchive?._bundleSource).toBe("skill-a");
    expect(result._bundleArchive?.transport).toBe("stdio");
  });

  it("rejects an empty-string _bundleSource (spoofing defence — min(1))", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "x",
        transport: "stdio",
        command: "npx",
        _bundleSource: "",
      }),
    ).toThrow();
  });

  it("rejects a non-string _bundleSource (Zod type error)", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        name: "x",
        transport: "stdio",
        command: "npx",
        _bundleSource: 123,
      }),
    ).toThrow();
  });
});
