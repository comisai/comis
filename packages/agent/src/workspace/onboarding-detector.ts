// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import {
  incrementOnboardingCount,
  safePath,
} from "@comis/core";

/**
 * Check if the workspace is in onboarding state.
 *
 * BOOTSTRAP.md content is the authoritative pending-state signal. The agent
 * clears it only after the staged setup is complete. Lifecycle timestamps and
 * a partially filled identity are observations, not alternate completion
 * signals, so neither can silently skip unfinished onboarding.
 */
export async function detectOnboardingState(workspaceDir: string): Promise<boolean> {
  try {
    const content = await fs.readFile(safePath(workspaceDir, "BOOTSTRAP.md"), "utf-8");
    if (!content.trim()) return false;
  } catch {
    return false;
  }

  // Diagnostic only. Onboarding is a user-paced conversation and must not be
  // abandoned merely because it needs more than a fixed number of messages.
  await incrementOnboardingCount(workspaceDir);
  return true;
}
