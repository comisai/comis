// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for embedding-provider-openai.ts.
 *
 * The existing test file (embedding-provider-openai.test.ts) is gated behind
 * a real OPENAI_API_KEY and runs only under live-API conditions, so the
 * catch-block error paths in embed() / embedBatch() and the constructor
 * `e instanceof Error ? e : new Error(...)` branches are entirely uncovered
 * in the unit-tier root run. This file uses vi.mock to swap the OpenAI SDK
 * for a stub that exercises every branch.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the openai package BEFORE importing the production module. The
// constructor decides behavior based on the apiKey sentinel so each test
// can pick "construct successfully" vs. "constructor throws" independently.
const mockCreate = vi.fn();
function makeOpenAIClient(opts: { apiKey: string }) {
  if (opts.apiKey === "trigger-constructor-throw") {
    throw new Error("constructor failed for sentinel apiKey");
  }
  if (opts.apiKey === "trigger-constructor-non-error") {
    // throw a non-Error value to exercise the !instanceof Error branch
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "string-thrown-from-constructor";
  }
  return { embeddings: { create: mockCreate } };
}
vi.mock("openai", () => ({
  default: makeOpenAIClient,
}));

import { createOpenAIEmbeddingProvider } from "./embedding-provider-openai.js";

describe("createOpenAIEmbeddingProvider — branch-gap coverage", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns err result when OpenAI client constructor throws an Error", () => {
    const result = createOpenAIEmbeddingProvider({
      apiKey: "trigger-constructor-throw",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("constructor failed for sentinel apiKey");
    }
  });

  it("wraps non-Error constructor throws into a descriptive Error", () => {
    const result = createOpenAIEmbeddingProvider({
      apiKey: "trigger-constructor-non-error",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("string-thrown-from-constructor");
    }
  });

  it("returns err result when embed call rejects with an Error", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    mockCreate.mockRejectedValueOnce(new Error("rate limit exceeded"));
    const result = await create.value.embed("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("rate limit exceeded");
    }
  });

  it("wraps non-Error embed rejection values into a descriptive Error", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    if (!create.ok) return;
    mockCreate.mockRejectedValueOnce("network unreachable");
    const result = await create.value.embed("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("network unreachable");
    }
  });

  it("returns err result when embedBatch call rejects with an Error", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    if (!create.ok) return;
    mockCreate.mockRejectedValueOnce(new Error("server error"));
    const result = await create.value.embedBatch(["a", "b"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("server error");
    }
  });

  it("wraps non-Error embedBatch rejection values into a descriptive Error", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    if (!create.ok) return;
    mockCreate.mockRejectedValueOnce(42); // non-Error throw
    const result = await create.value.embedBatch(["x"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("42");
    }
  });

  it("returns embedding vectors when single embed succeeds", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 4,
    });
    if (!create.ok) return;
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
    });
    const result = await create.value.embed("hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([0.1, 0.2, 0.3, 0.4]);
    }
  });

  it("returns embedding vectors when batch embed succeeds", async () => {
    const create = createOpenAIEmbeddingProvider({
      apiKey: "valid-key",
      model: "text-embedding-3-small",
      dimensions: 4,
    });
    if (!create.ok) return;
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: [0.1, 0.2, 0.3, 0.4] },
        { embedding: [0.5, 0.6, 0.7, 0.8] },
      ],
    });
    const result = await create.value.embedBatch(["a", "b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    }
  });
});
