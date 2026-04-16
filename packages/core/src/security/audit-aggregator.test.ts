import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuditAggregator } from "./audit-aggregator.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

describe("createAuditAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates events within window", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["a"] });
    aggregator.record({ source: "external_content", patterns: ["b"] });
    aggregator.record({ source: "external_content", patterns: ["c"] });

    // Not yet emitted
    expect(eventBus.emit).not.toHaveBeenCalled();

    // Advance past window
    vi.advanceTimersByTime(5001);

    // Should emit exactly once (deduplicated)
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  it("emits summary at window close with correct payload", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["pattern_a"] });
    aggregator.record({ source: "external_content", patterns: ["pattern_b"] });

    vi.advanceTimersByTime(5001);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = eventBus.emit.mock.calls[0];
    expect(eventName).toBe("security:injection_detected");
    expect(payload.source).toBe("external_content");
    expect(payload.riskLevel).toBe("medium");
    expect(payload.patterns).toContain("pattern_a");
    expect(payload.patterns).toContain("pattern_b");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("counts unique patterns", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["a", "b"] });
    aggregator.record({ source: "external_content", patterns: ["b", "c"] });

    vi.advanceTimersByTime(5001);

    const [, payload] = eventBus.emit.mock.calls[0];
    // Should have 3 unique patterns: a, b, c
    expect(payload.patterns).toHaveLength(3);
    expect(payload.patterns).toContain("a");
    expect(payload.patterns).toContain("b");
    expect(payload.patterns).toContain("c");
  });

  it("respects maxPatternsPerSummary cap", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, {
      windowMs: 5000,
      maxPatternsPerSummary: 2,
    });

    aggregator.record({
      source: "external_content",
      patterns: ["a", "b", "c", "d", "e"],
    });

    vi.advanceTimersByTime(5001);

    const [, payload] = eventBus.emit.mock.calls[0];
    expect(payload.patterns).toHaveLength(2);
  });

  it("handles multiple concurrent windows for different sources", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["a"] });
    aggregator.record({ source: "tool_output", patterns: ["b"] });

    vi.advanceTimersByTime(5001);

    // Two separate summary events -- one per source
    expect(eventBus.emit).toHaveBeenCalledTimes(2);

    const sources = eventBus.emit.mock.calls.map(
      (call: [string, { source: string }]) => call[0],
    );
    expect(sources).toEqual([
      "security:injection_detected",
      "security:injection_detected",
    ]);
  });

  it("flush() emits all pending windows immediately", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 60_000 });

    aggregator.record({ source: "external_content", patterns: ["a"] });
    aggregator.record({ source: "tool_output", patterns: ["b"] });

    // Flush without advancing timers
    aggregator.flush();

    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });

  it("destroy() clears all timers without emitting", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["a"] });
    aggregator.record({ source: "tool_output", patterns: ["b"] });

    aggregator.destroy();

    // Advance past window -- nothing should emit
    vi.advanceTimersByTime(10_000);

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("logs INFO summary at window close", () => {
    const eventBus = createMockEventBus();
    const mockLogger = { info: vi.fn() };
    const aggregator = createAuditAggregator(
      eventBus,
      { windowMs: 5000 },
      mockLogger,
    );

    aggregator.record({ source: "external_content", patterns: ["x"] });
    aggregator.record({ source: "external_content", patterns: ["y"] });
    aggregator.record({ source: "external_content", patterns: ["z"] });

    vi.advanceTimersByTime(5001);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [logObj, logMsg] = mockLogger.info.mock.calls[0];
    expect(logObj.eventCount).toBe(3);
    expect(logObj.uniquePatterns).toBe(3);
    expect(logObj.suppressedCount).toBe(2); // 3 - 1 = 2
    expect(logObj.windowKey).toBe("external_content");
    expect(logMsg).toBe("Audit aggregation window closed");
  });

  it("accepts new events after window closes for same source", () => {
    const eventBus = createMockEventBus();
    const aggregator = createAuditAggregator(eventBus, { windowMs: 5000 });

    aggregator.record({ source: "external_content", patterns: ["a"] });
    vi.advanceTimersByTime(5001);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);

    // Record again after window closed
    aggregator.record({ source: "external_content", patterns: ["b"] });
    vi.advanceTimersByTime(5001);

    expect(eventBus.emit).toHaveBeenCalledTimes(2);
  });
});
