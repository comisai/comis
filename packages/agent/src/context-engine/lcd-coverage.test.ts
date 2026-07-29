// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the assembler's coverage seam — `history ∪ freshTail == liveMessages`.
 *
 * The end-to-end proof lives in lcd-assembler.test.ts ("a LONG tool loop never
 * opens a hole…"); these pin the two helpers' edge semantics directly, because
 * both of them fail SILENTLY when wrong: a mis-clamped tail start drops messages
 * with every reported number still reading healthy, and a mis-computed shortfall
 * either cries wolf on every turn (and gets ignored) or never fires at all.
 */
import { describe, it, expect } from "vitest";
import { resolveFreshTailStart, warnOnCoverageShortfall } from "./lcd-coverage.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

describe("resolveFreshTailStart", () => {
  it("clamps the step boundary back to the store horizon (the in-flight gap)", () => {
    // The production shape: 9 steps deep into a turn, the boundary (12) has
    // overtaken the frozen horizon (9). Everything from 9 on is unpersisted and
    // must ride the verbatim tail.
    expect(resolveFreshTailStart(12, 9, true)).toBe(9);
  });

  it("leaves the boundary alone when it is still inside the persisted range", () => {
    // The steady state — the tail is a pure step-count window and nothing widens.
    expect(resolveFreshTailStart(41, 56, true)).toBe(41);
  });

  it("is a no-op at the exact seam", () => {
    expect(resolveFreshTailStart(56, 56, true)).toBe(56);
  });

  it("does NOT clamp under an unreadable scope — 0 there means 'unknown', not 'empty'", () => {
    // `countMessages` fail-closes to 0 for an incomplete scope. Clamping to 0
    // would make the WHOLE live array unconditional and overflow a tight window,
    // instead of degrading honestly to the fresh tail.
    expect(resolveFreshTailStart(17, 0, false)).toBe(17);
  });

  it("clamps to 0 on a genuinely empty store — a first turn is entirely in flight", () => {
    expect(resolveFreshTailStart(3, 0, true)).toBe(0);
  });
});

describe("warnOnCoverageShortfall", () => {
  const base = {
    persistedMsgCount: 56,
    stepBoundary: 57,
    tailStart: 56,
    historyCount: 56,
    freshTailCount: 17,
    freshTailTrimmedCount: 0,
    agentId: "agent_a",
    sessionKey: "sess-a",
  };

  it("stays silent when the assembled array covers the live conversation", () => {
    const logger = createMockLogger();
    const shortfall = warnOnCoverageShortfall(logger as never, {
      ...base,
      liveCount: 73,
      assembledCount: 73,
      assembledCoverageCount: 73,
      droppedCount: 0,
      droppedCoverageCount: 0,
    });
    expect(shortfall).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("nets out deliberate eviction — dropped history is accounted for, not a defect", () => {
    const logger = createMockLogger();
    const shortfall = warnOnCoverageShortfall(logger as never, {
      ...base,
      liveCount: 73,
      assembledCount: 60,
      assembledCoverageCount: 60,
      droppedCount: 13,
      droppedCoverageCount: 13,
    });
    expect(shortfall).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("nets out the residual trim — a tight window dropping oldest tail steps is honest, not a hole", () => {
    const logger = createMockLogger();
    const shortfall = warnOnCoverageShortfall(logger as never, {
      ...base,
      liveCount: 73,
      assembledCount: 69,
      assembledCoverageCount: 69,
      droppedCount: 0,
      droppedCoverageCount: 0,
      freshTailTrimmedCount: 4,
    });
    expect(shortfall).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never reports a NEGATIVE shortfall (a larger assembled array is not a defect)", () => {
    const logger = createMockLogger();
    const shortfall = warnOnCoverageShortfall(logger as never, {
      ...base,
      liveCount: 73,
      assembledCount: 75,
      assembledCoverageCount: 75,
      droppedCount: 0,
      droppedCoverageCount: 0,
    });
    expect(shortfall).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("WARNs with the two indices that localize the gap when messages go missing", () => {
    const logger = createMockLogger();
    // The live incident: boundary 57 past horizon 56 → live[56] in neither segment.
    const shortfall = warnOnCoverageShortfall(logger as never, {
      ...base,
      tailStart: 57, // un-clamped — the pre-fix behaviour
      liveCount: 73,
      assembledCount: 72,
      assembledCoverageCount: 72,
      droppedCount: 0,
      droppedCoverageCount: 0,
    });
    expect(shortfall).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const fields = logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.errorKind).toBe("internal");
    expect(fields.coverageShortfall).toBe(1);
    // Both sides of the seam ride the line, so the gap is localizable without a
    // second lens — that hand-join across two log lines is what made this bug
    // take a full investigation to find.
    expect(fields.persistedMsgCount).toBe(56);
    expect(fields.stepBoundary).toBe(57);
    expect(String(fields.hint)).toContain("persistedMsgCount");
    expect(String(fields.hint)).toContain("stepBoundary");
  });
});
