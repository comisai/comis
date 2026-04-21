// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingPort } from "@comis/core";
import { ok, err } from "@comis/shared";

// Mock the local and openai provider modules
vi.mock("./embedding-provider-local.js", () => ({
  createLocalEmbeddingProvider: vi.fn(),
}));

vi.mock("./embedding-provider-openai.js", () => ({
  createOpenAIEmbeddingProvider: vi.fn(),
}));

import { createEmbeddingProvider } from "./embedding-provider-factory.js";
import { createLocalEmbeddingProvider } from "./embedding-provider-local.js";
import { createOpenAIEmbeddingProvider } from "./embedding-provider-openai.js";

const mockLocal = vi.mocked(createLocalEmbeddingProvider);
const mockOpenAI = vi.mocked(createOpenAIEmbeddingProvider);

function stubPort(overrides?: Partial<EmbeddingPort>): EmbeddingPort {
  return {
    provider: "test",
    dimensions: 768,
    modelId: "test-model",
    embed: vi.fn().mockResolvedValue(ok([0.1, 0.2])),
    embedBatch: vi.fn().mockResolvedValue(ok([[0.1], [0.2]])),
    ...overrides,
  };
}

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auto mode", () => {
    it("selects local when local succeeds", async () => {
      const localPort = stubPort({ modelId: "local-model" });
      mockLocal.mockResolvedValue(ok(localPort));

      const result = await createEmbeddingProvider({
        provider: "auto",
        local: { modelUri: "hf:test", modelsDir: "models" },
        remote: { apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.modelId).toBe("local-model");
      }
      expect(mockLocal).toHaveBeenCalledOnce();
      // Remote should NOT have been called since local succeeded
      expect(mockOpenAI).not.toHaveBeenCalled();
    });

    it("falls back to remote when local fails", async () => {
      mockLocal.mockResolvedValue(err(new Error("node-llama-cpp not available")));
      const remotePort = stubPort({ modelId: "openai-model", dimensions: 1536 });
      mockOpenAI.mockReturnValue(ok(remotePort));

      const result = await createEmbeddingProvider({
        provider: "auto",
        local: { modelUri: "hf:test", modelsDir: "models" },
        remote: { apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.modelId).toBe("openai-model");
      }
      expect(mockLocal).toHaveBeenCalledOnce();
      expect(mockOpenAI).toHaveBeenCalledOnce();
    });

    it("returns error when both fail", async () => {
      mockLocal.mockResolvedValue(err(new Error("native bindings unavailable")));
      mockOpenAI.mockReturnValue(err(new Error("OpenAI embedding provider requires an apiKey")));

      const result = await createEmbeddingProvider({
        provider: "auto",
        local: { modelUri: "hf:test", modelsDir: "models" },
        remote: { apiKey: "", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No embedding provider available");
        expect(result.error.message).toContain("native bindings unavailable");
      }
    });

    it("skips local when no local config provided", async () => {
      const remotePort = stubPort({ modelId: "openai-fallback" });
      mockOpenAI.mockReturnValue(ok(remotePort));

      const result = await createEmbeddingProvider({
        provider: "auto",
        remote: { apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.modelId).toBe("openai-fallback");
      }
      expect(mockLocal).not.toHaveBeenCalled();
    });
  });

  describe("local mode", () => {
    it("returns error when local fails (no fallback)", async () => {
      mockLocal.mockResolvedValue(err(new Error("model file not found")));

      const result = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: "hf:test", modelsDir: "models" },
        remote: { apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("model file not found");
      }
      // Remote should NOT be attempted for explicit local mode
      expect(mockOpenAI).not.toHaveBeenCalled();
    });

    it("returns error when no local config provided", async () => {
      const result = await createEmbeddingProvider({
        provider: "local",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("no local config provided");
      }
    });

    it("succeeds when local provider works", async () => {
      const localPort = stubPort({ modelId: "local-gguf" });
      mockLocal.mockResolvedValue(ok(localPort));

      const result = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: "/path/to/model.gguf", modelsDir: "models" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.modelId).toBe("local-gguf");
      }
    });
  });

  describe("openai mode", () => {
    it("returns error when no apiKey provided", async () => {
      const result = await createEmbeddingProvider({
        provider: "openai",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("apiKey");
      }
    });

    it("returns error when apiKey is empty string", async () => {
      const result = await createEmbeddingProvider({
        provider: "openai",
        remote: { apiKey: "", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("apiKey");
      }
    });

    it("succeeds with valid config", async () => {
      const remotePort = stubPort({ modelId: "text-embedding-3-small", dimensions: 1536 });
      mockOpenAI.mockReturnValue(ok(remotePort));

      const result = await createEmbeddingProvider({
        provider: "openai",
        remote: { apiKey: "sk-valid-key", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.modelId).toBe("text-embedding-3-small");
        expect(result.value.dimensions).toBe(1536);
      }
      expect(mockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-valid-key",
        model: "text-embedding-3-small",
        dimensions: 1536,
      });
    });

    it("does not attempt local provider", async () => {
      const remotePort = stubPort();
      mockOpenAI.mockReturnValue(ok(remotePort));

      await createEmbeddingProvider({
        provider: "openai",
        local: { modelUri: "hf:test", modelsDir: "models" },
        remote: { apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 1536 },
      });

      expect(mockLocal).not.toHaveBeenCalled();
    });
  });
});
