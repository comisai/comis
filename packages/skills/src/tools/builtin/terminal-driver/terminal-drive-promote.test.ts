// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure auto-promotion predicate
 * (terminal-drive-promote.ts).
 *
 * `shouldPromoteDrive(result, mode)` is a PURE total predicate over the honest
 * settle signal: it answers "should this drive promote from the inline (attached)
 * path to the detached drive-owner?". The decision is keyed off the
 * wait-result's existing honest `isComplete:false,producing:true` signal,
 * NOT a wall-clock `promoteAfterMs` — that is the orthogonal
 * auto-background-middleware.
 *
 * The truth table pinned here:
 *   - mode:"auto"     + {isComplete:false, producing:true}  → true  (the honest signal)
 *   - mode:"auto"     + {isComplete:true,  producing:true}  → false (completed inline)
 *   - mode:"auto"     + {isComplete:false, producing:false} → false (honest-but-idle)
 *   - mode:"auto"     + {isComplete:false, producing:?}     → false (no positive signal)
 *   - mode:"attached" + anything                            → false (never promote — inline-only)
 *   - mode:"detached" + anything                            → true  (promote at the first wait)
 *
 * The completed-inline case (→ NO promotion) is the load-bearing one: it keeps
 * a quick `git status` short-drive on the unchanged inline path. The predicate only READS
 * `isComplete`/`producing` — it never fabricates `isComplete:true` (the `mapWaitReply`
 * never-coerce contract), so a wedged worker's honest not-complete settle is handled
 * truthfully (it does not spuriously suppress promotion).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { shouldPromoteDrive, resolveDriveMode } from "./terminal-drive-promote.js";

