// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createDeltaResetComposer (LAT-02, 177-03).
 *
 * The composer is the ALWAYS-DEFINED bridge onDelta: it forwards stream
 * deltas to the optional channel callback AND resets the stall timer through
 * a LIVE ref (assigned later at onResetTimer — Pitfall 2), throttled ~1/s via
 * a hand-rolled clock compare (R-7: no timer churn per token).
 *
 * LAT-02-W-4 (the gating fixture) is intentionally OMITTED: the 177-01
 * DECISION records gate_scope: all-providers — no `enabled` flag exists on
 * the composer, so there is no local-gated branch to pin.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ClockPort } from "@comis/core";
import { createDeltaResetComposer } from "./delta-reset.js";

/** Manual clock — the throttle is clock-driven, no fake timers needed. */
function makeManualClock(startMs = 0): ClockPort & { set(ms: number): void; advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    nowDate: () => new Date(t),
    set(ms: number) { t = ms; },
    advance(ms: number) { t += ms; },
  };
}

describe("createDeltaResetComposer (LAT-02)", () => {
  it("LAT-02-W-1: forwards (delta, kind) to the channel callback AND resets for BOTH kinds — thinking deltas count as activity", () => {
    // text delta
    const clock = makeManualClock();
    const channel = vi.fn();
    const reset = vi.fn();
    const onDelta = createDeltaResetComposer({}, {
      channelOnDelta: channel,
      getResetTimer: () => reset,
      clock,
    });
    onDelta("hello", "text");
    expect(channel).toHaveBeenCalledWith("hello", "text");
    expect(reset).toHaveBeenCalledTimes(1);

    // thinking delta — fresh composer so the throttle window cannot mask the
    // kind: a silent local prefill streams ONLY thinking deltas, and those
    // must extend the stall deadline exactly like text.
    const clock2 = makeManualClock();
    const channel2 = vi.fn();
    const reset2 = vi.fn();
    const onDelta2 = createDeltaResetComposer({}, {
      channelOnDelta: channel2,
      getResetTimer: () => reset2,
      clock: clock2,
    });
    onDelta2("pondering...", "thinking");
    expect(channel2).toHaveBeenCalledWith("pondering...", "thinking");
    expect(reset2).toHaveBeenCalledTimes(1);
  });

  it("LAT-02-W-2: ~1/s throttle — 50 deltas in 500ms reset exactly once; a delta at +1000ms resets again (first delta always resets)", () => {
    const clock = makeManualClock();
    const reset = vi.fn();
    const onDelta = createDeltaResetComposer({}, {
      channelOnDelta: undefined,
      getResetTimer: () => reset,
      clock,
    });

    // 50 deltas across 0..490ms — only the FIRST passes the throttle
    // (lastResetAtMs initialized so the first delta always resets).
    for (let i = 0; i < 50; i++) {
      clock.set(i * 10);
      onDelta(`token-${i}`, "text");
    }
    expect(reset).toHaveBeenCalledTimes(1);

    // One full throttle window after the first reset → resets again.
    clock.set(1_000);
    onDelta("later token", "text");
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("LAT-02-W-3: live-ref (Pitfall 2) — a delta before onResetTimer assignment is a correct no-op; after assignment the next unthrottled delta resets; channelOnDelta undefined stays callable", () => {
    const clock = makeManualClock();
    let liveResetRef: (() => void) | undefined;
    // Always-defined contract: built with NO channel callback, still callable.
    const onDelta = createDeltaResetComposer({}, {
      channelOnDelta: undefined,
      getResetTimer: () => liveResetRef,
      clock,
    });

    // The ref is unassigned (deltas can theoretically race the onResetTimer
    // hand-off) — the composer must read THROUGH the ref at call time and
    // no-op, never throw, never capture the undefined value.
    expect(() => { onDelta("early delta", "text"); }).not.toThrow();

    const reset = vi.fn();
    liveResetRef = reset;
    // The early delta consumed the throttle window — advance past it so this
    // test isolates the live-ref behavior from LAT-02-W-2's throttle pin.
    clock.advance(1_000);
    onDelta("after assignment", "text");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  // LAT-02-W-4 intentionally omitted: 177-01 DECISION gate_scope =
  // all-providers — the composer has no `enabled` flag (no local-gated branch
  // exists to fixture). See 177-01-SUMMARY.md DECISION block.
});
