import { describe, it, expect } from "vitest";
import {
  createContextWindowGuard,
  type ContextWindowGuard,
  type ContextUsageData,
} from "./context-window-guard.js";

describe("createContextWindowGuard (percent-based)", () => {
  const guard = createContextWindowGuard();

  it("returns ok when percent is null (unknown usage)", () => {
    const result = guard.check({ tokens: null, contextWindow: 128_000, percent: null });
    expect(result).toEqual({ level: "ok" });
  });

  it("returns ok when percent is below warnPercent", () => {
    const result = guard.check({ tokens: 64_000, contextWindow: 128_000, percent: 50 });
    expect(result).toEqual({ level: "ok" });
  });

  it("returns warn when percent is at warnPercent (80%)", () => {
    const result = guard.check({ tokens: 102_400, contextWindow: 128_000, percent: 80 });
    expect(result.level).toBe("warn");
    if (result.level === "warn") {
      expect(result.percent).toBe(80);
      expect(result.message).toContain("80%");
    }
  });

  it("returns warn when percent is above warnPercent but below blockPercent", () => {
    const result = guard.check({ tokens: 115_200, contextWindow: 128_000, percent: 90 });
    expect(result.level).toBe("warn");
    if (result.level === "warn") {
      expect(result.percent).toBe(90);
      expect(result.message).toContain("90%");
    }
  });

  it("returns block when percent is at blockPercent (95%)", () => {
    const result = guard.check({ tokens: 121_600, contextWindow: 128_000, percent: 95 });
    expect(result.level).toBe("block");
    if (result.level === "block") {
      expect(result.percent).toBe(95);
      expect(result.message).toContain("95%");
    }
  });

  it("returns block when percent is 100%", () => {
    const result = guard.check({ tokens: 128_000, contextWindow: 128_000, percent: 100 });
    expect(result.level).toBe("block");
    if (result.level === "block") {
      expect(result.percent).toBe(100);
      expect(result.message).toContain("100%");
    }
  });

  it("supports custom thresholds (warn=70, block=90)", () => {
    const custom = createContextWindowGuard({ warnPercent: 70, blockPercent: 90 });

    expect(custom.check({ tokens: 50_000, contextWindow: 128_000, percent: 69 }).level).toBe("ok");
    expect(custom.check({ tokens: 89_600, contextWindow: 128_000, percent: 70 }).level).toBe("warn");
    expect(custom.check({ tokens: 112_000, contextWindow: 128_000, percent: 89 }).level).toBe("warn");
    expect(custom.check({ tokens: 115_200, contextWindow: 128_000, percent: 90 }).level).toBe("block");
  });

  it("message includes the actual percent value", () => {
    const result = guard.check({ tokens: 108_800, contextWindow: 128_000, percent: 85 });
    expect(result.level).toBe("warn");
    if (result.level === "warn") {
      expect(result.message).toMatch(/85%/);
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("tokens null but percent provided still works", () => {
    const result = guard.check({ tokens: null, contextWindow: 200_000, percent: 96 });
    expect(result.level).toBe("block");
    if (result.level === "block") {
      expect(result.percent).toBe(96);
    }
  });

  it("returns ok at just below warnPercent", () => {
    const result = guard.check({ tokens: 101_120, contextWindow: 128_000, percent: 79 });
    expect(result.level).toBe("ok");
  });

  it("returns warn at just below blockPercent", () => {
    const result = guard.check({ tokens: 120_320, contextWindow: 128_000, percent: 94 });
    expect(result.level).toBe("warn");
  });
});
