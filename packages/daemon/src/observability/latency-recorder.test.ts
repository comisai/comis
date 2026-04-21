// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import { createLatencyRecorder } from "./latency-recorder.js";

describe("createLatencyRecorder", () => {
  it("startTimer returns function; calling it returns elapsed ms (> 0)", async () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    const stop = recorder.startTimer();

    // Wait a tiny bit to ensure elapsed > 0
    await new Promise((resolve) => setTimeout(resolve, 5));

    const elapsed = stop();
    expect(elapsed).toBeGreaterThan(0);
    expect(typeof elapsed).toBe("number");
  });

  it("record() stores entry and emits observability:latency event", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("observability:latency", handler);

    const recorder = createLatencyRecorder(bus);
    recorder.record("llm_call", 1500, { model: "claude-sonnet-4-5-20250929" });

    // Verify event emitted
    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]![0];
    expect(payload.operation).toBe("llm_call");
    expect(payload.durationMs).toBe(1500);
    expect(payload.metadata?.model).toBe("claude-sonnet-4-5-20250929");
    expect(payload.timestamp).toBeGreaterThan(0);

    // Verify stored via stats
    const stats = recorder.getStats("llm_call");
    expect(stats.count).toBe(1);
    expect(stats.mean).toBe(1500);
  });

  it('getStats("llm_call") returns correct stats', () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    // Record multiple measurements
    recorder.record("llm_call", 100);
    recorder.record("llm_call", 200);
    recorder.record("llm_call", 300);
    recorder.record("llm_call", 400);
    recorder.record("llm_call", 5000); // outlier

    const stats = recorder.getStats("llm_call");
    expect(stats.count).toBe(5);
    expect(stats.mean).toBe(1200); // (100+200+300+400+5000) / 5
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(5000);
    expect(stats.p50).toBe(300); // median
    expect(stats.p99).toBe(5000); // with 5 items, p99 is the max
  });

  it("getStats for empty operation returns zeroes", () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    const stats = recorder.getStats("memory_search");
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.p50).toBe(0);
    expect(stats.p99).toBe(0);
  });

  it("reset() clears all records", () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    recorder.record("llm_call", 100);
    recorder.record("tool_execution", 50);
    recorder.record("memory_search", 25);

    expect(recorder.getStats("llm_call").count).toBe(1);
    expect(recorder.getStats("tool_execution").count).toBe(1);

    recorder.reset();

    expect(recorder.getStats("llm_call").count).toBe(0);
    expect(recorder.getStats("tool_execution").count).toBe(0);
    expect(recorder.getStats("memory_search").count).toBe(0);
  });

  it("separate operations have independent stats", () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    recorder.record("llm_call", 1000);
    recorder.record("llm_call", 2000);
    recorder.record("tool_execution", 50);

    const llmStats = recorder.getStats("llm_call");
    expect(llmStats.count).toBe(2);
    expect(llmStats.mean).toBe(1500);

    const toolStats = recorder.getStats("tool_execution");
    expect(toolStats.count).toBe(1);
    expect(toolStats.mean).toBe(50);
  });

  it("record without metadata emits event with undefined metadata", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("observability:latency", handler);

    const recorder = createLatencyRecorder(bus);
    recorder.record("memory_search", 42);

    const payload = handler.mock.calls[0]![0];
    expect(payload.operation).toBe("memory_search");
    expect(payload.durationMs).toBe(42);
    expect(payload.metadata).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // prune() removes old entries by timestamp
  // -----------------------------------------------------------------------

  it("prune() removes entries older than maxAgeMs and returns count", () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    const now = Date.now();
    // Spy on Date.now to control timestamps during record calls
    const originalNow = Date.now;
    let mockTimestamp = now;
    vi.spyOn(Date, "now").mockImplementation(() => mockTimestamp);

    // Record 5 entries with varying timestamps
    mockTimestamp = now - 120_000; // 120s ago
    recorder.record("llm_call", 100);
    mockTimestamp = now - 90_000; // 90s ago
    recorder.record("llm_call", 200);
    mockTimestamp = now - 60_000; // 60s ago
    recorder.record("tool_execution", 300);
    mockTimestamp = now - 10_000; // 10s ago
    recorder.record("llm_call", 400);
    mockTimestamp = now; // now
    recorder.record("tool_execution", 500);

    // Prune entries older than 45s -- should remove 3 (120s, 90s, 60s)
    mockTimestamp = now; // current time for prune cutoff
    const removed = recorder.prune(45_000);
    expect(removed).toBe(3);

    // 2 entries remain
    const llmStats = recorder.getStats("llm_call");
    expect(llmStats.count).toBe(1);
    expect(llmStats.mean).toBe(400);

    const toolStats = recorder.getStats("tool_execution");
    expect(toolStats.count).toBe(1);
    expect(toolStats.mean).toBe(500);

    vi.restoreAllMocks();
  });

  it("prune() returns 0 when no entries are old enough", () => {
    const bus = new TypedEventBus();
    const recorder = createLatencyRecorder(bus);

    recorder.record("llm_call", 100);
    recorder.record("tool_execution", 200);

    // Prune with very large maxAge -- nothing should be removed
    const removed = recorder.prune(999_999_999);
    expect(removed).toBe(0);
    expect(recorder.getStats("llm_call").count).toBe(1);
    expect(recorder.getStats("tool_execution").count).toBe(1);
  });
});
