// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createHealthAggregator — sliding-window in-memory rate aggregator.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { AlertBudgetPolicy } from "./types.js";
import { createHealthAggregator } from "./aggregator.js";

// Default policy matching the 10 errorKind thresholds from the plan.
const defaultPolicy: AlertBudgetPolicy = {
  enabled: true,
  thresholds: {
    network:      { count: 100, windowMs: 60_000 },
    config:       { count: 10,  windowMs: 60_000 },
    auth:         { count: 20,  windowMs: 60_000 },
    validation:   { count: 100, windowMs: 60_000 },
    precondition: { count: 50,  windowMs: 60_000 },
    timeout:      { count: 50,  windowMs: 60_000 },
    resource:     { count: 10,  windowMs: 60_000 },
    dependency:   { count: 20,  windowMs: 60_000 },
    internal:     { count: 5,   windowMs: 60_000 },
    platform:     { count: 50,  windowMs: 60_000 },
  },
};

describe("createHealthAggregator — core window latch invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("100 errorKind:network events in 60s emit EXACTLY ONE health:budget_exceeded", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    for (let i = 0; i < 100; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "network",
        count: 100,
        windowMs: 60_000,
        timestamp: expect.any(Number),
      }),
    );
  });

  it("200 events in same window → still only 1 emission (once-per-window latch)", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    for (let i = 0; i < 200; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("after window expiry the latch resets — next threshold cross emits fresh budget_exceeded", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    // First window: emit 100 events → 1 emission at t=0
    for (let i = 0; i < 100; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-a${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }
    expect(listener).toHaveBeenCalledTimes(1);

    // Advance past the 60s window
    vi.advanceTimersByTime(60_001);

    // Second window: emit 100 more → 1 more emission (total 2)
    for (let i = 0; i < 100; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-b${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("synthetic errorKind: 5 security:injection_detected fires under internal threshold (5/60s)", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    for (let i = 0; i < 5; i++) {
      eventBus.emit("security:injection_detected", {
        source: "user_input",
        patterns: [],
        riskLevel: "high",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "internal", count: 5 }),
    );
  });

  it("below threshold → no emission (99 network events)", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    for (let i = 0; i < 99; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it("per-kind isolation: 99 network + 5 internal → only internal fires", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    // 99 network — below threshold of 100
    for (let i = 0; i < 99; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-n${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    // 5 injection_detected → internal threshold is 5
    for (let i = 0; i < 5; i++) {
      eventBus.emit("security:injection_detected", {
        source: "user_input",
        patterns: [],
        riskLevel: "high",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "internal" }),
    );
  });

  it("unsubscribe stops all subscriptions", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    const unsub = createHealthAggregator({ eventBus, policy: defaultPolicy });
    unsub();

    for (let i = 0; i < 100; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it("disabled config short-circuits — no subscriptions, no emissions", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({
      eventBus,
      policy: { enabled: false, thresholds: {} },
    });

    for (let i = 0; i < 100; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: false,
        errorKind: "network",
        timestamp: Date.now(),
      });
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it("auth:refresh_failed honored with typed errorKind (auth threshold = 20)", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    for (let i = 0; i < 20; i++) {
      eventBus.emit("auth:refresh_failed", {
        provider: "google",
        profileId: "google:test@test.com",
        errorKind: "auth",
        hint: "re-login",
        timestamp: Date.now(),
      });
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", count: 20 }),
    );
  });

  it("tool:executed with missing errorKind is ignored (resolveErrorKind returns null)", () => {
    const eventBus = new TypedEventBus();
    const listener = vi.fn();
    eventBus.on("health:budget_exceeded", listener);

    createHealthAggregator({ eventBus, policy: defaultPolicy });

    // success:true with no errorKind — should be ignored
    for (let i = 0; i < 200; i++) {
      eventBus.emit("tool:executed", {
        toolName: "x",
        toolCallId: `tc-${i}`,
        durationMs: 1,
        success: true,
        timestamp: Date.now(),
      });
    }

    expect(listener).not.toHaveBeenCalled();
  });
});
