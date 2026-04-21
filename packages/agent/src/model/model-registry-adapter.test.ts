// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { createSecretManager } from "@comis/core";
import { createAuthStorageAdapter } from "./auth-storage-adapter.js";
import { createModelAllowlist } from "./model-allowlist.js";
import {
  createModelRegistryAdapter,
  resolveInitialModel,
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
