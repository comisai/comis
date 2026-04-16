import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  resolveProviderCapabilities,
  normalizeProviderId,
  isAnthropicFamily,
  isOpenAiFamily,
  isGoogleFamily,
  isGoogleAIStudio,
  shouldDropThinkingBlocks,
  resolveToolCallIdMode,
} from "./capabilities.js";

// ---------------------------------------------------------------------------
// 1. DEFAULTS constant
// ---------------------------------------------------------------------------

describe("DEFAULTS", () => {
  it("has providerFamily 'default'", () => {
    expect(DEFAULTS.providerFamily).toBe("default");
  });

  it("has empty dropThinkingBlockModelHints", () => {
    expect(DEFAULTS.dropThinkingBlockModelHints).toEqual([]);
  });

  it("has transcriptToolCallIdMode 'default'", () => {
    expect(DEFAULTS.transcriptToolCallIdMode).toBe("default");
  });

  it("has empty transcriptToolCallIdModelHints", () => {
    expect(DEFAULTS.transcriptToolCallIdModelHints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeProviderId
// ---------------------------------------------------------------------------

describe("normalizeProviderId", () => {
  // 13 alias mappings
  it.each([
    ["aws-bedrock", "amazon-bedrock"],
    ["bedrock", "amazon-bedrock"],
    ["vertex", "anthropic-vertex"],
    ["vertex-ai", "anthropic-vertex"],
    ["azure", "azure-openai"],
    ["azure-responses", "azure-openai-responses"],
    ["codex", "openai-codex"],
    ["gcp", "google"],
    ["gcp-vertex", "google-vertex"],
    ["gemini", "google"],
    ["gemini-cli", "google-gemini-cli"],
    ["antigravity", "google-antigravity"],
    ["grok", "xai"],
  ])("maps '%s' to '%s'", (input, expected) => {
    expect(normalizeProviderId(input)).toBe(expected);
  });

  // Identity fallthrough (canonical names pass through unchanged)
  it.each([
    ["groq", "groq"],
    ["openai", "openai"],
    ["anthropic", "anthropic"],
  ])("identity fallthrough: '%s' -> '%s'", (input, expected) => {
    expect(normalizeProviderId(input)).toBe(expected);
  });

  // Case insensitivity + trim
  it("normalizes 'Anthropic' to 'anthropic'", () => {
    expect(normalizeProviderId("Anthropic")).toBe("anthropic");
  });

  it("normalizes ' GROK ' to 'xai' (trim + lowercase)", () => {
    expect(normalizeProviderId(" GROK ")).toBe("xai");
  });
});

// ---------------------------------------------------------------------------
// 3. resolveProviderCapabilities
// ---------------------------------------------------------------------------

describe("resolveProviderCapabilities", () => {
  // Anthropic family (3 providers)
  it.each([
    "anthropic",
    "anthropic-vertex",
    "amazon-bedrock",
  ])("'%s' returns providerFamily 'anthropic' with dropThinkingBlockModelHints ['claude']", (provider) => {
    const caps = resolveProviderCapabilities(provider);
    expect(caps.providerFamily).toBe("anthropic");
    expect(caps.dropThinkingBlockModelHints).toEqual(["claude"]);
    expect(caps.transcriptToolCallIdMode).toBe("default");
    expect(caps.transcriptToolCallIdModelHints).toEqual([]);
  });

  // OpenAI family (4 providers)
  it.each([
    "openai",
    "azure-openai",
    "azure-openai-responses",
    "openai-codex",
  ])("'%s' returns providerFamily 'openai'", (provider) => {
    const caps = resolveProviderCapabilities(provider);
    expect(caps.providerFamily).toBe("openai");
    expect(caps.dropThinkingBlockModelHints).toEqual([]);
    expect(caps.transcriptToolCallIdMode).toBe("default");
    expect(caps.transcriptToolCallIdModelHints).toEqual([]);
  });

  // Google family (4 providers)
  it.each([
    "google",
    "google-gemini-cli",
    "google-antigravity",
    "google-vertex",
  ])("'%s' returns providerFamily 'google'", (provider) => {
    const caps = resolveProviderCapabilities(provider);
    expect(caps.providerFamily).toBe("google");
    expect(caps.dropThinkingBlockModelHints).toEqual([]);
    expect(caps.transcriptToolCallIdMode).toBe("default");
    expect(caps.transcriptToolCallIdModelHints).toEqual([]);
  });

  // Mistral (1 provider)
  it("'mistral' returns transcriptToolCallIdMode 'strict9' with 7 model hints", () => {
    const caps = resolveProviderCapabilities("mistral");
    expect(caps.providerFamily).toBe("default");
    expect(caps.transcriptToolCallIdMode).toBe("strict9");
    expect(caps.transcriptToolCallIdModelHints).toEqual([
      "mistral", "mixtral", "codestral", "pixtral", "devstral", "ministral", "mistralai",
    ]);
    expect(caps.dropThinkingBlockModelHints).toEqual([]);
  });

  // Default family (13 providers -- no overrides, all DEFAULTS)
  it.each([
    "cerebras",
    "github-copilot",
    "groq",
    "huggingface",
    "kimi-coding",
    "minimax",
    "minimax-cn",
    "opencode",
    "opencode-go",
    "openrouter",
    "vercel-ai-gateway",
    "xai",
    "zai",
  ])("'%s' returns DEFAULTS (providerFamily 'default')", (provider) => {
    const caps = resolveProviderCapabilities(provider);
    expect(caps).toEqual(DEFAULTS);
  });

  // 3-layer cascade: user override wins over built-in
  it("user override wins: resolveProviderCapabilities('anthropic', { providerFamily: 'default' })", () => {
    const caps = resolveProviderCapabilities("anthropic", { providerFamily: "default" });
    expect(caps.providerFamily).toBe("default");
    // Built-in dropThinkingBlockModelHints still applies (user didn't override it)
    expect(caps.dropThinkingBlockModelHints).toEqual(["claude"]);
  });

  // Alias integration: normalizeProviderId is called internally
  it("alias integration: resolveProviderCapabilities('grok') returns DEFAULTS (xai has no overrides)", () => {
    const caps = resolveProviderCapabilities("grok");
    expect(caps).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// 4. isAnthropicFamily
// ---------------------------------------------------------------------------

describe("isAnthropicFamily", () => {
  it.each([
    "anthropic",
    "amazon-bedrock",
    "anthropic-vertex",
  ])("returns true for '%s'", (provider) => {
    expect(isAnthropicFamily(provider)).toBe(true);
  });

  it.each([
    "openai",
    "google",
    "groq",
  ])("returns false for '%s'", (provider) => {
    expect(isAnthropicFamily(provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. isOpenAiFamily
// ---------------------------------------------------------------------------

describe("isOpenAiFamily", () => {
  it.each([
    "openai",
    "azure-openai",
    "azure-openai-responses",
    "openai-codex",
  ])("returns true for '%s'", (provider) => {
    expect(isOpenAiFamily(provider)).toBe(true);
  });

  it.each([
    "anthropic",
    "google",
    "groq",
  ])("returns false for '%s'", (provider) => {
    expect(isOpenAiFamily(provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. isGoogleFamily
// ---------------------------------------------------------------------------

describe("isGoogleFamily", () => {
  it.each([
    "google",
    "google-gemini-cli",
    "google-antigravity",
    "google-vertex",
  ])("returns true for '%s'", (provider) => {
    expect(isGoogleFamily(provider)).toBe(true);
  });

  // Aliases that resolve to google family
  it.each([
    "gcp",
    "gemini",
    "gcp-vertex",
    "gemini-cli",
    "antigravity",
  ])("returns true for alias '%s'", (alias) => {
    expect(isGoogleFamily(alias)).toBe(true);
  });

  it.each([
    "anthropic",
    "openai",
    "groq",
    "mistral",
  ])("returns false for '%s'", (provider) => {
    expect(isGoogleFamily(provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. isGoogleAIStudio
// ---------------------------------------------------------------------------

describe("isGoogleAIStudio", () => {
  // Only canonical "google" and its aliases
  it.each([
    "google",
    "gcp",
    "gemini",
  ])("returns true for '%s'", (provider) => {
    expect(isGoogleAIStudio(provider)).toBe(true);
  });

  // Other Google family members are NOT AI Studio
  it.each([
    "google-vertex",
    "google-gemini-cli",
    "google-antigravity",
    "gcp-vertex",
    "gemini-cli",
    "antigravity",
  ])("returns false for '%s' (Google family but not AI Studio)", (provider) => {
    expect(isGoogleAIStudio(provider)).toBe(false);
  });

  // Non-Google providers
  it.each([
    "anthropic",
    "openai",
    "groq",
  ])("returns false for '%s'", (provider) => {
    expect(isGoogleAIStudio(provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. shouldDropThinkingBlocks
// ---------------------------------------------------------------------------

describe("shouldDropThinkingBlocks", () => {
  it("returns true for ('anthropic', 'claude-sonnet-4-20250514')", () => {
    expect(shouldDropThinkingBlocks("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("returns true for ('amazon-bedrock', 'claude-3-opus-20240229')", () => {
    expect(shouldDropThinkingBlocks("amazon-bedrock", "claude-3-opus-20240229")).toBe(true);
  });

  it("returns false for ('anthropic', 'gpt-4')", () => {
    expect(shouldDropThinkingBlocks("anthropic", "gpt-4")).toBe(false);
  });

  it("returns false for ('openai', 'gpt-4o')", () => {
    expect(shouldDropThinkingBlocks("openai", "gpt-4o")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. resolveToolCallIdMode
// ---------------------------------------------------------------------------

describe("resolveToolCallIdMode", () => {
  it("returns 'strict9' for ('mistral', 'mistral-large-latest')", () => {
    expect(resolveToolCallIdMode("mistral", "mistral-large-latest")).toBe("strict9");
  });

  it("returns 'strict9' for ('mistral', 'codestral-2025-01-14')", () => {
    expect(resolveToolCallIdMode("mistral", "codestral-2025-01-14")).toBe("strict9");
  });

  it("returns 'default' for ('openai', 'gpt-4o')", () => {
    expect(resolveToolCallIdMode("openai", "gpt-4o")).toBe("default");
  });

  it("returns 'default' for ('mistral', 'unknown-model')", () => {
    expect(resolveToolCallIdMode("mistral", "unknown-model")).toBe("default");
  });
});
