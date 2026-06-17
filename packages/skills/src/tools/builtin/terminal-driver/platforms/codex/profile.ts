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
};
