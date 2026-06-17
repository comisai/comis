// SPDX-License-Identifier: Apache-2.0
/**
 * The `codex` platform profile (Layer 2) — paired with
 * `packages/daemon/bundled-skills/codex/SKILL.md` by the shared `id` + `platformVersion`.
 *
 * Phase 167 (scaffold): no render transform (Codex has no ghost-strip). Perception (Phase 168)
 * and dialogs (Phase 169 — the approval overlay) are added in later phases.
 *
 * @module
 */

import type { TerminalPlatformProfile } from "../terminal-platform-profile.js";

/**
 * The `codex` profile. `allowIds` claims the conventional operator id (`codex`, matching the
 * bundled skill name). `platformVersion` MUST track the bundled SKILL.md `version` (drift-guarded
 * by the architecture test).
 */
export const codexProfile: TerminalPlatformProfile = {
  id: "codex",
  allowIds: ["codex"],
  platformVersion: "1.1.1",
  // CLASSIFY-01 (Phase 168): Codex perception signatures the classifier consumes (layered on the
  // generic structural detection). All anchored + ReDoS-safe (the registry guard enforces at load).
  perception: {
    // The Codex composer caret.
    promptAffordance: [/(?:^|\s)›\s/u],
    // The canonical Codex working line `Working (Ns)`, the working banner, and the ascii spinner —
    // a settled-but-unparked frame showing one of these is mid-work, not a hang (the Codex case).
    workingLine: [/Working \(\d+s\)/u, /Working on your request/iu, /[|/\\-]\s+thinking\b/iu],
    // A Codex selection menu (approval/sandbox/model). Boxed Codex menus are also caught generically.
    menuOrPicker: [/Select\s+(?:approval|sandbox|model)\b/iu],
    // The composer-return banner after a turn completes.
    turnEnd: [/(?:^|\s)›\s*$/u],
  },
};
