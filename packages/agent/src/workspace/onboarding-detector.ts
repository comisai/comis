// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import { safePath } from "@comis/core";
import { incrementOnboardingCount, isIdentityFilled, readWorkspaceState, writeWorkspaceState } from "./workspace-state.js";

/** Auto-complete onboarding after this many messages if identity is still unfilled. */
const MAX_ONBOARDING_MESSAGES = 3;

/**
 * Check if the workspace is in onboarding state.
 *
 * Returns true when BOOTSTRAP.md exists with non-empty content AND onboarding
 * has not been marked complete. Checks file content (not just existence) so
 * that an agent clearing the file mid-session correctly ends onboarding.
 *
 * Enforces an attempt cap: after {@link MAX_ONBOARDING_MESSAGES} messages
 * without identity completion, onboarding auto-completes so the agent
 * stops injecting BOOTSTRAP.md.
 */
export async function detectOnboardingState(workspaceDir: string): Promise<boolean> {
  const state = await readWorkspaceState(workspaceDir);
  if (state.onboardingCompletedAt) return false;

  try {
    const content = await fs.readFile(safePath(workspaceDir, "BOOTSTRAP.md"), "utf-8");
    if (!content.trim()) return false;
  } catch {
    return false;
  }

  // If IDENTITY.md is already filled (e.g., programmatic agent creation),
  // skip onboarding — the agent already has a real identity.
  const identityPath = safePath(workspaceDir, "IDENTITY.md");
  if (await isIdentityFilled(identityPath)) return false;

  // Cap: auto-complete onboarding after MAX_ONBOARDING_MESSAGES attempts
  const count = await incrementOnboardingCount(workspaceDir);
  if (count > MAX_ONBOARDING_MESSAGES) {
    await writeWorkspaceState(workspaceDir, { onboardingCompletedAt: Date.now() });
    return false;
  }
  return true;
}
