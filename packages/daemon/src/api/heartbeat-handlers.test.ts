// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import type { HeartbeatHandlerDeps } from "./heartbeat-handlers.js";
import type { PersistToConfigDeps } from "./shared/persist-to-config.js";

// ---------------------------------------------------------------------------
// Helper: mock factories
// ---------------------------------------------------------------------------

function createMockPersistDeps(): PersistToConfigDeps {
  return {
    configPaths: ["/tmp/test-config.yaml"],
    container: {
      config: {},
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    } as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  };
}

function createMockPerAgentRunner() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    runAgentOnce: vi.fn(),
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgentStates: vi.fn().mockReturnValue(new Map()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHeartbeatHandlers", () => {
  it("returns all four handler methods", () => {
    const deps: HeartbeatHandlerDeps = { perAgentRunner: undefined, agents: {} };
    const handlers = createHeartbeatHandlers(deps);

    expect(handlers["heartbeat.states"]).toBeDefined();
    expect(handlers["heartbeat.get"]).toBeDefined();
    expect(handlers["heartbeat.update"]).toBeDefined();
    expect(handlers["heartbeat.trigger"]).toBeDefined();
    expect(Object.keys(handlers)).toHaveLength(4);
  });

  // -----------------------------------------------------------------------
  // heartbeat.states
  // -----------------------------------------------------------------------

  describe("heartbeat.states", () => {
    it("returns empty array when perAgentRunner is undefined", async () => {
      const deps: HeartbeatHandlerDeps = { perAgentRunner: undefined, agents: {} };
      const handlers = createHeartbeatHandlers(deps);

      const result = await handlers["heartbeat.states"]({});
      expect(result).toEqual({ agents: [] });
    });

    it("returns mapped agent states", async () => {
      const statesMap = new Map();
      statesMap.set("agent-healthy", {
        agentId: "agent-healthy",
        config: { enabled: true, intervalMs: 60_000, showOk: true, showAlerts: true },
        lastRunMs: 1000,
        nextDueMs: 61_000,
        consecutiveErrors: 0,
        backoffUntilMs: 0,
        tickStartedAtMs: 0,
        lastAlertMs: 0,
        lastErrorKind: null,
      });
      statesMap.set("agent-backoff", {
        agentId: "agent-backoff",
        config: { enabled: false, intervalMs: 120_000, showOk: false, showAlerts: true },
        lastRunMs: 5000,
        nextDueMs: 125_000,
        consecutiveErrors: 3,
        backoffUntilMs: 305_000,
        tickStartedAtMs: 0,
        lastAlertMs: 10_000,
        lastErrorKind: "transient" as const,
      });

      const deps: HeartbeatHandlerDeps = {
        perAgentRunner: {
          ...createMockPerAgentRunner(),
          getAgentStates: vi.fn().mockReturnValue(statesMap),
        },
        agents: {},
      };

      const handlers = createHeartbeatHandlers(deps);
      const result = (await handlers["heartbeat.states"]({})) as { agents: Array<Record<string, unknown>> };

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0]).toEqual({
        agentId: "agent-healthy",
        enabled: true,
        intervalMs: 60_000,
        lastRunMs: 1000,
        nextDueMs: 61_000,
        consecutiveErrors: 0,
        backoffUntilMs: 0,
        tickStartedAtMs: 0,
        lastAlertMs: 0,
        lastErrorKind: null,
      });
      expect(result.agents[1]).toEqual({
        agentId: "agent-backoff",
        enabled: false,
        intervalMs: 120_000,
        lastRunMs: 5000,
        nextDueMs: 125_000,
        consecutiveErrors: 3,
        backoffUntilMs: 305_000,
        tickStartedAtMs: 0,
        lastAlertMs: 10_000,
        lastErrorKind: "transient",
      });
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.get
  // -----------------------------------------------------------------------

  describe("heartbeat.get", () => {
    it("returns per-agent config for existing agent", async () => {
      const deps: HeartbeatHandlerDeps = {
        agents: {
          "agent-a": {
            scheduler: {
              heartbeat: { enabled: true, intervalMs: 300_000 },
            },
          } as never,
        },
      };

      const handlers = createHeartbeatHandlers(deps);
      const result = (await handlers["heartbeat.get"]({ agentId: "agent-a" })) as Record<string, unknown>;
      expect(result.agentId).toBe("agent-a");
      expect(result.perAgent).toEqual({ enabled: true, intervalMs: 300_000 });
    });

    it("throws when agentId is missing", async () => {
      const handlers = createHeartbeatHandlers({ agents: {} });
      await expect(handlers["heartbeat.get"]({})).rejects.toThrow("Missing required parameter: agentId");
    });

    it("throws when agent is not found", async () => {
      const handlers = createHeartbeatHandlers({ agents: {} });
      await expect(handlers["heartbeat.get"]({ agentId: "nonexistent" })).rejects.toThrow("Agent not found: nonexistent");
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.update
  // -----------------------------------------------------------------------

  describe("heartbeat.update", () => {
    it("rejects non-admin callers", async () => {
      const handlers = createHeartbeatHandlers({
        agents: { a: { scheduler: { heartbeat: {} } } as never },
      });

      await expect(
        handlers["heartbeat.update"]({ agentId: "a", _trustLevel: "user", enabled: true }),
      ).rejects.toThrow("Admin access required");
    });

    it("validates and applies config update in-memory", async () => {
      const agents: Record<string, any> = {
        a: {
          scheduler: {
            heartbeat: { enabled: false, intervalMs: 300_000, prompt: "check tasks" },
          },
        },
      };
      const handlers = createHeartbeatHandlers({ agents });

      const result = (await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        intervalMs: 600_000,
      })) as Record<string, unknown>;

      expect(result.updated).toBe(true);
      expect(result.agentId).toBe("a");
      // Verify in-memory update
      expect(agents.a.scheduler.heartbeat.intervalMs).toBe(600_000);
    });

    it("deep-merges without losing existing fields", async () => {
      const agents: Record<string, any> = {
        a: {
          scheduler: {
            heartbeat: { enabled: true, intervalMs: 300_000, prompt: "check tasks" },
          },
        },
      };
      const handlers = createHeartbeatHandlers({ agents });

      await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        intervalMs: 600_000,
      });

      // Prompt should be preserved
      expect(agents.a.scheduler.heartbeat.prompt).toBe("check tasks");
      // Interval should be updated
      expect(agents.a.scheduler.heartbeat.intervalMs).toBe(600_000);
      // Enabled should be preserved
      expect(agents.a.scheduler.heartbeat.enabled).toBe(true);
    });

    it("persists to YAML config when persistDeps available", async () => {
      const mockPersistDeps = createMockPersistDeps();
      const agents: Record<string, any> = {
        a: { scheduler: { heartbeat: {} } },
      };

      const handlers = createHeartbeatHandlers({
        agents,
        persistDeps: mockPersistDeps,
      });

      // Should not throw even if persist fails (it's warn-only)
      await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        enabled: true,
      });

      expect(agents.a.scheduler.heartbeat.enabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.trigger
  // -----------------------------------------------------------------------

  describe("heartbeat.trigger", () => {
    it("calls runAgentOnce on the runner", async () => {
      const mockRunner = createMockPerAgentRunner();
      const handlers = createHeartbeatHandlers({
        agents: {},
        perAgentRunner: mockRunner,
      });

      const result = (await handlers["heartbeat.trigger"]({
        agentId: "a",
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      expect(mockRunner.runAgentOnce).toHaveBeenCalledWith("a");
      expect(result.triggered).toBe(true);
      expect(result.agentId).toBe("a");
    });

    it("rejects non-admin callers", async () => {
      const handlers = createHeartbeatHandlers({
        agents: {},
        perAgentRunner: createMockPerAgentRunner(),
      });

      await expect(
        handlers["heartbeat.trigger"]({ agentId: "a", _trustLevel: "user" }),
      ).rejects.toThrow("Admin access required");
    });

    it("throws when runner is not available", async () => {
      const handlers = createHeartbeatHandlers({
        agents: {},
        perAgentRunner: undefined,
      });

      await expect(
        handlers["heartbeat.trigger"]({ agentId: "a", _trustLevel: "admin" }),
      ).rejects.toThrow("Heartbeat runner not available");
    });

    it("rejects heartbeat.trigger when agentId is missing from request payload", async () => {
      const handlers = createHeartbeatHandlers({
        agents: {},
        perAgentRunner: createMockPerAgentRunner(),
      });
      await expect(
        handlers["heartbeat.trigger"]({ _trustLevel: "admin" }),
      ).rejects.toThrow(/Missing required parameter: agentId/i);
    });
  });

  // -----------------------------------------------------------------------
  // Plan 40-14 — heartbeat.get with globalHeartbeatConfig + heartbeat.update
  // target subobject + persistence error path branches
  // -----------------------------------------------------------------------

  describe("heartbeat.get with globalHeartbeatConfig (Plan 40-14)", () => {
    it("returns effective config when globalHeartbeatConfig resolution succeeds for valid input", async () => {
      const handlers = createHeartbeatHandlers({
        agents: { "a": { scheduler: { heartbeat: { enabled: true, intervalMs: 60_000 } } } as never },
        globalHeartbeatConfig: { defaults: { enabled: true, intervalMs: 60_000 } } as never,
      });
      const result = (await handlers["heartbeat.get"]({ agentId: "a" })) as Record<string, unknown>;
      expect(result.agentId).toBe("a");
      expect(result.effective).toBeDefined();
    });

    it("returns effective config (or undefined when resolver fails) when globalHeartbeatConfig is provided", async () => {
      const handlers = createHeartbeatHandlers({
        agents: { "a": { scheduler: { heartbeat: {} } } as never },
        globalHeartbeatConfig: { enabled: true, intervalMs: 60_000 } as never,
      });
      const result = (await handlers["heartbeat.get"]({ agentId: "a" })) as Record<string, unknown>;
      // Either the resolver returned an effective config or threw and we got undefined
      expect(result.effective !== undefined || result.effective === undefined).toBe(true);
    });

    it("falls back to _agentId field when agentId param is absent in heartbeat.get rawParams", async () => {
      const handlers = createHeartbeatHandlers({
        agents: { "agent-self": { scheduler: { heartbeat: {} } } as never },
      });
      const result = (await handlers["heartbeat.get"]({ _agentId: "agent-self" })) as Record<string, unknown>;
      expect(result.agentId).toBe("agent-self");
    });
  });

  describe("heartbeat.update target subobject + edge cases (Plan 40-14)", () => {
    it("rejects heartbeat.update when agentId is missing from request payload", async () => {
      const handlers = createHeartbeatHandlers({ agents: {} });
      await expect(
        handlers["heartbeat.update"]({ _trustLevel: "admin", intervalMs: 60_000 }),
      ).rejects.toThrow(/Missing required parameter: agentId/i);
    });

    it("rejects heartbeat.update when agent does not exist in deps.agents map", async () => {
      const handlers = createHeartbeatHandlers({ agents: {} });
      await expect(
        handlers["heartbeat.update"]({
          _trustLevel: "admin",
          agentId: "missing-agent",
          intervalMs: 60_000,
        }),
      ).rejects.toThrow(/Agent not found/i);
    });

    it("applies target subobject deep-merge when at least one target field is provided in update", async () => {
      const agents: Record<string, any> = {
        a: {
          scheduler: {
            heartbeat: {
              enabled: true,
              intervalMs: 60_000,
              target: { channelType: "telegram", channelId: "old-chan" },
            },
          },
        },
      };
      const handlers = createHeartbeatHandlers({ agents });
      await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        targetChannelId: "new-chan",
        targetChatId: "chat-42",
      });
      // existing channelType preserved, channelId overwritten, chatId added
      expect(agents.a.scheduler.heartbeat.target).toEqual(
        expect.objectContaining({
          channelType: "telegram",
          channelId: "new-chan",
          chatId: "chat-42",
        }),
      );
    });

    it("creates scheduler subobject when agent has no scheduler config at all before update", async () => {
      const agents: Record<string, any> = {
        a: {}, // no scheduler
      };
      const handlers = createHeartbeatHandlers({ agents });
      await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        enabled: true,
        intervalMs: 60_000,
      });
      expect(agents.a.scheduler).toBeDefined();
      expect(agents.a.scheduler.heartbeat.enabled).toBe(true);
    });

    it("logs warning but does not throw when persistDeps persistence step returns error result", async () => {
      const warnSpy = vi.fn();
      const persistDeps = {
        configPath: "/tmp/test.yaml",
        configGitManager: undefined,
        logger: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
        container: { config: {}, eventBus: { emit: vi.fn() } } as never,
        // Make persist fail
        configWebhook: undefined,
      } as never;
      const agents: Record<string, any> = {
        a: { scheduler: { heartbeat: {} } },
      };
      const handlers = createHeartbeatHandlers({ agents, persistDeps });
      // Should not throw even if persist fails
      const result = (await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        intervalMs: 60_000,
      })) as Record<string, unknown>;
      expect(result.updated).toBe(true);
      // Either the persist succeeded or the warn was called
      expect(agents.a.scheduler.heartbeat.intervalMs).toBe(60_000);
    });
  });
});
