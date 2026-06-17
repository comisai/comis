// SPDX-License-Identifier: Apache-2.0
/**
 * The `claude-code` platform profile (Layer 2) — paired with
 * `packages/daemon/bundled-skills/claude-code/SKILL.md` by the shared `id` + `platformVersion`.
 *
 * Phase 167 scaffold (this slice): identity only. The render transform (the FINDING-3 ghost-strip,
 * RENDER-01) is added in 167-02; perception (Phase 168) and dialogs (Phase 169) in later phases.
 *
 * @module
 */

import type { TerminalPlatformProfile } from "../terminal-platform-profile.js";

/**
 * The `claude-code` profile. `allowIds` claims the documented operator id (`claude`, per
 * `docs/agent-tools/terminal-driver.mdx`) + the `claude-code` alias. `platformVersion` MUST track
 * the bundled SKILL.md `version` (drift-guarded by the architecture test).
 */
export const claudeCodeProfile: TerminalPlatformProfile = {
  id: "claude-code",
  allowIds: ["claude", "claude-code"],
  platformVersion: "1.1.3",
};
