import { describe, it, expect, vi } from "vitest";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import type { HeartbeatHandlerDeps } from "./heartbeat-handlers.js";
import type { PersistToConfigDeps } from "./persist-to-config.js";

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
  });
});
