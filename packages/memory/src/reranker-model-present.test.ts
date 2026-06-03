// SPDX-License-Identifier: Apache-2.0
/**
 * Unit + env-gated coverage for the no-download reranker presence probe.
 *
 * The supply-chain invariant under test: probing whether the ~606 MB GGUF is
 * already cached must NEVER fetch it. The mocked-node-llama-cpp suite asserts
 * `resolveModelFile` is ALWAYS called with `{ download: false }` and that the
 * download mechanism (`getLlama`/`loadModel`) is NEVER invoked. A second
 * `describe.skipIf(!LLAMA_RERANKER_MODEL_PATH)` block exercises a real cached
 * GGUF when present. process.env is read ONLY here at the test boundary
 * (mirrors reranker-provider-local.test.ts) — production src reads no env.
 *
 * Mirrors the reranker-provider-local-mock.test.ts precedent (vi.mock map at
 * :35-38, beforeEach mockResolveModelFile at :45).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";

// Mock the package BEFORE importing the production module (vi.mock is hoisted).
// We mock getLlama/loadModel too so we can assert they are NEVER called by the
// probe — only resolveModelFile (with download:false) is part of a presence check.
const mockResolveModelFile =
  vi.fn<(uri: string, opts: { directory: string; download: false }) => Promise<string>>();
const mockGetLlama = vi.fn<() => Promise<unknown>>();
const mockLoadModel = vi.fn<() => Promise<unknown>>();

vi.mock("node-llama-cpp", () => ({
  resolveModelFile: (uri: string, opts: { directory: string; download: false }) =>
    mockResolveModelFile(uri, opts),
  getLlama: () => mockGetLlama(),
}));

import { rerankerModelPresent } from "./reranker-model-present.js";

describe("rerankerModelPresent (mocked node-llama-cpp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolveModelFile yields THIS test file's own path so existsSync
    // is deterministically true without touching a real model.
    mockResolveModelFile.mockResolvedValue(import.meta.url.replace("file://", ""));
  });

  it("resolves an hf: URI with download:false and returns true when the resolved file exists", async () => {
    const present = await rerankerModelPresent({
      modelUri: "hf:org/repo:model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    expect(present).toBe(true);
    // The supply-chain control: resolveModelFile MUST be called with download:false.
    expect(mockResolveModelFile).toHaveBeenCalledWith("hf:org/repo:model.gguf", {
      directory: "/tmp/comis-test-models",
      download: false,
    });
    // Probe NEVER triggers the download mechanism.
    expect(mockGetLlama).not.toHaveBeenCalled();
    expect(mockLoadModel).not.toHaveBeenCalled();
  });

  it("returns false for an hf: URI when resolveModelFile resolves a path that does not exist", async () => {
    mockResolveModelFile.mockResolvedValueOnce("/definitely/not/here/model.gguf");
    const present = await rerankerModelPresent({
      modelUri: "hf:org/repo:model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    expect(present).toBe(false);
    expect(mockResolveModelFile).toHaveBeenCalledWith("hf:org/repo:model.gguf", {
      directory: "/tmp/comis-test-models",
      download: false,
    });
    expect(mockGetLlama).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when resolveModelFile rejects for an absent hf: model", async () => {
    mockResolveModelFile.mockRejectedValueOnce(new Error("model not found, download disabled"));
    const present = await rerankerModelPresent({
      modelUri: "hf:org/repo:model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    // try/catch -> false: a throw-on-absent degrades to "absent" (stay OFF).
    expect(present).toBe(false);
    expect(mockGetLlama).not.toHaveBeenCalled();
    expect(mockLoadModel).not.toHaveBeenCalled();
  });

  it("uses existsSync directly for a local (non-hf:) path and never calls resolveModelFile", async () => {
    // This source file itself is a real on-disk path -> existsSync true.
    const localPath = import.meta.url.replace("file://", "");
    const present = await rerankerModelPresent({
      modelUri: localPath,
      modelsDir: "/tmp/comis-test-models",
    });

    expect(present).toBe(true);
    // Local-path branch short-circuits BEFORE the dynamic import.
    expect(mockResolveModelFile).not.toHaveBeenCalled();
    expect(mockGetLlama).not.toHaveBeenCalled();
  });

  it("returns false for a local (non-hf:) path that does not exist (no resolveModelFile)", async () => {
    const present = await rerankerModelPresent({
      modelUri: "/definitely/not/here/local-model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    expect(present).toBe(false);
    expect(mockResolveModelFile).not.toHaveBeenCalled();
    expect(mockGetLlama).not.toHaveBeenCalled();
  });
});

const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH;

describe.skipIf(!LLAMA_RERANKER_MODEL_PATH)(
  "rerankerModelPresent (real cached GGUF)",
  () => {
    it("reports a real, on-disk local GGUF path as present", async () => {
      // A genuinely cached model path -> existsSync true on the local-path branch.
      const present = await rerankerModelPresent({
        modelUri: LLAMA_RERANKER_MODEL_PATH!,
        modelsDir: "/tmp/comis-test-models",
      });
      expect(present).toBe(existsSync(LLAMA_RERANKER_MODEL_PATH!));
      expect(present).toBe(true);
    });
  },
);
