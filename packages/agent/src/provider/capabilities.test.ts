// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Hoist-mock @mariozechner/pi-ai so `validateProviderOverrides` reads from
// the controllable `getProvidersMock` instead of the real catalog.
// vi.mock is hoisted to the top of the file by Vitest -- the factory closure
// captures `getProvidersMock` via the function body, not via lexical scope at
// import time, so we redirect the mock per-test by reassigning its return
// value with `getProvidersMock.mockReturnValue(...)`.
const { getProvidersMock } = vi.hoisted(() => ({
  getProvidersMock: vi.fn<() => string[]>(() => []),
}));
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, getProviders: getProvidersMock };
});

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
  validateProviderOverrides,
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

// ---------------------------------------------------------------------------
// 10. ANTHROPIC_FAMILY de-duplication regression (Layer 3B -- 260501-07g)
// ---------------------------------------------------------------------------
//
// Phase 3B replaced three duplicate `ANTHROPIC_FAMILY` Sets in the executor
// with calls to `isAnthropicFamily` from this module. These regressions guard
// against the Sets reappearing as future "quick fix" copies.

describe("Layer 3B: ANTHROPIC_FAMILY de-duplication regression", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  it.each([
    "packages/agent/src/executor/ttl-guard.ts",
    "packages/agent/src/executor/stream-wrappers/request-body-injector.ts",
    "packages/agent/src/executor/stream-wrappers/config-resolver.ts",
  ])("%s does not declare a local ANTHROPIC_FAMILY Set", (relPath) => {
    const source = readFileSync(join(repoRoot, relPath), "utf8");
    // Local-declaration regex (catches `const ANTHROPIC_FAMILY = new Set(...)`)
    expect(source).not.toMatch(/const\s+ANTHROPIC_FAMILY\s*=/);
    // Belt-and-braces: bare identifier should also be gone (the executor
    // call sites used `ANTHROPIC_FAMILY.has(...)`).
    expect(source).not.toMatch(/\bANTHROPIC_FAMILY\b/);
  });

  it.each([
    "packages/agent/src/executor/ttl-guard.ts",
    "packages/agent/src/executor/stream-wrappers/request-body-injector.ts",
    "packages/agent/src/executor/stream-wrappers/config-resolver.ts",
  ])("%s imports isAnthropicFamily from provider/capabilities", (relPath) => {
    const source = readFileSync(join(repoRoot, relPath), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*\bisAnthropicFamily\b[^}]*\}\s*from\s*["'][^"']*provider\/capabilities/);
  });
});

// ---------------------------------------------------------------------------
// 11. validateProviderOverrides (Layer 3C -- 260501-07g)
// ---------------------------------------------------------------------------
//
// Boot-time staleness validator. Emits structured WARNs for keys in
// PROVIDER_OVERRIDES that pi-ai no longer ships. Does NOT throw -- the
// daemon continues to boot with dead override entries.

describe("validateProviderOverrides", () => {
  // Currently-known PROVIDER_OVERRIDES keys (from capabilities.ts).
  // If this list changes, update `OVERRIDE_KEYS_COUNT` to match.
  const OVERRIDE_KEYS_COUNT = 12;

  beforeEach(() => {
    getProvidersMock.mockReset();
  });

  afterEach(() => {
    getProvidersMock.mockReset();
  });

  it("emits one WARN per orphan key when getProviders() returns a sparse list", () => {
    const sparseProviders = ["anthropic", "openai"];
    getProvidersMock.mockReturnValue(sparseProviders);

    const warn = vi.fn();
    const result = validateProviderOverrides({ warn });

    // 12 override keys, only 2 present in mocked catalog -> 10 orphans
    expect(result.checked).toBe(OVERRIDE_KEYS_COUNT);
    expect(result.orphans).toHaveLength(OVERRIDE_KEYS_COUNT - 2);
    expect(warn).toHaveBeenCalledTimes(OVERRIDE_KEYS_COUNT - 2);

    // Orphans returned should include the override keys NOT in sparseProviders
    expect(result.orphans).toEqual(
      expect.arrayContaining([
        "anthropic-vertex", "amazon-bedrock", "azure-openai",
        "azure-openai-responses", "openai-codex", "google",
        "google-gemini-cli", "google-antigravity", "google-vertex", "mistral",
      ]),
    );
    // anthropic and openai are live, must NOT be in orphans
    expect(result.orphans).not.toContain("anthropic");
    expect(result.orphans).not.toContain("openai");
  });

  it("each WARN call carries provider, hint, errorKind, module fields", () => {
    getProvidersMock.mockReturnValue([]);
    const warn = vi.fn();
    validateProviderOverrides({ warn });

    expect(warn).toHaveBeenCalled();
    // Inspect the first call shape
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj).toEqual(expect.objectContaining({
      provider: expect.any(String),
      hint: expect.stringContaining("PROVIDER_OVERRIDES"),
      errorKind: "config",
      module: "agent.capabilities",
    }));
    expect(msg).toBe("Capability override has no matching pi-ai provider");
  });

  it("emits no WARN when all override keys are in the live catalog", () => {
    // Mock catalog to include every PROVIDER_OVERRIDES key
    const allOverrideKeys = [
      "anthropic", "anthropic-vertex", "amazon-bedrock",
      "openai", "azure-openai", "azure-openai-responses", "openai-codex",
      "google", "google-gemini-cli", "google-antigravity", "google-vertex",
      "mistral",
    ];
    getProvidersMock.mockReturnValue(allOverrideKeys);

    const warn = vi.fn();
    const result = validateProviderOverrides({ warn });

    expect(result.checked).toBe(OVERRIDE_KEYS_COUNT);
    expect(result.orphans).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returned `checked` matches Object.keys(PROVIDER_OVERRIDES).length", () => {
    getProvidersMock.mockReturnValue([]);
    const warn = vi.fn();
    const result = validateProviderOverrides({ warn });
    expect(result.checked).toBe(OVERRIDE_KEYS_COUNT);
    // With empty live catalog, every key is an orphan
    expect(result.orphans).toHaveLength(OVERRIDE_KEYS_COUNT);
  });

  it("does not throw when getProviders() returns []", () => {
    getProvidersMock.mockReturnValue([]);
    const warn = vi.fn();
    expect(() => validateProviderOverrides({ warn })).not.toThrow();
  });
});
