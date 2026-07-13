// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  FileExtractionConfigSchema,
  DOCUMENT_MIME_WHITELIST,
  MediaConfigSchema,
  McpConfigSchema,
  McpServerEntrySchema,
  TranscriptionConfigSchema,
  TtsConfigSchema,
} from "./schema-integrations.js";
import {
  VideoGenerateContract,
  MEDIA_CONTRACTS,
} from "../api-contracts/media.js";

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
    // The provider default is "auto" — follow the agent's main provider.
    expect(result.imageGeneration.provider).toBe("auto");
    expect(result.imageGeneration.safetyChecker).toBe(true);
    expect(result.imageGeneration.maxPerHour).toBe(10);
    expect(result.imageGeneration.defaultSize).toBe("1024x1024");
    // 300s default: the Codex hosted image_generation routinely runs 60-120s
    // and intermittently longer — at a 120s cap a live box clipped 3 of 4
    // generations as "timeout" (each aborted attempt still consumed quota).
    // 300s matches the videoGeneration ceiling; fast providers
    // (openai/google/openrouter) finish well under it.
    expect(result.imageGeneration.timeoutMs).toBe(300_000);
    // fallbackChain defaults to an empty array; maxCostPerHourUsd is omitted.
    expect(result.imageGeneration.fallbackChain).toEqual([]);
    expect(result.imageGeneration.maxCostPerHourUsd).toBeUndefined();
  });

  it("keeps the fal provider valid for existing operator configs", () => {
    // A config.yaml with the explicit provider:"fal" must still parse.
    const result = MediaConfigSchema.parse({ imageGeneration: { provider: "fal" } });
    expect(result.imageGeneration.provider).toBe("fal");
  });

  it("keeps the openai provider valid for existing operator configs", () => {
    // provider:"openai" parses and round-trips.
    const result = MediaConfigSchema.parse({ imageGeneration: { provider: "openai" } });
    expect(result.imageGeneration.provider).toBe("openai");
  });

  it("accepts the follow-main provider enum values", () => {
    // openrouter / openai-codex / google all parse without throwing.
    for (const provider of ["openrouter", "openai-codex", "google"] as const) {
      const result = MediaConfigSchema.parse({ imageGeneration: { provider } });
      expect(result.imageGeneration.provider).toBe(provider);
    }
  });

  it("rejects an unknown provider value at parse (closed enum)", () => {
    // Config-injection backstop — an unknown/typo'd provider fails at parse.
    expect(() =>
      MediaConfigSchema.parse({ imageGeneration: { provider: "totally-bogus" } }),
    ).toThrow();
  });

  it("rejects an unknown imageGeneration key in strict mode", () => {
    // strictObject — an injected unknown key never reaches a transport.
    expect(() =>
      MediaConfigSchema.parse({ imageGeneration: { provider: "auto", bogusKey: 1 } }),
    ).toThrow();
  });

  it("parses a fallbackChain of valid provider enum values", () => {
    // fallbackChain entries validate against the same closed enum.
    const result = MediaConfigSchema.parse({
      imageGeneration: { provider: "auto", fallbackChain: ["openrouter"] },
    });
    expect(result.imageGeneration.fallbackChain).toEqual(["openrouter"]);
  });

  it("rejects a fallbackChain entry outside the provider enum", () => {
    // fallbackChain entries share the closed enum — a bogus entry fails at parse.
    expect(() =>
      MediaConfigSchema.parse({
        imageGeneration: { provider: "auto", fallbackChain: ["bogus"] },
      }),
    ).toThrow();
  });

  it("parses an optional positive maxCostPerHourUsd ceiling", () => {
    // The ceiling parses as a positive number; enforcement happens in the cost limiter.
    const result = MediaConfigSchema.parse({
      imageGeneration: { provider: "auto", maxCostPerHourUsd: 5 },
    });
    expect(result.imageGeneration.maxCostPerHourUsd).toBe(5);
  });

  it("rejects a non-positive maxCostPerHourUsd value", () => {
    // The cost ceiling must be a positive number.
    expect(() =>
      MediaConfigSchema.parse({
        imageGeneration: { provider: "auto", maxCostPerHourUsd: -1 },
      }),
    ).toThrow();
  });

  // ─── videoGeneration: sibling of imageGeneration ─────────────────────────────

  it("includes videoGeneration with defaults from empty input", () => {
    const result = MediaConfigSchema.parse({});
    expect(result.videoGeneration).toBeDefined();
    // The provider default is "auto" — follow the agent's main provider.
    expect(result.videoGeneration.provider).toBe("auto");
    expect(result.videoGeneration.defaultDurationSecs).toBe(8);
    expect(result.videoGeneration.defaultAspectRatio).toBe("16:9");
    expect(result.videoGeneration.defaultResolution).toBe("720p");
    expect(result.videoGeneration.maxPerHour).toBe(5);
    expect(result.videoGeneration.timeoutMs).toBe(300_000);
    expect(result.videoGeneration.pollIntervalMs).toBe(10_000);
    // The poller's bounded-redelivery max attempts defaults to 5 (a persistent
    // delivery failure dead-letters to `failed` after this).
    expect(result.videoGeneration.maxDeliveryAttempts).toBe(5);
    // fallbackChain defaults empty; the optional knobs are omitted.
    expect(result.videoGeneration.fallbackChain).toEqual([]);
    expect(result.videoGeneration.generateAudio).toBeUndefined();
    expect(result.videoGeneration.maxConcurrentJobs).toBeUndefined();
    expect(result.videoGeneration.maxCostPerHourUsd).toBeUndefined();
  });

  it("validates an image-only media config unchanged (video block optional)", () => {
    // A config with an image block and NO videoGeneration key must still
    // parse — videoGeneration fills from defaults and the image block is
    // byte-identical to a parse WITHOUT video present.
    const existing = MediaConfigSchema.parse({
      imageGeneration: { provider: "fal", maxPerHour: 3 },
    });
    expect(existing.imageGeneration.provider).toBe("fal");
    expect(existing.imageGeneration.maxPerHour).toBe(3);
    // videoGeneration was absent → filled by the .default() wrapper, parses fine.
    expect(existing.videoGeneration.provider).toBe("auto");
  });

  it("accepts the fal / google / xai video provider enum values", () => {
    for (const provider of ["fal", "google", "xai"] as const) {
      const result = MediaConfigSchema.parse({ videoGeneration: { provider } });
      expect(result.videoGeneration.provider).toBe(provider);
    }
  });

  it("rejects an unknown video provider value at parse (closed enum)", () => {
    // Config-injection backstop — an unknown/typo'd provider fails at parse.
    expect(() =>
      MediaConfigSchema.parse({ videoGeneration: { provider: "sora" } }),
    ).toThrow();
  });

  it("rejects an unknown videoGeneration key in strict mode", () => {
    // strictObject — an injected unknown key never reaches a transport.
    expect(() =>
      MediaConfigSchema.parse({ videoGeneration: { provider: "auto", bogusKey: 1 } }),
    ).toThrow();
  });

  it("parses a video fallbackChain of valid provider enum values", () => {
    const result = MediaConfigSchema.parse({
      videoGeneration: { provider: "auto", fallbackChain: ["fal"] },
    });
    expect(result.videoGeneration.fallbackChain).toEqual(["fal"]);
  });

  it("rejects a video fallbackChain entry outside the provider enum", () => {
    expect(() =>
      MediaConfigSchema.parse({
        videoGeneration: { provider: "auto", fallbackChain: ["bogus"] },
      }),
    ).toThrow();
  });

  it("parses a positive integer video maxDeliveryAttempts override", () => {
    const result = MediaConfigSchema.parse({
      videoGeneration: { provider: "auto", maxDeliveryAttempts: 3 },
    });
    expect(result.videoGeneration.maxDeliveryAttempts).toBe(3);
  });

  it("rejects a non-positive or non-integer video maxDeliveryAttempts", () => {
    expect(() =>
      MediaConfigSchema.parse({ videoGeneration: { provider: "auto", maxDeliveryAttempts: 0 } }),
    ).toThrow();
    expect(() =>
      MediaConfigSchema.parse({ videoGeneration: { provider: "auto", maxDeliveryAttempts: 1.5 } }),
    ).toThrow();
  });

  it("parses an optional positive video maxCostPerHourUsd ceiling", () => {
    const result = MediaConfigSchema.parse({
      videoGeneration: { provider: "auto", maxCostPerHourUsd: 5 },
    });
    expect(result.videoGeneration.maxCostPerHourUsd).toBe(5);
  });

  it("rejects a non-positive video maxCostPerHourUsd value", () => {
    expect(() =>
      MediaConfigSchema.parse({
        videoGeneration: { provider: "auto", maxCostPerHourUsd: -1 },
      }),
    ).toThrow();
  });

  it("does not edit the image config when video defaults are applied", () => {
    // The image block must be byte-identical whether or not videoGeneration is present.
    const withVideo = MediaConfigSchema.parse({ videoGeneration: { provider: "fal" } });
    const imageOnly = MediaConfigSchema.parse({});
    expect(withVideo.imageGeneration).toEqual(imageOnly.imageGeneration);
  });

  // ─── keyless-first STT/TTS defaults ──────────────────────────────────────────

  it("defaults transcription.provider to auto (keyless-first)", () => {
    // A fresh install with no audio key resolves STT via `auto`
    // (keyless-first / follow-main) instead of constructing an empty-bearer
    // OpenAI adapter that would 401 on first use.
    // Assert both the schema directly and the MediaConfigSchema round-trip.
    expect(TranscriptionConfigSchema.parse({}).provider).toBe("auto");
    expect(MediaConfigSchema.parse({}).transcription.provider).toBe("auto");
  });

  it("defaults tts.provider to edge (keyless, zero credentials)", () => {
    // TTS defaults to the keyless Edge provider (zero credentials).
    expect(TtsConfigSchema.parse({}).provider).toBe("edge");
    expect(MediaConfigSchema.parse({}).tts.provider).toBe("edge");
  });

  it("keeps every explicit STT provider valid alongside the auto default", () => {
    // Every explicit STT provider parses and round-trips identically
    // through MediaConfigSchema.
    for (const provider of ["openai", "groq", "deepgram", "local"] as const) {
      expect(
        MediaConfigSchema.parse({ transcription: { provider } }).transcription.provider,
      ).toBe(provider);
    }
  });

  it("keeps every explicit TTS provider valid alongside the edge default", () => {
    // Every explicit TTS provider parses and round-trips.
    for (const provider of ["openai", "elevenlabs", "edge", "local"] as const) {
      expect(MediaConfigSchema.parse({ tts: { provider } }).tts.provider).toBe(provider);
    }
  });

  it("rejects an unknown STT/TTS provider at parse (closed enum)", () => {
    // Config-injection backstop — a typo'd/injected provider fails at parse, not
    // at a transport. fallbackProviders shares the closed STT enum.
    expect(() =>
      MediaConfigSchema.parse({ transcription: { provider: "totally-bogus" } }),
    ).toThrow();
    expect(() =>
      MediaConfigSchema.parse({ tts: { provider: "totally-bogus" } }),
    ).toThrow();
    expect(() =>
      MediaConfigSchema.parse({ transcription: { provider: "auto", fallbackProviders: ["bogus"] } }),
    ).toThrow();
  });

  it("defaults transcription.local.model to base and rejects an unknown local key (strictObject)", () => {
    // The local STT sub-config defaults model to "base"; the strictObject
    // invariant means an injected unknown key fails at parse.
    expect(TranscriptionConfigSchema.parse({ provider: "local" }).local.model).toBe("base");
    const explicit = TranscriptionConfigSchema.parse({
      provider: "local",
      local: { model: "small", baseUrl: "http://127.0.0.1:8000" },
    });
    expect(explicit.local.model).toBe("small");
    expect(explicit.local.baseUrl).toBe("http://127.0.0.1:8000");
    expect(() =>
      TranscriptionConfigSchema.parse({ provider: "local", local: { bogus: 1 } }),
    ).toThrow();
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

  it("rejects the prototype-polluting __proto__ name (dynamic-key sink guard)", () => {
    // Reviewed live on #294: mcpServers[].name is bracket-assigned as a dynamic
    // object key downstream (e.g. the bundle-ownership ledger), and the name
    // charset admitted the literal '__proto__' — the one own-key pollution
    // vector. It is refused here, the single schema every source (config.yaml,
    // skill manifests) funnels through.
    expect(() =>
      McpServerEntrySchema.parse({ name: "__proto__", transport: "stdio", command: "npx" }),
    ).toThrow(/__proto__/);
  });
});

