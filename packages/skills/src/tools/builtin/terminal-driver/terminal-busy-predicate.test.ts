// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure busy-vs-hung predicate
 * (terminal-busy-predicate.ts) — LIVE-01, phase 165 §busy-vs-hung.
 *
 * RED-first: `terminal-busy-predicate.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN.
 *
 * `busyOrHung({ alive, noProgressMs, stuckMs })` is the SINGLE liveness/endurance
 * signal the LIVE-01 backstop (165-07) and the ENDURE-01 reaper exclusion (165-08)
 * both consume. It is a PURE re-exposure of the classifier's shipped stuck rule
 * (`terminal-classifier.ts:281` — `noProgressMs > stuckMs`, by PROGRESS NEVER by
 * elapsed wall-clock): recent progress ⇒ "busy", no progress past the stuck window
 * ⇒ "hung", a dead backend ⇒ "hung".
 *
 * The doctrine under test is I9 (the worst outcome is a false death): a legitimately
 * busy / output-trickling long compile is NEVER declared hung. The predicate biases
 * to the SAFE direction — a degenerate (NaN/negative) input yields "busy" (keep
 * waiting), never a false "hung". It reads NO screen (I2): the caller passes the
 * content-free scalars; the signature carries no grid/cursor parameter.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { busyOrHung } from "./terminal-busy-predicate.js";

// ---------------------------------------------------------------------------
// Test 1 — recent progress is BUSY (I9: a CPU-busy / output-trickling compile
// is never killed). The defining contract of the whole 40h regime.
// ---------------------------------------------------------------------------

describe("busyOrHung — Test 1: recent progress is busy (I9)", () => {
  it('returns "busy" for an alive session with recent progress (noProgressMs << stuckMs)', () => {
    // A 2h compile that printed a line 5s ago — busy, NOT hung.
    expect(busyOrHung({ alive: true, noProgressMs: 5_000, stuckMs: 60_000 })).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — no progress past the stuck window is HUNG (the genuinely-idle,
// no-transition case the backstop synthesizes `stuck` for).
// ---------------------------------------------------------------------------

describe("busyOrHung — Test 2: no progress past the stuck window is hung", () => {
  it('returns "hung" for an alive session whose noProgressMs has exceeded stuckMs', () => {
    expect(busyOrHung({ alive: true, noProgressMs: 120_000, stuckMs: 60_000 })).toBe("hung");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — a dead backend is HUNG regardless of timing (tmux has-session false).
// ---------------------------------------------------------------------------

describe("busyOrHung — Test 3: a dead backend is hung regardless of timing", () => {
  it('returns "hung" when alive is false even with noProgressMs at 0', () => {
    expect(busyOrHung({ alive: false, noProgressMs: 0, stuckMs: 60_000 })).toBe("hung");
  });

  it('returns "hung" when alive is false even within the stuck window', () => {
    // Timing says "fresh progress" but the backend is GONE — death wins.
    expect(busyOrHung({ alive: false, noProgressMs: 1, stuckMs: 60_000 })).toBe("hung");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — the strict-`>` boundary (mirrors checkWallClock's strict >):
// AT the window the budget is not yet exceeded ⇒ still busy.
// ---------------------------------------------------------------------------

describe("busyOrHung — Test 4: the stuck window is a strict > boundary", () => {
  it('returns "busy" exactly AT the boundary (noProgressMs === stuckMs)', () => {
    // Exactly at the cap is NOT yet a breach — strict >, like the classifier rule.
    expect(busyOrHung({ alive: true, noProgressMs: 60_000, stuckMs: 60_000 })).toBe("busy");
  });

  it('returns "hung" one ms PAST the boundary (noProgressMs === stuckMs + 1)', () => {
    expect(busyOrHung({ alive: true, noProgressMs: 60_001, stuckMs: 60_000 })).toBe("hung");
  });
});

// ---------------------------------------------------------------------------
// Test 5 — TOTAL / never-throws: a degenerate input yields the SAFE direction
// ("busy", keep waiting) — NEVER a false "hung" (I9 bias).
// ---------------------------------------------------------------------------

describe("busyOrHung — Test 5: degenerate input is busy (the safe direction, never throws)", () => {
  it('returns "busy" for a NaN noProgressMs (treated as recent progress, not hung)', () => {
    expect(busyOrHung({ alive: true, noProgressMs: Number.NaN, stuckMs: 60_000 })).toBe("busy");
  });

  it('returns "busy" for a negative noProgressMs (clock skew never declares hung)', () => {
    expect(busyOrHung({ alive: true, noProgressMs: -1, stuckMs: 60_000 })).toBe("busy");
  });

  it('returns "busy" for a non-finite (Infinity) noProgressMs on an alive session', () => {
    // Infinity is not a finite measurement → bias to busy rather than a false death.
    expect(busyOrHung({ alive: true, noProgressMs: Number.POSITIVE_INFINITY, stuckMs: 60_000 })).toBe(
      "busy",
    );
  });

  it("never throws across the degenerate-input matrix", () => {
    const degenerate = [Number.NaN, -1, -1_000, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const noProgressMs of degenerate) {
      expect(() => busyOrHung({ alive: true, noProgressMs, stuckMs: 60_000 })).not.toThrow();
    }
  });
});
