// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the normalized region-scoped loop guard
 * (terminal-loop-guard.ts).
 *
 * `createLoopGuard({ nowMs, windowMs?, maxRepeats? })` is a pure-ish factory closing
 * over a CLOSURE-local `Map<sessionId, Array<{hash,ts}>>` (no module-global mutable
 * state) and an INJECTED `nowMs` reader (no wall-clock global anywhere in the module
 * under test). `observe(sessionId, promptRegion)` returns a typed
 * `{ repeat: boolean; reason?: "loop_detected" }` — it NEVER throws and NEVER sends;
 * the caller escalates on a repeat (`terminal:escalated`, reason
 * `loop_detected`) and the `maxInteractions` cap EVICTs independently (the guard
 * COMPOSES with the cap, it does not reimplement it).
 *
 * The load-bearing case is the NORMALIZED repeat: two prompts that differ
 * ONLY in a volatile region (a spinner glyph, a timestamp, an elapsed/progress
 * counter) hash to the SAME stable string and are detected as a repeat — so an
 * infinite auto-answer loop on a re-rendered prompt is caught even when the bytes are
 * not identical.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { createLoopGuard } from "./terminal-loop-guard.js";

const FIXED_NOW = 1_700_000_000_000;

describe("createLoopGuard — byte-identical repeat detection", () => {
  it("detects the same prompt region observed twice within the window", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });
    const prompt = "Overwrite file foo.txt? (y/n) ❯ ";

    // 1st observation primes the ring — not yet a repeat.
    expect(guard.observe("s1", prompt)).toEqual({ repeat: false });
    // 2nd identical observation → loop detected.
    expect(guard.observe("s1", prompt)).toEqual({ repeat: true, reason: "loop_detected" });
  });
});

describe("createLoopGuard — NORMALIZED repeat (the load-bearing case)", () => {
  it("detects a repeat when two prompts differ ONLY by a spinner glyph", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });
    // Same logical prompt, different braille spinner frame.
    const a = "⠋ Building project... Press enter to continue";
    const b = "⠙ Building project... Press enter to continue";

    expect(guard.observe("s1", a)).toEqual({ repeat: false });
    expect(guard.observe("s1", b)).toEqual({ repeat: true, reason: "loop_detected" });
  });

  it("detects a repeat when two prompts differ ONLY by a timestamp", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });
    const a = "[2026-06-03T12:00:01Z] Awaiting confirmation ❯ ";
    const b = "[2026-06-03T12:00:42Z] Awaiting confirmation ❯ ";

    expect(guard.observe("s1", a)).toEqual({ repeat: false });
    expect(guard.observe("s1", b)).toEqual({ repeat: true, reason: "loop_detected" });
  });

  it("detects a repeat when two prompts differ ONLY by an elapsed/progress counter", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });
    const a = "Installing (3s) 12% — waiting for input ❯ ";
    const b = "Installing (9s) 87% — waiting for input ❯ ";

    expect(guard.observe("s1", a)).toEqual({ repeat: false });
    expect(guard.observe("s1", b)).toEqual({ repeat: true, reason: "loop_detected" });
  });
});

describe("createLoopGuard — genuinely different prompts are not repeats", () => {
  it("does NOT flag two materially different prompts as a repeat", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });

    expect(guard.observe("s1", "Choose an option: [1] build [2] test ❯ ")).toEqual({ repeat: false });
    expect(guard.observe("s1", "Enter your project name ❯ ")).toEqual({ repeat: false });
    expect(guard.observe("s1", "Select a branch to deploy ❯ ")).toEqual({ repeat: false });
  });
});

describe("createLoopGuard — window/decay of stale hashes", () => {
  it("does not flag a repeat once the earlier hash falls outside the window", () => {
    let now = FIXED_NOW;
    const guard = createLoopGuard({ nowMs: () => now, windowMs: 1_000 });
    const prompt = "Continue with the upgrade? ❯ ";

    expect(guard.observe("s1", prompt)).toEqual({ repeat: false });

    // Advance PAST the window — the first hash decays out before the second observe.
    now += 1_500;
    expect(guard.observe("s1", prompt)).toEqual({ repeat: false });
  });
});

describe("createLoopGuard — per-session ring isolation", () => {
  it("tracks two session ids independently (closure-local Map keyed by session)", () => {
    const guard = createLoopGuard({ nowMs: () => FIXED_NOW });
    const prompt = "Apply changes? ❯ ";

    // s1 sees it twice → repeat on the 2nd; s2's first sighting is independent.
    expect(guard.observe("s1", prompt)).toEqual({ repeat: false });
    expect(guard.observe("s2", prompt)).toEqual({ repeat: false });
    expect(guard.observe("s1", prompt)).toEqual({ repeat: true, reason: "loop_detected" });
    // s2 has still only seen it once.
    expect(guard.observe("s2", prompt)).toEqual({ repeat: true, reason: "loop_detected" });
  });
});
