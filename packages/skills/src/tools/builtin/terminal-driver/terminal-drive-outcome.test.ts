// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure NOTIFY-01 wake-outcome module
 * (terminal-drive-outcome.ts) — design §4 Phase D, CONTEXT I4/I6/I9.
 *
 * RED-first: `terminal-drive-outcome.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns them
 * GREEN. (Mirrors terminal-spend-ceiling.test.ts:1-9 / terminal-drive-journal.test.ts —
 * the "module does not exist on first commit" banner.)
 *
 * Two pure decisions over a settled wake + the drive context:
 *
 *   - decideWakeAction(classifier, decision) → "escalate" | "answer" | "wait":
 *     the three-way, in PRIORITY order. escalate-always already won INSIDE
 *     decideAutoAnswer (terminal-auto-answer.ts) — this fn only READS the verdict and
 *     NEVER re-derives the SEC-12 gate (I4/I8). A safe-pattern `answer` is silent; a
 *     `working`/low-confidence frame waits, never a synthesized outcome (I6).
 *
 *   - mapTerminalOutcome(i) → "done" | "needs-you" | "failed" | undefined, in this
 *     PRIORITY order (failure > escalation > done > the uninteresting middle):
 *       - i.failure set      → "failed"     (I9 — fires ONLY for a genuine death; a
 *                                            healthy long/quiet drive never sets failure)
 *       - i.escalation set   → "needs-you"  (an escalation IS a terminal outcome, I4)
 *       - exited | text|exit → "done"       (I6 — never on awaiting-input/working/stuck)
 *       - otherwise          → undefined    (the middle — no notification)
 *
 * These pin the FULL contract. The escalate-always GATE itself is NOT re-tested here —
 * that is terminal-auto-answer.test.ts's job (I8 — single source of the SEC-12 gate).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  decideWakeAction,
  mapTerminalOutcome,
  type OutcomeInputs,
} from "./terminal-drive-outcome.js";
import type { AutoAnswerDecision } from "./terminal-auto-answer.js";

// ---------------------------------------------------------------------------
// mapTerminalOutcome — done (I6: only a high-confidence exited / explicit match)
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — done fires only on exited / forText / forExit (I6)", () => {
  it("a clean PTY exit → done", () => {
    expect(mapTerminalOutcome({ classifier: "exited" })).toBe("done");
  });

  it("an explicit forText match (waitMatch:'text') → done", () => {
    expect(mapTerminalOutcome({ classifier: "working", waitMatch: "text" })).toBe("done");
  });

  it("an explicit forExit match (waitMatch:'exit') → done", () => {
    expect(mapTerminalOutcome({ classifier: "working", waitMatch: "exit" })).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// mapTerminalOutcome — the uninteresting middle → undefined (no notification, I6)
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — the middle is silent (undefined; never fabricate done, I6)", () => {
  it("awaiting-input with no match/escalation → undefined (never a synthesized done)", () => {
    expect(mapTerminalOutcome({ classifier: "awaiting-input" })).toBeUndefined();
  });

  it("maps a working frame to undefined (the silent middle)", () => {
    expect(mapTerminalOutcome({ classifier: "working" })).toBeUndefined();
  });

  it("stuck (no escalation, no failure) → undefined (I6 — never fabricate done)", () => {
    expect(mapTerminalOutcome({ classifier: "stuck" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapTerminalOutcome — needs-you (an escalation IS a terminal outcome, I4)
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — needs-you on an escalation (I4)", () => {
  it("an escalation on an awaiting-input frame → needs-you", () => {
    expect(
      mapTerminalOutcome({ classifier: "awaiting-input", escalation: "approval" }),
    ).toBe("needs-you");
  });

  it("maps an auth_login escalation to needs-you", () => {
    expect(
      mapTerminalOutcome({ classifier: "stuck", escalation: "auth_login" }),
    ).toBe("needs-you");
  });
});

// ---------------------------------------------------------------------------
// mapTerminalOutcome — failed ONLY on a genuine death (I9)
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — failed fires only on a genuine death (I9)", () => {
  it("an unrecoverable death → failed", () => {
    expect(
      mapTerminalOutcome({
        classifier: "working",
        failure: { kind: "unrecoverable", reason: "tmux_reattach_failed" },
      }),
    ).toBe("failed");
  });

  it("a NAMED cap-eviction → failed", () => {
    expect(
      mapTerminalOutcome({
        classifier: "working",
        failure: { kind: "cap", cap: "wall_clock" },
      }),
    ).toBe("failed");
  });

  it("a healthy long/quiet working drive (failure:undefined) → undefined — NEVER failed (I9 RED-pin)", () => {
    // The 40h long-compile case: no escalation, no exit, no failure → silence, not failed.
    expect(
      mapTerminalOutcome({ classifier: "working", failure: undefined }),
    ).toBeUndefined();
  });

  it("a healthy long/quiet STUCK-busy drive (failure:undefined) → undefined — NEVER failed (I9)", () => {
    expect(
      mapTerminalOutcome({ classifier: "stuck", failure: undefined }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapTerminalOutcome — the PRIORITY order: failure > escalation > done > undefined
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — priority order (failure > escalation > done > undefined)", () => {
  it("escalation + exited → needs-you (escalation outranks done)", () => {
    expect(
      mapTerminalOutcome({ classifier: "exited", escalation: "destructive" }),
    ).toBe("needs-you");
  });

  it("failure + escalation → failed (failure outranks escalation)", () => {
    expect(
      mapTerminalOutcome({
        classifier: "awaiting-input",
        escalation: "approval",
        failure: { kind: "unrecoverable", reason: "crash" },
      }),
    ).toBe("failed");
  });

  it("failure + exited → failed (failure outranks done)", () => {
    expect(
      mapTerminalOutcome({
        classifier: "exited",
        failure: { kind: "cap", cap: "max_interactions" },
      }),
    ).toBe("failed");
  });

  it("failure + escalation + exited + waitMatch → failed (failure wins over everything)", () => {
    expect(
      mapTerminalOutcome({
        classifier: "exited",
        waitMatch: "exit",
        escalation: "auth_login",
        failure: { kind: "unrecoverable", reason: "gone" },
      }),
    ).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// mapTerminalOutcome — TOTAL / never throws on a degenerate input
// ---------------------------------------------------------------------------

describe("mapTerminalOutcome — TOTAL (a degenerate input never throws)", () => {
  it("a degenerate {} input → undefined, never throws", () => {
    // Force a structurally-empty input past the type — the fn must be total.
    expect(() => mapTerminalOutcome({} as OutcomeInputs)).not.toThrow();
    expect(mapTerminalOutcome({} as OutcomeInputs)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decideWakeAction — the three-way (escalate > answer > wait); reads, not derives (I4)
// ---------------------------------------------------------------------------

describe("decideWakeAction — escalate-any-reason → escalate (READS the verdict, I4)", () => {
  it("escalate:no_safe_match → escalate", () => {
    const d: AutoAnswerDecision = { action: "escalate", reason: "no_safe_match" };
    expect(decideWakeAction("awaiting-input", d)).toBe("escalate");
  });

  it("escalate:destructive → escalate", () => {
    const d: AutoAnswerDecision = { action: "escalate", reason: "destructive" };
    expect(decideWakeAction("awaiting-input", d)).toBe("escalate");
  });

  it("escalate:approval → escalate", () => {
    const d: AutoAnswerDecision = { action: "escalate", reason: "approval" };
    expect(decideWakeAction("stuck", d)).toBe("escalate");
  });

  it("escalate:auth_login → escalate (even on a working frame — escalate-always wins, I4)", () => {
    const d: AutoAnswerDecision = { action: "escalate", reason: "auth_login" };
    expect(decideWakeAction("working", d)).toBe("escalate");
  });
});

describe("decideWakeAction — answer → answer (silent); working/no-answer → wait (I6)", () => {
  it("returns answer for an answer verdict (silent)", () => {
    const d: AutoAnswerDecision = { action: "answer", keys: ["\r"], matchedPatternIndex: 0 };
    expect(decideWakeAction("awaiting-input", d)).toBe("answer");
  });

  it("a working classifier with a no_safe_match escalate is STILL escalate (the verdict wins)", () => {
    // decideWakeAction never overrides the verdict with the classifier — it reads the verdict.
    const d: AutoAnswerDecision = { action: "escalate", reason: "no_safe_match" };
    expect(decideWakeAction("working", d)).toBe("escalate");
  });

  it("never throws on any classifier/decision pair", () => {
    const a: AutoAnswerDecision = { action: "answer", keys: [], matchedPatternIndex: 3 };
    const e: AutoAnswerDecision = { action: "escalate", reason: "approval" };
    expect(() => decideWakeAction("exited", a)).not.toThrow();
    expect(() => decideWakeAction("exited", e)).not.toThrow();
  });
});