describe("McpServerEntrySchema transport inference", () => {
  // Case 1: Claude-Desktop-style stdio config ({name, command, args} with
  //         no explicit transport).
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
  // The schema must reject inconsistent command + url combinations
  // BEFORE the runtime gets a chance to silently ignore one of them. Without
  // this guard, the first matching inference branch (command -> stdio) would
  // win and the unused url field would pass through, silently ignored at
  // runtime by createTransport — operator misconfiguration with no warning.
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
    // by design, ignored at runtime; the explicit transport opts the
    // operator IN to that interpretation.
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
// Safety-hardening fields.
//
// Five optional Zod fields across McpConfigSchema (3) and McpServerEntrySchema
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
// Reliability fields (keepalive, circuit breaker).
// ---------------------------------------------------------------------------

describe("McpConfigSchema — reliability additive fields", () => {
  it("produces reliability defaults from an empty input object", () => {
    const result = McpConfigSchema.parse({});
    // keepaliveIntervalMs is optional (no Zod default); transport-aware default
    // is resolved at runtime by resolveDefaultKeepaliveIntervalMs.
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
// Per-server OAuth opt-in fields. Two optional fields on
// McpServerEntrySchema: `auth` (enum none/bearer/oauth) and an `oauth`
// strictObject (authorizationEndpoint URL fallback, scope, Stripe-Account).
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

  // Operator escape hatch for RFC 8628 device-flow when the
  // device-authorization server has no RFC 8414 metadata (some real-world
  // servers return 404 on every probed well-known path). Sibling of
  // authorizationEndpoint; consumed by runDeviceFlow's discovery cascade.
  it("McpServerEntrySchema oauth strictObject accepts deviceAuthorizationEndpoint URL field", () => {
    const result = McpServerEntrySchema.parse({
      name: "higgsfield",
      url: "https://mcp.higgsfield.ai/mcp",
      transport: "http",
      auth: "oauth",
      oauth: {
        deviceAuthorizationEndpoint: "https://fnf-device-auth.higgsfield.ai/device",
      },
    });
    expect(result.oauth?.deviceAuthorizationEndpoint).toBe(
      "https://fnf-device-auth.higgsfield.ai/device",
    );
  });

  it("McpServerEntrySchema oauth strictObject rejects malformed deviceAuthorizationEndpoint", () => {
    const parsed = McpServerEntrySchema.safeParse({
      name: "higgsfield",
      url: "https://mcp.higgsfield.ai/mcp",
      transport: "http",
      auth: "oauth",
      oauth: { deviceAuthorizationEndpoint: "not-a-url" },
    });
    expect(parsed.success).toBe(false);
  });

  // Per-server flow override. "device_code" forces RFC 8628;
  // "auth_code" forces PKCE+loopback even when the heuristic would dispatch
  // device-flow (headless ∧ device-code advertised). Absent ⇒ heuristic chooses.
  it("McpServerEntrySchema oauth strictObject accepts flow override device_code", () => {
    const result = McpServerEntrySchema.parse({
      name: "higgsfield",
      url: "https://mcp.higgsfield.ai/mcp",
      transport: "http",
      auth: "oauth",
      oauth: { flow: "device_code" },
    });
    expect(result.oauth?.flow).toBe("device_code");
  });

  it("McpServerEntrySchema oauth strictObject accepts flow override auth_code", () => {
    const result = McpServerEntrySchema.parse({
      name: "notion",
      url: "https://mcp.notion.so/mcp",
      transport: "http",
      auth: "oauth",
      oauth: { flow: "auth_code" },
    });
    expect(result.oauth?.flow).toBe("auth_code");
  });

  it("McpServerEntrySchema oauth strictObject rejects unknown flow values", () => {
    const parsed = McpServerEntrySchema.safeParse({
      name: "notion",
      url: "https://mcp.notion.so/mcp",
      transport: "http",
      auth: "oauth",
      oauth: { flow: "implicit" },
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// keepaliveIntervalMs has no Zod default — startKeepaliveTicker resolves a
// transport-aware default at runtime instead.
// ---------------------------------------------------------------------------

describe("McpConfigSchema — keepaliveIntervalMs has no Zod default", () => {
  it("keepaliveIntervalMs is undefined when omitted from config (no Zod default)", () => {
    const result = McpConfigSchema.parse({ servers: [] });
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

  it("parses a baseline entry without _bundleSource (absent markers stay undefined)", () => {
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

// ===========================================================================
// VideoGenerateContract (the video.generate member of MEDIA_CONTRACTS)
// ===========================================================================

describe("VideoGenerateContract", () => {
  it("declares method 'video.generate' and is a member of MEDIA_CONTRACTS", () => {
    expect(VideoGenerateContract.method).toBe("video.generate");
    expect(MEDIA_CONTRACTS).toContain(VideoGenerateContract);
  });

  it("parses a full request shape (prompt + all optional fields)", () => {
    const parsed = VideoGenerateContract.request.parse({
      prompt: "x",
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
      negative_prompt: "y",
      seed: 1,
      image_url: "workspace/a.png",
      model: "m",
    });
    expect(parsed.prompt).toBe("x");
    expect(parsed.duration).toBe(8);
    expect(parsed.image_url).toBe("workspace/a.png");
  });

  it("scopes the contract to rpc", () => {
    expect(VideoGenerateContract.scopes).toEqual(["rpc"]);
  });
});
