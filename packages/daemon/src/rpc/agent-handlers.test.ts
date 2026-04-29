// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAgentHandlers } from "./agent-handlers.js";
import type { AgentHandlerDeps } from "./agent-handlers.js";
import type { PersistToConfigDeps } from "./persist-to-config.js";

// ---------------------------------------------------------------------------
// Mock persist-to-config module to avoid real filesystem operations
// ---------------------------------------------------------------------------

vi.mock("./persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));

// ---------------------------------------------------------------------------
// Mock agent-inline-workspace module so we can drive 260428-vyf inline-write
// outcomes per-test without touching the real filesystem.
// ---------------------------------------------------------------------------

vi.mock("./agent-inline-workspace.js", () => ({
  writeInlineWorkspaceFiles: vi.fn(),
}));

vi.mock("@comis/agent", () => ({
  resolveWorkspaceDir: vi.fn((_config: unknown, agentId?: string) =>
    agentId && agentId !== "default"
      ? `/home/test/.comis/workspace-${agentId}`
      : "/home/test/.comis/workspace"
  ),
  resolveOperationModel: vi.fn((params: { operationType: string; agentProvider: string; agentModel: string; operationModels: Record<string, unknown>; providerFamily: string }) => {
    // Simulate real resolver: return family default for non-interactive, agent primary for interactive
    const tier: Record<string, string> = { interactive: "primary", cron: "mid", heartbeat: "fast", subagent: "mid", compaction: "fast", taskExtraction: "fast", condensation: "fast" };
    const familyDefaults: Record<string, Record<string, string>> = {
      anthropic: { mid: "claude-sonnet-4-5-20250929", fast: "claude-haiku-4-5" },
    };
    const opTier = tier[params.operationType] ?? "primary";
    const familyMap = familyDefaults[params.providerFamily];

    // Check explicit config first
    const explicitModel = params.operationModels[params.operationType];
    if (typeof explicitModel === "string" && explicitModel.length > 0) {
      const colonIdx = explicitModel.indexOf(":");
      const provider = colonIdx > 0 ? explicitModel.slice(0, colonIdx) : params.agentProvider;
      const modelId = colonIdx > 0 ? explicitModel.slice(colonIdx + 1) : explicitModel;
      return {
        model: `${provider}:${modelId}`,
        provider,
        modelId,
        source: "explicit_config",
        operationType: params.operationType,
        timeoutMs: 60000,
      };
    }

    if (opTier !== "primary" && familyMap) {
      return {
        model: `${params.agentProvider}:${familyMap[opTier]}`,
        provider: params.agentProvider,
        modelId: familyMap[opTier],
        source: "family_default",
        operationType: params.operationType,
        timeoutMs: 60000,
      };
    }
    return {
      model: `${params.agentProvider}:${params.agentModel}`,
      provider: params.agentProvider,
      modelId: params.agentModel,
      source: "agent_primary",
      operationType: params.operationType,
      timeoutMs: 180000,
    };
  }),
  resolveProviderFamily: vi.fn((provider: string) => {
    if (provider.endsWith("-bedrock")) return provider.slice(0, -"-bedrock".length);
    if (provider.endsWith("-vertex")) return provider.slice(0, -"-vertex".length);
    return provider;
  }),
  OPERATION_TIER_MAP: {
    interactive: "primary",
    cron: "mid",
    heartbeat: "fast",
    subagent: "mid",
    compaction: "fast",
    taskExtraction: "fast",
    condensation: "fast",
  },
  DEFAULT_PROVIDER_KEYS: {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
  },
}));

import { persistToConfig } from "./persist-to-config.js";
const mockPersistToConfig = vi.mocked(persistToConfig);

import { writeInlineWorkspaceFiles } from "./agent-inline-workspace.js";
const mockWriteInline = vi.mocked(writeInlineWorkspaceFiles);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<AgentHandlerDeps>): AgentHandlerDeps {
  return {
    agents: {
      default: {
        name: "Test Agent",
        model: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        maxSteps: 25,
      } as AgentHandlerDeps["agents"][string],
    },
    defaultAgentId: "default",
    suspendedAgents: new Set<string>(),
    ...overrides,
  };
}

