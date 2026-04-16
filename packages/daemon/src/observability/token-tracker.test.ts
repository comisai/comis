import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import { createTokenTracker, type TokenUsageEntry } from "./token-tracker.js";

function makeEntry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
  return {
    timestamp: Date.now(),
    traceId: "trace-001",
    agentId: "agent-1",
    channelId: "telegram",
    executionId: "exec-001",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    tokens: { prompt: 100, completion: 50, total: 150 },
    cost: { input: 0.003, output: 0.015, total: 0.018 },
    latencyMs: 1200,
    ...overrides,
  };
}

describe("createTokenTracker", () => {
  it("record() stores entry and emits observability:token_usage event", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("observability:token_usage", handler);

    const tracker = createTokenTracker(bus);
    const entry = makeEntry();
    tracker.record(entry);

    // Verify stored (entry goes through bus emission -> bus subscription -> entries.push)
    expect(tracker.getAll()).toHaveLength(1);
    const stored = tracker.getAll()[0]!;
    expect(stored.traceId).toBe("trace-001");
    expect(stored.provider).toBe("anthropic");
    expect(stored.model).toBe("claude-sonnet-4-5-20250929");
    expect(stored.tokens.total).toBe(150);
    expect(stored.cost.total).toBe(0.018);
    expect(stored.latencyMs).toBe(1200);
    // Cache fields default to 0/false when not set on entry
    expect(stored.cacheReadTokens).toBe(0);
    expect(stored.cacheWriteTokens).toBe(0);
    expect(stored.savedVsUncached).toBe(0);
    expect(stored.cacheEligible).toBe(false);

    // Verify event emitted (handler called twice: once by record(), once by bus subscription re-emit -- no, only once because record() emits, bus handler pushes but does NOT re-emit)
    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]![0];
    expect(payload.provider).toBe("anthropic");
    expect(payload.model).toBe("claude-sonnet-4-5-20250929");
    expect(payload.tokens.total).toBe(150);
    expect(payload.cost.total).toBe(0.018);
    expect(payload.traceId).toBe("trace-001");
  });

  it('getByProvider("anthropic") aggregates only Anthropic entries', () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        provider: "anthropic",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: { input: 0.003, output: 0.015, total: 0.018 },
      }),
    );
    tracker.record(
      makeEntry({
        provider: "anthropic",
        tokens: { prompt: 200, completion: 100, total: 300 },
        cost: { input: 0.006, output: 0.03, total: 0.036 },
      }),
    );
    tracker.record(
      makeEntry({
        provider: "openai",
        tokens: { prompt: 50, completion: 25, total: 75 },
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      }),
    );

    const result = tracker.getByProvider("anthropic");
    expect(result.count).toBe(2);
    expect(result.totalTokens).toBe(450);
    expect(result.totalCost).toBeCloseTo(0.054, 5);

    const openai = tracker.getByProvider("openai");
    expect(openai.count).toBe(1);
    expect(openai.totalTokens).toBe(75);
  });

  it('getByModel("claude-sonnet-4-5-20250929") aggregates only that model', () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        model: "claude-sonnet-4-5-20250929",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: { input: 0.003, output: 0.015, total: 0.018 },
      }),
    );
    tracker.record(
      makeEntry({
        model: "gpt-4o-mini",
        tokens: { prompt: 200, completion: 100, total: 300 },
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      }),
    );
    tracker.record(
      makeEntry({
        model: "claude-sonnet-4-5-20250929",
        tokens: { prompt: 50, completion: 25, total: 75 },
        cost: { input: 0.001, output: 0.005, total: 0.006 },
      }),
    );

    const result = tracker.getByModel("claude-sonnet-4-5-20250929");
    expect(result.count).toBe(2);
    expect(result.totalTokens).toBe(225);
    expect(result.totalCost).toBeCloseTo(0.024, 5);
  });

  it("getByTrace() returns entries matching traceId", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(makeEntry({ traceId: "trace-A" }));
    tracker.record(makeEntry({ traceId: "trace-B" }));
    tracker.record(makeEntry({ traceId: "trace-A" }));

    const result = tracker.getByTrace("trace-A");
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.traceId === "trace-A")).toBe(true);

    expect(tracker.getByTrace("trace-B")).toHaveLength(1);
    expect(tracker.getByTrace("trace-C")).toHaveLength(0);
  });

  it("prune() removes old entries", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    const now = Date.now();
    tracker.record(makeEntry({ timestamp: now - 60_000 })); // 60s old
    tracker.record(makeEntry({ timestamp: now - 30_000 })); // 30s old
    tracker.record(makeEntry({ timestamp: now })); // current

    const removed = tracker.prune(45_000); // remove entries older than 45s
    expect(removed).toBe(1);
    expect(tracker.getAll()).toHaveLength(2);
  });

  it("getAll() returns defensive copy", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(makeEntry());
    const all = tracker.getAll();
    all.pop(); // mutate the copy

    expect(tracker.getAll()).toHaveLength(1); // original unchanged
  });

  it("getByProvider for unknown provider returns zeroes", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(makeEntry({ provider: "anthropic" }));

    const result = tracker.getByProvider("google");
    expect(result.count).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it("bus subscription captures observability:token_usage events in getAll()", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    // Simulate PiEventBridge emitting directly on the bus (no record() call)
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-bus-001",
      agentId: "agent-1",
      channelId: "telegram",
      executionId: "exec-bus-001",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      tokens: { prompt: 200, completion: 100, total: 300 },
      cost: { input: 0.006, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.036 },
      latencyMs: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "",
      savedVsUncached: 0,
      cacheEligible: false,
    });

    const all = tracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.traceId).toBe("trace-bus-001");
    expect(all[0]!.tokens.total).toBe(300);
    expect(all[0]!.cost.total).toBe(0.036);
  });

  it("record() stores entry via bus subscription (no duplicate)", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(makeEntry({ traceId: "trace-record-001" }));

    // record() emits on bus -> bus subscription pushes to entries -> exactly 1 entry
    const all = tracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.traceId).toBe("trace-record-001");
  });

  it("bus events and record() entries coexist in getAll()", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    // Entry via record()
    tracker.record(makeEntry({ traceId: "trace-via-record" }));

    // Entry via direct bus emit (simulating PiEventBridge)
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-via-bus",
      agentId: "agent-1",
      channelId: "discord",
      executionId: "exec-bus-002",
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt: 50, completion: 25, total: 75 },
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      latencyMs: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "",
      savedVsUncached: 0,
      cacheEligible: false,
    });

    const all = tracker.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.traceId).sort()).toEqual(["trace-via-bus", "trace-via-record"]);
  });

  it("getCacheHitRate returns 0 when no entries", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    expect(tracker.getCacheHitRate()).toBe(0);
  });

  it("getCacheHitRate computes correct ratio with mixed cache and uncached", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    // Entry 1: cacheRead=600, cacheWrite=200, uncached prompt=200 (total input=1000)
    tracker.record(
      makeEntry({
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        tokens: { prompt: 200, completion: 300, total: 500 },
      }),
    );
    // Entry 2: cacheRead=0, cacheWrite=0, uncached prompt=500 (total input=500)
    tracker.record(
      makeEntry({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: { prompt: 500, completion: 100, total: 600 },
      }),
    );

    // Expected: 600 / (600 + 200 + 200 + 0 + 0 + 500) = 600 / 1500 = 0.4
    expect(tracker.getCacheHitRate()).toBeCloseTo(0.4, 5);
  });

  it("getCacheHitRate excludes completion tokens from denominator", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        cacheReadTokens: 50,
        cacheWriteTokens: 50,
        tokens: { prompt: 100, completion: 900, total: 1000 },
      }),
    );

    // Expected: 50 / (50 + 50 + 100) = 50 / 200 = 0.25
    // NOT 50 / 1000 = 0.05 (which would be wrong if using tokens.total)
    expect(tracker.getCacheHitRate()).toBeCloseTo(0.25, 5);
    expect(tracker.getCacheHitRate()).not.toBeCloseTo(0.05, 2);
  });

  it("getCacheHitRate returns 1.0 when all input is from cache", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        tokens: { prompt: 0, completion: 200, total: 200 },
      }),
    );

    // Expected: 1000 / (1000 + 0 + 0) = 1.0
    expect(tracker.getCacheHitRate()).toBe(1.0);
  });

  // -------------------------------------------------------------------------
  // getCacheEffectiveness tests
  // -------------------------------------------------------------------------

  it("getCacheEffectiveness returns 0 when no entries", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    expect(tracker.getCacheEffectiveness()).toBe(0);
  });

  it("getCacheEffectiveness returns 0 when entries have zero cache tokens", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: { prompt: 500, completion: 100, total: 600 },
      }),
    );

    expect(tracker.getCacheEffectiveness()).toBe(0);
  });

  it("getCacheEffectiveness returns correct ratio (0.9 for 90K read + 10K write)", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        cacheReadTokens: 90000,
        cacheWriteTokens: 10000,
        tokens: { prompt: 500, completion: 100, total: 600 },
      }),
    );

    // Expected: 90000 / (90000 + 10000) = 0.9
    expect(tracker.getCacheEffectiveness()).toBeCloseTo(0.9, 5);
  });

  it("getCacheEffectiveness excludes tokens.prompt from calculation (differs from getCacheHitRate)", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    tracker.record(
      makeEntry({
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        tokens: { prompt: 200, completion: 300, total: 500 },
      }),
    );

    // getCacheEffectiveness: 600 / (600 + 200) = 0.75
    expect(tracker.getCacheEffectiveness()).toBeCloseTo(0.75, 5);

    // getCacheHitRate: 600 / (600 + 200 + 200) = 0.6
    expect(tracker.getCacheHitRate()).toBeCloseTo(0.6, 5);

    // They must differ when tokens.prompt > 0
    expect(tracker.getCacheEffectiveness()).not.toBeCloseTo(tracker.getCacheHitRate(), 2);
  });

  it("getCacheEffectiveness returns 0 after prune() removes all entries", () => {
    const bus = new TypedEventBus();
    const tracker = createTokenTracker(bus);

    const now = Date.now();
    tracker.record(
      makeEntry({
        timestamp: now - 60_000,
        cacheReadTokens: 500,
        cacheWriteTokens: 100,
      }),
    );

    // Before prune: effectiveness should be > 0
    expect(tracker.getCacheEffectiveness()).toBeGreaterThan(0);

    // Prune all entries (older than 1s)
    tracker.prune(1_000);

    expect(tracker.getCacheEffectiveness()).toBe(0);
  });
});
