// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the agents + models + providers-domain contract registry.
 *
 * Follows the shared per-domain contract-registry test pattern:
 *   - Aggregator sanity: count + method-name presence + scope assignments.
 *   - INTERNAL_FIELD_NAMES paired sanity (no contract request schema declares
 *     a dispatcher-injected `_X` key).
 *   - Per-contract spot-checks: request acceptance + rejection + optional-field
 *     acceptance, response acceptance + rejection on representative shape
 *     mismatch.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  AGENTS_CONTRACTS,
  AgentsCreateContract,
  AgentsGetContract,
  AgentsUpdateContract,
  AgentsDeleteContract,
  AgentsSuspendContract,
  AgentsResumeContract,
  AgentGetOperationModelsContract,
  ModelsListContract,
  ModelsListProvidersContract,
  ModelsTestContract,
  ProvidersListContract,
  ProvidersGetContract,
  ProvidersCreateContract,
  ProvidersUpdateContract,
  ProvidersDeleteContract,
  ProvidersEnableContract,
  ProvidersDisableContract,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

// ===========================================================================
// Aggregator sanity
// ===========================================================================

describe("AGENTS_CONTRACTS aggregator", () => {
  it("has exactly 17 entries (7 agent + 3 model + 7 provider)", () => {
    expect(AGENTS_CONTRACTS.length).toBe(17);
  });

  it("includes every expected method-name", () => {
    const names = new Set(AGENTS_CONTRACTS.map((c) => c.method));
    expect(names).toEqual(new Set([
      // agent-handlers.ts (7)
      "agents.create",
      "agents.get",
      "agents.update",
      "agents.delete",
      "agents.suspend",
      "agents.resume",
      "agent.getOperationModels",
      // model-handlers.ts (3)
      "models.list",
      "models.list_providers",
      "models.test",
      // provider-handlers.ts (7)
      "providers.list",
      "providers.get",
      "providers.create",
      "providers.update",
      "providers.delete",
      "providers.enable",
      "providers.disable",
    ]));
  });

  it("every contract is admin-scoped", () => {
    for (const c of AGENTS_CONTRACTS) {
      expect(c.scopes).toEqual(["admin"]);
    }
  });
});

// ===========================================================================
// INTERNAL_FIELD_NAMES paired sanity
// ===========================================================================

describe("agents domain contracts do not declare dispatcher internals", () => {
  it("no contract's request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // Run a probe input carrying every internal-field name. Each request
    // schema should either silently strip it (z.object default) or reject —
    // never echo it back in the parsed output.
    const internalPayload: Record<string, unknown> = Object.fromEntries(
      INTERNAL_FIELD_NAMES.map((n) => [n, "probe-value"]),
    );

    for (const c of AGENTS_CONTRACTS) {
      // Combine an internal-field payload with a minimal valid input for the
      // contract (presence of `agentId`/`providerId`/`provider` satisfies the
      // common required field across most contracts; for empty-request
      // contracts the internals are silently stripped).
      const minimalValid: Record<string, unknown> = {
        agentId: "x",
        providerId: "x",
        provider: "x",
      };
      const probe = { ...minimalValid, ...internalPayload };

      const parsed = c.request.safeParse(probe);
      if (parsed.success) {
        // Parsed output must NOT include any INTERNAL_FIELD_NAMES key.
        const outKeys = Object.keys(parsed.data as Record<string, unknown>);
        for (const internalKey of INTERNAL_FIELD_NAMES) {
          expect(outKeys).not.toContain(internalKey);
        }
      }
      // If !success, the schema rejected the probe (e.g. on a required-field
      // mismatch); that's also a valid outcome — we just need to ensure NO
      // contract MODELS an internal field, which the not-toContain assertion
      // above covers when the parse succeeds.
    }
  });
});

// ===========================================================================
// Per-contract spot-checks
// ===========================================================================

describe("AgentsCreateContract", () => {
  it("accepts a minimal valid request (agentId only)", () => {
    expect(AgentsCreateContract.request.parse({ agentId: "alpha" })).toEqual({
      agentId: "alpha",
    });
  });

  it("accepts request with config + inlineContent", () => {
    const parsed = AgentsCreateContract.request.parse({
      agentId: "alpha",
      config: { provider: "anthropic", model: "claude-sonnet-4-5" },
      inlineContent: { role: "developer", identity: "Alice" },
    });
    expect(parsed.agentId).toBe("alpha");
    expect(parsed.config).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(parsed.inlineContent).toEqual({ role: "developer", identity: "Alice" });
  });

  it("rejects request missing agentId", () => {
    expect(() => AgentsCreateContract.request.parse({})).toThrow();
  });

  it("accepts response shape with all fields", () => {
    expect(AgentsCreateContract.response.parse({
      agentId: "alpha",
      config: { provider: "anthropic", model: "claude-sonnet-4-5" },
      created: true,
      workspaceDir: "/home/test/.comis/workspace-alpha",
    })).toBeDefined();
  });

  it("rejects response with created: false", () => {
    expect(() => AgentsCreateContract.response.parse({
      agentId: "alpha",
      config: {},
      created: false,
      workspaceDir: "/x",
    })).toThrow();
  });
});

