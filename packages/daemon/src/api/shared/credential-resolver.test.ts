// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveProviderCredential,
  resolveProviderCredentialWithStore,
} from "./credential-resolver.js";
import { KEYLESS_PROVIDER_TYPES } from "@comis/core";
import type { OAuthCredentialStorePort, ProviderEntry } from "@comis/core";

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

function makeCredentialStore(
  overrides: Record<string, unknown> = {},
): OAuthCredentialStorePort {
  return {
    has: async () => ({ ok: true as const, value: false }),
    get: async () => ({ ok: true as const, value: undefined }),
    set: async () => ({ ok: true as const, value: undefined }),
    delete: async () => ({ ok: true as const, value: false }),
    list: async () => ({ ok: true as const, value: [] }),
    ...overrides,
  } as unknown as OAuthCredentialStorePort;
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

  it("requires a configured key name even when the provider type can be keyless", () => {
    const r = resolveProviderCredential("secured-ollama", {
      providerEntries: {
        "secured-ollama": makeEntry({
          type: "ollama",
          apiKeyName: "OLLAMA_API_KEY",
        }),
      },
      secretManager: { has: () => false },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain('apiKeyName is "OLLAMA_API_KEY"');
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

  it("does not fall back to an opposite Anthropic credential when the configured name is missing", () => {
    const r = resolveProviderCredential("anthropic", {
      providerEntries: {
        anthropic: makeEntry({ type: "anthropic", apiKeyName: "ANTHROPIC_OAUTH_TOKEN" }),
      },
      secretManager: { has: (name) => name === "ANTHROPIC_API_KEY" },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain('apiKeyName is "ANTHROPIC_OAUTH_TOKEN"');
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
  // Source: secret-store static mapping (encrypted-storage mode)
  //
  // In encrypted mode a provider key lives in the secret store rather than
  // process.env. The pre-write resolver and runtime AuthStorage bridge must use
  // the same provider mapping so both accept the same configuration.
  // ---------------------------------------------------------------------

  it("passes via secret store when a bare provider's static key is not ambient", () => {
    const r = resolveProviderCredential("anthropic", {
      providerEntries: {},
      secretManager: { has: (k) => k === "ANTHROPIC_API_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("secret_store_canonical");
    expect(r.resolvedProvider).toBe("anthropic");
  });

  it("resolves provider default to a statically mapped secret-store provider", () => {
    const r = resolveProviderCredential("default", {
      providerEntries: {},
      modelsConfig: { defaultProvider: "anthropic" },
      secretManager: { has: (k) => k === "ANTHROPIC_API_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("secret_store_canonical");
    expect(r.resolvedProvider).toBe("anthropic");
  });

  it("applies secret-store canonical resolution to OpenRouter without a provider entry", () => {
    const r = resolveProviderCredential("openrouter", {
      providerEntries: {},
      secretManager: { has: (k) => k === "OPENROUTER_API_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("secret_store_canonical");
  });

  it("accepts a catalog alias from the secret store without a provider entry", () => {
    const r = resolveProviderCredential("google", {
      providerEntries: {},
      secretManager: { has: (k) => k === "GEMINI_API_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("secret_store_canonical");
  });

  it("accepts an encrypted Vertex API key without ADC routing values", () => {
    const r = resolveProviderCredential("google-vertex", {
      providerEntries: {},
      secretManager: { has: (name) => name === "GOOGLE_CLOUD_API_KEY" },
    });

    expect(r.ok).toBe(true);
    expect(r.source).toBe("secret_store_canonical");
  });

  it("rejects encrypted Cloudflare Gateway credentials without a gateway identifier", () => {
    const configured = new Set(["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]);
    const r = resolveProviderCredential("cloudflare-ai-gateway", {
      providerEntries: {},
      secretManager: { has: (name) => configured.has(name) },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CLOUDFLARE_GATEWAY_ID");
  });

  it("prefers Source A (providers_entry) over secret-store canonical when both match", () => {
    const r = resolveProviderCredential("anthropic", {
      providerEntries: { anthropic: makeEntry({ type: "anthropic", apiKeyName: "CUSTOM_ANTHROPIC" }) },
      secretManager: { has: (k) => k === "CUSTOM_ANTHROPIC" || k === "ANTHROPIC_API_KEY" },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("providers_entry");
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
    expect(r.reason).toContain("credential store");
    expect(r.reason).not.toContain("not in env");
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

  it("passes via Source C when an unpinned provider has a stored fallback profile", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProvidersWithProfiles: new Set(["openai-codex"]),
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("oauth_profile");
    expect(r.resolvedProvider).toBe("openai-codex");
  });

  it("does not replace a missing explicit profile with an available provider fallback", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: () => false },
      oauthProvidersWithProfiles: new Set(["openai-codex"]),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('OAuth profile "openai-codex:user_a@example.com" is configured but not found');
  });

  it("does not replace a missing explicit profile with ambient credentials", () => {
    process.env.ANTHROPIC_OAUTH_TOKEN = "test-key";

    const r = resolveProviderCredential("anthropic", {
      oauthProfiles: { anthropic: "anthropic:user_a@example.com" },
      oauthProfileLoader: { has: () => false },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain('OAuth profile "anthropic:user_a@example.com" is configured but not found');
  });

  it("rejects with OAuth-aware copy when oauthProfiles entry exists but loader.has returns false", () => {
    const r = resolveProviderCredential("openai-codex", {
      oauthProfiles: { "openai-codex": "openai-codex:user_a@example.com" },
      oauthProfileLoader: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('OAuth profile "openai-codex:user_a@example.com" is configured but not found');
    expect(r.reason).not.toContain("auth-profiles.json");
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

describe("resolveProviderCredentialWithStore", () => {
  it("does not inspect an explicit OAuth pin after Source A resolves", async () => {
    const has = vi.fn(async () => ({
      ok: false as const,
      error: new Error("OAuth store unavailable"),
    }));
    const store = makeCredentialStore({ has });

    const result = await resolveProviderCredentialWithStore("openrouter", {
      providerEntries: {
        openrouter: makeEntry({ type: "openai", apiKeyName: "OPENROUTER_API_KEY" }),
      },
      secretManager: { has: (name) => name === "OPENROUTER_API_KEY" },
      oauthProfiles: { openrouter: "openrouter:user_a@example.com" },
    }, store);

    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, source: "providers_entry" },
    });
    expect(has).not.toHaveBeenCalled();
  });

  it("prefers a stored OAuth profile over static credentials for an OAuth provider", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [{
        provider: "anthropic",
        profileId: "anthropic:user_a@example.com",
        access: "test-key",
        refresh: "test-key",
        expires: 1_900_000_000_000,
        version: 1 as const,
      }],
    }));

    const result = await resolveProviderCredentialWithStore("anthropic", {
      secretManager: { has: (name) => name === "ANTHROPIC_API_KEY" },
    }, makeCredentialStore({ list }));

    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, source: "oauth_profile" },
    });
    expect(list).toHaveBeenCalledWith({ provider: "anthropic" });
  });

  it("does not hide an OAuth store failure behind static credentials", async () => {
    const list = vi.fn(async () => ({
      ok: false as const,
      error: new Error("OAuth store unavailable"),
    }));

    const result = await resolveProviderCredentialWithStore("anthropic", {
      secretManager: { has: (name) => name === "ANTHROPIC_API_KEY" },
    }, makeCredentialStore({ list }));

    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringMatching(/Failed to inspect OAuth credential store/),
      }),
    });
    expect(list).toHaveBeenCalledWith({ provider: "anthropic" });
  });

  it("does not accept a stored profile for a provider without OAuth support", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [{
        provider: "custom-provider",
        profileId: "custom-provider:user_a@example.com",
        access: "test-key",
        refresh: "test-key",
        expires: 1_900_000_000_000,
        version: 1 as const,
      }],
    }));

    const result = await resolveProviderCredentialWithStore(
      "custom-provider",
      { secretManager: { has: () => false } },
      makeCredentialStore({ list }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { ok: false },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("accepts a validated OAuth environment seed when the provider store is empty", async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: [] }));
    const secretManager = {
      has: (name: string) => name === "OAUTH_OPENAI_CODEX",
      get: (name: string) => name === "OAUTH_OPENAI_CODEX"
        ? JSON.stringify({
            access: "test-key",
            refresh: "test-key",
            expires: 1_900_000_000_000,
            accountId: "user_a",
            email: "user_a@example.com",
          })
        : undefined,
    };

    const result = await resolveProviderCredentialWithStore(
      "openai-codex",
      { secretManager },
      makeCredentialStore({ list }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, source: "oauth_env_seed" },
    });
    expect(list).toHaveBeenCalledWith({ provider: "openai-codex" });
  });

  it("rejects a malformed OAuth environment seed when the provider store is empty", async () => {
    const secretManager = {
      has: () => true,
      get: () => JSON.stringify({ access: "test-key" }),
    };

    const result = await resolveProviderCredentialWithStore(
      "openai-codex",
      { secretManager },
      makeCredentialStore(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { ok: false },
    });
  });
});

// ---------------------------------------------------------------------------
// Static provider key hint messaging
// ---------------------------------------------------------------------------

describe("static provider key hint messaging", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("includes the preferred Anthropic key in the rejection message", () => {
    const r = resolveProviderCredential("anthropic", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
    expect(r.reason).not.toContain("canonical env key");
  });

  it("keeps the rejection actionable when a provider has no static key mapping", () => {
    const r = resolveProviderCredential("my-custom-provider", {
      providerEntries: {},
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Cannot set agent provider to "my-custom-provider"');
    expect(r.reason).not.toContain("MY_CUSTOM_PROVIDER_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// KEYLESS_PROVIDER_TYPES shared source
// ---------------------------------------------------------------------------

describe("KEYLESS_PROVIDER_TYPES shared source", () => {
  it("includes both Ollama and LM Studio provider types", () => {
    expect(KEYLESS_PROVIDER_TYPES.has("ollama")).toBe(true);
    expect(KEYLESS_PROVIDER_TYPES.has("lm-studio")).toBe(true);
  });

  it("passes LM Studio through the keyless credential path", () => {
    const r = resolveProviderCredential("my-lmstudio", {
      providerEntries: { "my-lmstudio": makeEntry({ type: "lm-studio" }) },
      secretManager: { has: () => false },
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("keyless");
  });
});
