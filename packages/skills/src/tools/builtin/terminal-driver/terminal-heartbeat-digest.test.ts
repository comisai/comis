// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure NOTIFY-02 heartbeat line
 * (terminal-heartbeat-digest.ts) — design §4 Phase D, CONTEXT I3.
 *
 * RED-first: `terminal-heartbeat-digest.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns them
 * GREEN. (Mirrors terminal-spend-ceiling.test.ts:1-9 — the "module does not exist on
 * first commit" banner.)
 *
 * `heartbeatLine(j)` assembles the content-free NOTIFY-02 one-liner PURELY from the
 * DriveJournal's counts/durations + the (already-redacted) `lastScreenDigest`:
 * `"still working — elapsed Xh, last activity <digest>, N interactions, ~$Y"`.
 *
 *   - a populated journal → contains "still working", the interactions count, the elapsed hours.
 *   - an empty lastScreenDigest → "(no activity yet)".
 *   - a degenerate journal (NaN/negative/Infinity elapsedMs/interactions/costUsd) → a SAFE
 *     "0"-ish string; never throws (TOTAL).
 *   - content-free (I3): the ONLY screen-derived text in the output is the passed
 *     `lastScreenDigest`, VERBATIM — never re-expanded (a sentinel-digest assertion).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { heartbeatLine } from "./terminal-heartbeat-digest.js";

describe("heartbeatLine — a populated journal yields the content-free one-liner", () => {
  it("contains 'still working', the interactions count, and the elapsed hours", () => {
    const line = heartbeatLine({
      elapsedMs: 2 * 3_600_000, // 2.0h
      lastScreenDigest: "80r 24c, 3 changed, cursor@(0,5) | building…",
      interactions: 42,
      costUsd: 1.5,
    });
    expect(line).toContain("still working");
    expect(line).toContain("42 interactions");
    expect(line).toContain("2.0h");
  });
});

describe("heartbeatLine — an empty digest reads '(no activity yet)'", () => {
  it("an empty lastScreenDigest → '(no activity yet)'", () => {
    const line = heartbeatLine({
      elapsedMs: 3_600_000,
      lastScreenDigest: "",
      interactions: 0,
      costUsd: 0,
    });
    expect(line).toContain("(no activity yet)");
  });
});

describe("heartbeatLine — TOTAL / safe-direction on a degenerate journal (never throws)", () => {
  it("a NaN elapsedMs → a safe '0'-ish hours, no throw", () => {
    let line = "";
    expect(() => {
      line = heartbeatLine({
        elapsedMs: Number.NaN,
        lastScreenDigest: "x",
        interactions: 1,
        costUsd: 0,
      });
    }).not.toThrow();
    expect(line).toContain("0h");
  });

  it("a NEGATIVE elapsedMs → a safe '0'-ish hours, no throw", () => {
    const line = heartbeatLine({
      elapsedMs: -5_000,
      lastScreenDigest: "x",
      interactions: 1,
      costUsd: 0,
    });
    expect(line).toContain("0h");
  });

  it("a NaN/Infinity interactions + costUsd → safe defaults, never throws", () => {
    let line = "";
    expect(() => {
      line = heartbeatLine({
        elapsedMs: 3_600_000,
        lastScreenDigest: "x",
        interactions: Number.NaN,
        costUsd: Number.POSITIVE_INFINITY,
      });
    }).not.toThrow();
    expect(line).toContain("0 interactions");
  });
});

describe("heartbeatLine — content-free (I3): the ONLY screen text is the passed digest, verbatim", () => {
  it("a sentinel lastScreenDigest appears UNCHANGED — nothing is re-expanded", () => {
    const sentinel = "SENTINEL_DIGEST_a1b2c3 — first non-empty line excerpt";
    const line = heartbeatLine({
      elapsedMs: 3_600_000,
      lastScreenDigest: sentinel,
      interactions: 7,
      costUsd: 0.25,
    });
    // The passed (already-redacted) digest is present verbatim …
    expect(line).toContain(sentinel);
    // … and removing it + the structural fields leaves NO other screen-derived text:
    // the remaining string is purely the structural template (counts/durations/labels).
    const withoutScreen = line.replace(sentinel, "");
    expect(withoutScreen).not.toContain("SENTINEL");
  });
});
