// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createEmbeddingCircuitBreaker decorator.
 * Separate file from setup-memory.test.ts because those tests mock @comis/core
 * and @comis/memory globally. The CB decorator tests use real imports from
 * @comis/agent and @comis/shared with no module mocks.
 */

import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import { createCircuitBreaker } from "@comis/agent";
import type { EmbeddingPort } from "@comis/core";
import { createEmbeddingCircuitBreaker } from "./setup-memory.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPort(overrides?: Partial<EmbeddingPort>): EmbeddingPort {
  return {
    provider: "test",
    dimensions: 384,
    modelId: "test-model",
    embed: vi.fn().mockResolvedValue(ok([1, 2, 3])),
    embedBatch: vi.fn().mockResolvedValue(ok([[1, 2, 3]])),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const CB_CONFIG = { failureThreshold: 3, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEmbeddingCircuitBreaker", () => {
  // 1. forwards provider, dimensions, modelId from inner port
  it("forwards provider, dimensions, modelId from inner port", () => {
    const inner = createMockPort({ provider: "openai", dimensions: 1536, modelId: "text-embedding-3-small" });
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    expect(wrapped.provider).toBe("openai");
    expect(wrapped.dimensions).toBe(1536);
    expect(wrapped.modelId).toBe("text-embedding-3-small");
  });

  // 2. embed() delegates to inner when circuit is closed
  it("embed() delegates to inner when circuit is closed", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    const result = await wrapped.embed("test");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3]);
    expect(inner.embed).toHaveBeenCalledWith("test");
  });

  // 3. embed() returns err when circuit is open
  it("embed() returns err when circuit is open", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);

    // Force circuit open by recording 3 failures
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    const result = await wrapped.embed("test");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("circuit breaker is open");
    expect(inner.embed).not.toHaveBeenCalled();
  });

  // 4. embedBatch() delegates to inner when circuit is closed
  it("embedBatch() delegates to inner when circuit is closed", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    const result = await wrapped.embedBatch(["hello", "world"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([[1, 2, 3]]);
    expect(inner.embedBatch).toHaveBeenCalledWith(["hello", "world"]);
  });

  // 5. embedBatch() returns err when circuit is open
  it("embedBatch() returns err when circuit is open", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    const result = await wrapped.embedBatch(["hello"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("circuit breaker is open");
    expect(inner.embedBatch).not.toHaveBeenCalled();
  });

  // 6. records success on ok result
  it("records success on ok result, circuit stays closed", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    await wrapped.embed("test");

    expect(cb.getState()).toBe("closed");
  });

  // 7. records failure on err result, opens circuit after threshold
  it("records failure on err result, opens circuit after threshold", async () => {
    const inner = createMockPort({
      embed: vi.fn().mockResolvedValue(err(new Error("provider down"))),
    });
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    await wrapped.embed("a");
    expect(cb.getState()).toBe("closed");

    await wrapped.embed("b");
    expect(cb.getState()).toBe("closed");

    await wrapped.embed("c");
    expect(cb.getState()).toBe("open");
  });

  // 8. dispose() calls inner.dispose()
  it("dispose() calls inner.dispose()", async () => {
    const inner = createMockPort();
    const cb = createCircuitBreaker(CB_CONFIG);
    const wrapped = createEmbeddingCircuitBreaker(inner, cb, createMockLogger());

    await wrapped.dispose!();

    expect(inner.dispose).toHaveBeenCalled();
  });
});
