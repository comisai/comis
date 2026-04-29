// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProviderHandlers } from "./provider-handlers.js";
import type { ProviderHandlerDeps } from "./provider-handlers.js";
import type { PersistToConfigDeps } from "./persist-to-config.js";
import type { ProviderEntry, PerAgentConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Mock persist-to-config module to avoid real filesystem operations
// ---------------------------------------------------------------------------

vi.mock("./persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));

vi.mock("./probe-provider-auth.js", () => ({
  probeProviderAuth: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
}));

import { persistToConfig } from "./persist-to-config.js";
const mockPersistToConfig = vi.mocked(persistToConfig);

import { probeProviderAuth } from "./probe-provider-auth.js";
const mockProbeProviderAuth = vi.mocked(probeProviderAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOllamaEntry(overrides?: Partial<ProviderEntry>): ProviderEntry {
  return {
    type: "ollama",
    name: "Local Ollama",
    baseUrl: "http://localhost:11434",
    apiKeyName: "",
    enabled: true,
    timeoutMs: 120000,
    maxRetries: 2,
    headers: {},
    capabilities: {
      providerFamily: "default",
      dropThinkingBlockModelHints: [],
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
    },
    models: [],
    ...overrides,
  } as ProviderEntry;
}

function makeOpenAIEntry(overrides?: Partial<ProviderEntry>): ProviderEntry {
  return {
    type: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyName: "OPENAI_API_KEY",
    enabled: true,
    timeoutMs: 120000,
    maxRetries: 2,
    headers: {},
    capabilities: {
      providerFamily: "default",
      dropThinkingBlockModelHints: [],
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
    },
    models: [],
    ...overrides,
  } as ProviderEntry;
}

function makeDeps(overrides?: Partial<ProviderHandlerDeps>): ProviderHandlerDeps {
  return {
    providerEntries: {
      "my-ollama": makeOllamaEntry(),
    },
    agents: {
      default: { provider: "default", model: "claude-sonnet-4" } as PerAgentConfig,
    },
    ...overrides,
  };
}

function makePersistDeps(): PersistToConfigDeps {
  return {
    container: {
      config: { tenantId: "test", providers: { entries: {} } },
      eventBus: { emit: vi.fn() },
    },
    configPaths: ["/tmp/test-config.yaml"],
    defaultConfigPaths: ["/tmp/default-config.yaml"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  } as unknown as PersistToConfigDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProviderHandlers", () => {
  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
    mockProbeProviderAuth.mockClear();
    mockProbeProviderAuth.mockResolvedValue({ ok: true, value: undefined });
  });

  // -------------------------------------------------------------------------
  // Admin trust gate
  // -------------------------------------------------------------------------

  describe("admin trust gate", () => {
    const handlerNames = [
      "providers.list",
      "providers.get",
      "providers.create",
      "providers.update",
      "providers.delete",
      "providers.enable",
      "providers.disable",
    ] as const;

    for (const handlerName of handlerNames) {
      it(`rejects ${handlerName} without admin trust level`, async () => {
        const deps = makeDeps();
        const handlers = createProviderHandlers(deps);

        await expect(
          handlers[handlerName]!({ providerId: "my-ollama", _trustLevel: "viewer" }),
        ).rejects.toThrow("Admin access required");
      });

      it(`rejects ${handlerName} without any trust level`, async () => {
        const deps = makeDeps();
        const handlers = createProviderHandlers(deps);

        await expect(
          handlers[handlerName]!({ providerId: "my-ollama" }),
        ).rejects.toThrow("Admin access required");
      });
    }
  });

  // -------------------------------------------------------------------------
  // providers.list
  // -------------------------------------------------------------------------

  describe("providers.list", () => {
    it("returns provider summaries", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<Record<string, unknown>> };

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]).toMatchObject({
        id: "my-ollama",
        type: "ollama",
        name: "Local Ollama",
        enabled: true,
        modelCount: 0,
      });
    });

    it("returns apiKeyConfigured: null for keyless providers (empty apiKeyName)", async () => {
      const deps = makeDeps(); // my-ollama has apiKeyName: ""
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<{ apiKeyConfigured: boolean | null }> };

      expect(result.providers[0]!.apiKeyConfigured).toBeNull();
    });

    it("returns apiKeyConfigured: true when secret exists", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-openai": makeOpenAIEntry(),
        },
        secretManager: { has: (key: string) => key === "OPENAI_API_KEY" },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<{ apiKeyConfigured: boolean | null }> };

      expect(result.providers[0]!.apiKeyConfigured).toBe(true);
    });

    it("returns apiKeyConfigured: false when secret is missing", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-openai": makeOpenAIEntry(),
        },
        secretManager: { has: () => false },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<{ apiKeyConfigured: boolean | null }> };

      expect(result.providers[0]!.apiKeyConfigured).toBe(false);
    });

    it("returns apiKeyConfigured: false when no secretManager provided", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-openai": makeOpenAIEntry(),
        },
        // no secretManager
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<{ apiKeyConfigured: boolean | null }> };

      expect(result.providers[0]!.apiKeyConfigured).toBe(false);
    });

    it("returns empty array when no providers configured", async () => {
      const deps = makeDeps({ providerEntries: {} });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.list"]!({
        _trustLevel: "admin",
      })) as { providers: Array<unknown> };

      expect(result.providers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // providers.get
  // -------------------------------------------------------------------------

  describe("providers.get", () => {
    it("returns full config for an existing provider", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { providerId: string; config: Record<string, unknown>; agentsUsing: string[] };

      expect(result.providerId).toBe("my-ollama");
      expect(result.config.type).toBe("ollama");
      expect(result.config.name).toBe("Local Ollama");
      expect(result.config.baseUrl).toBe("http://localhost:11434");
      expect(result.agentsUsing).toEqual([]);
    });

    it("throws for missing providerId parameter", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.get"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: providerId");
    });

    it("throws for nonexistent provider", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.get"]!({ providerId: "nonexistent", _trustLevel: "admin" }),
      ).rejects.toThrow("Provider not found: nonexistent");
    });

    it("includes agents using provider as primary", async () => {
      const deps = makeDeps({
        agents: {
          "agent-a": { provider: "my-ollama", model: "llama3" } as PerAgentConfig,
          default: { provider: "default", model: "claude-sonnet-4" } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { agentsUsing: string[] };

      expect(result.agentsUsing).toContain("agent-a");
      expect(result.agentsUsing).not.toContain("default");
    });

    it("includes agents using provider in fallbackModels", async () => {
      const deps = makeDeps({
        agents: {
          "agent-b": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [{ provider: "my-ollama", modelId: "llama3" }],
              authProfiles: [],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { agentsUsing: string[] };

      expect(result.agentsUsing).toContain("agent-b");
    });

    it("includes agents using provider in authProfiles", async () => {
      const deps = makeDeps({
        agents: {
          "agent-c": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [],
              authProfiles: [{ keyName: "EXTRA_KEY", provider: "my-ollama" }],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { agentsUsing: string[] };

      expect(result.agentsUsing).toContain("agent-c");
    });

    it("deduplicates agents referencing provider in multiple slots", async () => {
      const deps = makeDeps({
        agents: {
          "multi-ref": {
            provider: "my-ollama",
            model: "llama3",
            modelFailover: {
              fallbackModels: [{ provider: "my-ollama", modelId: "llama3.1" }],
              authProfiles: [{ keyName: "EXTRA_KEY", provider: "my-ollama" }],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { agentsUsing: string[] };

      // Same agent appears once even though it references in all 3 slots
      expect(result.agentsUsing).toEqual(["multi-ref"]);
    });

    it("returns apiKeyConfigured three-state", async () => {
      // Keyless (null)
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.get"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { apiKeyConfigured: boolean | null };

      expect(result.apiKeyConfigured).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // providers.create
  // -------------------------------------------------------------------------

  describe("providers.create", () => {
    it("creates a new provider with valid config", async () => {
      const deps = makeDeps({ persistDeps: makePersistDeps() });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.create"]!({
        providerId: "nvidia-nim",
        config: { type: "openai", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
        _trustLevel: "admin",
      })) as { providerId: string; created: boolean; config: Record<string, unknown> };

      expect(result.providerId).toBe("nvidia-nim");
      expect(result.created).toBe(true);
      expect(result.config).toBeDefined();
      expect(deps.providerEntries["nvidia-nim"]).toBeDefined();
    });

    it("rejects duplicate provider ID", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.create"]!({
          providerId: "my-ollama",
          config: { type: "ollama" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Provider already exists: my-ollama");
    });

    it('rejects providerId === "default" as reserved', async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.create"]!({
          providerId: "default",
          config: { type: "openai" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/reserved/i);
    });

    it("rejects empty providerId", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.create"]!({
          config: { type: "openai" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Missing required parameter: providerId");
    });

    it("validates config through ProviderEntrySchema (rejects unknown keys)", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.create"]!({
          providerId: "bad-config",
          config: { type: "openai", unknownField: "test" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(); // z.strictObject rejects unknown keys
    });

    it("calls persistToConfig with correct patch shape", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.create"]!({
        providerId: "new-provider",
        config: { type: "openai", name: "Test" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const call = mockPersistToConfig.mock.calls[0]!;
      expect(call[1]!.actionType).toBe("providers.create");
      expect(call[1]!.entityId).toBe("new-provider");
      expect(call[1]!.patch).toMatchObject({
        providers: { entries: { "new-provider": expect.objectContaining({ type: "openai" }) } },
      });
    });

    it("rejects when probe returns auth error", async () => {
      mockProbeProviderAuth.mockResolvedValueOnce({
        ok: false,
        error: "API key rejected by provider (HTTP 401). Verify the key is correct and has not expired.",
      });
      const deps = makeDeps({
        persistDeps: makePersistDeps(),
        secretManager: { has: () => true, get: (key: string) => key === "NVIDIA_API_KEY" ? "test-key" : undefined },
      });
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.create"]!({
          providerId: "nvidia-nim",
          config: { type: "openai", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyName: "NVIDIA_API_KEY" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("API key validation failed");

      // Provider should NOT have been added to the map
      expect(deps.providerEntries["nvidia-nim"]).toBeUndefined();
    });

    it("succeeds when probe returns ok", async () => {
      // Default mock already returns ok
      const deps = makeDeps({
        persistDeps: makePersistDeps(),
        secretManager: { has: () => true, get: (key: string) => key === "NVIDIA_API_KEY" ? "test-key" : undefined },
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.create"]!({
        providerId: "nvidia-nim",
        config: { type: "openai", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyName: "NVIDIA_API_KEY" },
        _trustLevel: "admin",
      })) as { providerId: string; created: boolean };

      expect(result.created).toBe(true);
      expect(deps.providerEntries["nvidia-nim"]).toBeDefined();
      expect(mockProbeProviderAuth).toHaveBeenCalledOnce();
    });

    it("skips probe when no apiKeyName", async () => {
      const deps = makeDeps({
        persistDeps: makePersistDeps(),
        secretManager: { has: () => true, get: () => "test-key" },
      });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.create"]!({
        providerId: "local-ollama",
        config: { type: "ollama", name: "Ollama" },
        _trustLevel: "admin",
      });

      expect(mockProbeProviderAuth).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // providers.update
  // -------------------------------------------------------------------------

  describe("providers.update", () => {
    it("updates an existing provider", async () => {
      const deps = makeDeps({ persistDeps: makePersistDeps() });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.update"]!({
        providerId: "my-ollama",
        config: { name: "Updated Ollama" },
        _trustLevel: "admin",
      })) as { providerId: string; updated: boolean; config: Record<string, unknown> };

      expect(result.updated).toBe(true);
      expect(deps.providerEntries["my-ollama"]!.name).toBe("Updated Ollama");
    });

    it("throws for nonexistent provider", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.update"]!({
          providerId: "nonexistent",
          config: { name: "Test" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Provider not found: nonexistent");
    });

    it("shallow-merges headers per-key (preserves existing keys)", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-ollama": makeOllamaEntry({
            headers: { "X-Existing": "keep-me", "X-Override": "old" },
          }),
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.update"]!({
        providerId: "my-ollama",
        config: { headers: { "X-Override": "new", "X-New": "added" } },
        _trustLevel: "admin",
      });

      const updated = deps.providerEntries["my-ollama"]!;
      expect(updated.headers).toEqual({
        "X-Existing": "keep-me",
        "X-Override": "new",
        "X-New": "added",
      });
    });

    it("replaces models[] wholesale (not merged)", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-ollama": makeOllamaEntry({
            models: [
              { id: "old-model", reasoning: false, input: ["text"] },
            ] as ProviderEntry["models"],
          }),
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.update"]!({
        providerId: "my-ollama",
        config: { models: [{ id: "new-model" }] },
        _trustLevel: "admin",
      });

      const updated = deps.providerEntries["my-ollama"]!;
      expect(updated.models).toHaveLength(1);
      expect(updated.models[0]!.id).toBe("new-model");
    });

    it("persists userPatch NOT merged config", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.update"]!({
        providerId: "my-ollama",
        config: { name: "Patched" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const call = mockPersistToConfig.mock.calls[0]!;
      const persistedPatch = call[1]!.patch as Record<string, unknown>;
      const entries = (persistedPatch.providers as Record<string, unknown>)?.entries as Record<string, unknown>;
      const providerPatch = entries?.["my-ollama"] as Record<string, unknown>;

      // The persisted patch should contain only the user's partial update,
      // NOT the full merged config with all default fields
      expect(providerPatch).toEqual({ name: "Patched" });
    });

    it("validates merged config through ProviderEntrySchema", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      // type: "" would fail z.string().min(1) validation after merge
      await expect(
        handlers["providers.update"]!({
          providerId: "my-ollama",
          config: { type: "" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // providers.delete
  // -------------------------------------------------------------------------

  describe("providers.delete", () => {
    it("deletes an unreferenced provider", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.delete"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { providerId: string; deleted: boolean };

      expect(result.deleted).toBe(true);
      expect(deps.providerEntries["my-ollama"]).toBeUndefined();
    });

    it("blocks deletion when agent references provider as primary", async () => {
      const deps = makeDeps({
        agents: {
          "agent-a": { provider: "my-ollama", model: "llama3" } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.delete"]!({
          providerId: "my-ollama",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/primary provider.*agent-a/i);

      // Provider should NOT be deleted
      expect(deps.providerEntries["my-ollama"]).toBeDefined();
    });

    it("blocks deletion when referenced in fallbackModels", async () => {
      const deps = makeDeps({
        agents: {
          "agent-b": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [{ provider: "my-ollama", modelId: "llama3" }],
              authProfiles: [],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.delete"]!({
          providerId: "my-ollama",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/fallbackModels.*agent-b/i);

      expect(deps.providerEntries["my-ollama"]).toBeDefined();
    });

    it("blocks deletion when referenced in authProfiles", async () => {
      const deps = makeDeps({
        agents: {
          "agent-c": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [],
              authProfiles: [{ keyName: "EXTRA_KEY", provider: "my-ollama" }],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
      });
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.delete"]!({
          providerId: "my-ollama",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/authProfiles.*agent-c/i);

      expect(deps.providerEntries["my-ollama"]).toBeDefined();
    });

    it("uses removePaths in persistence call", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.delete"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const call = mockPersistToConfig.mock.calls[0]!;
      expect(call[1]!.removePaths).toEqual([["providers", "entries", "my-ollama"]]);
      expect(call[1]!.actionType).toBe("providers.delete");
    });

    it("throws for nonexistent provider", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.delete"]!({
          providerId: "nonexistent",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Provider not found: nonexistent");
    });
  });

  // -------------------------------------------------------------------------
  // providers.enable
  // -------------------------------------------------------------------------

  describe("providers.enable", () => {
    it("sets enabled: true on a disabled provider", async () => {
      const deps = makeDeps({
        providerEntries: {
          "my-ollama": makeOllamaEntry({ enabled: false }),
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.enable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { providerId: string; enabled: boolean };

      expect(result.enabled).toBe(true);
      expect(deps.providerEntries["my-ollama"]!.enabled).toBe(true);
    });

    it("persists enabled: true", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({
        providerEntries: {
          "my-ollama": makeOllamaEntry({ enabled: false }),
        },
        persistDeps,
      });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.enable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const call = mockPersistToConfig.mock.calls[0]!;
      expect(call[1]!.patch).toMatchObject({
        providers: { entries: { "my-ollama": { enabled: true } } },
      });
    });

    it("throws for nonexistent provider", async () => {
      const deps = makeDeps();
      const handlers = createProviderHandlers(deps);

      await expect(
        handlers["providers.enable"]!({
          providerId: "nonexistent",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Provider not found: nonexistent");
    });
  });

  // -------------------------------------------------------------------------
  // providers.disable
  // -------------------------------------------------------------------------

  describe("providers.disable", () => {
    it("sets enabled: false on a provider", async () => {
      const deps = makeDeps({ persistDeps: makePersistDeps() });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { providerId: string; enabled: boolean; warning?: string };

      expect(result.enabled).toBe(false);
      expect(deps.providerEntries["my-ollama"]!.enabled).toBe(false);
    });

    it("warns but does NOT block when agent references provider as primary", async () => {
      const deps = makeDeps({
        agents: {
          "agent-a": { provider: "my-ollama", model: "llama3" } as PerAgentConfig,
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { enabled: boolean; warning?: string };

      // Should succeed (not throw)
      expect(result.enabled).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/agent-a/);
    });

    it("warns but does NOT block when referenced in fallbackModels", async () => {
      const deps = makeDeps({
        agents: {
          "agent-b": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [{ provider: "my-ollama", modelId: "llama3" }],
              authProfiles: [],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { enabled: boolean; warning?: string };

      expect(result.enabled).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/agent-b/);
    });

    it("warns but does NOT block when referenced in authProfiles", async () => {
      const deps = makeDeps({
        agents: {
          "agent-c": {
            provider: "default",
            model: "claude-sonnet-4",
            modelFailover: {
              fallbackModels: [],
              authProfiles: [{ keyName: "EXTRA_KEY", provider: "my-ollama" }],
              allowedModels: [],
              maxAttempts: 6,
              cooldownInitialMs: 60000,
              cooldownMultiplier: 5,
              cooldownCapMs: 3600000,
            },
          } as PerAgentConfig,
        },
        persistDeps: makePersistDeps(),
      });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { enabled: boolean; warning?: string };

      expect(result.enabled).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/agent-c/);
    });

    it("does not include warning when no agents reference provider", async () => {
      const deps = makeDeps({ persistDeps: makePersistDeps() });
      const handlers = createProviderHandlers(deps);

      const result = (await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      })) as { enabled: boolean; warning?: string };

      expect(result.enabled).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it("persists enabled: false", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.disable"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const call = mockPersistToConfig.mock.calls[0]!;
      expect(call[1]!.patch).toMatchObject({
        providers: { entries: { "my-ollama": { enabled: false } } },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Live reference invariant
  // -------------------------------------------------------------------------

  describe("live reference invariant", () => {
    it("mutations to providerEntries are same-object visible", async () => {
      const providerEntries: Record<string, ProviderEntry> = {
        "my-ollama": makeOllamaEntry(),
      };
      const deps = makeDeps({ providerEntries });
      const handlers = createProviderHandlers(deps);

      // Create a new provider through the handler
      await handlers["providers.create"]!({
        providerId: "new-provider",
        config: { type: "openai", name: "New" },
        _trustLevel: "admin",
      });

      // The same providerEntries reference should see the new provider
      expect(providerEntries["new-provider"]).toBeDefined();
      expect(providerEntries["new-provider"]!.type).toBe("openai");
    });

    it("delete removes from same-object reference", async () => {
      const providerEntries: Record<string, ProviderEntry> = {
        "my-ollama": makeOllamaEntry(),
      };
      const deps = makeDeps({ providerEntries, agents: {} });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.delete"]!({
        providerId: "my-ollama",
        _trustLevel: "admin",
      });

      expect(providerEntries["my-ollama"]).toBeUndefined();
    });

    it("update mutates same-object reference", async () => {
      const providerEntries: Record<string, ProviderEntry> = {
        "my-ollama": makeOllamaEntry(),
      };
      const deps = makeDeps({ providerEntries });
      const handlers = createProviderHandlers(deps);

      await handlers["providers.update"]!({
        providerId: "my-ollama",
        config: { name: "Updated" },
        _trustLevel: "admin",
      });

      expect(providerEntries["my-ollama"]!.name).toBe("Updated");
    });
  });
});
