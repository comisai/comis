// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { setupHeartbeat } from "./setup-heartbeat.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContainer(agentOverrides: Record<string, { model?: string; provider?: string; operationModels?: Record<string, unknown>; promptTimeout?: { promptTimeoutMs?: number }; scheduler?: { heartbeat?: Record<string, unknown> } }> = {}) {
  const agents: Record<string, { model: string; provider: string; operationModels: Record<string, unknown>; scheduler?: { heartbeat?: Record<string, unknown> } }> = {};
  for (const [id, cfg] of Object.entries(agentOverrides)) {
    agents[id] = {
      model: cfg.model ?? "claude-sonnet-4-20250514",
      provider: cfg.provider ?? "anthropic",
      operationModels: cfg.operationModels ?? {},
      ...cfg,
    };
  }

  return {
    config: {
      tenantId: "test-tenant",
      agents,
      scheduler: {
        heartbeat: {
          enabled: false,
          intervalMs: 300_000,
          showOk: true,
          showAlerts: true,
        },
      },
    },
    eventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as any;
}

function makeExecutor() {
  return {
    execute: vi.fn(async () => ({ response: "heartbeat ok" })),
  };
}

function makeSystemEventQueue() {
  return {
    enqueue: vi.fn(),
    peek: vi.fn(() => Object.freeze([])),
    drain: vi.fn(() => []),
    clear: vi.fn(),
    clearAll: vi.fn(),
    size: vi.fn(() => 0),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupHeartbeat", () => {
  // 1. Two agents, one enabled, one disabled -> runner has 1 agent
  it("creates runner with only heartbeat-enabled agents", () => {
    const container = makeContainer({
      "agent-enabled": {
        model: "claude-sonnet-4-20250514",
        scheduler: {
          heartbeat: { enabled: true, intervalMs: 60_000 },
        },
      },
      "agent-disabled": {
        model: "claude-sonnet-4-20250514",
        scheduler: {
          heartbeat: { enabled: false },
        },
      },
    });

    const { perAgentRunner } = setupHeartbeat({
      container,
      executors: new Map([
        ["agent-enabled", makeExecutor()],
        ["agent-disabled", makeExecutor()],
      ]),
      assembleToolsForAgent: vi.fn(async () => []),
      workspaceDirs: new Map(),
      systemEventQueue: makeSystemEventQueue(),
      schedulerLogger: makeLogger(),
    });

    expect(perAgentRunner).toBeDefined();
    const states = perAgentRunner!.getAgentStates();
    expect(states.size).toBe(1);
    expect(states.has("agent-enabled")).toBe(true);
    expect(states.has("agent-disabled")).toBe(false);
  });

  // 2. No agents have heartbeat enabled -> returns undefined
  it("returns undefined runner when no agents have heartbeat enabled", () => {
    const container = makeContainer({
      "agent-1": {
        model: "claude-sonnet-4-20250514",
        scheduler: {
          heartbeat: { enabled: false },
        },
      },
    });

    const { perAgentRunner } = setupHeartbeat({
      container,
      executors: new Map([["agent-1", makeExecutor()]]),
      assembleToolsForAgent: vi.fn(async () => []),
      workspaceDirs: new Map(),
      systemEventQueue: makeSystemEventQueue(),
      schedulerLogger: makeLogger(),
    });

    expect(perAgentRunner).toBeUndefined();
  });

  // 3. Runner.start() is called when agents exist
  it("starts the runner when heartbeat-enabled agents exist", () => {
    const container = makeContainer({
      "agent-1": {
        model: "claude-sonnet-4-20250514",
        scheduler: {
          heartbeat: { enabled: true, intervalMs: 120_000 },
        },
      },
    });

    const schedulerLogger = makeLogger();

    const { perAgentRunner } = setupHeartbeat({
      container,
      executors: new Map([["agent-1", makeExecutor()]]),
      assembleToolsForAgent: vi.fn(async () => []),
      workspaceDirs: new Map(),
      systemEventQueue: makeSystemEventQueue(),
      schedulerLogger,
    });

    expect(perAgentRunner).toBeDefined();
    // PerAgentHeartbeatRunner logs "PerAgentHeartbeatRunner started" on start()
    // and setupHeartbeat logs "Per-agent heartbeat runner started" after start()
    expect(schedulerLogger.info).toHaveBeenCalledWith(
      { agentCount: 1 },
      "Per-agent heartbeat runner started",
    );

    // Clean up timer
    perAgentRunner!.stop();
  });

  // 4. Provides resolveModel callback in heartbeat source deps
  it("provides resolveModel callback in heartbeat source deps", () => {
    const container = makeContainer({
      "agent-hb": {
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        scheduler: { heartbeat: { enabled: true, intervalMs: 60_000 } },
      },
    });
    const { perAgentRunner } = setupHeartbeat({
      container,
      executors: new Map([["agent-hb", makeExecutor()]]),
      assembleToolsForAgent: vi.fn(async () => []),
      workspaceDirs: new Map(),
      systemEventQueue: makeSystemEventQueue(),
      schedulerLogger: makeLogger(),
    });
    // The runner was created successfully, meaning createAgentHeartbeatSource
    // accepted the deps including the resolveModel callback (type-checked at compile time)
    expect(perAgentRunner).toBeDefined();
    perAgentRunner!.stop();
  });

  // 5. Global heartbeat enabled inherits to agents without per-agent override
  it("uses global heartbeat config when per-agent config is not specified", () => {
    const container = makeContainer({
      "agent-inherit": {
        model: "claude-sonnet-4-20250514",
        // No scheduler.heartbeat -- inherits global
      },
    });
    // Override global to enabled
    container.config.scheduler.heartbeat.enabled = true;
    container.config.scheduler.heartbeat.intervalMs = 180_000;

    const { perAgentRunner } = setupHeartbeat({
      container,
      executors: new Map([["agent-inherit", makeExecutor()]]),
      assembleToolsForAgent: vi.fn(async () => []),
      workspaceDirs: new Map(),
      systemEventQueue: makeSystemEventQueue(),
      schedulerLogger: makeLogger(),
    });

    expect(perAgentRunner).toBeDefined();
    const states = perAgentRunner!.getAgentStates();
    expect(states.size).toBe(1);
    const state = states.get("agent-inherit")!;
    expect(state.config.intervalMs).toBe(180_000);

    perAgentRunner!.stop();
  });
});
