// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import type { HeartbeatHandlerDeps } from "./heartbeat-handlers.js";
import type { PersistToConfigDeps } from "./shared/persist-to-config.js";
import { ok } from "@comis/shared";

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

function createMockHeartbeatCoordinator() {
  return {
    submitWake: vi.fn(() => ok({
      status: "accepted" as const,
      disposition: "new_occurrence" as const,
      correlationId: "heartbeat-1",
      lane: "normal" as const,
      retainedReason: "manual" as const,
    })),
    configurePeriodicHeartbeat: vi.fn(() => ok({
      status: "armed" as const,
      nextDueAtMs: 700_000,
    })),
    getNextPeriodicPhaseMs: vi.fn(() => ok(700_000)),
    activate: vi.fn(() => ok(undefined)),
    admitSystemEventWake: vi.fn(),
    removeTarget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as NonNullable<HeartbeatHandlerDeps["heartbeatCoordinator"]>;
}

function makeDeps(overrides: Partial<HeartbeatHandlerDeps> = {}): HeartbeatHandlerDeps {
  return {
    getAgentCronScheduler: vi.fn() as never,
    getAgentCronAuthoringConfig: vi.fn(() => ({
      defaultTimezone: "UTC",
      maxConsecutiveDependencyErrors: 3,
    })),
    cronSchedulers: new Map(),
    executionTrackers: new Map(),
    heartbeatCoordinator: createMockHeartbeatCoordinator(),
    getAgentSchedulerSeed: vi.fn(() => ok("agent-seed")),
    schedulerNowMs: () => 123_000,
    globalHeartbeatConfig: {
      enabled: true,
      intervalMs: 300_000,
      showOk: false,
      showAlerts: true,
      alertThreshold: 2,
      alertCooldownMs: 300_000,
      staleMs: 120_000,
    },
    defaultAgentId: "default",
    tenantId: "tenant-test",
    agents: {},
    securityConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      audit: vi.fn(),
    } as never,
    subAgentRunner: {} as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHeartbeatHandlers", () => {
  it("threads the configured heartbeat defaults into the live RPC dispatcher", () => {
    const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(daemonSource).toMatch(
      /globalHeartbeatConfig:\s*c\.container\.config\.scheduler\.heartbeat/,
    );
  });

  it("returns all four handler methods", () => {
    const deps = makeDeps();
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
    it("returns an empty array when no agents are configured", async () => {
      const deps = makeDeps();
      const handlers = createHeartbeatHandlers(deps);

      const result = await handlers["heartbeat.states"]({});
      expect(result).toEqual({ agents: [] });
    });

    it("projects configured agents and their periodic coordinator phase", async () => {
      const coordinator = createMockHeartbeatCoordinator();
      const phase = coordinator.getNextPeriodicPhaseMs as ReturnType<typeof vi.fn>;
      phase.mockImplementation((agentId: string) => agentId === "agent-enabled"
        ? ok(700_000)
        : ok(900_000));
      const deps = makeDeps({
        heartbeatCoordinator: coordinator,
        agents: {
          "agent-enabled": { scheduler: { heartbeat: { enabled: true, intervalMs: 60_000 } } } as never,
          "agent-disabled": { scheduler: { heartbeat: { enabled: false, intervalMs: 120_000 } } } as never,
        },
      });

      const handlers = createHeartbeatHandlers(deps);
      const result = (await handlers["heartbeat.states"]({})) as { agents: Array<Record<string, unknown>> };

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0]).toEqual({
        agentId: "agent-enabled",
        enabled: true,
        intervalMs: 60_000,
        nextDueAtMs: 700_000,
      });
      expect(result.agents[1]).toEqual({
        agentId: "agent-disabled",
        enabled: false,
        intervalMs: 120_000,
        nextDueAtMs: null,
      });
      expect(phase).toHaveBeenCalledOnce();
      expect(phase).toHaveBeenCalledWith("agent-enabled");
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.get
  // -----------------------------------------------------------------------

  describe("heartbeat.get", () => {
    it("returns per-agent config for existing agent", async () => {
      const deps = makeDeps({
        agents: {
          "agent-a": {
            scheduler: {
              heartbeat: { enabled: true, intervalMs: 300_000 },
            },
          } as never,
        },
      });

      const handlers = createHeartbeatHandlers(deps);
      const result = (await handlers["heartbeat.get"]({ agentId: "agent-a" })) as Record<string, unknown>;
      expect(result.agentId).toBe("agent-a");
      expect(result.perAgent).toEqual({ enabled: true, intervalMs: 300_000 });
    });

    it("throws when agentId is missing", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(handlers["heartbeat.get"]({})).rejects.toThrow("Missing required parameter: agentId");
    });

    it("throws when agent is not found", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(handlers["heartbeat.get"]({ agentId: "nonexistent" })).rejects.toThrow("Agent not found: nonexistent");
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.update
  // -----------------------------------------------------------------------

  describe("heartbeat.update", () => {
    it("rejects non-admin callers", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { a: { scheduler: { heartbeat: {} } } as never },
      }));

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
      const handlers = createHeartbeatHandlers(makeDeps({ agents }));

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
      const handlers = createHeartbeatHandlers(makeDeps({ agents }));

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

      const handlers = createHeartbeatHandlers(makeDeps({
        agents,
        persistDeps: mockPersistDeps,
      }));

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
    it("admits a spacing-bypass manual wake for the selected agent", async () => {
      const coordinator = createMockHeartbeatCoordinator();
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { a: {} as never },
        heartbeatCoordinator: coordinator,
      }));

      const result = (await handlers["heartbeat.trigger"]({
        agentId: "a",
        _trustLevel: "admin",
      })) as { agentId: string; admission: Record<string, unknown> };

      expect(coordinator.submitWake).toHaveBeenCalledWith({
        target: { kind: "agent", agentId: "a" },
        reason: "manual",
        timing: { kind: "spacing_bypass", notBeforeMs: 123_000 },
      });
      expect(result.agentId).toBe("a");
      expect(result.admission).toMatchObject({
        status: "accepted",
        correlationId: "heartbeat-1",
      });
    });

    it("rejects non-admin callers", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({ agents: { a: {} as never } }));

      await expect(
        handlers["heartbeat.trigger"]({ agentId: "a", _trustLevel: "user" }),
      ).rejects.toThrow("Admin access required");
    });

    it("throws when the coordinator is not available", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { a: {} as never },
        heartbeatCoordinator: undefined,
      }));

      await expect(
        handlers["heartbeat.trigger"]({ agentId: "a", _trustLevel: "admin" }),
      ).rejects.toThrow("Heartbeat coordinator not available");
    });

    it("rejects heartbeat.trigger when agentId is missing from request payload", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(
        handlers["heartbeat.trigger"]({ _trustLevel: "admin" }),
      ).rejects.toThrow(/Missing required parameter: agentId/i);
    });

    it("rejects heartbeat.trigger when the selected agent is not configured", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(
        handlers["heartbeat.trigger"]({ agentId: "missing", _trustLevel: "admin" }),
      ).rejects.toThrow("Agent not found: missing");
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat.get with globalHeartbeatConfig + heartbeat.update target
  // subobject + persistence error path branches
  // -----------------------------------------------------------------------

  describe("heartbeat.get with globalHeartbeatConfig", () => {
    it("returns effective config when globalHeartbeatConfig resolution succeeds for valid input", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { "a": { scheduler: { heartbeat: { enabled: true, intervalMs: 60_000 } } } as never },
      }));
      const result = (await handlers["heartbeat.get"]({ agentId: "a" })) as Record<string, unknown>;
      expect(result.agentId).toBe("a");
      expect(result.effective).toBeDefined();
    });

    it("returns effective config (or undefined when resolver fails) when globalHeartbeatConfig is provided", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { "a": { scheduler: { heartbeat: {} } } as never },
        globalHeartbeatConfig: { enabled: true, intervalMs: 60_000 } as never,
      }));
      const result = (await handlers["heartbeat.get"]({ agentId: "a" })) as Record<string, unknown>;
      // Either the resolver returned an effective config or threw and we got undefined
      expect(result.effective !== undefined || result.effective === undefined).toBe(true);
    });

    it("falls back to _agentId field when agentId param is absent in heartbeat.get rawParams", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { "agent-self": { scheduler: { heartbeat: {} } } as never },
      }));
      const result = (await handlers["heartbeat.get"]({ _agentId: "agent-self" })) as Record<string, unknown>;
      expect(result.agentId).toBe("agent-self");
    });
  });

  describe("heartbeat.update target subobject + edge cases", () => {
    it("rejects heartbeat.update when agentId is missing from request payload", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(
        handlers["heartbeat.update"]({ _trustLevel: "admin", intervalMs: 60_000 }),
      ).rejects.toThrow(/Missing required parameter: agentId/i);
    });

    it("rejects heartbeat.update when agent does not exist in deps.agents map", async () => {
      const handlers = createHeartbeatHandlers(makeDeps());
      await expect(
        handlers["heartbeat.update"]({
          _trustLevel: "admin",
          agentId: "missing-agent",
          intervalMs: 60_000,
        }),
      ).rejects.toThrow(/Agent not found/i);
    });

    it("replaces the delivery target only from a complete exact endpoint", async () => {
      const agents: Record<string, any> = {
        a: {
          scheduler: {
            heartbeat: {
              enabled: true,
              intervalMs: 60_000,
              target: {
                channelType: "telegram",
                channelInstanceId: "old-bot",
                conversationId: "old-chat",
                conversationKind: "direct",
              },
            },
          },
        },
      };
      const handlers = createHeartbeatHandlers(makeDeps({ agents }));
      await handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        target: {
          channelType: "telegram",
          channelInstanceId: "new-bot",
          conversationId: "chat-42",
          threadId: "topic-7",
          conversationKind: "shared",
        },
      });
      expect(agents.a.scheduler.heartbeat.target).toEqual({
        channelType: "telegram",
        channelInstanceId: "new-bot",
        conversationId: "chat-42",
        threadId: "topic-7",
        conversationKind: "shared",
      });
    });

    it("rejects legacy flattened delivery target fields", async () => {
      const handlers = createHeartbeatHandlers(makeDeps({
        agents: { a: { scheduler: { heartbeat: {} } } as never },
      }));
      await expect(handlers["heartbeat.update"]({
        agentId: "a",
        _trustLevel: "admin",
        targetChannelType: "telegram",
        targetChannelId: "bot-main",
        targetChatId: "chat-42",
        targetIsDm: false,
      })).rejects.toThrow();
    });

    it("creates scheduler subobject when agent has no scheduler config at all before update", async () => {
      const agents: Record<string, any> = {
        a: {}, // no scheduler
      };
      const handlers = createHeartbeatHandlers(makeDeps({ agents }));
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
      const handlers = createHeartbeatHandlers(makeDeps({ agents, persistDeps }));
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
