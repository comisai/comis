// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbeddingProvider } from "./embedding-provider-local.js";

const llamaMocks = vi.hoisted(() => ({
  getEmbeddingFor: vi.fn(),
  contextDispose: vi.fn(),
  modelDispose: vi.fn(),
  llamaDispose: vi.fn(),
  loadModel: vi.fn(),
  createEmbeddingContext: vi.fn(),
  getLlama: vi.fn(),
  resolveModelFile: vi.fn(),
}));

vi.mock("node-llama-cpp", () => ({
  getLlama: llamaMocks.getLlama,
  resolveModelFile: llamaMocks.resolveModelFile,
}));

beforeEach(() => {
  vi.clearAllMocks();
  llamaMocks.getEmbeddingFor.mockImplementation(async (text: string) => ({
    vector: Float32Array.from(text === "probe" ? [0.1, 0.2, 0.3] : [0.4, 0.5, 0.6]),
  }));
  llamaMocks.createEmbeddingContext.mockResolvedValue({
    getEmbeddingFor: llamaMocks.getEmbeddingFor,
    dispose: llamaMocks.contextDispose,
  });
  llamaMocks.loadModel.mockResolvedValue({
    createEmbeddingContext: llamaMocks.createEmbeddingContext,
    dispose: llamaMocks.modelDispose,
  });
  llamaMocks.getLlama.mockResolvedValue({
    loadModel: llamaMocks.loadModel,
    dispose: llamaMocks.llamaDispose,
  });
  llamaMocks.resolveModelFile.mockResolvedValue("/models/resolved.gguf");
});

describe("local embedding provider", () => {
  it("embeds direct-path text and disposes native resources exactly once", async () => {
    const created = await createLocalEmbeddingProvider({
      modelUri: "/models/local.gguf",
      modelsDir: "/models",
      contextSize: 4096,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      provider: "local",
      dimensions: 3,
      modelId: "/models/local.gguf",
    });
    expect(llamaMocks.loadModel).toHaveBeenCalledWith({ modelPath: "/models/local.gguf" });
    expect(llamaMocks.createEmbeddingContext).toHaveBeenCalledWith({ contextSize: 4096 });
    const embedded = await created.value.embed("hello");
    expect(embedded.ok).toBe(true);
    if (embedded.ok) {
      expect(embedded.value).toEqual([
        expect.closeTo(0.4, 5),
        expect.closeTo(0.5, 5),
        expect.closeTo(0.6, 5),
      ]);
    }
    const batch = await created.value.embedBatch(["first", "second"]);
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      expect(batch.value).toHaveLength(2);
      expect(batch.value[0]).toEqual([
        expect.closeTo(0.4, 5),
        expect.closeTo(0.5, 5),
        expect.closeTo(0.6, 5),
      ]);
    }

    await created.value.dispose?.();
    await created.value.dispose?.();
    expect(llamaMocks.contextDispose).toHaveBeenCalledOnce();
    expect(llamaMocks.modelDispose).toHaveBeenCalledOnce();
    expect(llamaMocks.llamaDispose).toHaveBeenCalledOnce();
  });

  it("resolves a hosted model before loading the embedding context", async () => {
    const created = await createLocalEmbeddingProvider({
      modelUri: "hf:example/model/model.gguf",
      modelsDir: "/models",
    });

    expect(created.ok).toBe(true);
    expect(llamaMocks.resolveModelFile).toHaveBeenCalledWith(
      "hf:example/model/model.gguf",
      "/models",
    );
    expect(llamaMocks.loadModel).toHaveBeenCalledWith({ modelPath: "/models/resolved.gguf" });
  });

  it("returns Result errors for single and batch embedding failures", async () => {
    const created = await createLocalEmbeddingProvider({
      modelUri: "/models/local.gguf",
      modelsDir: "/models",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    llamaMocks.getEmbeddingFor.mockRejectedValueOnce("single failed");
    expect(await created.value.embed("single")).toMatchObject({
      ok: false,
      error: expect.any(Error),
    });
    llamaMocks.getEmbeddingFor
      .mockResolvedValueOnce({ vector: Float32Array.from([1, 2, 3]) })
      .mockRejectedValueOnce(new Error("batch failed"));

    expect(await created.value.embedBatch(["first", "second"])).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "batch failed" }),
    });
  });

  it("converts a non-Error native initialization failure into Result.err", async () => {
    llamaMocks.getLlama.mockRejectedValueOnce("native unavailable");

    const result = await createLocalEmbeddingProvider({
      modelUri: "/models/local.gguf",
      modelsDir: "/models",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "Failed to create local embedding provider: native unavailable",
      }),
    });
  });
});
