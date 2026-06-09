// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProviderCredential } from "./credential-resolver.js";
import { KEYLESS_PROVIDER_TYPES } from "@comis/core";
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

// ---------------------------------------------------------------------
// Source C: comis OAuth profiles (per-agent oauthProfiles + loader)
// ---------------------------------------------------------------------

describe("resolveProviderCredential — Source C (oauth_profile)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("passes via Source C when oauthProfiles entry exists and loader.has returns true", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: (id) => id === "openai-codex:user_a@example.com" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("oauth_profile");
    expect(r.resolvedProvider).toBe("openai-codex");
  });

  it("rejects with OAuth-aware copy when oauthProfiles entry exists but loader.has returns false", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('OAuth profile "openai-codex:user_a@example.com" is configured but not found');
    expect(r.reason).toContain("comis auth login --provider openai-codex");
    expect(r.reason).toContain("comis auth list");
    // Crucially: no API-key recovery copy when this is an OAuth-shaped failure
    expect(r.reason).not.toContain("env_set");
    expect(r.reason).not.toContain("apiKeyName");
    expect(r.reason).not.toContain("providers_manage");
  });

  it("falls through to env_canonical when oauthProfiles map has no entry for this provider", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-xxx";
    const r = resolveProviderCredential("openrouter", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: () => true },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("env_canonical");
  });

  it("Source A (providers_entry) still wins over Source C when both would resolve", () => {
    const r = resolveProviderCredential("openai-codex", {
      providerEntries: { "openai-codex": makeEntry({ type: "openai", apiKeyName: "OPENAI_CODEX_KEY" }) },
      secretManager: { has: (k) => k === "OPENAI_CODEX_KEY" },
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: () => true },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("providers_entry");
  });

  it("Source C wins over env_canonical when both would resolve", () => {
    // Establish env_canonical would pass (anthropic supports OAUTH_TOKEN env)
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-xxx";
    const r = resolveProviderCredential("anthropic", {
      oauthProfiles: { anthropic: "anthropic:user_a@example.com" },
      oauthProfileLoader: { has: () => true },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("oauth_profile");
  });

  it("ignores oauthProfiles when oauthProfileLoader is absent (cannot prove existence)", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      // No oauthProfileLoader — resolver cannot confirm; still emits OAuth-aware
      // rejection copy because the agent has an oauthProfiles entry for this
      // provider (the failure mode is "OAuth profile not loadable", not
      // "missing API key").
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Cannot set agent provider to "openai-codex"');
    expect(r.reason).toContain('OAuth profile "openai-codex:user_a@example.com" is configured but not found');
    expect(r.reason).toContain("comis auth login --provider openai-codex");
  });
});

// ---------------------------------------------------------------------------
// SA5 tests — canonicalEnvKeyHint messaging contract
// ---------------------------------------------------------------------------
// NOTE (SA5 deviation): The plan proposed replacing canonicalEnvKeyHint with
// findEnvKeys(provider)?.[0] from @earendil-works/pi-ai. However, findEnvKeys
// only returns env-var names that are CURRENTLY SET in process.env — it cannot
// return canonical names for the "no credential found" error path where
// canonicalEnvKeyHint is called. The local hardcoded map is therefore retained.
// The tests below verify the messaging contract instead of the internal impl.

describe("SA5 canonicalEnvKeyHint — messaging contract", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("SA5 canonicalEnvKeyHint includes ANTHROPIC_API_KEY hint in rejection message", () => {
    // canonicalEnvKeyHint returns "ANTHROPIC_API_KEY" for "anthropic" —
    // the rejection message must include this hint for operator guidance.
    // MESSAGING-ONLY: the hint is in the error message, never used for resolution.
    const r = resolveProviderCredential("anthropic", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("SA5 canonicalEnvKeyHint safe-fallback for unknown provider", () => {
    // For a completely unknown provider, canonicalEnvKeyHint returns undefined.
    // The rejection message is still actionable (env_list fallback), just without a hint.
    const r = resolveProviderCredential("my-custom-provider", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    // Must not throw — safe fallback
    expect(r.reason).toContain('Cannot set agent provider to "my-custom-provider"');
    // No env-key hint expected for unknown provider
    expect(r.reason).not.toContain("MY_CUSTOM_PROVIDER_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// SA6 RED tests — KEYLESS_PROVIDER_TYPES shared source
// ---------------------------------------------------------------------------

describe("SA6 KEYLESS_PROVIDER_TYPES shared source", () => {
  it("SA6 credential-resolver KEYLESS_PROVIDER_TYPES source is shared — includes both ollama and lm-studio", () => {
    // Verify that the KEYLESS_PROVIDER_TYPES imported from @comis/core
    // (the shared canonical source after SA6b) includes both "ollama" and "lm-studio".
    // PASSES even on current code because @comis/core now exports the correct set
    // — the RED failure is in the agent-side (model-registry-adapter) test above,
    // and in the production code that still has local Sets that don't import from core.
    expect(KEYLESS_PROVIDER_TYPES.has("ollama")).toBe(true);
    expect(KEYLESS_PROVIDER_TYPES.has("lm-studio")).toBe(true);
  });

  it("SA6 lm-studio keyless pass through credential-resolver when shared set is used", () => {
    // After SA6b, credential-resolver imports KEYLESS_PROVIDER_TYPES from @comis/core.
    // This test verifies the keyless path works for lm-studio via the resolver.
    // PASSES today (lm-studio is already in credential-resolver's local set).
    // Regression test: after SA6b the shared set must still include lm-studio.
    const r = resolveProviderCredential("my-lmstudio", {
      providerEntries: { "my-lmstudio": makeEntry({ type: "lm-studio" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("keyless");
  });
});
