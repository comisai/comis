// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { createSecretManager } from "@comis/core";
import { createAuthStorageAdapter } from "./auth-storage-adapter.js";
import { createModelAllowlist } from "./model-allowlist.js";
import {
  createModelRegistryAdapter,
  registerCustomProviders,
  resolveInitialModel,
  type CustomProviderRegistration,
} from "./model-registry-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an AuthStorage with a dummy Anthropic key so models are "available". */
function buildAuthStorage() {
  const secretManager = createSecretManager({
    ANTHROPIC_API_KEY: "test-key-123",
    OPENAI_API_KEY: "test-openai-key",
  });
  return createAuthStorageAdapter({ secretManager });
}

// ---------------------------------------------------------------------------
// createModelRegistryAdapter
// ---------------------------------------------------------------------------

describe("createModelRegistryAdapter", () => {
  it("returns a ModelRegistry instance", () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);

    expect(registry).toBeInstanceOf(ModelRegistry);
  });

  it("discovers built-in models for providers with auth configured", () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);

    const available = registry.getAvailable();
    expect(available.length).toBeGreaterThan(0);

    // Should have Anthropic models since we set ANTHROPIC_API_KEY
    const anthropicModels = available.filter((m) => m.provider === "anthropic");
    expect(anthropicModels.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialModel
// ---------------------------------------------------------------------------

describe("resolveInitialModel", () => {
  it("returns a model when provider/modelId match an available model", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);

    // Find an actual model ID from the registry to test with
    const available = registry.getAvailable();
    const anthropicModel = available.find((m) => m.provider === "anthropic");
    expect(anthropicModel).toBeDefined();

    const result = await resolveInitialModel(registry, {
      provider: "anthropic",
      model: anthropicModel!.id,
    });

    expect(result.model).toBeDefined();
    expect(result.model!.provider).toBe("anthropic");
    expect(result.model!.id).toBe(anthropicModel!.id);
    expect(result.fallbackMessage).toBeUndefined();
  });

  it("returns undefined model with fallback message when no matching model exists", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);

    const result = await resolveInitialModel(registry, {
      provider: "anthropic",
      model: "nonexistent-model-xyz",
    });

    expect(result.model).toBeUndefined();
    expect(result.fallbackMessage).toBeDefined();
    expect(result.fallbackMessage).toContain("nonexistent-model-xyz");
    expect(result.thinkingLevel).toBe("off");
  });

  it("finds model in catalog even when provider has no auth configured", async () => {
    // Only Anthropic has a key, but groq models still exist in the catalog
    const secretManager = createSecretManager({
      ANTHROPIC_API_KEY: "test-key-123",
    });
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);

    // ModelRegistry.find() searches all models (auth-independent)
    const result = await resolveInitialModel(registry, {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    });

    // Model is found in the catalog -- auth check happens at API call time
    expect(result.model).toBeDefined();
    expect(result.model!.provider).toBe("groq");
    expect(result.model!.id).toBe("llama-3.3-70b-versatile");
  });

  it("returns undefined for completely unknown provider", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);

    const result = await resolveInitialModel(registry, {
      provider: "unknown-provider-xyz",
      model: "some-model",
    });

    expect(result.model).toBeUndefined();
    expect(result.fallbackMessage).toBeDefined();
    expect(result.fallbackMessage).toContain("unknown-provider-xyz");
  });

  it("with active allowlist that permits the model -- returns the model", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);
    const available = registry.getAvailable();
    const anthropicModel = available.find((m) => m.provider === "anthropic");
    expect(anthropicModel).toBeDefined();

    const allowlist = createModelAllowlist([`anthropic/${anthropicModel!.id}`]);

    const result = await resolveInitialModel(
      registry,
      { provider: "anthropic", model: anthropicModel!.id },
      allowlist,
    );

    expect(result.model).toBeDefined();
    expect(result.model!.id).toBe(anthropicModel!.id);
    expect(result.fallbackMessage).toBeUndefined();
  });

  it("with active allowlist that rejects the model -- returns undefined with rejection message", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);
    const available = registry.getAvailable();
    const anthropicModel = available.find((m) => m.provider === "anthropic");
    expect(anthropicModel).toBeDefined();

    // Allowlist only permits a different model
    const allowlist = createModelAllowlist(["openai/gpt-4o"]);

    const result = await resolveInitialModel(
      registry,
      { provider: "anthropic", model: anthropicModel!.id },
      allowlist,
    );

    expect(result.model).toBeUndefined();
    expect(result.fallbackMessage).toBeDefined();
    expect(result.fallbackMessage).toContain("not allowed");
    expect(result.fallbackMessage).toContain("openai/gpt-4o");
  });

  it("with inactive allowlist (empty) -- allows any model", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);
    const available = registry.getAvailable();
    const anthropicModel = available.find((m) => m.provider === "anthropic");
    expect(anthropicModel).toBeDefined();

    const allowlist = createModelAllowlist([]);

    const result = await resolveInitialModel(
      registry,
      { provider: "anthropic", model: anthropicModel!.id },
      allowlist,
    );

    expect(result.model).toBeDefined();
    expect(result.model!.id).toBe(anthropicModel!.id);
    expect(result.fallbackMessage).toBeUndefined();
  });

  it("sets thinkingLevel based on model.reasoning capability", async () => {
    const authStorage = buildAuthStorage();
    const registry = createModelRegistryAdapter(authStorage);
    const available = registry.getAvailable();

    // Find a reasoning model (e.g., claude-opus-4-5 or similar)
    const reasoningModel = available.find((m) => m.reasoning === true);
    const nonReasoningModel = available.find((m) => m.reasoning === false);

    if (reasoningModel) {
      const result = await resolveInitialModel(registry, {
        provider: reasoningModel.provider as string,
        model: reasoningModel.id,
      });
      expect(result.thinkingLevel).toBe("medium");
    }

    if (nonReasoningModel) {
      const result = await resolveInitialModel(registry, {
        provider: nonReasoningModel.provider as string,
        model: nonReasoningModel.id,
      });
      expect(result.thinkingLevel).toBe("off");
    }
  });
});

