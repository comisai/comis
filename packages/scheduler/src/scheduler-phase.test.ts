// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  resolveNextSchedulerPhaseAtMs,
  resolveSchedulerPhaseMs,
} from "./scheduler-phase.js";

describe("scheduler phase resolution", () => {
  it("pins the canonical full-digest phase vectors including UTF-8 identifiers", () => {
    expect(resolveSchedulerPhaseMs("opaque-seed", "agent", "agent-a", 300_000)).toEqual({
      ok: true,
      value: 144_627,
    });
    expect(resolveSchedulerPhaseMs("opaque-seed", "job", "job-a", 60_000)).toEqual({
      ok: true,
      value: 56_853,
    });
    expect(resolveSchedulerPhaseMs("זרע", "agent", "סוכן-א", 300_000)).toEqual({
      ok: true,
      value: 194_353,
    });
  });

  it("keeps length-delimited identities distinct before hashing", () => {
    expect(resolveSchedulerPhaseMs("ab", "job", "c", 97)).toEqual({ ok: true, value: 23 });
    expect(resolveSchedulerPhaseMs("a", "job", "bc", 97)).toEqual({ ok: true, value: 5 });
  });

  it("rejects unsafe and nonpositive scheduler phase moduli", () => {
    for (const modulusMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(resolveSchedulerPhaseMs("seed", "agent", "agent-a", modulusMs)).toEqual({
        ok: false,
        error: {
          code: "invalid_modulus",
          errorKind: "validation",
          message: "Scheduler phase modulus must be a positive safe integer",
        },
      });
    }
  });

  it("chooses the smallest safe epoch strictly after the lower bound", () => {
    expect(resolveNextSchedulerPhaseAtMs(144_627, 300_000, 144_626)).toEqual({
      ok: true,
      value: 144_627,
    });
    expect(resolveNextSchedulerPhaseAtMs(144_627, 300_000, 144_627)).toEqual({
      ok: true,
      value: 444_627,
    });
    expect(resolveNextSchedulerPhaseAtMs(0, 60_000, 60_000)).toEqual({
      ok: true,
      value: 120_000,
    });
  });

  it("fails closed when the next phase epoch would overflow", () => {
    expect(resolveNextSchedulerPhaseAtMs(1, 2, Number.MAX_SAFE_INTEGER)).toEqual({
      ok: false,
      error: {
        code: "epoch_overflow",
        errorKind: "precondition",
        message: "Next scheduler phase epoch exceeds the safe integer range",
      },
    });
  });
});
