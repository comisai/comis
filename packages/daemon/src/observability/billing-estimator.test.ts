// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createCostTracker } from "@comis/agent";
import { createBillingEstimator } from "./billing-estimator.js";

/**
 * Helper: record cost entries into a real CostTracker.
 * Uses real CostTracker (no mocks) to verify correct delegation.
 */
function seedTracker() {
  const costTracker = createCostTracker();

  // Record 6 entries across 2 providers, 3 models, 2 agents, 2 sessions
  // Timestamps vary: some "recent" (Date.now()), some "old" (1 hour ago)
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;

  // We need to control timestamps, so we spy on Date.now()
  // Entry 1: anthropic/claude-sonnet, agent-a, session-x (recent)
  vi.spyOn(Date, "now").mockReturnValue(now);
  costTracker.record("agent-a", "ch-1", "exec-1", {
    input: 100,
    output: 50,
    totalTokens: 150,
    cost: { input: 0.003, output: 0.015, total: 0.018 },
    provider: "anthropic",
    model: "claude-sonnet",
    sessionKey: "session-x",
  });

  // Entry 2: anthropic/claude-haiku, agent-a, session-x (recent)
  vi.spyOn(Date, "now").mockReturnValue(now - 1000);
  costTracker.record("agent-a", "ch-1", "exec-2", {
    input: 200,
    output: 100,
    totalTokens: 300,
    cost: { input: 0.001, output: 0.005, total: 0.006 },
    provider: "anthropic",
    model: "claude-haiku",
    sessionKey: "session-x",
  });

  // Entry 3: openai/gpt-4, agent-b, session-y (recent)
  vi.spyOn(Date, "now").mockReturnValue(now - 2000);
  costTracker.record("agent-b", "ch-2", "exec-3", {
    input: 500,
    output: 200,
    totalTokens: 700,
    cost: { input: 0.03, output: 0.06, total: 0.09 },
    provider: "openai",
    model: "gpt-4",
    sessionKey: "session-y",
  });

  // Entry 4: openai/gpt-4, agent-a, session-y (old -- 1 hour ago)
  vi.spyOn(Date, "now").mockReturnValue(oneHourAgo);
  costTracker.record("agent-a", "ch-1", "exec-4", {
    input: 400,
    output: 300,
    totalTokens: 700,
    cost: { input: 0.02, output: 0.06, total: 0.08 },
    provider: "openai",
    model: "gpt-4",
    sessionKey: "session-y",
  });

  // Entry 5: anthropic/claude-sonnet, agent-b, session-x (old -- 1 hour ago)
  vi.spyOn(Date, "now").mockReturnValue(oneHourAgo - 1000);
  costTracker.record("agent-b", "ch-2", "exec-5", {
    input: 300,
    output: 150,
    totalTokens: 450,
    cost: { input: 0.009, output: 0.045, total: 0.054 },
    provider: "anthropic",
    model: "claude-sonnet",
    sessionKey: "session-x",
  });

  // Entry 6: anthropic/claude-haiku, agent-b, session-y (recent)
  vi.spyOn(Date, "now").mockReturnValue(now - 500);
  costTracker.record("agent-b", "ch-2", "exec-6", {
    input: 80,
    output: 40,
    totalTokens: 120,
    cost: { input: 0.0004, output: 0.002, total: 0.0024 },
    provider: "anthropic",
    model: "claude-haiku",
    sessionKey: "session-y",
  });

  // Restore Date.now for test assertions
  vi.restoreAllMocks();

  return { costTracker, now, oneHourAgo };
}