describe("AgentsGetContract", () => {
  it("accepts valid request", () => {
    expect(AgentsGetContract.request.parse({ agentId: "alpha" })).toEqual({
      agentId: "alpha",
    });
  });

  it("response carries boolean suspended + isDefault flags", () => {
    expect(AgentsGetContract.response.parse({
      agentId: "alpha",
      config: {},
      suspended: false,
      isDefault: true,
      workspaceDir: "/x",
    })).toBeDefined();
  });

  it("rejects response with non-boolean suspended", () => {
    expect(() => AgentsGetContract.response.parse({
      agentId: "alpha",
      config: {},
      suspended: "no",
      isDefault: true,
      workspaceDir: "/x",
    })).toThrow();
  });
});

describe("AgentsUpdateContract", () => {
  it("accepts loose config patch", () => {
    expect(AgentsUpdateContract.request.parse({
      agentId: "alpha",
      config: { model: "claude-haiku-4-5", skills: { builtinTools: { browser: false } } },
    })).toBeDefined();
  });

  it("accepts request without config (no-op update)", () => {
    expect(AgentsUpdateContract.request.parse({ agentId: "alpha" })).toEqual({
      agentId: "alpha",
    });
  });

  it("response.updated must be literal true", () => {
    expect(() => AgentsUpdateContract.response.parse({
      agentId: "alpha",
      config: {},
      updated: false,
    })).toThrow();
  });
});

describe("AgentsDeleteContract", () => {
  it("accepts valid request", () => {
    expect(AgentsDeleteContract.request.parse({ agentId: "alpha" })).toBeDefined();
  });

  it("response.deleted must be true", () => {
    expect(AgentsDeleteContract.response.parse({ agentId: "alpha", deleted: true })).toEqual({
      agentId: "alpha",
      deleted: true,
    });
  });
});

describe("AgentsSuspendContract", () => {
  it("response.suspended must be true", () => {
    expect(AgentsSuspendContract.response.parse({ agentId: "alpha", suspended: true })).toBeDefined();
    expect(() => AgentsSuspendContract.response.parse({ agentId: "alpha", suspended: false })).toThrow();
  });
});

describe("AgentsResumeContract", () => {
  it("response.resumed must be true", () => {
    expect(AgentsResumeContract.response.parse({ agentId: "alpha", resumed: true })).toBeDefined();
    expect(() => AgentsResumeContract.response.parse({ agentId: "alpha", resumed: false })).toThrow();
  });
});

describe("AgentGetOperationModelsContract", () => {
  it("accepts valid request", () => {
    expect(AgentGetOperationModelsContract.request.parse({ agentId: "alpha" })).toBeDefined();
  });

  it("response.operations carries tight per-entry shape", () => {
    expect(AgentGetOperationModelsContract.response.parse({
      agentId: "alpha",
      primaryModel: "anthropic:claude-sonnet-4-5",
      primaryProvider: "anthropic",
      providerFamily: "anthropic",
      tieringActive: true,
      operations: [
        {
          operationType: "interactive",
          model: "anthropic:claude-sonnet-4-5",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          source: "agent_primary",
          timeoutMs: 180000,
          tieringActive: false,
          crossProvider: false,
          apiKeyConfigured: true,
        },
      ],
    })).toBeDefined();
  });

  it("response.operations.apiKeyConfigured must be boolean", () => {
    expect(() => AgentGetOperationModelsContract.response.parse({
      agentId: "alpha",
      primaryModel: "x",
      primaryProvider: "x",
      providerFamily: "x",
      tieringActive: false,
      operations: [
        {
          operationType: "x",
          model: "x",
          provider: "x",
          modelId: "x",
          source: "x",
          timeoutMs: 0,
          tieringActive: false,
          crossProvider: false,
          apiKeyConfigured: "yes", // wrong type
        },
      ],
    })).toThrow();
  });
});

