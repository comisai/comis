// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCostTracker } from "./cost-tracker.js";

describe("CostTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const sampleUsage = {
    input: 100,
    output: 50,
    totalTokens: 150,
    cost: { input: 0.001, output: 0.002, total: 0.003 },
    operationType: "interactive" as const,
  };

  describe("record", () => {
    it("stores a cost record with timestamp", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      const all = tracker.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-1");
      expect(all[0].channelId).toBe("channel-1");
      expect(all[0].executionId).toBe("exec-1");
      expect(all[0].tokens.input).toBe(100);
      expect(all[0].tokens.output).toBe(50);
      expect(all[0].tokens.total).toBe(150);
      expect(all[0].cost.input).toBe(0.001);
      expect(all[0].cost.output).toBe(0.002);
      expect(all[0].cost.total).toBe(0.003);
      expect(all[0].timestamp).toBeTypeOf("number");
    });

    it("stores multiple records", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      tracker.record("agent-2", "channel-2", "exec-2", sampleUsage);
      expect(tracker.getAll()).toHaveLength(2);
    });
  });

  describe("getByAgent", () => {
    it("returns total tokens and cost for a specific agent", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      tracker.record("agent-1", "channel-2", "exec-2", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        operationType: "interactive",
      });
      tracker.record("agent-2", "channel-1", "exec-3", sampleUsage);

      const result = tracker.getByAgent("agent-1");
      expect(result.totalTokens).toBe(450); // 150 + 300
      expect(result.totalCost).toBeCloseTo(0.009); // 0.003 + 0.006
    });

    it("returns zeros for unknown agent", () => {
      const tracker = createCostTracker();
      const result = tracker.getByAgent("unknown");
      expect(result.totalTokens).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });

  describe("getByChannel", () => {
    it("returns total tokens and cost for a specific channel", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      tracker.record("agent-2", "channel-1", "exec-2", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        operationType: "interactive",
      });
      tracker.record("agent-1", "channel-2", "exec-3", sampleUsage);

      const result = tracker.getByChannel("channel-1");
      expect(result.totalTokens).toBe(450);
      expect(result.totalCost).toBeCloseTo(0.009);
    });

    it("returns zeros for unknown channel", () => {
      const tracker = createCostTracker();
      const result = tracker.getByChannel("unknown");
      expect(result.totalTokens).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });

  describe("getByExecution", () => {
    it("returns total tokens and cost for a specific execution", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      tracker.record("agent-1", "channel-1", "exec-1", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        operationType: "interactive",
      });

      const result = tracker.getByExecution("exec-1");
      expect(result.totalTokens).toBe(450);
      expect(result.totalCost).toBeCloseTo(0.009);
    });

    it("returns zeros for unknown execution", () => {
      const tracker = createCostTracker();
      const result = tracker.getByExecution("unknown");
      expect(result.totalTokens).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });

  describe("sessionKey field", () => {
    it("stores sessionKey when provided in usage", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        sessionKey: "default:user-1:telegram-123",
      });
      const all = tracker.getAll();
      expect(all[0].sessionKey).toBe("default:user-1:telegram-123");
    });

    it("defaults sessionKey to empty string when not provided", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      const all = tracker.getAll();
      expect(all[0].sessionKey).toBe("");
    });
  });

  describe("operationType field", () => {
    it("stores operationType from usage input", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        operationType: "interactive",
      });
      const all = tracker.getAll();
      expect(all[0].operationType).toBe("interactive");
    });

    it("stores non-default operationType when provided", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        operationType: "heartbeat",
      });
      const all = tracker.getAll();
      expect(all[0].operationType).toBe("heartbeat");
    });
  });

  describe("getBySession", () => {
    it("returns correct totals for matching session", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        sessionKey: "default:user-1:telegram-123",
      });
      tracker.record("agent-1", "channel-1", "exec-2", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        sessionKey: "default:user-1:telegram-123",
        operationType: "interactive",
      });
      tracker.record("agent-1", "channel-1", "exec-3", {
        ...sampleUsage,
        sessionKey: "default:user-2:telegram-456",
      });

      const result = tracker.getBySession("default:user-1:telegram-123");
      expect(result.totalTokens).toBe(450); // 150 + 300
      expect(result.totalCost).toBeCloseTo(0.009); // 0.003 + 0.006
    });

    it("returns zeros for unknown session", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        sessionKey: "default:user-1:telegram-123",
      });
      const result = tracker.getBySession("unknown:session:key");
      expect(result.totalTokens).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });

  describe("getByProvider", () => {
    it("returns breakdown grouped by provider/model", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
      });
      tracker.record("agent-1", "channel-1", "exec-2", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        operationType: "interactive",
      });
      tracker.record("agent-1", "channel-1", "exec-3", {
        ...sampleUsage,
        provider: "openai",
        model: "gpt-4o",
      });

      const result = tracker.getByProvider();
      expect(result).toHaveLength(2);

      // Sorted by totalCost descending
      expect(result[0].provider).toBe("anthropic");
      expect(result[0].model).toBe("claude-sonnet-4-5-20250929");
      expect(result[0].totalTokens).toBe(450);
      expect(result[0].totalCost).toBeCloseTo(0.009);
      expect(result[0].callCount).toBe(2);

      expect(result[1].provider).toBe("openai");
      expect(result[1].model).toBe("gpt-4o");
      expect(result[1].totalTokens).toBe(150);
      expect(result[1].totalCost).toBeCloseTo(0.003);
      expect(result[1].callCount).toBe(1);
    });

    it("includes callCount per provider/model group", () => {
      const tracker = createCostTracker();
      for (let i = 0; i < 5; i++) {
        tracker.record("agent-1", "channel-1", `exec-${i}`, {
          ...sampleUsage,
          provider: "anthropic",
          model: "claude-haiku",
        });
      }

      const result = tracker.getByProvider();
      expect(result).toHaveLength(1);
      expect(result[0].callCount).toBe(5);
      expect(result[0].totalTokens).toBe(750); // 150 * 5
    });

    it("returns empty array when no records", () => {
      const tracker = createCostTracker();
      const result = tracker.getByProvider();
      expect(result).toEqual([]);
    });
  });

  describe("getByOperation", () => {
    it("returns breakdown grouped by operationType", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        operationType: "heartbeat",
      });
      tracker.record("agent-1", "channel-1", "exec-2", {
        input: 200,
        output: 100,
        totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
        operationType: "heartbeat",
      });
      tracker.record("agent-1", "channel-1", "exec-3", {
        ...sampleUsage,
        operationType: "cron",
      });

      const result = tracker.getByOperation();
      expect(result).toHaveLength(2);

      // Sorted by totalCost descending
      expect(result[0].operationType).toBe("heartbeat");
      expect(result[0].totalTokens).toBe(450);
      expect(result[0].totalCost).toBeCloseTo(0.009);
      expect(result[0].callCount).toBe(2);

      expect(result[1].operationType).toBe("cron");
      expect(result[1].totalTokens).toBe(150);
      expect(result[1].totalCost).toBeCloseTo(0.003);
      expect(result[1].callCount).toBe(1);
    });

    it("groups records with same operationType together", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        operationType: "interactive",
      });
      tracker.record("agent-1", "channel-1", "exec-2", {
        ...sampleUsage,
        operationType: "interactive",
      });

      const result = tracker.getByOperation();
      expect(result).toHaveLength(1);
      expect(result[0].operationType).toBe("interactive");
      expect(result[0].callCount).toBe(2);
    });

    it("returns empty array when no records", () => {
      const tracker = createCostTracker();
      const result = tracker.getByOperation();
      expect(result).toEqual([]);
    });
  });

  describe("getAll", () => {
    it("returns empty array when no records exist", () => {
      const tracker = createCostTracker();
      expect(tracker.getAll()).toEqual([]);
    });

    it("returns a copy, not the internal array", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      const all1 = tracker.getAll();
      const all2 = tracker.getAll();
      expect(all1).not.toBe(all2);
      expect(all1).toEqual(all2);
    });
  });

  describe("prune", () => {
    it("removes records older than maxAgeMs", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);

      vi.advanceTimersByTime(60_000); // 60 seconds

      tracker.record("agent-1", "channel-1", "exec-2", sampleUsage);

      const removed = tracker.prune(30_000); // prune entries older than 30s
      expect(removed).toBe(1);
      expect(tracker.getAll()).toHaveLength(1);
      expect(tracker.getAll()[0].executionId).toBe("exec-2");
    });

    it("returns 0 when no records are prunable", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", sampleUsage);
      const removed = tracker.prune(60_000);
      expect(removed).toBe(0);
    });

    it("returns 0 when tracker is empty", () => {
      const tracker = createCostTracker();
      const removed = tracker.prune(60_000);
      expect(removed).toBe(0);
    });

    it("works correctly with records that have sessionKey", () => {
      const tracker = createCostTracker();
      tracker.record("agent-1", "channel-1", "exec-1", {
        ...sampleUsage,
        sessionKey: "default:user-1:ch-1",
      });

      vi.advanceTimersByTime(60_000);

      tracker.record("agent-1", "channel-1", "exec-2", {
        ...sampleUsage,
        sessionKey: "default:user-2:ch-2",
      });

      const removed = tracker.prune(30_000);
      expect(removed).toBe(1);

      const remaining = tracker.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionKey).toBe("default:user-2:ch-2");
    });
  });
});
