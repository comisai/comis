// SPDX-License-Identifier: Apache-2.0
/**
 * The `default` activity theme (UX-01, Plan 75-01).
 *
 * Baseline status markers — the glyphs currently hardcoded downstream
 * (`✓ done` / `❌ {errorKind}` / `🤖 {agentId} subagent` / the running wrench).
 * Plan 75-05 redirects those downstream literals to read these markers so the
 * default rendering is byte-identical to today's behavior.
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";

/** Default theme: the canonical emoji status glyphs (today's hardcoded set). */
export const defaultTheme: ActivityTheme = {
  markers: {
    success: "✓",
    failure: "❌",
    subagent: "🤖",
    running: "🔧",
    // WS-E Phase 78 / SPEC-§9: surrogate-count separator (e.g. `reading config ×3`).
    // The default theme uses the multiplication sign U+00D7 — humane glyph.
    surrogateSeparator: "×",
  },
};