describe("ModelsListContract", () => {
  it("accepts request without provider", () => {
    expect(ModelsListContract.request.parse({})).toEqual({});
  });

  it("accepts request with provider", () => {
    expect(ModelsListContract.request.parse({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
    });
  });

  it("accepts response in the flat variant", () => {
    expect(ModelsListContract.response.parse({ models: [], total: 0 })).toBeDefined();
  });

  it("accepts response in the nested variant", () => {
    expect(ModelsListContract.response.parse({ providers: [], totalModels: 0 })).toBeDefined();
  });
});

describe("ModelsListProvidersContract", () => {
  it("accepts empty request", () => {
    expect(ModelsListProvidersContract.request.parse({})).toEqual({});
  });

  it("response carries providers[] + count", () => {
    expect(ModelsListProvidersContract.response.parse({
      providers: ["anthropic", "openai"],
      count: 2,
    })).toBeDefined();
  });

  it("rejects response without count", () => {
    expect(() => ModelsListProvidersContract.response.parse({
      providers: ["x"],
    })).toThrow();
  });
});

describe("ModelsTestContract", () => {
  it("accepts request with provider", () => {
    expect(ModelsTestContract.request.parse({ provider: "anthropic" })).toBeDefined();
  });

  it("rejects request missing provider", () => {
    expect(() => ModelsTestContract.request.parse({})).toThrow();
  });

  it("accepts loose response (status: not_configured variant)", () => {
    expect(ModelsTestContract.response.parse({
      provider: "x",
      status: "not_configured",
      message: "...",
      modelsInCatalog: 0,
    })).toBeDefined();
  });

  it("accepts loose response (status: available variant)", () => {
    expect(ModelsTestContract.response.parse({
      provider: "x",
      status: "available",
      modelsAvailable: 5,
      validatedModels: 3,
      agentsUsing: [{ agentId: "a", model: "m" }],
    })).toBeDefined();
  });
});

describe("ProvidersListContract", () => {
  it("accepts empty request", () => {
    expect(ProvidersListContract.request.parse({})).toBeDefined();
  });

  it("accepts response with apiKeyConfigured: null", () => {
    expect(ProvidersListContract.response.parse({
      providers: [
        {
          id: "ollama",
          type: "ollama",
          name: "Ollama",
          enabled: true,
          baseUrl: "http://localhost:11434",
          modelCount: 0,
          apiKeyConfigured: null,
        },
      ],
    })).toBeDefined();
  });

  it("accepts response with apiKeyConfigured: boolean", () => {
    expect(ProvidersListContract.response.parse({
      providers: [
        {
          id: "anthropic",
          type: "anthropic",
          name: "Anthropic",
          enabled: true,
          baseUrl: "https://api.anthropic.com",
          apiKeyName: "ANTHROPIC_API_KEY",
          modelCount: 5,
          apiKeyConfigured: true,
        },
      ],
    })).toBeDefined();
  });

  it("rejects response with apiKeyConfigured of wrong type", () => {
    expect(() => ProvidersListContract.response.parse({
      providers: [
        {
          id: "x",
          type: "x",
          name: "x",
          enabled: true,
          baseUrl: "x",
          modelCount: 0,
          apiKeyConfigured: "yes",
        },
      ],
    })).toThrow();
  });
});

describe("ProvidersGetContract", () => {
  it("accepts valid request", () => {
    expect(ProvidersGetContract.request.parse({ providerId: "x" })).toBeDefined();
  });

  it("response carries agentsUsing string[]", () => {
    expect(ProvidersGetContract.response.parse({
      providerId: "anthropic",
      config: {},
      apiKeyConfigured: false,
      agentsUsing: ["alpha", "beta"],
    })).toBeDefined();
  });
});

describe("ProvidersCreateContract", () => {
  it("accepts request with loose config patch", () => {
    expect(ProvidersCreateContract.request.parse({
      providerId: "my-custom",
      config: { name: "Custom", type: "openai", baseUrl: "https://x.com" },
    })).toBeDefined();
  });

  it("response.created must be literal true", () => {
    expect(() => ProvidersCreateContract.response.parse({
      providerId: "x",
      config: {},
      created: false,
    })).toThrow();
  });
});

describe("ProvidersUpdateContract", () => {
  it("accepts loose config patch", () => {
    expect(ProvidersUpdateContract.request.parse({
      providerId: "anthropic",
      config: { enabled: false },
    })).toBeDefined();
  });

  it("response.updated must be literal true", () => {
    expect(() => ProvidersUpdateContract.response.parse({
      providerId: "x",
      config: {},
      updated: false,
    })).toThrow();
  });
});

describe("ProvidersDeleteContract", () => {
  it("response.deleted must be true", () => {
    expect(ProvidersDeleteContract.response.parse({
      providerId: "x",
      deleted: true,
    })).toBeDefined();
  });
});

describe("ProvidersEnableContract", () => {
  it("response.enabled must be literal true", () => {
    expect(ProvidersEnableContract.response.parse({
      providerId: "x",
      enabled: true,
    })).toBeDefined();
    expect(() => ProvidersEnableContract.response.parse({
      providerId: "x",
      enabled: false,
    })).toThrow();
  });
});

describe("ProvidersDisableContract", () => {
  it("response.enabled must be literal false", () => {
    expect(ProvidersDisableContract.response.parse({
      providerId: "x",
      enabled: false,
    })).toBeDefined();
    expect(() => ProvidersDisableContract.response.parse({
      providerId: "x",
      enabled: true,
    })).toThrow();
  });

  it("accepts response with optional warning", () => {
    expect(ProvidersDisableContract.response.parse({
      providerId: "x",
      enabled: false,
      warning: "Provider \"x\" is referenced by agents",
    })).toBeDefined();
  });
});
