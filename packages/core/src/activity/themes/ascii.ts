// SPDX-License-Identifier: Apache-2.0
/**
 * The `ascii` activity theme.
 *
 * INVARIANT — "ASCII strips ALL emoji": every marker here is a bracketed
 * pure-ASCII tag with ZERO emoji (and zero non-ASCII) codepoints. The
 * `ascii theme markers contain zero emoji codepoints` test
 * asserts `not.toMatch(/\p{Extended_Pictographic}/u)` plus literal negative
 * checks for the default-theme glyphs — a future emoji edit here fails the
 * build. (This comment is intentionally glyph-free so the acceptance grep
 * over this file stays at zero.)
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";

/** ASCII theme: bracketed ASCII tags, provably emoji-free. */
export const asciiTheme: ActivityTheme = {
  markers: {
    success: "[OK]",
    failure: "[ERR]",
    subagent: "[SUB]",
    running: "[..]",
    // Lowercase Latin `x` so a coalesced surrogate
    // renders `reading config x3` instead of `×3` (the default U+00D7 fails the
    // strict ASCII-parity test in ascii-parity.test.ts).
    surrogateSeparator: "x",
  },
};
