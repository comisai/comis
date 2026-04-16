import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProviderHealthMonitor } from "./provider-health-monitor.js";
import type { TypedEventBus } from "@comis/core";

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as unknown as TypedEventBus;
}

function makeMonitor(overrides?: Record<string, unknown>) {
  const eventBus = makeEventBus();
  const monitor = createProviderHealthMonitor({
    degradedThreshold: 2,
    consecutiveFailureThreshold: 3,
    windowMs: 60_000,
    recoveryThreshold: 1,
    eventBus,
    ...overrides,
  });
  return { monitor, eventBus };
}

describe("createProviderHealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("isDegraded returns false for unknown provider", () => {
      const { monitor } = makeMonitor();
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("getHealthSummary returns empty Map", () => {
      const { monitor } = makeMonitor();
      const summary = monitor.getHealthSummary();
      expect(summary.size).toBe(0);
    });
  });

  describe("single agent consecutive failures", () => {
    it("not degraded after 2 failures (below threshold of 3)", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("degraded after 3 consecutive failures from single agent", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(true);
    });

    it("provider:degraded event emitted with correct payload", () => {
      const { monitor, eventBus } = makeMonitor();
      vi.setSystemTime(1000);

      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");

      expect(eventBus.emit).toHaveBeenCalledWith(
        "provider:degraded",
        expect.objectContaining({
          provider: "anthropic",
          failingAgents: 1,
          timestamp: 1000,
        }),
      );
    });

    it("event emitted exactly once (not on 4th failure)", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");

      const degradedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "provider:degraded",
      );
      expect(degradedCalls).toHaveLength(1);
    });
  });

  describe("multi-agent failure aggregation", () => {
    it("not degraded after 1 agent fails (below threshold of 2)", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("degraded after 2 different agents each fail once within window", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);
    });

    it("provider:degraded event includes failingAgents: 2", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");

      expect(eventBus.emit).toHaveBeenCalledWith(
        "provider:degraded",
        expect.objectContaining({
          provider: "anthropic",
          failingAgents: 2,
        }),
      );
    });
  });

  describe("recovery", () => {
    it("recordSuccess recovers from degraded state", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      monitor.recordSuccess("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("provider:recovered event emitted with correct payload", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");

      vi.setSystemTime(5000);
      monitor.recordSuccess("anthropic", "agent-1");

      expect(eventBus.emit).toHaveBeenCalledWith(
        "provider:recovered",
        expect.objectContaining({
          provider: "anthropic",
          timestamp: 5000,
        }),
      );
    });

    it("isDegraded returns false after recovery", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      monitor.recordSuccess("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("recordSuccess on non-degraded provider does not emit event", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordSuccess("anthropic", "agent-1");

      const recoveredCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "provider:recovered",
      );
      expect(recoveredCalls).toHaveLength(0);
    });

    it("after recovery and window expiry, needs fresh failures to degrade again", () => {
      const { monitor } = makeMonitor();
      // Degrade
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      // Recover
      monitor.recordSuccess("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);

      // Advance past window so old timestamps expire
      vi.advanceTimersByTime(61_000);

      // Single failure from new agent should not re-degrade (old timestamps expired)
      monitor.recordFailure("anthropic", "agent-3");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });
  });

  describe("consecutive count reset", () => {
    it("recordSuccess resets consecutive count for specific agent to 0", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      // 2 consecutive -- not yet at threshold of 3
      monitor.recordSuccess("anthropic", "agent-1");
      // Reset to 0 -- now need 3 more consecutive failures
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("after reset, needs 3 more consecutive failures to degrade again", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordSuccess("anthropic", "agent-1");

      // 3 new consecutive failures should degrade
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(true);
    });

    it("success from agent A does not reset agent B consecutive count", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-b");
      monitor.recordFailure("anthropic", "agent-b");
      // agent-b has 2 consecutive

      monitor.recordSuccess("anthropic", "agent-a");
      // agent-a success should not affect agent-b

      monitor.recordFailure("anthropic", "agent-b");
      // agent-b now has 3 consecutive -- should degrade
      expect(monitor.isDegraded("anthropic")).toBe(true);
    });
  });

  describe("time window expiry", () => {
    it("failures outside window do not count toward multi-agent threshold", () => {
      const { monitor } = makeMonitor();
      vi.setSystemTime(1000);
      monitor.recordFailure("anthropic", "agent-1");

      // Advance past 60s window
      vi.advanceTimersByTime(61_000);
      monitor.recordFailure("anthropic", "agent-2");

      // agent-1's failure is outside the window, only agent-2 counts
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("isDegraded auto-recovers when all timestamps expire", () => {
      const { monitor } = makeMonitor();
      // Degrade via multi-agent failures
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      // Advance past window
      vi.advanceTimersByTime(61_000);

      // isDegraded check should trigger auto-recovery
      expect(monitor.isDegraded("anthropic")).toBe(false);
    });

    it("auto-recovery emits provider:recovered event", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      vi.advanceTimersByTime(61_000);

      // isDegraded triggers auto-recovery
      monitor.isDegraded("anthropic");

      const recoveredCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "provider:recovered",
      );
      expect(recoveredCalls).toHaveLength(1);
      expect(recoveredCalls[0]![1]).toEqual(
        expect.objectContaining({ provider: "anthropic" }),
      );
    });
  });

  describe("multiple providers", () => {
    it("provider A degraded does not affect provider B", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);
      expect(monitor.isDegraded("openai")).toBe(false);
    });

    it("getHealthSummary returns correct state for each provider independently", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      monitor.recordFailure("openai", "agent-1");

      const summary = monitor.getHealthSummary();
      expect(summary.size).toBe(2);

      const anthropic = summary.get("anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.degraded).toBe(true);
      expect(anthropic!.failingAgents).toBe(2);

      const openai = summary.get("openai");
      expect(openai).toBeDefined();
      expect(openai!.degraded).toBe(false);
      expect(openai!.failingAgents).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("recordFailure + recordSuccess + recordFailure cycle (re-degradation path)", () => {
      const { monitor, eventBus } = makeMonitor();

      // First degradation
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-2");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      // Recovery
      monitor.recordSuccess("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);

      // Re-degradation via consecutive failures
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      monitor.recordFailure("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(true);

      // Should have emitted degraded twice and recovered once
      const degradedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "provider:degraded",
      );
      const recoveredCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "provider:recovered",
      );
      expect(degradedCalls).toHaveLength(2);
      expect(recoveredCalls).toHaveLength(1);
    });

    it("large number of agents (10+) -- no performance issues", () => {
      const { monitor } = makeMonitor({ degradedThreshold: 10 });

      for (let i = 0; i < 10; i++) {
        monitor.recordFailure("anthropic", `agent-${i}`);
      }

      expect(monitor.isDegraded("anthropic")).toBe(true);
      const summary = monitor.getHealthSummary();
      expect(summary.get("anthropic")!.failingAgents).toBe(10);
    });

    it("empty provider string handled gracefully", () => {
      const { monitor } = makeMonitor();
      monitor.recordFailure("", "agent-1");
      monitor.recordFailure("", "agent-2");
      expect(monitor.isDegraded("")).toBe(true);
      monitor.recordSuccess("", "agent-1");
      expect(monitor.isDegraded("")).toBe(false);
    });

    it("calling recordSuccess before any recordFailure is a no-op", () => {
      const { monitor, eventBus } = makeMonitor();
      monitor.recordSuccess("anthropic", "agent-1");
      expect(monitor.isDegraded("anthropic")).toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });
});
