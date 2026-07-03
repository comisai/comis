// SPDX-License-Identifier: Apache-2.0
/**
 * The `default` activity theme.
 *
 * Baseline status markers
 * (`✓ done` / `❌ {errorKind}` / `🤖 {agentId} subagent` / the running wrench).
 * Downstream renderers read these markers instead of hardcoding glyphs, so a
 * theme can override them while the default rendering stays canonical.
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";

/** Default theme: the canonical emoji status glyphs. */
export const defaultTheme: ActivityTheme = {
  markers: {
    success: "✓",
    failure: "❌",
    subagent: "🤖",
    running: "🔧",
    // Surrogate-count separator (e.g. `reading config ×3`).
    // The default theme uses the multiplication sign U+00D7 — humane glyph.
    surrogateSeparator: "×",
  },
};
