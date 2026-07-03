// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure bounded digest/diff read selector
 * (terminal-read-digest.ts).
 *
 * `boundedReadDigest(view, mode, byteCap)` is a PURE total selector over a
 * single already-rendered read view ({screen, diff?}): it answers "what bounded
 * text should the woken turn see this wake?" — the DEFAULT being a bounded digest
 * of the CURRENT rendered screen (NOT scrollback / the byte-stream), with a
 * `diff` mode that returns ONLY the changed rows (`firstChangedRow..lastChangedRow`
 * from the SHIPPED {@link diffSnapshot}, which the worker already attaches as
 * `view.diff`), and a `full` opt-in. Every mode passes through the byte cap so an
 * over-cap result is CLIPPED with a `truncations` breadcrumb — never a silent trim.
 * At 40h a drive is woken thousands of times; each read must stay cheap +
 * bounded.
 *
 * `screenDigestLine(view)` is the content-free one-liner the journal stores as
 * `lastScreenDigest`: counts/coords (`<rows>r <cols>c, <changed> changed,
 * cursor@(x,y)`) plus a SHORT excerpt — content-free BY CONSTRUCTION (it never
 * dumps the whole grid; the caller — the woken-turn driver — runs `scrubSecretsFromText` over the
 * excerpt before it reaches the journal/notification).
 *
 * The behavior pinned here (the selector table):
 *   - digest, under cap          → screen verbatim, truncated:false
 *   - digest, over READ_DIGEST_BYTE_CAP → clipped to cap, truncated:true,
 *                                  truncations === original.length − cap > 0
 *   - diff {changed:true, 2..4}  → ONLY rows 2..4 of a 10-row screen (not the grid)
 *   - diff {changed:false, -1,-1}→ empty/no-change result, truncated:false
 *   - diff, view.diff undefined  → falls back to the digest (defensive, never throws)
 *   - full                       → screen as-is, still byte-capped (bounded)
 *   - screenDigestLine           → counts/coords + short excerpt, NEVER the whole grid
 *   - totality                   → every mode side-effect-free + never throws on {screen:""}
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import type { SnapshotDiff } from "./terminal-render.js";
import {
  boundedReadDigest,
  screenDigestLine,
  READ_DIGEST_BYTE_CAP,
  type DriveReadMode,
} from "./terminal-read-digest.js";

/** Build a deterministic `"row0\nrow1\n…"` screen of `n` rows. */
function rows(n: number): string {
  return Array.from({ length: n }, (_, i) => `row${i}`).join("\n");
}

/** A `SnapshotDiff` literal — the diff is an INPUT (the worker attaches it), so no live emulator is needed. */
function diff(firstChangedRow: number, lastChangedRow: number): SnapshotDiff {
  return { changed: firstChangedRow !== -1, firstChangedRow, lastChangedRow };
}

describe("boundedReadDigest — digest mode (the default bounded current-screen read)", () => {
  it("returns the current screen verbatim when under the byte cap, truncated:false", () => {
    const screen = rows(5);
    const out = boundedReadDigest({ screen }, "digest", READ_DIGEST_BYTE_CAP);

    expect(out.mode).toBe("digest");
    expect(out.screen).toBe(screen);
    expect(out.truncated).toBe(false);
    expect(out.truncations).toBeUndefined();
  });

  it("defaults the byteCap to READ_DIGEST_BYTE_CAP when omitted", () => {
    const screen = rows(5);
    // The cap arg is optional — a sub-cap screen comes back verbatim.
    const out = boundedReadDigest({ screen }, "digest");
    expect(out.screen).toBe(screen);
    expect(out.truncated).toBe(false);
  });

  it("clips an over-cap screen + sets a truncations breadcrumb — never a silent trim", () => {
    const cap = 64;
    const screen = "x".repeat(cap + 40); // 40 bytes over the cap
    const out = boundedReadDigest({ screen }, "digest", cap);

    expect(out.truncated).toBe(true);
    expect(out.screen.length).toBeLessThanOrEqual(cap);
    // The breadcrumb is the EXPLICIT count of dropped bytes — the anti-silent-trim guarantee.
    expect(out.truncations).toBe(screen.length - cap);
    expect(out.truncations).toBeGreaterThan(0);
  });
});

