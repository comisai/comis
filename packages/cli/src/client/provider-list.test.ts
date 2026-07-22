// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared provider-list utility.
 *
 * Verifies:
 * - RPC success path returns provider rows as the daemon returned them
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

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: vi.fn(),
}));

// Mock @comis/core for the local-fallback path. createModelCatalog lives in
// @comis/core (not routed through @comis/agent).
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    createModelCatalog: vi.fn(),
  };
});

const { withClient } = await import("./rpc-client.js");
const { createModelCatalog } = await import("@comis/core");
const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
const { loadProvidersWithFallback } = await import("./provider-list.js");

function unknownRow(provider: string, modelCount: number) {
  return {
    provider,
    modelCount,
    status: "unknown",
    credentialSource: "daemon_unavailable",
  } as const;
}

describe("loadProvidersWithFallback", () => {
  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(createModelCatalog).mockReset();
    vi.mocked(getEnvApiKey).mockReset();
  });

  it("returns authoritative daemon provider rows when RPC succeeds", async () => {
    vi.mocked(withClient).mockImplementation(async () => ({
      agentId: "default",
      providers: [
        {
          provider: "amazon-bedrock",
          modelCount: 109,
          status: "configured",
          credentialSource: "secret_store_canonical",
        },
      ],
      count: 1,
    }));

    const result = await loadProvidersWithFallback();

    expect(result).toEqual([
      {
        provider: "amazon-bedrock",
        modelCount: 109,
        status: "configured",
        credentialSource: "secret_store_canonical",
      },
    ]);
    expect(createModelCatalog).not.toHaveBeenCalled();
  });

  it("does not hide an explicit agent lookup failure behind local fallback", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("Agent not found: absent"));

    await expect(loadProvidersWithFallback("absent")).rejects.toThrow(
      "Agent not found: absent",
    );
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

    expect(result).toEqual([
      unknownRow("anthropic", 1),
      unknownRow("openai", 2),
    ]);
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

    expect(result).toEqual([unknownRow("anthropic", 1)]);
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

    expect(result).toEqual([
      unknownRow("anthropic", 1),
      unknownRow("openai", 1),
    ]);
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

    expect(result).toEqual([unknownRow("openai", 1)]);
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

    expect(result).toEqual([
      unknownRow("anthropic", 2),
      unknownRow("openai", 3),
    ]);
    expect(result).toHaveLength(2);
  });

  it("reports only ambient credential truth when the daemon is unavailable", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(getEnvApiKey).mockImplementation((provider: string) =>
      provider === "anthropic" ? "test-key" : undefined,
    );
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic: vi.fn(),
      getAll: vi.fn(() => [
        { provider: "anthropic", modelId: "claude-sonnet" },
        { provider: "openai", modelId: "gpt-4o" },
      ]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    await expect(loadProvidersWithFallback()).resolves.toEqual([
      {
        provider: "anthropic",
        modelCount: 1,
        status: "configured",
        credentialSource: "env_canonical",
      },
      unknownRow("openai", 1),
    ]);
  });

  it("keeps local keyless providers truthful without a daemon", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic: vi.fn(),
      getAll: vi.fn(() => [{ provider: "ollama", modelId: "local-model" }]),
      get: vi.fn(),
      getByProvider: vi.fn(),
      mergeScanned: vi.fn(),
      getProviders: vi.fn(),
    } as never);

    await expect(loadProvidersWithFallback()).resolves.toEqual([
      {
        provider: "ollama",
        modelCount: 1,
        status: "keyless",
        credentialSource: "keyless",
      },
    ]);
  });
});
