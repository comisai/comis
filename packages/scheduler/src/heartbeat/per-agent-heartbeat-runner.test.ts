// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPerAgentHeartbeatRunner } from "./per-agent-heartbeat-runner.js";
import type {
  PerAgentHeartbeatRunnerDeps,
  HeartbeatAgentState,
} from "./per-agent-heartbeat-runner.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeEventBus() {
  return { emit: vi.fn() } as unknown as PerAgentHeartbeatRunnerDeps["eventBus"];
}

function makeConfig(overrides?: Partial<EffectiveHeartbeatConfig>): EffectiveHeartbeatConfig {
  return {
    enabled: true,
    intervalMs: 100,
    showOk: false,
    showAlerts: true,
    ...overrides,
  };
}

function makeAgentState(
  agentId: string,
  intervalMs: number,
  overrides?: Partial<HeartbeatAgentState>,
): HeartbeatAgentState {
  return {
    agentId,
    config: makeConfig({ intervalMs }),
    lastRunMs: 0,
    nextDueMs: 0,
    consecutiveErrors: 0,
    backoffUntilMs: 0,
    tickStartedAtMs: 0,
    lastAlertMs: 0,
    lastErrorKind: null,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<PerAgentHeartbeatRunnerDeps>): PerAgentHeartbeatRunnerDeps {
  return {
    agents: new Map(),
    eventBus: makeEventBus(),
    logger: makeLogger(),
    onTick: vi.fn(),
    nowMs: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PerAgentHeartbeatRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Scheduling ----
  describe("scheduling", () => {
    it("fires tick for the soonest-due agent first", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      // Advance past agent-a's interval (100ms) but not agent-b's (200ms)
      await vi.advanceTimersByTimeAsync(100);

      expect(onTick).toHaveBeenCalledWith("agent-a");
      expect(onTick).not.toHaveBeenCalledWith("agent-b");

      runner.stop();
    });

    it("two agents with different intervals tick independently", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      // After 250ms: agent-a should have ticked 2x (at 100ms, 200ms), agent-b 1x (at 200ms)
      await vi.advanceTimersByTimeAsync(250);

      const aCalls = onTick.mock.calls.filter(
        (args: [string]) => args[0] === "agent-a",
      ).length;
      const bCalls = onTick.mock.calls.filter(
        (args: [string]) => args[0] === "agent-b",
      ).length;
      expect(aCalls).toBe(2);
      expect(bCalls).toBe(1);

      runner.stop();
    });

    it("multiple agents due at the same tick are all processed", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      // Both agents have 100ms intervals -- they'll be due at the same time
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      await vi.advanceTimersByTimeAsync(100);

      expect(onTick).toHaveBeenCalledWith("agent-a");
      expect(onTick).toHaveBeenCalledWith("agent-b");

      runner.stop();
    });

    it("after a tick, nextDueMs is updated to lastRunMs + intervalMs", async () => {
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick: vi.fn() }));
      runner.start();

      await vi.advanceTimersByTimeAsync(100);

      const states = runner.getAgentStates();
      const agentA = states.get("agent-a")!;
      expect(agentA.nextDueMs).toBe(agentA.lastRunMs + 100);

      runner.stop();
    });

    it("uses setTimeout (not setInterval) -- verified by reschedule after each tick", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      const initialSetTimeoutCalls = setTimeoutSpy.mock.calls.length;

      await vi.advanceTimersByTimeAsync(100);

      // After first tick, a new setTimeout should have been scheduled
      expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(initialSetTimeoutCalls);

      runner.stop();
      setTimeoutSpy.mockRestore();
    });
  });

  // ---- Per-agent isolation ----
  describe("per-agent isolation", () => {
    it("onTick receives the correct agentId for each tick", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(onTick).toHaveBeenCalledWith("agent-a");

      await vi.advanceTimersByTimeAsync(100);
      // At t=200: agent-a fires again, agent-b fires for the first time
      expect(onTick).toHaveBeenCalledWith("agent-b");

      runner.stop();
    });

    it("each agent's lastRunMs tracks independently", async () => {
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick: vi.fn() }));
      runner.start();

      await vi.advanceTimersByTimeAsync(100);

      const states = runner.getAgentStates();
      const agentA = states.get("agent-a")!;
      const agentB = states.get("agent-b")!;

      // Agent A has ticked, agent B has not
      expect(agentA.lastRunMs).toBeGreaterThan(0);
      expect(agentB.lastRunMs).toBe(0);

      runner.stop();
    });
  });

  // ---- Runtime management ----
  describe("runtime management", () => {
    it("addAgent inserts new agent into the map and reschedules timer", async () => {
      const onTick = vi.fn();
      const runner = createPerAgentHeartbeatRunner(makeDeps({ onTick }));
      runner.start();

      // Add agent at runtime
      runner.addAgent(makeAgentState("agent-x", 50));

      const states = runner.getAgentStates();
      expect(states.has("agent-x")).toBe(true);

      // Agent should fire after its interval
      await vi.advanceTimersByTimeAsync(50);
      expect(onTick).toHaveBeenCalledWith("agent-x");

      runner.stop();
    });

    it("removeAgent removes agent and reschedules timer", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      const removed = runner.removeAgent("agent-a");
      expect(removed).toBe(true);

      // Advance past agent-a's interval -- should NOT fire
      await vi.advanceTimersByTimeAsync(150);
      expect(onTick).not.toHaveBeenCalledWith("agent-a");

      // Advance to agent-b's interval -- should fire
      await vi.advanceTimersByTimeAsync(50);
      expect(onTick).toHaveBeenCalledWith("agent-b");

      runner.stop();
    });

    it("removeAgent returns false for non-existent agent", () => {
      const runner = createPerAgentHeartbeatRunner(makeDeps());
      const removed = runner.removeAgent("nonexistent");
      expect(removed).toBe(false);
    });

    it("getAgentStates returns current state snapshot", () => {
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));
      agents.set("agent-b", makeAgentState("agent-b", 200));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents }));
      const states = runner.getAgentStates();

      expect(states.size).toBe(2);
      expect(states.get("agent-a")?.agentId).toBe("agent-a");
      expect(states.get("agent-b")?.agentId).toBe("agent-b");
    });
  });

  // ---- Lifecycle ----
  describe("lifecycle", () => {
    it("start begins scheduling, stop clears the timer", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(onTick).toHaveBeenCalledOnce();

      runner.stop();

      // Advance further -- no more ticks
      await vi.advanceTimersByTimeAsync(200);
      expect(onTick).toHaveBeenCalledOnce();
    });

    it("calling start twice is a no-op (idempotent)", () => {
      const logger = makeLogger();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, logger }));
      runner.start();
      runner.start(); // should not throw or create duplicate timers

      // Logger should only log start once
      const infoCalls = logger.info.mock.calls.filter(
        (args: unknown[]) =>
          typeof args[args.length - 1] === "string" &&
          (args[args.length - 1] as string).includes("started"),
      );
      expect(infoCalls.length).toBe(1);

      runner.stop();
    });

    it("stop is safe to call when not started", () => {
      const runner = createPerAgentHeartbeatRunner(makeDeps());
      // Should not throw
      expect(() => runner.stop()).not.toThrow();
    });
  });

  // ---- Resilience ----
  describe("resilience", () => {
    it("detects stuck tick and increments consecutiveErrors after staleMs timeout", async () => {
      const onTick = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-stuck", makeAgentState("agent-stuck", 100, {
        config: makeConfig({ intervalMs: 100, staleMs: 50 }),
      }));

      const logger = makeLogger();
      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick, logger }));
      runner.start();

      // Advance past the interval (100ms) to trigger the tick
      await vi.advanceTimersByTimeAsync(100);

      // Advance past staleMs (50ms) to trigger stuck detection
      await vi.advanceTimersByTimeAsync(50);

      // Verify error was logged (either error or warn level)
      const errorCalls = logger.error.mock.calls.concat(logger.warn.mock.calls);
      const stuckLog = errorCalls.find((args: unknown[]) => {
        const msg = typeof args[args.length - 1] === "string" ? args[args.length - 1] as string : "";
        const obj = typeof args[0] === "object" && args[0] !== null ? args[0] as Record<string, unknown> : {};
        return msg.includes("stuck") || msg.includes("backoff") || (typeof obj.err === "string" && (obj.err as string).includes("stuck"));
      });
      expect(stuckLog).toBeDefined();

      // Verify state was updated
      const states = runner.getAgentStates();
      const agentState = states.get("agent-stuck")!;
      expect(agentState.consecutiveErrors).toBeGreaterThanOrEqual(1);
      expect(agentState.backoffUntilMs).toBeGreaterThan(0);

      runner.stop();
    });

    it("emits scheduler:heartbeat_alert event after reaching alertThreshold", async () => {
      const onTick = vi.fn().mockRejectedValue(new Error("Connection timeout"));
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-alert", makeAgentState("agent-alert", 100, {
        config: makeConfig({ intervalMs: 100, alertThreshold: 2 }),
      }));

      const eventBus = makeEventBus();
      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick, eventBus }));
      runner.start();

      // First failure -- should NOT emit alert (threshold is 2)
      await vi.advanceTimersByTimeAsync(100);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        "scheduler:heartbeat_alert",
        expect.anything(),
      );

      // Advance past backoff (first failure backoff is 30s) + interval
      await vi.advanceTimersByTimeAsync(30_000 + 100);

      // Second failure -- should trigger alert (reaches threshold of 2)
      expect(eventBus.emit).toHaveBeenCalledWith(
        "scheduler:heartbeat_alert",
        expect.objectContaining({
          agentId: "agent-alert",
          consecutiveErrors: 2,
          classification: expect.any(String),
          reason: expect.any(String),
        }),
      );

      runner.stop();
    });

    it("skips agent in backoff period (backoffUntilMs prevents execution)", async () => {
      const onTick = vi.fn();
      const now = Date.now();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-backoff", makeAgentState("agent-backoff", 100, {
        nextDueMs: now + 100, // due in 100ms
        backoffUntilMs: now + 60_000, // backoff for 60s (well beyond nextDueMs)
      }));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));
      runner.start();

      // Advance past nextDueMs but NOT past backoffUntilMs
      await vi.advanceTimersByTimeAsync(200);

      // onTick should NOT have been called because backoff prevents it
      expect(onTick).not.toHaveBeenCalled();

      runner.stop();
    });
  });

  // ---- Manual trigger ----
  describe("manual trigger", () => {
    it("runAgentOnce calls onTick for the specified agent", async () => {
      const onTick = vi.fn();
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick }));

      await runner.runAgentOnce("agent-a");
      expect(onTick).toHaveBeenCalledWith("agent-a");
    });

    it("runAgentOnce updates lastRunMs and nextDueMs", async () => {
      const agents = new Map<string, HeartbeatAgentState>();
      agents.set("agent-a", makeAgentState("agent-a", 100));

      const runner = createPerAgentHeartbeatRunner(makeDeps({ agents, onTick: vi.fn() }));

      await runner.runAgentOnce("agent-a");

      const states = runner.getAgentStates();
      const agentA = states.get("agent-a")!;
      expect(agentA.lastRunMs).toBeGreaterThan(0);
      expect(agentA.nextDueMs).toBe(agentA.lastRunMs + 100);
    });

    it("runAgentOnce with unknown agentId is a no-op (logs warning, does not throw)", async () => {
      const logger = makeLogger();
      const runner = createPerAgentHeartbeatRunner(makeDeps({ logger }));

      await expect(runner.runAgentOnce("unknown")).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