describe("boundedReadDigest — diff mode (only the changed rows, reusing view.diff)", () => {
  it("returns ONLY rows firstChangedRow..lastChangedRow, not the whole grid", () => {
    const screen = rows(10); // row0..row9
    const out = boundedReadDigest({ screen, diff: diff(2, 4) }, "diff", READ_DIGEST_BYTE_CAP);

    expect(out.mode).toBe("diff");
    // Exactly rows 2..4 (inclusive) — a contiguous slice of the changed range.
    expect(out.screen).toBe("row2\nrow3\nrow4");
    // It must NOT contain the unchanged rows above/below the changed range.
    expect(out.screen).not.toContain("row0");
    expect(out.screen).not.toContain("row1");
    expect(out.screen).not.toContain("row5");
    expect(out.truncated).toBe(false);
  });

  it("returns an empty/no-change result when the diff reports changed:false", () => {
    const screen = rows(10);
    const out = boundedReadDigest({ screen, diff: diff(-1, -1) }, "diff", READ_DIGEST_BYTE_CAP);

    expect(out.mode).toBe("diff");
    expect(out.screen).toBe("");
    expect(out.truncated).toBe(false);
    expect(out.truncations).toBeUndefined();
  });

  it("falls back to the digest of the current screen when view.diff is undefined (defensive)", () => {
    const screen = rows(6);
    // No diff attached (e.g. the emulator-absent fallback) — diff mode must not throw,
    // it degrades to the bounded current-screen digest.
    const out = boundedReadDigest({ screen }, "diff", READ_DIGEST_BYTE_CAP);

    expect(out.screen).toBe(screen);
    expect(out.truncated).toBe(false);
  });

  it("still applies the byte cap + breadcrumb to a large changed-row range", () => {
    const cap = 32;
    // A single very-long changed row > cap.
    const screen = "a".repeat(cap + 20);
    const out = boundedReadDigest({ screen, diff: diff(0, 0) }, "diff", cap);

    expect(out.truncated).toBe(true);
    expect(out.screen.length).toBeLessThanOrEqual(cap);
    expect(out.truncations).toBe(screen.length - cap);
  });
});

describe("boundedReadDigest — full mode (opt-in for diagnosis, still bounded)", () => {
  it("returns the screen as-is when under the cap", () => {
    const screen = rows(4);
    const out = boundedReadDigest({ screen }, "full", READ_DIGEST_BYTE_CAP);

    expect(out.mode).toBe("full");
    expect(out.screen).toBe(screen);
    expect(out.truncated).toBe(false);
  });

  it("STILL enforces the byte cap with a truncations breadcrumb — full is opt-in, never unbounded", () => {
    const cap = 50;
    const screen = "f".repeat(cap + 13);
    const out = boundedReadDigest({ screen }, "full", cap);

    expect(out.truncated).toBe(true);
    expect(out.screen.length).toBeLessThanOrEqual(cap);
    expect(out.truncations).toBe(screen.length - cap);
    expect(out.truncations).toBeGreaterThan(0);
  });
});

describe("screenDigestLine — the content-free one-line journal digest", () => {
  it("names rows/cols/changed-row-count/cursor as counts + coords", () => {
    const line = screenDigestLine({
      screen: rows(3),
      rows: 24,
      cols: 80,
      cursor: { x: 12, y: 4 },
      diff: diff(2, 4), // 3 changed rows (2,3,4)
    });

    expect(line).toContain("24r");
    expect(line).toContain("80c");
    expect(line).toContain("3 changed"); // lastChangedRow − firstChangedRow + 1 = 3
    expect(line).toContain("cursor@(12,4)");
  });

  it("does NOT dump the whole screen — only counts/coords + a SHORT excerpt", () => {
    // A screen with many distinct rows; the digest line must not contain them all.
    const screen = Array.from({ length: 40 }, (_, i) => `LINE_${i}_UNIQUE_TOKEN`).join("\n");
    const line = screenDigestLine({ screen, rows: 40, cols: 120, cursor: { x: 0, y: 0 } });

    // A short excerpt of the FIRST non-empty line may appear; the deep rows must NOT.
    expect(line).toContain("LINE_0");
    expect(line).not.toContain("LINE_39_UNIQUE_TOKEN");
    // And the whole line stays short (a one-liner, not a grid).
    expect(line.length).toBeLessThan(200);
  });

  it("uses 0 changed when no diff is present, and is single-line", () => {
    const line = screenDigestLine({ screen: rows(2), rows: 10, cols: 40, cursor: { x: 1, y: 1 } });
    expect(line).toContain("0 changed");
    expect(line).not.toContain("\n");
  });
});

describe("boundedReadDigest / screenDigestLine — totality (never throws on a degenerate view)", () => {
  const modes: DriveReadMode[] = ["digest", "diff", "full"];
  for (const mode of modes) {
    it(`mode:"${mode}" on an empty screen yields a safe bounded result, no throw`, () => {
      const out = boundedReadDigest({ screen: "" }, mode, READ_DIGEST_BYTE_CAP);
      expect(out.mode).toBe(mode);
      expect(typeof out.screen).toBe("string");
      expect(out.truncated).toBe(false);
    });
  }

  it("screenDigestLine on a {screen:''} view does not throw and returns a string", () => {
    const line = screenDigestLine({ screen: "" });
    expect(typeof line).toBe("string");
    expect(line).not.toContain("\n");
  });
});
