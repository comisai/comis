// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure abort -> honest TurnOutcome mapper.
 *
 * Root-cause incident: a max_steps abort whose filtered text still delivered
 * was rendered as a bare "❌ platform" — a mislabel. The mapper turns a
 * resource abort (max_steps / loop_detected) into a TRUTHFUL
 * kind:"failure" {errorKind:"resource"} carrying a one-line human reason,
 * and returns undefined for the non-abort branches so the normal
 * success/silent/delivery-failure paths are untouched.
 */
import { describe, it, expect } from "vitest";

import { mapAbortToTurnOutcome } from "./turn-outcome-mapper.js";

describe("mapAbortToTurnOutcome", () => {
  it("maps a max_steps resource abort to a truthful resource failure mentioning the step limit", () => {
    const outcome = mapAbortToTurnOutcome({
      finishReason: "max_steps",
      resourceAborted: true,
      abortReason: "max_steps",
    });
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("failure");
    if (outcome?.kind !== "failure") throw new Error("expected failure");
    expect(outcome.errorKind).toBe("resource");
    expect(outcome.errorKind).not.toBe("platform");
    expect(outcome.reason).toMatch(/step limit/i);
  });

  it("maps a loop_detected abort to a truthful resource failure mentioning the repeating-tool loop", () => {
    const outcome = mapAbortToTurnOutcome({
      finishReason: "loop_detected",
      resourceAborted: true,
      abortReason: "loop_detected",
    });
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("failure");
    if (outcome?.kind !== "failure") throw new Error("expected failure");
    expect(outcome.errorKind).toBe("resource");
    expect(outcome.reason).toMatch(/loop/i);
  });

  it("maps a spend_exceeded abort to a truthful resource failure mentioning the spend limit (never a stale tool errorKind)", () => {
    // Observed live: a spend-aborted turn fell through this mapper
    // (undefined), finalized via the success branch, and the coordinator's
    // failed-event reclassify stamped the status pill with the turn's
    // TRANSIENT recovered tool errorKind — the user saw "❌ validation" for a
    // budget stop.
    const outcome = mapAbortToTurnOutcome({
      finishReason: "spend_exceeded",
      resourceAborted: true,
      abortReason: "spend_exceeded",
    });
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("failure");
    if (outcome?.kind !== "failure") throw new Error("expected failure");
    expect(outcome.errorKind).toBe("resource");
    expect(outcome.reason).toMatch(/spend|budget/i);
  });

  it("returns undefined for a normal stop so the success/silent branches are untouched", () => {
    expect(
      mapAbortToTurnOutcome({ finishReason: "stop", resourceAborted: false }),
    ).toBeUndefined();
  });

  it("returns undefined when resourceAborted is false even with a non-stop finishReason", () => {
    expect(
      mapAbortToTurnOutcome({ finishReason: "max_steps", resourceAborted: false }),
    ).toBeUndefined();
  });

  it("never synthesizes a failedEvents trail (the reason carries the truth, not raw events)", () => {
    const outcome = mapAbortToTurnOutcome({
      finishReason: "max_steps",
      resourceAborted: true,
    });
    if (outcome?.kind !== "failure") throw new Error("expected failure");
    expect(outcome.failedEvents).toEqual([]);
  });
});
