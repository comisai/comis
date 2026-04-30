// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProviderCredential } from "./credential-resolver.js";
import type { ProviderEntry } from "@comis/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal-but-valid ProviderEntry for tests. Only the fields the
 * resolver inspects (`type`, `apiKeyName`) are meaningful here; the rest
 * are filled with default-acceptable values to keep type checking happy.
 */
function makeEntry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    type: "openai",
    name: "",
    baseUrl: "",
    apiKeyName: "",
    enabled: true,
    timeoutMs: 120_000,
    maxRetries: 2,
    headers: {},
    capabilities: {
      providerFamily: "default",
      dropThinkingBlockModelHints: [],
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
    },
    models: [],
    ...overrides,
  } as ProviderEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveProviderCredential", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Strip canonical keys we manipulate so per-test state is deterministic.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------

  it("rejects when targetProvider is empty string", () => {
    const r = resolveProviderCredential("", {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Invalid provider/);
  });

  it("rejects when targetProvider is not a string", () => {
    // @ts-expect-error testing runtime type guard
    const r = resolveProviderCredential(undefined, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Invalid provider/);
  });

  // ---------------------------------------------------------------------
  // Source: keyless (ollama / lm-studio)
  // ---------------------------------------------------------------------

  it("passes for keyless ollama with providers.entries record", () => {
    const r = resolveProviderCredential("my-ollama", {
      providerEntries: { "my-ollama": makeEntry({ type: "ollama" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("keyless");
  });

  it("passes for keyless lm-studio", () => {
    const r = resolveProviderCredential("my-lmstudio", {
      providerEntries: { "my-lmstudio": makeEntry({ type: "lm-studio" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("keyless");
  });

  // ---------------------------------------------------------------------
  // Source A: providers.entries with secret-manager-resolvable apiKeyName
  // ---------------------------------------------------------------------

  it("passes via Source A when providers.entries.apiKeyName resolves via secretManager", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: { openrouter: makeEntry({ type: "openai", apiKeyName: "OR_KEY" }) },
      secretManager: { has: (k) => k === "OR_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("providers_entry");
  });

  // ---------------------------------------------------------------------
  // Source B: pi-ai canonical env / OAuth / ADC chain
  // ---------------------------------------------------------------------

  it("passes via Source B (pi-ai canonical env) when entry is missing but env key exists", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-xxx";
    const r = resolveProviderCredential("openrouter", {});
    expect(r.ok).toBe(true);
    expect(r.source).toBe("env_canonical");
  });

  it("passes via Source B when providers.entry.apiKeyName is missing but canonical env exists", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-xxx";
    const r = resolveProviderCredential("openrouter", {
      providerEntries: { openrouter: makeEntry({ type: "openai", apiKeyName: "" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("env_canonical");
  });

  it("passes for Anthropic OAuth via Source B (ANTHROPIC_OAUTH_TOKEN, no API_KEY)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-xxx";
    const r = resolveProviderCredential("anthropic", {});
    expect(r.ok).toBe(true);
    expect(r.source).toBe("env_canonical");
  });

  // ---------------------------------------------------------------------
  // Rejection — message content (actionable for LLMs)
  // ---------------------------------------------------------------------

  it("rejects with actionable message when no source resolves and no providers.entries record", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Cannot set agent provider to "openrouter"');
    expect(r.reason).toContain("OPENROUTER_API_KEY");
    expect(r.reason).toContain("gateway");
    expect(r.reason).toContain("env_set");
    expect(r.reason).toContain("env_list");
    expect(r.reason).toContain("providers_manage");
  });

  it("rejection message names the configured apiKeyName when providers.entry exists but secret is missing", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: { openrouter: makeEntry({ type: "openai", apiKeyName: "OR_KEY" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('apiKeyName is "OR_KEY"');
    expect(r.reason).toContain("env_set");
    expect(r.reason).toContain('"OR_KEY"');
  });

  it("rejection message references env_list filter pattern based on provider name", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filter:"OPENROUTER\*"/);
  });

  it("rejection message handles unknown provider (no canonical hint)", () => {
    const r = resolveProviderCredential("totally-custom-provider", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Cannot set agent provider to "totally-custom-provider"');
    expect(r.reason).toContain("env_list");
    // Without a canonical mapping, recovery (a) instructs env_list discovery
    expect(r.reason).not.toContain("(OPENROUTER_API_KEY)");
  });

  it("rejection message includes both recovery options for no-entry case", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("(a) Run gateway");
    expect(r.reason).toContain("(b) Run providers_manage");
  });

  // ---------------------------------------------------------------------
  // Source priority — Source A wins over Source B when both match
  // ---------------------------------------------------------------------

  it("prefers Source A (providers_entry) when both Source A and Source B would resolve", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-xxx";
    const r = resolveProviderCredential("openrouter", {
      providerEntries: { openrouter: makeEntry({ type: "openai", apiKeyName: "OR_KEY" }) },
      secretManager: { has: (k) => k === "OR_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("providers_entry");
  });

  // ---------------------------------------------------------------------
  // Edge — entry exists but apiKeyName is empty AND no canonical env
  // ---------------------------------------------------------------------

  it("rejects when providers.entry exists with empty apiKeyName and no canonical env", () => {
    const r = resolveProviderCredential("custom-proxy", {
      providerEntries: { "custom-proxy": makeEntry({ type: "openai", apiKeyName: "" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    // Falls through to the no-entry branch since apiKeyName is empty
    expect(r.reason).toContain('Cannot set agent provider to "custom-proxy"');
  });
});