// ---------------------------------------------------------------------------
// registerCustomProviders
// ---------------------------------------------------------------------------

describe("registerCustomProviders", () => {
  function captureLogger() {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const debugs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    return {
      warns,
      debugs,
      logger: {
        warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
        debug: (obj: Record<string, unknown>, msg: string) => debugs.push({ obj, msg }),
      },
    };
  }

  function nvidiaEntry(overrides: Partial<CustomProviderRegistration> = {}): CustomProviderRegistration {
    return {
      type: "openai",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKeyName: "NVIDIA_API_KEY",
      enabled: true,
      headers: {},
      models: [{ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" }],
      ...overrides,
    };
  }

  it("registers a custom OpenAI-compatible provider so find() succeeds", () => {
    const secretManager = createSecretManager({
      NVIDIA_API_KEY: "nvapi-test",
    });
    const authStorage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: { nvidia: { apiKeyName: "NVIDIA_API_KEY", enabled: true } },
    });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger } = captureLogger();

    const count = registerCustomProviders(
      registry,
      { nvidia: nvidiaEntry() },
      secretManager,
      logger,
    );

    expect(count).toBe(1);
    const found = registry.find("nvidia", "moonshotai/kimi-k2.5");
    expect(found).toBeDefined();
    expect(found!.provider).toBe("nvidia");
    expect(found!.id).toBe("moonshotai/kimi-k2.5");
    expect(found!.api).toBe("openai-completions");
    expect(found!.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("after registration, getAvailable() includes the custom provider's models", () => {
    const secretManager = createSecretManager({ NVIDIA_API_KEY: "nvapi-test" });
    const authStorage = createAuthStorageAdapter({
      secretManager,
      customProviderEntries: { nvidia: { apiKeyName: "NVIDIA_API_KEY", enabled: true } },
    });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger } = captureLogger();

    registerCustomProviders(registry, { nvidia: nvidiaEntry() }, secretManager, logger);

    const available = registry.getAvailable();
    const nvidiaAvailable = available.filter((m) => m.provider === "nvidia");
    expect(nvidiaAvailable.length).toBe(1);
    expect(nvidiaAvailable[0]!.id).toBe("moonshotai/kimi-k2.5");
  });

  it("skips disabled entries", () => {
    const secretManager = createSecretManager({ NVIDIA_API_KEY: "nvapi-test" });
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger, debugs } = captureLogger();

    const count = registerCustomProviders(
      registry,
      { nvidia: nvidiaEntry({ enabled: false }) },
      secretManager,
      logger,
    );

    expect(count).toBe(0);
    expect(registry.find("nvidia", "moonshotai/kimi-k2.5")).toBeUndefined();
    expect(debugs.some((d) => d.msg.includes("disabled"))).toBe(true);
  });

  it("skips entries with no models and no baseUrl override", () => {
    const secretManager = createSecretManager({});
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger } = captureLogger();

    const count = registerCustomProviders(
      registry,
      { empty: nvidiaEntry({ baseUrl: "", models: [] }) },
      secretManager,
      logger,
    );

    expect(count).toBe(0);
  });

  it("logs WARN and continues when models declared but apiKeyName secret is missing", () => {
    const secretManager = createSecretManager({}); // no NVIDIA_API_KEY
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger, warns } = captureLogger();

    const count = registerCustomProviders(
      registry,
      { nvidia: nvidiaEntry() },
      secretManager,
      logger,
    );

    expect(count).toBe(0);
    expect(registry.find("nvidia", "moonshotai/kimi-k2.5")).toBeUndefined();
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj.errorKind).toBe("config");
    expect(warns[0]!.obj.providerName).toBe("nvidia");
  });

  it("maps known provider types to pi API identifiers", () => {
    const secretManager = createSecretManager({
      A: "a", B: "b", C: "c", D: "d",
    });
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger } = captureLogger();

    registerCustomProviders(
      registry,
      {
        groqProxy: nvidiaEntry({
          type: "groq", apiKeyName: "A", baseUrl: "https://groq.example/v1",
          models: [{ id: "x" }],
        }),
        anthropicProxy: nvidiaEntry({
          type: "anthropic", apiKeyName: "B", baseUrl: "https://anthropic.example/v1",
          models: [{ id: "y" }],
        }),
        googleProxy: nvidiaEntry({
          type: "google", apiKeyName: "C", baseUrl: "https://google.example/v1",
          models: [{ id: "z" }],
        }),
        unknownProxy: nvidiaEntry({
          type: "ollama", apiKeyName: "D", baseUrl: "https://ollama.local/v1",
          models: [{ id: "q" }],
        }),
      },
      secretManager,
      logger,
    );

    expect(registry.find("groqProxy", "x")!.api).toBe("openai-completions");
    expect(registry.find("anthropicProxy", "y")!.api).toBe("anthropic-messages");
    expect(registry.find("googleProxy", "z")!.api).toBe("google-generative-ai");
    // Unknown types default to openai-completions for arbitrary OpenAI-compat proxies.
    expect(registry.find("unknownProxy", "q")!.api).toBe("openai-completions");
  });

  it("logs WARN and keeps going when registerProvider throws (e.g., missing baseUrl)", () => {
    const secretManager = createSecretManager({ A: "a", NVIDIA_API_KEY: "n" });
    const authStorage = createAuthStorageAdapter({ secretManager });
    const registry = createModelRegistryAdapter(authStorage);
    const { logger, warns } = captureLogger();

    const count = registerCustomProviders(
      registry,
      {
        bad: nvidiaEntry({ apiKeyName: "A", baseUrl: "", models: [{ id: "m" }] }),
        good: nvidiaEntry(),
      },
      secretManager,
      logger,
    );

    // 'bad' fails (no baseUrl), 'good' succeeds. registerProvider keys
    // by the entries-object key, so 'good' is the provider name in pi.
    expect(count).toBe(1);
    expect(registry.find("good", "moonshotai/kimi-k2.5")).toBeDefined();
    expect(registry.find("bad", "m")).toBeUndefined();
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj.providerName).toBe("bad");
    expect(warns[0]!.obj.errorKind).toBe("config");
  });
});
