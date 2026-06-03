// SPDX-License-Identifier: Apache-2.0
/**
 * The `terminal-minimal` activity theme.
 *
 * Terse, low-emoji markers built from plain Unicode symbols — distinct from
 * both `default` (no ❌/🤖/🔧 emoji) and `ascii` (uses symbols, not bracketed
 * tags). Only the `ascii` theme is required to be strictly emoji-free; this
 * theme MAY use a couple of Unicode glyphs (✓ ✗ ↳ …) that are not emoji
 * codepoints.
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";

/** Terminal-minimal theme: terse Unicode symbols, no emoji. */
export const terminalMinimalTheme: ActivityTheme = {
  markers: {
    success: "✓",
    failure: "✗",
    subagent: "↳",
    running: "…",
  },
};