function makePersistDeps(): PersistToConfigDeps {
  return {
    container: {
      config: { tenantId: "test", agents: {} },
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

describe("createAgentHandlers", () => {
  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
    // Default: helper returns ok with no files written. The handler skips
    // the call entirely when inlineContent is undefined, so this default
    // is a safety net for tests that supply inlineContent without
    // overriding the helper outcome.
    mockWriteInline.mockReset();
    mockWriteInline.mockResolvedValue({
      ok: true,
      value: { roleWritten: false, identityWritten: false, bytesWritten: 0 },
    });
  });

  // -------------------------------------------------------------------------
  // agents.create (admin required)
  // -------------------------------------------------------------------------

  describe("agents.create", () => {
    it("rejects agents.create without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.create"]!({ agentId: "new-bot", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects agents.create without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.create"]!({ agentId: "new-bot" }),
      ).rejects.toThrow("Admin access required");
    });

    it("creates a new agent with valid config", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "new-bot",
        config: { name: "New Bot", model: "claude-sonnet-4-5-20250929" },
        _trustLevel: "admin",
      })) as { agentId: string; config: unknown; created: boolean };

      expect(result.agentId).toBe("new-bot");
      expect(result.created).toBe(true);
      expect(result.config).toBeDefined();
      // Verify agent was added to the runtime map
      expect(deps.agents["new-bot"]).toBeDefined();
    });

    it("creates agent with empty config (all defaults)", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "minimal-bot",
        _trustLevel: "admin",
      })) as { agentId: string; created: boolean };

      expect(result.agentId).toBe("minimal-bot");
      expect(result.created).toBe(true);
      expect(deps.agents["minimal-bot"]).toBeDefined();
    });

    it("throws when agentId already exists", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.create"]!({ agentId: "default", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent already exists: default");
    });

    it("throws when agentId is empty", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.create"]!({ agentId: "", _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: agentId");
    });

    it("throws when agentId is missing", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(handlers["agents.create"]!({ _trustLevel: "admin" })).rejects.toThrow(
        "Missing required parameter: agentId",
      );
    });

    it("strips workspacePath from config to force auto-computed workspace", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "ws-bot",
        config: { name: "WS Bot", workspacePath: "agents/ws-bot" },
        _trustLevel: "admin",
      });

      expect(deps.agents["ws-bot"]!.workspacePath).toBeUndefined();
    });

    it("defaults all builtinTools to true (except browser) for runtime-created agents", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "web-bot",
        config: { name: "Web Bot", model: "claude-sonnet-4-5-20250929" },
        _trustLevel: "admin",
      });

      const agent = deps.agents["web-bot"]!;
      // All tools enabled by default
      expect(agent.skills.builtinTools.read).toBe(true);
      expect(agent.skills.builtinTools.write).toBe(true);
      expect(agent.skills.builtinTools.edit).toBe(true);
      expect(agent.skills.builtinTools.grep).toBe(true);
      expect(agent.skills.builtinTools.find).toBe(true);
      expect(agent.skills.builtinTools.ls).toBe(true);
      expect(agent.skills.builtinTools.exec).toBe(true);
      expect(agent.skills.builtinTools.process).toBe(true);
      expect(agent.skills.builtinTools.webSearch).toBe(true);
      expect(agent.skills.builtinTools.webFetch).toBe(true);
      // Browser is the only one disabled by default
      expect(agent.skills.builtinTools.browser).toBe(false);
    });

    it("returns workspaceDir in create response", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "ws-test",
        config: { name: "WS Test" },
        _trustLevel: "admin",
      })) as { workspaceDir: string };

      expect(result.workspaceDir).toBe("/home/test/.comis/workspace-ws-test");
    });

    it("preserves explicit skills overrides while defaulting unspecified tools to true", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "custom-bot",
        config: {
          name: "Custom Bot",
          skills: { builtinTools: { webSearch: false, webFetch: false } },
        },
        _trustLevel: "admin",
      });

      const agent = deps.agents["custom-bot"]!;
      // Explicit overrides are honored
      expect(agent.skills.builtinTools.webSearch).toBe(false);
      expect(agent.skills.builtinTools.webFetch).toBe(false);
      // Unspecified tools default to true (not left undefined)
      expect(agent.skills.builtinTools.read).toBe(true);
      expect(agent.skills.builtinTools.write).toBe(true);
      expect(agent.skills.builtinTools.edit).toBe(true);
      expect(agent.skills.builtinTools.grep).toBe(true);
      expect(agent.skills.builtinTools.find).toBe(true);
      expect(agent.skills.builtinTools.ls).toBe(true);
      expect(agent.skills.builtinTools.exec).toBe(true);
      expect(agent.skills.builtinTools.process).toBe(true);
      // Browser still defaults to false
      expect(agent.skills.builtinTools.browser).toBe(false);
    });

    it("persisted config does not contain workspacePath", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "ws-persist-bot",
        config: { name: "WS Bot", workspacePath: "/custom/path" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const agentsPatch = mockPersistToConfig.mock.calls[0]![1].patch.agents as Record<string, Record<string, unknown>>;
      expect(agentsPatch["ws-persist-bot"]!.workspacePath).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 260428-vyf Layer 2: agents.create with inlineContent {role, identity}.
  //
  // Single-call agent creation: the L1 tool layer strips role/identity from
  // config.workspace and forwards them as a separate top-level RPC param
  // (`inlineContent`). The daemon writes ROLE.md / IDENTITY.md atomically
  // via the writeInlineWorkspaceFiles helper. role/identity are write-once
  // side-effects, NOT durable state — they NEVER reach config.yaml.
  // -------------------------------------------------------------------------
  describe("agents.create with inlineContent (260428-vyf)", () => {
    it("Test 1 (full inline): forwards role+identity to helper, returns inlineWritesResult on RPC payload", async () => {
      mockWriteInline.mockResolvedValueOnce({
        ok: true,
        value: { roleWritten: true, identityWritten: true, bytesWritten: 2 },
      });
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "vyf-full",
        inlineContent: { role: "R", identity: "I" },
        _trustLevel: "admin",
      })) as { agentId: string; created: boolean; workspaceDir: string; inlineWritesResult?: unknown };

      expect(result.created).toBe(true);
      expect(result.workspaceDir).toBe("/home/test/.comis/workspace-vyf-full");
      expect(result.inlineWritesResult).toEqual({
        roleWritten: true,
        identityWritten: true,
        bytesWritten: 2,
      });

      expect(mockWriteInline).toHaveBeenCalledTimes(1);
      const [helperDeps, helperParams] = mockWriteInline.mock.calls[0]!;
      expect(helperDeps).toHaveProperty("logger");
      expect(helperParams).toEqual({
        workspaceDir: "/home/test/.comis/workspace-vyf-full",
        agentId: "vyf-full",
        role: "R",
        identity: "I",
      });
    });

    it("Test 2 (role-only): forwards role only, returns partial inlineWritesResult", async () => {
      mockWriteInline.mockResolvedValueOnce({
        ok: true,
        value: { roleWritten: true, identityWritten: false, bytesWritten: 1 },
      });
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "vyf-role",
        inlineContent: { role: "R" },
        _trustLevel: "admin",
      })) as { inlineWritesResult?: unknown };

      expect(result.inlineWritesResult).toEqual({
        roleWritten: true,
        identityWritten: false,
        bytesWritten: 1,
      });
      const [, helperParams] = mockWriteInline.mock.calls[0]!;
      expect(helperParams).toEqual({
        workspaceDir: "/home/test/.comis/workspace-vyf-role",
        agentId: "vyf-role",
        role: "R",
        identity: undefined,
      });
    });

    it("Test 3 (no inlineContent — regression): result OMITS inlineWritesResult; helper not invoked", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "vyf-none",
        config: { name: "None" },
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      expect("inlineWritesResult" in result).toBe(false);
      expect(mockWriteInline).not.toHaveBeenCalled();
    });

    it("Test 4 (persisted config strips role/identity): patch.agents[agentId] has no role/identity keys even when inlineContent supplied", async () => {
      mockWriteInline.mockResolvedValueOnce({
        ok: true,
        value: { roleWritten: true, identityWritten: true, bytesWritten: 2 },
      });
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "vyf-strip",
        config: { name: "Strip Bot" },
        inlineContent: { role: "R", identity: "I" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const agentsPatch = mockPersistToConfig.mock.calls[0]![1].patch.agents as Record<string, Record<string, unknown>>;
      const agentEntry = agentsPatch["vyf-strip"]!;
      expect(agentEntry).not.toHaveProperty("role");
      expect(agentEntry).not.toHaveProperty("identity");
      // Workspace, if present, must not carry these either.
      const ws = agentEntry.workspace as Record<string, unknown> | undefined;
      if (ws !== undefined) {
        expect(ws).not.toHaveProperty("role");
        expect(ws).not.toHaveProperty("identity");
      }
    });

    it("Test 5 (helper failure): RPC still returns created:true; inlineWritesResult carries the err shape; no throw", async () => {
      mockWriteInline.mockResolvedValueOnce({
        ok: false,
        error: { kind: "io", file: "ROLE.md", message: "EACCES" },
      });
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "vyf-fail",
        inlineContent: { role: "R" },
        _trustLevel: "admin",
      })) as { created: boolean; workspaceDir: string; inlineWritesResult?: unknown };

      expect(result.created).toBe(true);
      expect(result.workspaceDir).toBe("/home/test/.comis/workspace-vyf-fail");
      expect(result.inlineWritesResult).toEqual({
        ok: false,
        error: { kind: "io", file: "ROLE.md", message: "EACCES" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // agents.get (read-only -- no admin required)
  // -------------------------------------------------------------------------

  describe("agents.get", () => {
    it("returns agent config with suspended=false for active agent", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "default",
      })) as {
        agentId: string;
        config: unknown;
        suspended: boolean;
        isDefault: boolean;
      };

      expect(result.agentId).toBe("default");
      expect(result.suspended).toBe(false);
      expect(result.config).toBeDefined();
    });

    it("returns agent config with suspended=true for suspended agent", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "default",
      })) as { suspended: boolean };

      expect(result.suspended).toBe(true);
    });

    it("identifies default agent correctly (isDefault: true)", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "default",
      })) as { isDefault: boolean };

      expect(result.isDefault).toBe(true);
    });

    it("returns isDefault=false for non-default agent", async () => {
      const deps = makeDeps();
      // Add a second agent
      deps.agents["secondary"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "secondary",
      })) as { isDefault: boolean };

      expect(result.isDefault).toBe(false);
    });

    it("throws when agent not found", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.get"]!({ agentId: "nonexistent" }),
      ).rejects.toThrow("Agent not found: nonexistent");
    });

    it("returns workspaceDir in get response", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "default",
      })) as { workspaceDir: string };

      expect(result.workspaceDir).toBe("/home/test/.comis/workspace");
    });

    it("works without _trustLevel (read-only operation)", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.get"]!({
        agentId: "default",
      })) as { agentId: string };

      expect(result.agentId).toBe("default");
    });
  });

  // -------------------------------------------------------------------------
  // agents.update (admin required)
  // -------------------------------------------------------------------------

  describe("agents.update", () => {
    it("rejects agents.update without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.update"]!({ agentId: "default", config: { model: "gpt-4o" }, _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects agents.update without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.update"]!({ agentId: "default", config: { model: "gpt-4o" } }),
      ).rejects.toThrow("Admin access required");
    });

    it("updates existing agent config fields", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.update"]!({
        agentId: "default",
        config: { model: "gpt-4o" },
        _trustLevel: "admin",
      })) as { agentId: string; config: Record<string, unknown>; updated: boolean };

      expect(result.agentId).toBe("default");
      expect(result.updated).toBe(true);
      expect(result.config.model).toBe("gpt-4o");
      // Original fields should be preserved
      expect(result.config.name).toBe("Test Agent");
    });

    it("deep-merges skills.builtinTools without resetting existing toggles", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      // First create an agent with webSearch enabled
      await handlers["agents.create"]!({
        agentId: "merge-bot",
        config: { name: "Merge Bot", skills: { builtinTools: { webSearch: true } } },
        _trustLevel: "admin",
      });
      expect(deps.agents["merge-bot"]!.skills.builtinTools.webSearch).toBe(true);
      expect(deps.agents["merge-bot"]!.skills.builtinTools.webFetch).toBe(true);

      // Now update to enable webFetch -- webSearch should be preserved
      await handlers["agents.update"]!({
        agentId: "merge-bot",
        config: { skills: { builtinTools: { webFetch: true } } },
        _trustLevel: "admin",
      });

      const agent = deps.agents["merge-bot"]!;
      expect(agent.skills.builtinTools.webSearch).toBe(true);  // preserved
      expect(agent.skills.builtinTools.webFetch).toBe(true);   // newly enabled
      expect(agent.skills.builtinTools.read).toBe(true);       // schema default preserved
    });

    it("throws when agent not found", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.update"]!({
          agentId: "nonexistent",
          config: { name: "Updated" },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow("Agent not found: nonexistent");
    });

    it("preserves scalar modelFailover fields when patching only fallbackModels", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      // Setup: agent with existing modelFailover scalars
      await handlers["agents.create"]!({
        agentId: "failover-test",
        config: {
          name: "Failover Test",
          modelFailover: {
            fallbackModels: [{ provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" }],
            cooldownInitialMs: 30_000,
            cooldownMultiplier: 3,
          },
        },
        _trustLevel: "admin",
      });

      mockPersistToConfig.mockClear();

      const result = (await handlers["agents.update"]!({
        agentId: "failover-test",
        config: {
          modelFailover: {
            fallbackModels: [
              { provider: "deepseek", modelId: "deepseek-chat" },
              { provider: "ollama", modelId: "llama3.3" },
            ],
          },
        },
        _trustLevel: "admin",
      })) as { agentId: string; config: Record<string, unknown>; updated: boolean };

      // In-memory: fallbackModels replaced, scalar cooldown fields preserved
      const mf = result.config.modelFailover as Record<string, unknown>;
      expect((mf.fallbackModels as unknown[]).length).toBe(2);
      expect(mf.cooldownInitialMs).toBe(30_000);
      expect(mf.cooldownMultiplier).toBe(3);

      // Persisted: only user's partial patch (NOT the merged form)
      const persistCall = mockPersistToConfig.mock.calls.at(-1);
      const persistedPatch = (persistCall?.[1] as Record<string, unknown>)?.patch as Record<string, unknown>;
      const agentPatch = (persistedPatch?.agents as Record<string, Record<string, unknown>>)?.["failover-test"];
      // The persisted patch should have modelFailover.fallbackModels but NOT cooldownInitialMs
      expect((agentPatch?.modelFailover as Record<string, unknown>)?.fallbackModels).toBeDefined();
      // cooldownInitialMs should NOT be in the persisted patch (it was not in the user's input)
      expect((agentPatch?.modelFailover as Record<string, unknown>)?.cooldownInitialMs).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // agents.delete (admin required)
  // -------------------------------------------------------------------------

  describe("agents.delete", () => {
    it("rejects agents.delete without admin trust level", async () => {
      const deps = makeDeps();
      deps.agents["temp-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.delete"]!({ agentId: "temp-bot", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects agents.delete without any trust level", async () => {
      const deps = makeDeps();
      deps.agents["temp-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.delete"]!({ agentId: "temp-bot" }),
      ).rejects.toThrow("Admin access required");
    });

    it("deletes existing non-default agent", async () => {
      const deps = makeDeps();
      deps.agents["temp-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.delete"]!({
        agentId: "temp-bot",
        _trustLevel: "admin",
      })) as { agentId: string; deleted: boolean };

      expect(result.agentId).toBe("temp-bot");
      expect(result.deleted).toBe(true);
      expect(deps.agents["temp-bot"]).toBeUndefined();
    });

    it("removes agent from suspendedAgents set if suspended", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["temp-bot"]),
      });
      deps.agents["temp-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await handlers["agents.delete"]!({ agentId: "temp-bot", _trustLevel: "admin" });

      expect(deps.suspendedAgents.has("temp-bot")).toBe(false);
    });

    it("throws when trying to delete default agent", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.delete"]!({ agentId: "default", _trustLevel: "admin" }),
      ).rejects.toThrow("Cannot delete default agent: default");
    });

    it("throws when agent not found", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.delete"]!({ agentId: "nonexistent", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent not found: nonexistent");
    });
  });

  // -------------------------------------------------------------------------
  // agents.suspend (admin required)
  // -------------------------------------------------------------------------

  describe("agents.suspend", () => {
    it("rejects agents.suspend without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.suspend"]!({ agentId: "default", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects agents.suspend without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.suspend"]!({ agentId: "default" }),
      ).rejects.toThrow("Admin access required");
    });

    it("suspends an active agent", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.suspend"]!({
        agentId: "default",
        _trustLevel: "admin",
      })) as { agentId: string; suspended: boolean };

      expect(result.agentId).toBe("default");
      expect(result.suspended).toBe(true);
      expect(deps.suspendedAgents.has("default")).toBe(true);
    });

    it("throws when agent already suspended", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.suspend"]!({ agentId: "default", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent already suspended: default");
    });

    it("throws when agent not found", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.suspend"]!({ agentId: "nonexistent", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent not found: nonexistent");
    });
  });

  // -------------------------------------------------------------------------
  // agents.resume (admin required)
  // -------------------------------------------------------------------------

  describe("agents.resume", () => {
    it("rejects agents.resume without admin trust level", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.resume"]!({ agentId: "default", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects agents.resume without any trust level", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.resume"]!({ agentId: "default" }),
      ).rejects.toThrow("Admin access required");
    });

    it("resumes a suspended agent", async () => {
      const deps = makeDeps({
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.resume"]!({
        agentId: "default",
        _trustLevel: "admin",
      })) as { agentId: string; resumed: boolean };

      expect(result.agentId).toBe("default");
      expect(result.resumed).toBe(true);
      expect(deps.suspendedAgents.has("default")).toBe(false);
    });

    it("throws when agent not suspended", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.resume"]!({ agentId: "default", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent is not suspended: default");
    });

    it("throws when agent not found", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agents.resume"]!({ agentId: "nonexistent", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent not found: nonexistent");
    });
  });

  // -------------------------------------------------------------------------
  // Persistence wiring tests
  // -------------------------------------------------------------------------

  describe("persistence wiring", () => {
    it("agents.create calls persistToConfig with agent config patch", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "persist-bot",
        config: { name: "Persist Bot", model: "claude-sonnet-4-5-20250929" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("agents.create");
      expect(callOpts.entityId).toBe("persist-bot");
      expect(callOpts.patch).toHaveProperty("agents");
      const agentsPatch = callOpts.patch.agents as Record<string, unknown>;
      expect(agentsPatch).toHaveProperty("persist-bot");

      // Verify only user-provided fields are persisted, not full Zod-parsed config
      const persistedAgent = agentsPatch["persist-bot"] as Record<string, unknown>;
      // Should contain user-provided fields
      expect(persistedAgent).toHaveProperty("name", "Persist Bot");
      expect(persistedAgent).toHaveProperty("model", "claude-sonnet-4-5-20250929");
      // Should contain auto-added web tools (since no skills provided)
      expect(persistedAgent).toHaveProperty("skills");
      // Should NOT contain Zod defaults that weren't user-provided
      expect(persistedAgent).not.toHaveProperty("provider");
      expect(persistedAgent).not.toHaveProperty("maxSteps");
      expect(persistedAgent).not.toHaveProperty("temperature");
      expect(persistedAgent).not.toHaveProperty("systemPrompt");
    });

    it("agents.update calls persistToConfig with updated config patch", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.update"]!({
        agentId: "default",
        config: { model: "gpt-4o" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("agents.update");
      expect(callOpts.entityId).toBe("default");
      expect(callOpts.patch).toHaveProperty("agents");
      const agentsPatch = callOpts.patch.agents as Record<string, unknown>;
      expect(agentsPatch).toHaveProperty("default");

      // Verify only the user's partial update is persisted, not full merged config
      const persistedAgent = agentsPatch["default"] as Record<string, unknown>;
      // Should contain only the user-provided update field
      expect(persistedAgent).toHaveProperty("model", "gpt-4o");
      // Should NOT contain fields from the existing config or Zod defaults
      expect(persistedAgent).not.toHaveProperty("name");
      expect(persistedAgent).not.toHaveProperty("maxSteps");
      expect(persistedAgent).not.toHaveProperty("provider");
    });

    it("agents.delete calls persistToConfig with removePaths", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      deps.agents["temp-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await handlers["agents.delete"]!({ agentId: "temp-bot", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("agents.delete");
      expect(callOpts.entityId).toBe("temp-bot");
      expect(callOpts.removePaths).toEqual([["agents", "temp-bot"]]);
      expect(callOpts.patch).toEqual({});
    });

    it("agents.create succeeds even if persistToConfig fails", async () => {
      mockPersistToConfig.mockResolvedValue({ ok: false, error: "disk full" } as never);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "resilient-bot",
        config: { name: "Resilient Bot" },
        _trustLevel: "admin",
      })) as { agentId: string; created: boolean };

      // Handler still succeeds -- persistence is best-effort
      expect(result.agentId).toBe("resilient-bot");
      expect(result.created).toBe(true);
      expect(deps.agents["resilient-bot"]).toBeDefined();
      // Persistence failure was logged
      expect(persistDeps.logger.warn).toHaveBeenCalled();
    });

    it("agents.suspend does not call persistToConfig", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.suspend"]!({ agentId: "default", _trustLevel: "admin" });

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("agents.resume does not call persistToConfig", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({
        persistDeps,
        suspendedAgents: new Set(["default"]),
      });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.resume"]!({ agentId: "default", _trustLevel: "admin" });

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // hotAdd/hotRemove lifecycle tests
  // -------------------------------------------------------------------------

  describe("agents.create with hotAdd", () => {
    it("calls hotAdd after successful persist with correct args", async () => {
      const hotAddMock = vi.fn().mockResolvedValue(undefined);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotAdd: hotAddMock });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "hot-bot",
        config: { name: "Hot Bot", model: "claude-sonnet-4-5-20250929" },
        _trustLevel: "admin",
      });

      expect(hotAddMock).toHaveBeenCalledOnce();
      expect(hotAddMock).toHaveBeenCalledWith(
        "hot-bot",
        expect.objectContaining({ name: "Hot Bot", model: "claude-sonnet-4-5-20250929" }),
      );
    });

    it("passes skipRestart: true to persistToConfig when hotAdd provided", async () => {
      const hotAddMock = vi.fn().mockResolvedValue(undefined);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotAdd: hotAddMock });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "skip-bot",
        config: { name: "Skip Bot" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipRestart: true }),
      );
    });

    it("does NOT pass skipRestart when hotAdd is not provided", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps }); // no hotAdd
      const handlers = createAgentHandlers(deps);

      await handlers["agents.create"]!({
        agentId: "no-hot-bot",
        config: { name: "No Hot Bot" },
        _trustLevel: "admin",
      });

      expect(mockPersistToConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipRestart: false }),
      );
    });

    it("hotAdd failure does not fail the create RPC (graceful degradation)", async () => {
      const hotAddMock = vi.fn().mockRejectedValue(new Error("setup failed"));
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotAdd: hotAddMock });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.create"]!({
        agentId: "fail-hot-bot",
        config: { name: "Fail Hot Bot" },
        _trustLevel: "admin",
      })) as { agentId: string; created: boolean };

      // RPC should NOT throw -- hot-add failure is graceful
      expect(result.created).toBe(true);
      expect(result.agentId).toBe("fail-hot-bot");
      // Warning should have been logged
      expect(persistDeps.logger.warn).toHaveBeenCalled();
    });
  });

  describe("agents.delete with hotRemove", () => {
    it("calls hotRemove after successful persist with correct agentId", async () => {
      const hotRemoveMock = vi.fn().mockResolvedValue(undefined);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotRemove: hotRemoveMock });
      deps.agents["temp-hot-bot"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await handlers["agents.delete"]!({ agentId: "temp-hot-bot", _trustLevel: "admin" });

      expect(hotRemoveMock).toHaveBeenCalledOnce();
      expect(hotRemoveMock).toHaveBeenCalledWith("temp-hot-bot");
    });

    it("passes skipRestart: true to persistToConfig when hotRemove provided", async () => {
      const hotRemoveMock = vi.fn().mockResolvedValue(undefined);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotRemove: hotRemoveMock });
      deps.agents["temp-hot-bot2"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      await handlers["agents.delete"]!({ agentId: "temp-hot-bot2", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipRestart: true }),
      );
    });

    it("hotRemove failure does not fail the delete RPC (graceful)", async () => {
      const hotRemoveMock = vi.fn().mockRejectedValue(new Error("teardown failed"));
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotRemove: hotRemoveMock });
      deps.agents["temp-hot-bot3"] = deps.agents["default"]!;
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agents.delete"]!({
        agentId: "temp-hot-bot3",
        _trustLevel: "admin",
      })) as { agentId: string; deleted: boolean };

      // RPC should NOT throw -- hot-remove failure is graceful
      expect(result.deleted).toBe(true);
      expect(result.agentId).toBe("temp-hot-bot3");
      // Warning should have been logged
      expect(persistDeps.logger.warn).toHaveBeenCalled();
    });
  });

  describe("agents.update hotAdd/hotRemove regression guard", () => {
    it("agents.update does NOT pass skipRestart or call hotAdd/hotRemove", async () => {
      const hotAddMock = vi.fn();
      const hotRemoveMock = vi.fn();
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps, hotAdd: hotAddMock, hotRemove: hotRemoveMock });
      const handlers = createAgentHandlers(deps);

      await handlers["agents.update"]!({
        agentId: "default",
        config: { model: "gpt-4o" },
        _trustLevel: "admin",
      });

      // persistToConfig should be called WITHOUT skipRestart in the opts
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const callOpts = mockPersistToConfig.mock.calls[0]![1];
      expect(callOpts.skipRestart).toBeUndefined();

      // Neither hotAdd nor hotRemove should have been called
      expect(hotAddMock).not.toHaveBeenCalled();
      expect(hotRemoveMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // agent.getOperationModels RPC handler
  // -------------------------------------------------------------------------

  describe("agent.getOperationModels", () => {
    it("returns structured response with all 7 operations for valid agentId", async () => {
      const deps = makeDeps({
        secretManager: { has: vi.fn(() => true) },
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agent.getOperationModels"]!({
        agentId: "default",
      })) as {
        agentId: string;
        primaryModel: string;
        providerFamily: string;
        tieringActive: boolean;
        operations: Array<{ operationType: string }>;
      };

      expect(result.agentId).toBe("default");
      expect(result.primaryModel).toBe("anthropic:claude-sonnet-4-5-20250929");
      expect(result.providerFamily).toBe("anthropic");
      expect(result.operations).toHaveLength(7);
      const opTypes = result.operations.map((o) => o.operationType);
      expect(opTypes).toContain("interactive");
      expect(opTypes).toContain("cron");
      expect(opTypes).toContain("heartbeat");
      expect(opTypes).toContain("subagent");
      expect(opTypes).toContain("compaction");
      expect(opTypes).toContain("taskExtraction");
      expect(opTypes).toContain("condensation");
    });

    it("throws for unknown agentId", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agent.getOperationModels"]!({ agentId: "unknown" }),
      ).rejects.toThrow("Agent not found: unknown");
    });

    it("throws when agentId param is missing", async () => {
      const deps = makeDeps();
      const handlers = createAgentHandlers(deps);

      await expect(
        handlers["agent.getOperationModels"]!({}),
      ).rejects.toThrow("Missing required parameter: agentId");
    });

    it("marks tieringActive=true for non-interactive ops with family_default source", async () => {
      const deps = makeDeps({
        secretManager: { has: vi.fn(() => true) },
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agent.getOperationModels"]!({
        agentId: "default",
      })) as {
        tieringActive: boolean;
        operations: Array<{ operationType: string; tieringActive: boolean; source: string }>;
      };

      // Overall tiering should be active (at least one op is tiered)
      expect(result.tieringActive).toBe(true);

      // Interactive uses agent_primary -> tieringActive=false
      const interactive = result.operations.find((o) => o.operationType === "interactive")!;
      expect(interactive.tieringActive).toBe(false);
      expect(interactive.source).toBe("agent_primary");

      // Non-interactive ops use family_default -> tieringActive=true
      const cron = result.operations.find((o) => o.operationType === "cron")!;
      expect(cron.tieringActive).toBe(true);
      expect(cron.source).toBe("family_default");
    });

    it("detects cross-provider resolution and checks apiKeyConfigured", async () => {
      // Secret manager returns true only for ANTHROPIC_API_KEY
      const deps = makeDeps({
        agents: {
          "cross-agent": {
            name: "Cross Agent",
            model: "claude-sonnet-4-5-20250929",
            provider: "anthropic",
            maxSteps: 25,
            operationModels: {
              cron: "openai:gpt-4o",
            },
          } as AgentHandlerDeps["agents"][string],
        },
        defaultAgentId: "cross-agent",
        secretManager: { has: vi.fn((key: string) => key === "ANTHROPIC_API_KEY") },
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agent.getOperationModels"]!({
        agentId: "cross-agent",
      })) as {
        operations: Array<{
          operationType: string;
          crossProvider: boolean;
          apiKeyConfigured: boolean;
        }>;
      };

      // Cron has explicit openai model on anthropic agent -> crossProvider=true
      const cron = result.operations.find((o) => o.operationType === "cron")!;
      expect(cron.crossProvider).toBe(true);
      expect(cron.apiKeyConfigured).toBe(false); // OPENAI_API_KEY not in secretManager

      // Heartbeat resolves to anthropic family default -> crossProvider=false
      const heartbeat = result.operations.find((o) => o.operationType === "heartbeat")!;
      expect(heartbeat.crossProvider).toBe(false);
      expect(heartbeat.apiKeyConfigured).toBe(true); // ANTHROPIC_API_KEY is in secretManager
    });

    it("shows crossProvider=false and apiKeyConfigured=true for same-provider ops", async () => {
      const deps = makeDeps({
        secretManager: { has: vi.fn(() => true) },
      });
      const handlers = createAgentHandlers(deps);

      const result = (await handlers["agent.getOperationModels"]!({
        agentId: "default",
      })) as {
        operations: Array<{
          operationType: string;
          crossProvider: boolean;
          apiKeyConfigured: boolean;
        }>;
      };

      // All default ops resolve to same provider (anthropic)
      for (const op of result.operations) {
        expect(op.crossProvider).toBe(false);
        expect(op.apiKeyConfigured).toBe(true);
      }
    });
  });
});
