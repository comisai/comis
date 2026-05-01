// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared provider-list utility.
 *
 * Verifies:
 * - RPC success path returns provider IDs as the daemon returned them
 * - RPC failure path falls back to the local pi-ai catalog (deduped + sorted)
 * - Malformed RPC shapes (null, missing key, non-array) trigger fallback
 * - Catastrophic failure (RPC fails AND local catalog throws) returns []
 * - Function never throws
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock RPC layer at module level for ESM hoisting
vi.mock("./rpc-client.js", () => ({
  withClient: vi.fn(),
}));

// Mock @comis/agent for the local-fallback path
vi.mock("@comis/agent", () => ({
  createModelCatalog: vi.fn(),
}));

const { withClient } = await import("./rpc-client.js");
const { createModelCatalog } = await import("@comis/agent");
const { loadProvidersWithFallback } = await import("./provider-list.js");

describe("loadProvidersWithFallback", () => {
  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(createModelCatalog).mockReset();
  });

  it("returns RPC providers verbatim when RPC succeeds with valid shape", async () => {
    vi.mocked(withClient).mockImplementation(async () => ({
      providers: ["anthropic", "openai", "ollama"],
      count: 3,
    }));

    const result = await loadProvidersWithFallback();

    expect(result).toEqual(["anthropic", "openai", "ollama"]);
    expect(createModelCatalog).not.toHaveBeenCalled();
  });

  it("falls back to local catalog when RPC rejects (daemon not running)", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    const loadStatic = vi.fn();
    const getAll = vi.fn(() => [
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    ]);
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      getAll,
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    // Deduped + sorted
    expect(result).toEqual(["anthropic", "openai"]);
    expect(loadStatic).toHaveBeenCalledOnce();
  });

  it("falls back to local catalog when RPC succeeds but returns null", async () => {
    vi.mocked(withClient).mockImplementation(async () => null);

    const loadStatic = vi.fn();
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      getAll: vi.fn(() => [{ provider: "anthropic", modelId: "claude-sonnet" }]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    expect(result).toEqual(["anthropic"]);
  });

  it("falls back to local catalog when RPC returns non-array providers field", async () => {
    vi.mocked(withClient).mockImplementation(async () => ({
      providers: "anthropic,openai",
      count: 2,
    }));

    const loadStatic = vi.fn();
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      getAll: vi.fn(() => [
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "anthropic", modelId: "claude-sonnet" },
      ]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    expect(result).toEqual(["anthropic", "openai"]);
  });

  it("falls back to local catalog when RPC succeeds but providers key is missing", async () => {
    vi.mocked(withClient).mockImplementation(async () => ({ count: 0 }));

    const loadStatic = vi.fn();
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      getAll: vi.fn(() => [{ provider: "openai", modelId: "gpt-4o" }]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    expect(result).toEqual(["openai"]);
  });

  it("returns [] when RPC fails AND local catalog throws", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(createModelCatalog).mockImplementation(() => {
      throw new Error("Catalog boot failure");
    });

    const result = await loadProvidersWithFallback();

    expect(result).toEqual([]);
  });

  it("returns [] when loadStatic itself throws", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    const loadStatic = vi.fn(() => {
      throw new Error("pi-ai SDK init failure");
    });
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      getAll: vi.fn(() => []),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    expect(result).toEqual([]);
  });

  it("never throws -- regression pin for all paths", async () => {
    // RPC throws a non-Error
    vi.mocked(withClient).mockRejectedValue("string error");
    vi.mocked(createModelCatalog).mockImplementation(() => {
      throw "another non-error";
    });

    await expect(loadProvidersWithFallback()).resolves.toBeDefined();
  });

  it("dedupes providers from local catalog when RPC fails", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));

    const loadStatic = vi.fn();
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic,
      // Multiple models per provider; result must be deduped
      getAll: vi.fn(() => [
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "openai", modelId: "gpt-4o-mini" },
        { provider: "openai", modelId: "o1" },
        { provider: "anthropic", modelId: "claude-sonnet" },
        { provider: "anthropic", modelId: "claude-opus" },
      ]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    const result = await loadProvidersWithFallback();

    expect(result).toEqual(["anthropic", "openai"]);
    expect(result).toHaveLength(2);
  });
});
