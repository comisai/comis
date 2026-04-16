import { describe, expect, it } from "vitest";

import type { LifecyclePhase } from "./lifecycle-state-machine.js";
import {
  computeStallThresholds,
  getPhaseMultiplier,
  PHASE_MULTIPLIERS,
} from "./stall-detector.js";

describe("stall-detector", () => {
  describe("PHASE_MULTIPLIERS", () => {
    it("has expected value for coding (2.0x)", () => {
      expect(PHASE_MULTIPLIERS["coding"]).toBe(2.0);
    });

    it("has expected value for web (1.5x)", () => {
      expect(PHASE_MULTIPLIERS["web"]).toBe(1.5);
    });

    it("has expected value for media (3.0x)", () => {
      expect(PHASE_MULTIPLIERS["media"]).toBe(3.0);
    });

    it("has expected value for thinking (1.0x)", () => {
      expect(PHASE_MULTIPLIERS["thinking"]).toBe(1.0);
    });

    it("has expected value for memory (1.0x)", () => {
      expect(PHASE_MULTIPLIERS["memory"]).toBe(1.0);
    });

    it("has expected value for tool (1.0x)", () => {
      expect(PHASE_MULTIPLIERS["tool"]).toBe(1.0);
    });

    it("has exactly 6 entries", () => {
      expect(Object.keys(PHASE_MULTIPLIERS)).toHaveLength(6);
    });
  });

  describe("getPhaseMultiplier", () => {
    it("returns correct multipliers for listed phases", () => {
      expect(getPhaseMultiplier("thinking")).toBe(1.0);
      expect(getPhaseMultiplier("memory")).toBe(1.0);
      expect(getPhaseMultiplier("tool")).toBe(1.0);
      expect(getPhaseMultiplier("coding")).toBe(2.0);
      expect(getPhaseMultiplier("web")).toBe(1.5);
      expect(getPhaseMultiplier("media")).toBe(3.0);
    });

    it("returns 1.0 for idle", () => {
      expect(getPhaseMultiplier("idle")).toBe(1.0);
    });

    it("returns 1.0 for queued", () => {
      expect(getPhaseMultiplier("queued")).toBe(1.0);
    });

    it("returns 1.0 for done", () => {
      expect(getPhaseMultiplier("done")).toBe(1.0);
    });

    it("returns 1.0 for error", () => {
      expect(getPhaseMultiplier("error")).toBe(1.0);
    });

    it("returns 1.0 for stall_soft", () => {
      expect(getPhaseMultiplier("stall_soft")).toBe(1.0);
    });

    it("returns 1.0 for stall_hard", () => {
      expect(getPhaseMultiplier("stall_hard")).toBe(1.0);
    });
  });

  describe("computeStallThresholds", () => {
    const defaultTiming = { stallSoftMs: 15000, stallHardMs: 30000 };

    it("computes correct thresholds for thinking (1.0x)", () => {
      const result = computeStallThresholds("thinking", defaultTiming);
      expect(result).toEqual({ softMs: 15000, hardMs: 30000 });
    });

    it("computes correct thresholds for coding (2.0x)", () => {
      const result = computeStallThresholds("coding", defaultTiming);
      expect(result).toEqual({ softMs: 30000, hardMs: 60000 });
    });

    it("computes correct thresholds for web (1.5x)", () => {
      const result = computeStallThresholds("web", defaultTiming);
      expect(result).toEqual({ softMs: 22500, hardMs: 45000 });
    });

    it("computes correct thresholds for media (3.0x)", () => {
      const result = computeStallThresholds("media", defaultTiming);
      expect(result).toEqual({ softMs: 45000, hardMs: 90000 });
    });

    it("computes correct thresholds for memory (1.0x)", () => {
      const result = computeStallThresholds("memory", defaultTiming);
      expect(result).toEqual({ softMs: 15000, hardMs: 30000 });
    });

    it("computes correct thresholds for tool (1.0x)", () => {
      const result = computeStallThresholds("tool", defaultTiming);
      expect(result).toEqual({ softMs: 15000, hardMs: 30000 });
    });

    it("uses 1.0x multiplier for unlisted phases", () => {
      const unlisted: LifecyclePhase[] = ["idle", "queued", "done", "error", "stall_soft", "stall_hard"];
      for (const phase of unlisted) {
        const result = computeStallThresholds(phase, defaultTiming);
        expect(result).toEqual({ softMs: 15000, hardMs: 30000 });
      }
    });

    it("works with custom timing values", () => {
      const customTiming = { stallSoftMs: 10000, stallHardMs: 20000 };
      expect(computeStallThresholds("coding", customTiming)).toEqual({
        softMs: 20000,
        hardMs: 40000,
      });
      expect(computeStallThresholds("media", customTiming)).toEqual({
        softMs: 30000,
        hardMs: 60000,
      });
    });

    it("handles zero timing values", () => {
      const zeroTiming = { stallSoftMs: 0, stallHardMs: 0 };
      const result = computeStallThresholds("coding", zeroTiming);
      expect(result).toEqual({ softMs: 0, hardMs: 0 });
    });

    it("preserves precision with fractional multipliers", () => {
      const timing = { stallSoftMs: 10000, stallHardMs: 30000 };
      const result = computeStallThresholds("web", timing);
      // 1.5x * 10000 = 15000, 1.5x * 30000 = 45000
      expect(result.softMs).toBe(15000);
      expect(result.hardMs).toBe(45000);
    });
  });
});
