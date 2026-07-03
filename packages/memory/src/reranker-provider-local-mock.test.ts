// SPDX-License-Identifier: Apache-2.0
/**
 * Branch + success-path coverage for reranker-provider-local.ts.
 *
 * The contract test file (reranker-provider-local.test.ts) is gated behind a
 * real LLAMA_RERANKER_MODEL_PATH (~606 MB GGUF) and runs only when that env var
 * points at a model, so the full success path — getLlama -> resolveModelFile ->
 * loadModel -> createRankingContext (singleton) -> rankAll -> dispose — is
 * entirely uncovered in the unit-tier root run, and the ungated invalid-path
 * test only reaches the outer catch. This file uses vi.mock to swap
 * node-llama-cpp for a stub that exercises every path deterministically (no
 * model download, no native binary). The mock is scoped to THIS file, so the
 * gated contract test still runs against the real model when the env var is set.
 *
 * Mirrors the embedding-provider-openai-mock.test.ts precedent.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Native stub handles. Mock the package BEFORE importing the production module
// (vi.mock is hoisted); each test wires behavior in beforeEach.
const mockRankAll = vi.fn<(query: string, docs: string[]) => Promise<number[]>>();
const mockCtxDispose = vi.fn<() => Promise<void>>(async () => {});
const mockModelDispose = vi.fn<() => Promise<void>>(async () => {});
const mockLlamaDispose = vi.fn<() => Promise<void>>(async () => {});
const mockCreateRankingContext =
  vi.fn<(opts?: { threads?: number }) => Promise<unknown>>();
const mockLoadModel = vi.fn<(opts: { modelPath: string }) => Promise<unknown>>();
const mockResolveModelFile =
  vi.fn<(uri: string, dir: string) => Promise<string>>();
const mockGetLlama =
  vi.fn<(opts?: { gpu?: string | false }) => Promise<unknown>>();

vi.mock("node-llama-cpp", () => ({
  getLlama: (opts?: { gpu?: string | false }) => mockGetLlama(opts),
  resolveModelFile: (uri: string, dir: string) => mockResolveModelFile(uri, dir),
}));

import { createLocalRerankerProvider } from "./reranker-provider-local.js";

describe("createLocalRerankerProvider (mocked node-llama-cpp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveModelFile.mockResolvedValue("/resolved/model.gguf");
    mockCreateRankingContext.mockResolvedValue({
      rankAll: mockRankAll,
      dispose: mockCtxDispose,
    });
    mockLoadModel.mockResolvedValue({
      createRankingContext: mockCreateRankingContext,
      dispose: mockModelDispose,
    });
    mockGetLlama.mockResolvedValue({
      loadModel: mockLoadModel,
      dispose: mockLlamaDispose,
    });
  });

  it("resolves an hf: URI via resolveModelFile and reports isAvailable()", async () => {
    const result = await createLocalRerankerProvider({
      modelUri: "hf:org/repo:model.gguf",
      modelsDir: "models",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isAvailable()).toBe(true);
    // hf: URI is resolved (not passed through verbatim) into loadModel.
    expect(mockResolveModelFile).toHaveBeenCalledWith(
      "hf:org/repo:model.gguf",
      "models",
    );
    expect(mockLoadModel).toHaveBeenCalledWith({ modelPath: "/resolved/model.gguf" });
  });

  it("uses a local path verbatim (no resolveModelFile) and creates the context once with threads", async () => {
    const result = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
      threads: 4,
    });

    expect(result.ok).toBe(true);
    expect(mockResolveModelFile).not.toHaveBeenCalled();
    expect(mockLoadModel).toHaveBeenCalledWith({ modelPath: "/local/model.gguf" });
    // Singleton: createRankingContext is invoked exactly once at factory time.
    expect(mockCreateRankingContext).toHaveBeenCalledTimes(1);
    expect(mockCreateRankingContext).toHaveBeenCalledWith({ threads: 4 });
  });

  it("rank() returns rankAll scores in input order and reuses the singleton context", async () => {
    mockRankAll.mockResolvedValue([0.91, 0.12]);
    const create = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const first = await create.value.rank("q", ["relevant doc", "irrelevant doc"]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toEqual([0.91, 0.12]);
    expect(mockRankAll).toHaveBeenCalledWith("q", ["relevant doc", "irrelevant doc"]);

    // A second rank() does NOT re-create the ranking context (singleton reuse).
    mockRankAll.mockResolvedValue([0.3, 0.4]);
    const second = await create.value.rank("q2", ["a", "b"]);
    expect(second.ok).toBe(true);
    expect(mockCreateRankingContext).toHaveBeenCalledTimes(1);
  });

  it("rank() returns err() (not a throw) when rankAll rejects with an Error", async () => {
    mockRankAll.mockRejectedValue(new Error("inference exploded"));
    const create = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const result = await create.value.rank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("inference exploded");
    }
  });

  it("rank() wraps a non-Error rejection in an Error (covers the !instanceof branch)", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    mockRankAll.mockRejectedValue("string-failure");
    const create = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const result = await create.value.rank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("string-failure");
    }
  });

  it("dispose() frees context -> model -> llama once and is idempotent", async () => {
    const create = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    await create.value.dispose?.();
    expect(mockCtxDispose).toHaveBeenCalledTimes(1);
    expect(mockModelDispose).toHaveBeenCalledTimes(1);
    expect(mockLlamaDispose).toHaveBeenCalledTimes(1);
    // Teardown order: innermost (context) before model before llama.
    expect(mockCtxDispose.mock.invocationCallOrder[0]).toBeLessThan(
      mockModelDispose.mock.invocationCallOrder[0],
    );
    expect(mockModelDispose.mock.invocationCallOrder[0]).toBeLessThan(
      mockLlamaDispose.mock.invocationCallOrder[0],
    );

    // Idempotent: a second dispose() does nothing (guarded by `disposed`).
    await create.value.dispose?.();
    expect(mockCtxDispose).toHaveBeenCalledTimes(1);
  });

  it("returns err() when loadModel rejects (graceful degrade)", async () => {
    mockLoadModel.mockRejectedValue(new Error("model load failed"));
    const result = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("model load failed");
    }
  });

  // The rerankerGpu enum must reach getLlama, not be a silent no-op.
  it("maps gpu=\"false\" to getLlama({ gpu: false }) (force CPU)", async () => {
    const result = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
      gpu: "false",
    });
    expect(result.ok).toBe(true);
    expect(mockGetLlama).toHaveBeenCalledWith({ gpu: false });
  });

  it("passes gpu=\"cuda\" and gpu=\"metal\" through to getLlama as the string backend", async () => {
    const cuda = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
      gpu: "cuda",
    });
    expect(cuda.ok).toBe(true);
    expect(mockGetLlama).toHaveBeenLastCalledWith({ gpu: "cuda" });

    const metal = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
      gpu: "metal",
    });
    expect(metal.ok).toBe(true);
    expect(mockGetLlama).toHaveBeenLastCalledWith({ gpu: "metal" });
  });

  it("calls getLlama with no gpu option when gpu is unset (native auto-detect)", async () => {
    const result = await createLocalRerankerProvider({
      modelUri: "/local/model.gguf",
      modelsDir: "models",
    });
    expect(result.ok).toBe(true);
    // No gpu key forced — let node-llama-cpp auto-detect (its own default).
    expect(mockGetLlama).toHaveBeenCalledWith({});
  });
});
