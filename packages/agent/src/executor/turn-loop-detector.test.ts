// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-execution turn-loop detector.
 *
 * The detector bounds a runaway turn at the source: an identical idempotent
 * read is short-circuited to its cached result + a one-line steer; six
 * consecutive no-progress steps break the turn early (well before maxSteps);
 * a mutation is NEVER cached and invalidates the read cache; consecutive empty
 * turns are capped. Mutations short-circuited as a stale "success" would be a
 * tampering bug — the allowlist is explicit and closed.
 */
import { describe, it, expect } from "vitest";

import { createTurnLoopDetector } from "./turn-loop-detector.js";

describe("createTurnLoopDetector", () => {
  it("reports bounded content-free evidence for an identical successful-call loop", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 7; i++) {
      detector.recordCall(
        "mcp__records--list_current",
        { page_number: 1, page_size: 10 },
        { content: "same-result", isError: false },
      );
    }

    const evidence = (
      detector as unknown as {
        getLoopEvidence(): {
          lastNoProgressKind: string;
          repeatedToolName: string;
          consecutiveNoProgress: number;
          threshold: number;
          duplicateCallCount: number;
          stagnantResultCount: number;
        };
      }
    ).getLoopEvidence();

    expect(evidence).toEqual({
      lastNoProgressKind: "identical_success",
      repeatedToolName: "mcp__records--list_current",
      consecutiveNoProgress: 6,
      threshold: 6,
      duplicateCallCount: 6,
      stagnantResultCount: 6,
    });
    expect(JSON.stringify(evidence)).not.toContain("page_number");
    expect(JSON.stringify(evidence)).not.toContain("same-result");
  });

  it("short-circuits an identical idempotent read to the cached result with a one-line steer", () => {
    const detector = createTurnLoopDetector();
    const result1 = { content: [{ type: "text", text: "file body" }] };
    detector.recordCall("read", { path: "/a" }, result1);

    const verdict = detector.beforeCall("read", { path: "/a" });
    expect(verdict.kind).toBe("short_circuit");
    if (verdict.kind !== "short_circuit") throw new Error("expected short_circuit");
    expect(verdict.cachedResult).toBe(result1);
    expect(verdict.steer).toContain("read");
    expect(verdict.steer.length).toBeGreaterThan(0);
  });

  it("canonicalizes args so key order and whitespace do not defeat the dedupe", () => {
    const detector = createTurnLoopDetector();
    const r = { content: [{ type: "text", text: "x" }] };
    detector.recordCall("read", { a: 1, b: 2 }, r);

    const verdict = detector.beforeCall("read", { b: 2, a: 1 });
    expect(verdict.kind).toBe("short_circuit");
  });

  it("never caches or short-circuits a mutation tool even after an identical prior call", () => {
    const detector = createTurnLoopDetector();
    detector.recordCall("write", { path: "/a", content: "x" }, { ok: true });

    const verdict = detector.beforeCall("write", { path: "/a", content: "x" });
    expect(verdict.kind).toBe("allow");
  });

  it("breaks the loop after six consecutive no-progress steps", () => {
    const detector = createTurnLoopDetector();
    const r = { content: [{ type: "text", text: "x" }] };
    detector.recordCall("read", { path: "/a" }, r);
    expect(detector.shouldBreakLoop()).toBe(false);

    // Six repeat reads of the already-cached path are no-progress steps.
    for (let i = 0; i < 6; i++) {
      detector.beforeCall("read", { path: "/a" });
    }
    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("breaks before the step limit is reached (threshold well under a representative maxSteps)", () => {
    const detector = createTurnLoopDetector();
    const r = { content: [{ type: "text", text: "x" }] };
    detector.recordCall("read", { path: "/a" }, r);
    for (let i = 0; i < 6; i++) detector.beforeCall("read", { path: "/a" });
    // shouldBreakLoop fires at 6 no-progress steps — far under a maxSteps of 50.
    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("resets the no-progress counter when a genuinely new read signature appears", () => {
    const detector = createTurnLoopDetector();
    const r = { content: [{ type: "text", text: "x" }] };
    detector.recordCall("read", { path: "/a" }, r);
    for (let i = 0; i < 5; i++) detector.beforeCall("read", { path: "/a" });
    // A new distinct read is progress — resets the counter below the threshold.
    detector.recordCall("read", { path: "/b" }, r);
    expect(detector.shouldBreakLoop()).toBe(false);
  });

  it("invalidates the read cache when a mutation hits the same path between two reads", () => {
    const detector = createTurnLoopDetector();
    const r1 = { content: [{ type: "text", text: "before" }] };
    detector.recordCall("read", { path: "/a" }, r1);
    detector.recordCall("write", { path: "/a", content: "after" }, { ok: true });

    // The second read of the same path must really re-execute (cache cleared).
    const verdict = detector.beforeCall("read", { path: "/a" });
    expect(verdict.kind).toBe("allow");
  });

  it("caps consecutive empty turns at two and resets on a non-empty turn", () => {
    const detector = createTurnLoopDetector();
    detector.recordEmptyTurn();
    expect(detector.shouldBreakEmptyTurns()).toBe(false);
    detector.recordEmptyTurn();
    expect(detector.shouldBreakEmptyTurns()).toBe(true);

    detector.recordProgress();
    expect(detector.shouldBreakEmptyTurns()).toBe(false);
  });

  // Observed live: a small model that loops on a
  // FAILING/blocked mutation (e.g. exec repeatedly content-gate-rejected, varying
  // the command each time) used to clear the no-progress counter on every attempt
  // (mutations counted as "progress"), so the loop guard never fired and the turn
  // ran to makespan. A failed mutation makes NO progress and must count.
  it("breaks the loop after six consecutive FAILED mutations (isError), even with varying args", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 6; i++) {
      // different command each time (the model evades signature matching)
      detector.recordCall("exec", { command: `git step-${i}` }, { content: [], isError: true });
    }
    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("counts a content-gate-rejected mutation (marker, no isError flag) as no-progress", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 6; i++) {
      detector.recordCall("exec", { command: `c${i}` }, { content: [{ type: "text", text: "[invalid_value] Shell command substitution $(...) detected" }] });
    }
    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("a SUCCESSFUL mutation still resets the no-progress count (genuine progress preserved)", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 5; i++) detector.recordCall("exec", { command: `c${i}` }, { content: [], isError: true });
    detector.recordCall("exec", { command: "ok" }, { content: [{ type: "text", text: "done" }], isError: false });
    detector.recordCall("exec", { command: "next" }, { content: [], isError: true });
    expect(detector.shouldBreakLoop()).toBe(false); // counter restarted after the success
  });

  it("breaks the loop after six identical successful mutation results", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 7; i++) {
      detector.recordCall("exec", { command: "check-fixture" }, { content: "waiting", isError: false });
    }
    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("resets successful-repeat progress when the tool result changes", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 6; i++) {
      detector.recordCall("exec", { command: "check-fixture" }, { content: "waiting", isError: false });
    }
    expect(detector.shouldBreakLoop()).toBe(false);

    detector.recordCall("exec", { command: "check-fixture" }, { content: "flipped", isError: false });
    expect(detector.shouldBreakLoop()).toBe(false);
  });

  it("ignores a one-shot Comis tool guide when comparing successful results", () => {
    const detector = createTurnLoopDetector();
    detector.recordCall(
      "mcp__fixture--check_condition",
      {},
      {
        content: [
          { type: "text", text: "WAITING" },
          {
            type: "text",
            text: "\n---\n[Tool Guide - shown once per session]\nUse the fixture safely.\n---",
          },
        ],
        details: { success: true },
      },
    );
    for (let i = 0; i < 6; i++) {
      detector.recordCall(
        "mcp__fixture--check_condition",
        {},
        {
          content: [{ type: "text", text: "WAITING" }],
          details: { success: true },
        },
      );
    }

    expect(detector.shouldBreakLoop()).toBe(true);
  });

  it("does not break on distinct successful mutations", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 10; i++) {
      detector.recordCall("write", { path: `/f${i}`, content: "x" }, { ok: true });
    }
    expect(detector.shouldBreakLoop()).toBe(false);
  });
});