describe("BillingEstimator", () => {
  it("byProvider returns per-provider breakdown with models", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const providers = estimator.byProvider();

    // Should have 2 providers: anthropic and openai
    expect(providers).toHaveLength(2);

    // Find each provider
    const anthropic = providers.find((p) => p.provider === "anthropic")!;
    const openai = providers.find((p) => p.provider === "openai")!;

    expect(anthropic).toBeDefined();
    expect(openai).toBeDefined();

    // Anthropic has 2 models: claude-sonnet (2 entries), claude-haiku (2 entries)
    expect(anthropic.models).toHaveLength(2);
    expect(anthropic.callCount).toBe(4);

    // OpenAI has 1 model: gpt-4 (2 entries)
    expect(openai.models).toHaveLength(1);
    expect(openai.callCount).toBe(2);

    // Check model-level detail for anthropic claude-sonnet
    const sonnet = anthropic.models.find((m) => m.model === "claude-sonnet")!;
    expect(sonnet).toBeDefined();
    expect(sonnet.calls).toBe(2);
    expect(sonnet.tokens).toBe(600); // 150 + 450
    expect(sonnet.cost).toBeCloseTo(0.072, 6); // 0.018 + 0.054
  });

  it("byProvider sorts by totalCost descending", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const providers = estimator.byProvider();

    // openai has higher total cost (0.09 + 0.08 = 0.17)
    // anthropic total cost (0.018 + 0.006 + 0.054 + 0.0024 = 0.0804)
    // So openai should be first
    expect(providers[0]!.provider).toBe("openai");
    expect(providers[1]!.provider).toBe("anthropic");
    expect(providers[0]!.totalCost).toBeGreaterThan(providers[1]!.totalCost);
  });

  it("byAgent returns accurate totals for a specific agent", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    // agent-a: entries 1, 2, 4
    // tokens: 150 + 300 + 700 = 1150
    // cost: 0.018 + 0.006 + 0.08 = 0.104
    // callCount: 3
    const snapshot = estimator.byAgent("agent-a");
    expect(snapshot.totalTokens).toBe(1150);
    expect(snapshot.totalCost).toBeCloseTo(0.104, 6);
    expect(snapshot.callCount).toBe(3);
  });

  it("byAgent returns zeros for unknown agent", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const snapshot = estimator.byAgent("nonexistent-agent");
    expect(snapshot).toEqual({ totalCost: 0, totalTokens: 0, callCount: 0 });
  });

  it("bySession returns accurate totals for a specific session", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    // session-x: entries 1, 2, 5
    // tokens: 150 + 300 + 450 = 900
    // cost: 0.018 + 0.006 + 0.054 = 0.078
    // callCount: 3
    const snapshot = estimator.bySession("session-x");
    expect(snapshot.totalTokens).toBe(900);
    expect(snapshot.totalCost).toBeCloseTo(0.078, 6);
    expect(snapshot.callCount).toBe(3);
  });

  it("bySession returns zeros for unknown session", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const snapshot = estimator.bySession("nonexistent-session");
    expect(snapshot).toEqual({ totalCost: 0, totalTokens: 0, callCount: 0 });
  });

  it("total returns aggregate across all records", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    // All 6 entries:
    // tokens: 150 + 300 + 700 + 700 + 450 + 120 = 2420
    // cost: 0.018 + 0.006 + 0.09 + 0.08 + 0.054 + 0.0024 = 0.2504
    // callCount: 6
    const snapshot = estimator.total();
    expect(snapshot.totalTokens).toBe(2420);
    expect(snapshot.totalCost).toBeCloseTo(0.2504, 6);
    expect(snapshot.callCount).toBe(6);
  });

  it("sinceMs filters out old records", () => {
    const { costTracker, now } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    // Use sinceMs = 30 minutes (1_800_000 ms)
    // This should include entries 1,2,3,6 (within last 30 min) and exclude 4,5 (1 hour old)
    vi.spyOn(Date, "now").mockReturnValue(now);

    const snapshot = estimator.total({ sinceMs: 1_800_000 });
    // Recent entries: 150 + 300 + 700 + 120 = 1270 tokens
    // Cost: 0.018 + 0.006 + 0.09 + 0.0024 = 0.1164
    expect(snapshot.callCount).toBe(4);
    expect(snapshot.totalTokens).toBe(1270);
    expect(snapshot.totalCost).toBeCloseTo(0.1164, 6);

    // byProvider with sinceMs should also filter
    const providers = estimator.byProvider({ sinceMs: 1_800_000 });
    const totalCalls = providers.reduce((sum, p) => sum + p.callCount, 0);
    expect(totalCalls).toBe(4);

    // byAgent with sinceMs: agent-a recent = entries 1,2 only
    const agentA = estimator.byAgent("agent-a", { sinceMs: 1_800_000 });
    expect(agentA.callCount).toBe(2);
    expect(agentA.totalTokens).toBe(450); // 150 + 300

    vi.restoreAllMocks();
  });

  it("sinceMs undefined returns all records", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const allTotal = estimator.total();
    const noFilterTotal = estimator.total({ sinceMs: undefined });

    expect(allTotal).toEqual(noFilterTotal);
    expect(allTotal.callCount).toBe(6);
  });

  it("usage24h returns 24 hourly data points with token totals", () => {
    const { costTracker, now } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    // All 6 entries are within last 24h (created with `now` and `now - 1h`)
    vi.spyOn(Date, "now").mockReturnValue(now);

    const usage = estimator.usage24h();
    expect(usage).toHaveLength(24);

    // Every entry should have hour 0-23 and tokens >= 0
    for (let i = 0; i < 24; i++) {
      expect(usage[i]!.hour).toBe(i);
      expect(usage[i]!.tokens).toBeGreaterThanOrEqual(0);
    }

    // Total tokens across all hours should equal total across all records
    const totalFromUsage = usage.reduce((sum, p) => sum + p.tokens, 0);
    expect(totalFromUsage).toBe(2420); // Same as total() = 2420

    vi.restoreAllMocks();
  });

  it("usage24h returns zeros when no records exist", () => {
    const costTracker = createCostTracker();
    const estimator = createBillingEstimator({ costTracker });

    const usage = estimator.usage24h();
    expect(usage).toHaveLength(24);
    expect(usage.every((p) => p.tokens === 0)).toBe(true);
  });

  it("delegates to CostTracker.getAll() on every call (no cache)", () => {
    const { costTracker } = seedTracker();
    const estimator = createBillingEstimator({ costTracker });

    const getAllSpy = vi.spyOn(costTracker, "getAll");

    // Call multiple methods
    estimator.byProvider();
    estimator.byAgent("agent-a");
    estimator.bySession("session-x");
    estimator.total();
    estimator.byProvider(); // second call to byProvider

    // getAll should have been called once per query (5 total)
    expect(getAllSpy).toHaveBeenCalledTimes(5);

    getAllSpy.mockRestore();
  });
});
