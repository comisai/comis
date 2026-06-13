// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-execution turn-loop detector (FIX #2b).
 *
 * The detector bounds a runaway turn at the source: an identical idempotent
 * read is short-circuited to its cached result + a one-line steer; six
 * consecutive no-progress steps break the turn early (well before maxSteps);
 * a mutation is NEVER cached and invalidates the read cache; consecutive empty
 * turns are capped. Mutations short-circuited as a stale "success" would be a
 * tampering bug (T-hbe-03) — the allowlist is explicit and closed.
 */
import { describe, it, expect } from "vitest";

import { createTurnLoopDetector } from "./turn-loop-detector.js";

describe("createTurnLoopDetector", () => {
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

  // F-15 / forget-exec-loop (live 2026-06-12): a small model that loops on a
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

  it("does not break on repeated SUCCESSFUL mutations (no false trip)", () => {
    const detector = createTurnLoopDetector();
    for (let i = 0; i < 10; i++) detector.recordCall("write", { path: `/f${i}`, content: "x" }, { ok: true });
    expect(detector.shouldBreakLoop()).toBe(false);
  });
});
