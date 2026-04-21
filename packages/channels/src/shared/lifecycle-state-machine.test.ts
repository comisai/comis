// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ALL_PHASES,
  getPhaseCategory,
  isTerminal,
  isValidTransition,
  VALID_TRANSITIONS,
  type LifecyclePhase,
} from "./lifecycle-state-machine.js";

describe("lifecycle-state-machine", () => {
  describe("ALL_PHASES", () => {
    it("contains exactly 12 phases", () => {
      expect(ALL_PHASES).toHaveLength(12);
    });

    it("includes all expected phase names", () => {
      const expected: LifecyclePhase[] = [
        "idle",
        "queued",
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "done",
        "error",
        "stall_soft",
        "stall_hard",
      ];
      expect(ALL_PHASES).toEqual(expected);
    });
  });

  describe("getPhaseCategory", () => {
    it('returns "idle" for idle phase', () => {
      expect(getPhaseCategory("idle")).toBe("idle");
    });

    it('returns "terminal" for done', () => {
      expect(getPhaseCategory("done")).toBe("terminal");
    });

    it('returns "terminal" for error', () => {
      expect(getPhaseCategory("error")).toBe("terminal");
    });

    it('returns "stall" for stall_soft', () => {
      expect(getPhaseCategory("stall_soft")).toBe("stall");
    });

    it('returns "stall" for stall_hard', () => {
      expect(getPhaseCategory("stall_hard")).toBe("stall");
    });

    it('returns "intermediate" for queued', () => {
      expect(getPhaseCategory("queued")).toBe("intermediate");
    });

    it('returns "intermediate" for all processing phases', () => {
      const intermediates: LifecyclePhase[] = [
        "queued",
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
      ];
      for (const phase of intermediates) {
        expect(getPhaseCategory(phase)).toBe("intermediate");
      }
    });
  });

  describe("isValidTransition", () => {
    it("allows idle -> queued", () => {
      expect(isValidTransition("idle", "queued")).toBe(true);
    });

    it("does not allow idle -> thinking", () => {
      expect(isValidTransition("idle", "thinking")).toBe(false);
    });

    it("does not allow idle -> done", () => {
      expect(isValidTransition("idle", "done")).toBe(false);
    });

    it("allows queued -> thinking", () => {
      expect(isValidTransition("queued", "thinking")).toBe(true);
    });

    it("allows queued -> done (direct)", () => {
      expect(isValidTransition("queued", "done")).toBe(true);
    });

    it("allows queued -> error", () => {
      expect(isValidTransition("queued", "error")).toBe(true);
    });

    it("does not allow queued -> coding", () => {
      expect(isValidTransition("queued", "coding")).toBe(false);
    });

    it("allows thinking -> all other intermediates", () => {
      const targets: LifecyclePhase[] = ["memory", "tool", "coding", "web", "media"];
      for (const target of targets) {
        expect(isValidTransition("thinking", target)).toBe(true);
      }
    });

    it("allows thinking -> done and error", () => {
      expect(isValidTransition("thinking", "done")).toBe(true);
      expect(isValidTransition("thinking", "error")).toBe(true);
    });

    it("allows thinking -> stall_soft", () => {
      expect(isValidTransition("thinking", "stall_soft")).toBe(true);
    });

    it("does not allow thinking -> stall_hard directly", () => {
      expect(isValidTransition("thinking", "stall_hard")).toBe(false);
    });

    it("does not allow thinking -> idle", () => {
      expect(isValidTransition("thinking", "idle")).toBe(false);
    });

    it("does not allow thinking -> queued", () => {
      expect(isValidTransition("thinking", "queued")).toBe(false);
    });

    it("allows intermediate phases to transition between each other (except self)", () => {
      const intermediates: LifecyclePhase[] = [
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
      ];
      for (const from of intermediates) {
        for (const to of intermediates) {
          if (from !== to) {
            expect(isValidTransition(from, to)).toBe(true);
          }
        }
      }
    });

    it("does not allow intermediate phases to transition to themselves", () => {
      const intermediates: LifecyclePhase[] = [
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
      ];
      for (const phase of intermediates) {
        expect(isValidTransition(phase, phase)).toBe(false);
      }
    });

    it("allows done -> idle", () => {
      expect(isValidTransition("done", "idle")).toBe(true);
    });

    it("allows error -> idle", () => {
      expect(isValidTransition("error", "idle")).toBe(true);
    });

    it("does not allow done -> any phase except idle", () => {
      const others: LifecyclePhase[] = [
        "queued",
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "done",
        "error",
        "stall_soft",
        "stall_hard",
      ];
      for (const target of others) {
        expect(isValidTransition("done", target)).toBe(false);
      }
    });

    it("does not allow error -> any phase except idle", () => {
      const others: LifecyclePhase[] = [
        "queued",
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "done",
        "error",
        "stall_soft",
        "stall_hard",
      ];
      for (const target of others) {
        expect(isValidTransition("error", target)).toBe(false);
      }
    });

    it("allows stall_soft -> stall_hard", () => {
      expect(isValidTransition("stall_soft", "stall_hard")).toBe(true);
    });

    it("allows stall_soft -> all intermediates, done, and error", () => {
      const targets: LifecyclePhase[] = [
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "done",
        "error",
      ];
      for (const target of targets) {
        expect(isValidTransition("stall_soft", target)).toBe(true);
      }
    });

    it("allows stall_hard -> all intermediates, done, and error", () => {
      const targets: LifecyclePhase[] = [
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "done",
        "error",
      ];
      for (const target of targets) {
        expect(isValidTransition("stall_hard", target)).toBe(true);
      }
    });

    it("does not allow stall_hard -> stall_hard", () => {
      expect(isValidTransition("stall_hard", "stall_hard")).toBe(false);
    });

    it("does not allow stall_hard -> idle", () => {
      expect(isValidTransition("stall_hard", "idle")).toBe(false);
    });
  });

  describe("isTerminal", () => {
    it("returns true for done", () => {
      expect(isTerminal("done")).toBe(true);
    });

    it("returns true for error", () => {
      expect(isTerminal("error")).toBe(true);
    });

    it("returns false for all non-terminal phases", () => {
      const nonTerminal: LifecyclePhase[] = [
        "idle",
        "queued",
        "thinking",
        "memory",
        "tool",
        "coding",
        "web",
        "media",
        "stall_soft",
        "stall_hard",
      ];
      for (const phase of nonTerminal) {
        expect(isTerminal(phase)).toBe(false);
      }
    });
  });

  describe("VALID_TRANSITIONS completeness", () => {
    it("has an entry for every phase in ALL_PHASES", () => {
      for (const phase of ALL_PHASES) {
        expect(VALID_TRANSITIONS).toHaveProperty(phase);
        expect(Array.isArray(VALID_TRANSITIONS[phase])).toBe(true);
      }
    });

    it("every transition target is a valid LifecyclePhase", () => {
      for (const phase of ALL_PHASES) {
        for (const target of VALID_TRANSITIONS[phase]) {
          expect(ALL_PHASES).toContain(target);
        }
      }
    });

    it("no phase lists itself as a valid transition target", () => {
      for (const phase of ALL_PHASES) {
        expect(VALID_TRANSITIONS[phase]).not.toContain(phase);
      }
    });
  });
});
