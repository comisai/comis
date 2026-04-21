// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace directory step -- step 08 of the init wizard.
 *
 * Collects the data directory path where agent memory, sessions,
 * and logs are stored. Shows available disk space via statfs in
 * human-readable format. Default path is ~/.comis/data.
 *
 * Disk space detection fails gracefully -- the wizard continues
 * even if statfs errors (e.g., path does not exist yet).
 *
 * @module
 */

import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import type { WizardState, WizardStep, WizardPrompter } from "../index.js";
import { updateState, sectionSeparator } from "../index.js";

// ---------- Helpers ----------

/**
 * Format bytes into human-readable string.
 *
 * Uses binary units (1 GB = 1024^3 bytes) to match
 * what users expect from disk space displays.
 */
function formatBytes(bytes: number): string {
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  if (bytes >= TB) return `${(bytes / TB).toFixed(1)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
  return `${bytes} bytes`;
}

// ---------- Step Implementation ----------

export const workspaceStep: WizardStep = {
  id: "workspace",
  label: "Workspace",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Workspace"));

    const defaultDir = `${homedir()}/.comis`;

    // 1. Detect disk space (best-effort, never blocks wizard)
    let diskSpaceInfo: string | undefined;

    try {
      // Use homedir as the statfs target since the default path may not exist yet
      const stats = await statfs(homedir());
      const availableBytes = stats.bavail * stats.bsize;
      diskSpaceInfo = formatBytes(availableBytes);
    } catch {
      // statfs failed -- skip disk space display
    }

    // 2. Show info messages
    prompter.log.info("Agent memory, sessions, and logs are stored here.");
    if (diskSpaceInfo) {
      prompter.log.info(`Disk space: ${diskSpaceInfo} available`);
    }

    // 3. Directory prompt
    const dirInput = await prompter.text({
      message: "Data directory",
      placeholder: state.dataDir ?? defaultDir,
      defaultValue: state.dataDir ?? defaultDir,
      required: true,
    });

    const selectedDir = dirInput.trim() || defaultDir;

    return updateState(state, { dataDir: selectedDir });
  },
};
