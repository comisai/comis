// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure auto-promotion predicate
 * (terminal-drive-promote.ts) — DRIVE-02, design §4 Phase B / §7.1.2.
 *
 * RED-first: `terminal-drive-promote.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN.
 *
 * `shouldPromoteDrive(result, mode)` is a PURE total predicate over the honest
 * settle signal: it answers "should this drive promote from the inline (attached)
 * path to the DRIVE-01 detached drive-owner?". The decision is keyed off the
 * wait-result's existing honest `isComplete:false,producing:true` signal (§7.1.2
 * LOCKED), NOT a wall-clock `promoteAfterMs` — that is the orthogonal
 * auto-background-middleware (Pitfall 1).
 *
 * The truth table pinned here:
 *   - mode:"auto"     + {isComplete:false, producing:true}  → true  (the honest signal)
 *   - mode:"auto"     + {isComplete:true,  producing:true}  → false (completed inline — I1)
 *   - mode:"auto"     + {isComplete:false, producing:false} → false (honest-but-idle)
 *   - mode:"auto"     + {isComplete:false, producing:?}     → false (no positive signal)
 *   - mode:"attached" + anything                            → false (never promote = today, I1)
 *   - mode:"detached" + anything                            → true  (promote at the first wait)
 *
 * The I1 case (a completed-inline wait → NO promotion) is the load-bearing one: it keeps
 * a quick `git status` short-drive byte-identical to today. The predicate only READS
 * `isComplete`/`producing` — it never fabricates `isComplete:true` (the I6 / `mapWaitReply`
 * never-coerce contract), so a wedged worker's honest not-complete settle is handled
 * truthfully (it does not spuriously suppress promotion).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { shouldPromoteDrive, resolveDriveMode } from "./terminal-drive-promote.js";

describe("shouldPromoteDrive (DRIVE-02 auto-promotion predicate)", () => {
  describe('mode:"auto" — keyed off the honest isComplete:false,producing:true signal', () => {
    it("promotes on the honest signal: not-complete but still producing", () => {
      expect(shouldPromoteDrive({ isComplete: false, producing: true }, "auto")).toBe(true);
    });

    it("does NOT promote when the wait completed inline (isComplete:true) — I1 short-drive byte-identical", () => {
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

  describe('mode:"attached" — never promote (= today, I1 explicit opt-out)', () => {
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

describe("resolveDriveMode (DELIVER-02 — a durable drive backgrounds; a pty one-shot stays inline)", () => {
  // Real-VPS 2026-06-16: a short DURABLE claude build whose agent did a single `idle` wait (claude
  // paused between bursts, never a `producing` timeout) under the default `auto` mode NEVER promoted
  // → the daemon backstop (promoted-only) didn't track it → DELIVER-01 delivered no completion.
  // A durable drive IS a long backgrounded drive, so absent an explicit mode it defaults to detached.
  it("an absent mode + durable → detached (the long backgrounded drive promotes at the first wait → tracked)", () => {
    expect(resolveDriveMode(undefined, true)).toBe("detached");
  });

  it("returns auto for an absent mode on a NON-durable (pty) drive — the quick-one-shot inline posture (I1, byte-identical)", () => {
    expect(resolveDriveMode(undefined, false)).toBe("auto");
  });

  it("an EXPLICIT operator mode ALWAYS wins over the durable default (no surprise override)", () => {
    expect(resolveDriveMode("auto", true)).toBe("auto");
    expect(resolveDriveMode("attached", true)).toBe("attached");
    expect(resolveDriveMode("detached", false)).toBe("detached");
  });
});
