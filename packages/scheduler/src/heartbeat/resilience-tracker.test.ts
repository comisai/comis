import { describe, it, expect } from "vitest";
import {
  HEARTBEAT_BACKOFF_SCHEDULE_MS,
  computeBackoffMs,
  classifyError,
  shouldFireAlert,
  isRecovery,
} from "./resilience-tracker.js";
import type { ErrorClassification, AlertDecision } from "./resilience-tracker.js";

describe("HEARTBEAT_BACKOFF_SCHEDULE_MS", () => {
  it("contains the expected 5-step schedule [30s, 1m, 5m, 15m, 60m]", () => {
    expect(HEARTBEAT_BACKOFF_SCHEDULE_MS).toEqual([
      30_000, 60_000, 300_000, 900_000, 3_600_000,
    ]);
  });

  it("is readonly (as const)", () => {
    expect(Object.isFrozen(HEARTBEAT_BACKOFF_SCHEDULE_MS)).toBe(true);
  });
});

describe("computeBackoffMs", () => {
  it("returns 0 for 0 consecutive errors", () => {
    expect(computeBackoffMs(0)).toBe(0);
  });

  it("returns 0 for negative consecutive errors", () => {
    expect(computeBackoffMs(-1)).toBe(0);
  });

  it("returns 30s for 1 consecutive error", () => {
    expect(computeBackoffMs(1)).toBe(30_000);
  });

  it("returns 60s for 2 consecutive errors", () => {
    expect(computeBackoffMs(2)).toBe(60_000);
  });

  it("returns 300s for 3 consecutive errors", () => {
    expect(computeBackoffMs(3)).toBe(300_000);
  });

  it("returns 900s for 4 consecutive errors", () => {
    expect(computeBackoffMs(4)).toBe(900_000);
  });

  it("returns 3600s for 5 consecutive errors", () => {
    expect(computeBackoffMs(5)).toBe(3_600_000);
  });

  it("clamps at max (3600s) for 100 consecutive errors", () => {
    expect(computeBackoffMs(100)).toBe(3_600_000);
  });
});

describe("classifyError", () => {
  it("classifies non-Error object as transient", () => {
    expect(classifyError("some string")).toBe("transient");
  });

  it("classifies null as transient", () => {
    expect(classifyError(null)).toBe("transient");
  });

  it("classifies undefined as transient", () => {
    expect(classifyError(undefined)).toBe("transient");
  });

  it("classifies network timeout error as transient", () => {
    expect(classifyError(new Error("network timeout"))).toBe("transient");
  });

  it("classifies ECONNREFUSED as transient", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe("transient");
  });

  it("classifies generic Error as transient", () => {
    expect(classifyError(new Error("something went wrong"))).toBe("transient");
  });

  it("classifies 'unauthorized' as permanent", () => {
    expect(classifyError(new Error("unauthorized"))).toBe("permanent");
  });

  it("classifies 'Unauthorized access' as permanent (case-insensitive)", () => {
    expect(classifyError(new Error("Unauthorized access"))).toBe("permanent");
  });

  it("classifies 'forbidden' as permanent", () => {
    expect(classifyError(new Error("forbidden"))).toBe("permanent");
  });

  it("classifies 'not found' as permanent", () => {
    expect(classifyError(new Error("Agent not found"))).toBe("permanent");
  });

  it("classifies 'not enabled' as permanent", () => {
    expect(classifyError(new Error("Feature not enabled"))).toBe("permanent");
  });

  it("classifies 'not configured' as permanent", () => {
    expect(classifyError(new Error("Channel not configured"))).toBe("permanent");
  });

  it("classifies 'invalid' as permanent", () => {
    expect(classifyError(new Error("invalid token format"))).toBe("permanent");
  });

  it("classifies 'validation failed' as permanent", () => {
    expect(classifyError(new Error("validation failed: missing field"))).toBe("permanent");
  });
});

describe("shouldFireAlert", () => {
  const baseOpts = {
    consecutiveErrors: 3,
    alertThreshold: 2,
    lastAlertMs: 0,
    cooldownMs: 300_000,
    nowMs: 1_000_000,
    classification: "transient" as ErrorClassification,
  };

  it("returns shouldAlert=false when below threshold (transient)", () => {
    const result = shouldFireAlert({ ...baseOpts, consecutiveErrors: 1 });
    expect(result.shouldAlert).toBe(false);
    expect(result.reason).toBe("below-threshold");
  });

  it("returns shouldAlert=true when at threshold and cooldown expired (transient)", () => {
    const result = shouldFireAlert({ ...baseOpts, consecutiveErrors: 2 });
    expect(result.shouldAlert).toBe(true);
    expect(result.reason).toBe("threshold-exceeded");
  });

  it("returns shouldAlert=true when above threshold and cooldown expired (transient)", () => {
    const result = shouldFireAlert({ ...baseOpts, consecutiveErrors: 5 });
    expect(result.shouldAlert).toBe(true);
    expect(result.reason).toBe("threshold-exceeded");
  });

  it("returns shouldAlert=false when cooldown is active", () => {
    const result = shouldFireAlert({
      ...baseOpts,
      consecutiveErrors: 5,
      lastAlertMs: 900_000, // 100ms ago, within 300s cooldown
      nowMs: 1_000_000,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.reason).toBe("cooldown-active");
  });

  it("returns shouldAlert=true when cooldown just expired", () => {
    const result = shouldFireAlert({
      ...baseOpts,
      consecutiveErrors: 5,
      lastAlertMs: 700_000, // exactly 300s ago
      nowMs: 1_000_000,
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.reason).toBe("threshold-exceeded");
  });

  it("returns shouldAlert=true for permanent error on first failure (cooldown expired)", () => {
    const result = shouldFireAlert({
      ...baseOpts,
      consecutiveErrors: 1,
      classification: "permanent",
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.reason).toBe("permanent-error");
  });

  it("returns shouldAlert=false for permanent error when cooldown active", () => {
    const result = shouldFireAlert({
      ...baseOpts,
      consecutiveErrors: 1,
      classification: "permanent",
      lastAlertMs: 900_000,
      nowMs: 1_000_000,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.reason).toBe("cooldown-active");
  });

  it("handles lastAlertMs=0 (never alerted) as cooldown expired", () => {
    const result = shouldFireAlert({
      ...baseOpts,
      consecutiveErrors: 2,
      lastAlertMs: 0,
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.reason).toBe("threshold-exceeded");
  });
});

describe("isRecovery", () => {
  it("returns false for 0 previous errors", () => {
    expect(isRecovery(0)).toBe(false);
  });

  it("returns true for 1 previous error", () => {
    expect(isRecovery(1)).toBe(true);
  });

  it("returns true for 5 previous errors", () => {
    expect(isRecovery(5)).toBe(true);
  });
});