describe("shouldPromoteDrive (the auto-promotion predicate)", () => {
  describe('mode:"auto" — keyed off the honest isComplete:false,producing:true signal', () => {
    it("promotes on the honest signal: not-complete but still producing", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "auto")).toBe(true);
    });

    it("does NOT promote when the wait completed inline (isComplete:true) — the short-drive stays inline", () => {
      // The git-status one-shot: it finished within the settle budget, so it must stay
      // inline (no detached context, no journal, no notification). A `producing:true`
      // alongside `isComplete:true` must NOT override the completion.
      expect(shouldPromoteDrive({ isComplete: true, producing: true }, "auto")).toBe(false);
    });

    it("does NOT promote when honest-but-not-producing (idle/inspect, not yet a long drive)", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: false }, "auto")).toBe(false);
    });

    it("does NOT promote with no positive producing signal (producing undefined)", () => {
      // Absent `producing` (e.g. the complete reasons never carry it) is not a promotion
      // trigger — only an explicit `producing:true` is.
      expect(shouldPromoteDrive({ isComplete: false }, "auto")).toBe(false);
    });

    it("does NOT promote when complete with producing undefined", () => {
      expect(shouldPromoteDrive({ isComplete: true }, "auto")).toBe(false);
    });
  });

  describe('mode:"attached" — never promote (the inline-only explicit opt-out)', () => {
    it("does NOT promote even on the honest producing signal", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "attached")).toBe(false);
    });

    it("does NOT promote when not-producing", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: false }, "attached")).toBe(false);
    });

    it("does NOT promote when complete", () => {
      expect(shouldPromoteDrive({ isComplete: true, producing: true }, "attached")).toBe(false);
    });
  });

  describe('mode:"detached" — promote at the first wait regardless of the result', () => {
    it("promotes on a not-complete producing wait", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "detached")).toBe(true);
    });

    it("promotes even on a completed-inline wait (explicit opt-in)", () => {
      expect(shouldPromoteDrive({ isComplete: true, producing: true }, "detached")).toBe(true);
    });

    it("promotes even when not-complete and not-producing", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: false }, "detached")).toBe(true);
    });
  });

  describe("everTasked gate (loop-closure) — a drive that was NEVER tasked must not background", () => {
    // Observed live: a DURABLE drive resolves to `detached`, so it promotes at
    // the FIRST wait — even the initial gate/idle wait BEFORE the agent delivered any task (no
    // send_text since create). Backgrounding a work-less drive hands an idle terminal back to an
    // absent human and (worse) persists a wake-state that RESURRECTS on the next boot. An un-tasked
    // drive has no work to track, so it must stay inline; the NEXT wait — after the task lands —
    // promotes normally. The gate defaults on (everTasked=true) so every existing caller is unchanged.
    it('does NOT promote a never-tasked "detached" drive (the loop-closure gate)', () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "detached", false)).toBe(false);
      expect(shouldPromoteDrive({ isComplete: false, producing: false }, "detached", false)).toBe(false);
      expect(shouldPromoteDrive({ isComplete: true, producing: true }, "detached", false)).toBe(false);
    });

    it("promotes a TASKED detached drive (preserves the durable-tracking path once work is delivered)", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "detached", true)).toBe(true);
      expect(shouldPromoteDrive({ isComplete: true, producing: true }, "detached", true)).toBe(true);
    });

    it('"auto" is UNAFFECTED by everTasked — a producing wait promotes regardless (producing already implies work)', () => {
      // The everTasked gate is DETACHED-only (that is the promote-at-first-wait branch with the
      // loop-closure bug). `auto` promotes solely on the honest producing signal, which cannot occur
      // on an un-tasked idle drive — so it needs no separate gate and stays byte-identical.
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "auto", false)).toBe(true);
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "auto", true)).toBe(true);
      expect(shouldPromoteDrive({ isComplete: false, producing: false }, "auto", false)).toBe(false);
    });

    it("everTasked defaults to true — every existing 2-arg caller/test stays byte-identical", () => {
      // Only the wait tool threads the real everTasked (from the registry handle); every other
      // caller relies on the default, so today's behavior is preserved for them verbatim.
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "detached")).toBe(true);
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "auto")).toBe(true);
    });
  });

  describe("purity / totality — side-effect-free, never throws, reads only isComplete/producing", () => {
    it("is referentially transparent: repeated calls with the same args return the same value", () => {
      const result = { isComplete: false, producing: true } as const;
      const first = shouldPromoteDrive(result, "auto");
      const second = shouldPromoteDrive(result, "auto");
      expect(first).toBe(second);
      expect(first).toBe(true);
    });

    it("does not mutate its result argument", () => {
      const result = { isComplete: false, producing: true };
      const snapshot = { ...result };
      shouldPromoteDrive(result, "auto");
      expect(result).toEqual(snapshot);
    });

    it("never throws across every mode", () => {
      const result = { isComplete: false, producing: true } as const;
      expect(() => shouldPromoteDrive(result, "auto")).not.toThrow();
      expect(() => shouldPromoteDrive(result, "attached")).not.toThrow();
      expect(() => shouldPromoteDrive(result, "detached")).not.toThrow();
    });
  });
});

describe("resolveDriveMode — a durable drive backgrounds; a pty one-shot stays inline", () => {
  // Observed live: a short DURABLE claude build whose agent did a single `idle` wait (claude
  // paused between bursts, never a `producing` timeout) under the default `auto` mode NEVER promoted
  // → the daemon backstop (promoted-only) didn't track it → no completion was delivered.
  // A durable drive IS a long backgrounded drive, so absent an explicit mode it defaults to detached.
  it("an absent mode + durable → detached (the long backgrounded drive promotes at the first wait → tracked)", () => {
    expect(resolveDriveMode(undefined, true)).toBe("detached");
  });

  it("returns auto for an absent mode on a NON-durable (pty) drive — the quick-one-shot inline posture", () => {
    expect(resolveDriveMode(undefined, false)).toBe("auto");
  });

  it("an EXPLICIT operator mode ALWAYS wins over the durable default (no surprise override)", () => {
    expect(resolveDriveMode("auto", true)).toBe("auto");
    expect(resolveDriveMode("attached", true)).toBe("attached");
    expect(resolveDriveMode("detached", false)).toBe("detached");
  });
});
