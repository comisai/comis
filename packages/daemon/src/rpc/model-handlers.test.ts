// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createModelHandlers } from "./model-handlers.js";
import type { ModelHandlerDeps } from "./model-handlers.js";

// ---------------------------------------------------------------------------
// Mock ModelCatalog
// ---------------------------------------------------------------------------

function makeMockCatalog() {
  const allModels = [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxTokens: 8192,
      input: ["text", "image"],
      reasoning: true,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      validated: true,
      validatedAt: Date.now(),
    },
    {
      provider: "openai",
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      contextWindow: 128000,
      maxTokens: 16384,
      input: ["text", "image"],
      reasoning: false,
      cost: { input: 5, output: 15, cacheRead: 2.5, cacheWrite: 0 },
      validated: false,
      validatedAt: 0,
    },
  ];

  return {
    getAll: () => allModels,
    getByProvider: (p: string) => allModels.filter((e) => e.provider === p),
    getProviders: () => ["anthropic", "openai"],
    get: () => undefined,
    loadStatic: () => {},
    mergeScanned: () => {},
  } as never;
}

// ---------------------------------------------------------------------------
// Helper: create isolated deps per test
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ModelHandlerDeps>): ModelHandlerDeps {
  return {
    modelCatalog: makeMockCatalog(),
    agents: {
      main: { provider: "anthropic", model: "claude-sonnet-4-5" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests for the 2 model management RPC handlers
// ---------------------------------------------------------------------------

describe("createModelHandlers - model management", () => {
  // -------------------------------------------------------------------------
  // models.list
  // -------------------------------------------------------------------------

  describe("models.list", () => {
    it("unfiltered list returns full catalog grouped by provider", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.list"]!({})) as {
        providers: Array<{
          name: string;
          modelCount: number;
          models: Array<{ modelId: string; displayName: string; contextWindow: number; maxTokens: number }>;
        }>;
        totalModels: number;
      };

      expect(result.providers).toHaveLength(2);
      expect(result.totalModels).toBe(2);

      const anthropic = result.providers.find((p) => p.name === "anthropic")!;
      expect(anthropic.modelCount).toBe(1);
      expect(anthropic.models).toHaveLength(1);
      expect(anthropic.models[0]!.modelId).toBe("claude-sonnet-4-5");
      expect(anthropic.models[0]!.contextWindow).toBe(200000);

      const openai = result.providers.find((p) => p.name === "openai")!;
      expect(openai.modelCount).toBe(1);
      expect(openai.models[0]!.modelId).toBe("gpt-4o");

      // Full catalog should not have cost fields
      expect(anthropic.models[0]).not.toHaveProperty("cost");
    });

    it("filters by provider when specified", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.list"]!({
        provider: "anthropic",
      })) as { models: Array<{ provider: string }>; total: number };

      expect(result.models).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.models[0]!.provider).toBe("anthropic");
    });

    it("returns empty for unknown provider", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.list"]!({
        provider: "unknown-provider",
      })) as { models: unknown[]; total: number };

      expect(result.models).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("filtered list returns full model details without cost", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.list"]!({
        provider: "anthropic",
      })) as {
        models: Array<Record<string, unknown>>;
        total: number;
      };

      expect(result.models).toHaveLength(1);
      expect(result.total).toBe(1);

      const model = result.models[0]!;
      expect(model.provider).toBe("anthropic");
      expect(model.modelId).toBe("claude-sonnet-4-5");
      expect(model.displayName).toBe("Claude Sonnet 4.5");
      expect(model.contextWindow).toBe(200000);
      expect(model.validated).toBe(true);
      expect(model).not.toHaveProperty("cost");
    });
  });

  // -------------------------------------------------------------------------
  // models.test
  // -------------------------------------------------------------------------

  describe("models.test", () => {
    it("returns status for configured provider with agents", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.test"]!({
        provider: "anthropic",
      })) as {
        provider: string;
        status: string;
        agentsUsing: Array<{ agentId: string; model: string }>;
      };

      expect(result.provider).toBe("anthropic");
      expect(result.status).toBe("available");
      expect(result.agentsUsing).toHaveLength(1);
      expect(result.agentsUsing[0]!.agentId).toBe("main");
      expect(result.agentsUsing[0]!.model).toBe("claude-sonnet-4-5");
    });

    it("returns not_configured for provider with no agents", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.test"]!({
        provider: "openai",
      })) as { provider: string; status: string; message: string; modelsInCatalog: number; hint: string };

      expect(result.provider).toBe("openai");
      expect(result.status).toBe("not_configured");
      expect(result.message).toBe("No agents use this provider");
      expect(result.modelsInCatalog).toBeGreaterThan(0);
      expect(result.hint).toContain("agents_manage");
    });

    it("reports validated model count", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      const result = (await handlers["models.test"]!({
        provider: "anthropic",
      })) as {
        modelsAvailable: number;
        validatedModels: number;
      };

      expect(result.modelsAvailable).toBe(1);
      expect(result.validatedModels).toBe(1);
    });

    it("throws when provider param missing", async () => {
      const deps = makeDeps();
      const handlers = createModelHandlers(deps);

      await expect(
        handlers["models.test"]!({}),
      ).rejects.toThrow("Missing required parameter: provider");
    });
  });
});
