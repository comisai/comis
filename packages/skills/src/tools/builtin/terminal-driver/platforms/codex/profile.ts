// SPDX-License-Identifier: Apache-2.0
/**
 * The `codex` platform profile (Layer 2) — paired with
 * `packages/daemon/bundled-skills/codex/SKILL.md` by the shared `id` + `platformVersion`.
 *
 * No render transform (Codex has no ghost-strip); the profile carries perception
 * signatures and one dialog (the approval overlay).
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
  // Codex perception signatures the classifier consumes (layered on the generic structural
  // detection). All anchored + ReDoS-safe (the registry guard enforces at load).
  perception: {
    // The Codex composer caret.
    promptAffordance: [/(?:^|\s)›\s/u],
    // The canonical Codex working line `Working (Ns)`, the working banner, and the ascii spinner
    // (ANCHORED to line-start so a markdown bullet `- thinking` / table cell does not match) —
    // a settled-but-RECENT frame showing one of these is mid-work, not a hang.
    workingLine: [/Working \(\d+s\)/u, /Working on your request/iu, /^\s*[|/\\-]\s+thinking\b/iu],
    // A Codex selection menu (approval/sandbox/model). Boxed Codex menus are also caught generically.
    menuOrPicker: [/Select\s+(?:approval|sandbox|model)\b/iu],
    // The composer-return banner after a turn completes.
    turnEnd: [/(?:^|\s)›\s*$/u],
  },
  // Codex's approval overlay. Approving COMMAND EXECUTION is privilege-bearing,
  // so it is flagged `destructive` ⇒ ALWAYS escalates to a human (never auto-answered, even under mode
  // `all`) — an operator who wants unattended Codex uses Codex's own auto-approve flag, not the driver.
  // The safeAnswer is declared but moot (destructive wins); even a missed `detect` still escalates
  // (the boxed overlay → generic awaiting-input → no safeAnswer path → escalate).
  dialogs: [
    {
      name: "approval-overlay",
      detect: /\b(?:Approve|Allow)\b.{0,40}\b(?:command|run|execute|exec)\b/iu,
      safeAnswer: ["\r"],
      destructive: true,
    },
  ],
};
