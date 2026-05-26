// SPDX-License-Identifier: Apache-2.0
/**
 * The `playful` activity theme (UX-01, Plan 75-01).
 *
 * Rich-emoji markers — proves the four themes render the SAME event distinctly
 * (it differs from `default` in success/failure/running) and that the
 * distinction is real emoji, not just label text (its `success` is an emoji
 * codepoint, asserted in themes.test.ts).
 *
 * @module
 */
import type { ActivityTheme } from "../label-spec.js";

/** Playful theme: rich emoji status glyphs. */
export const playfulTheme: ActivityTheme = {
  markers: {
    success: "✅",
    failure: "💥",
    subagent: "🤖",
    running: "⚙️",
  },
};
