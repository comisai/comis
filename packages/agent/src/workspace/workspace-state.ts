// SPDX-License-Identifier: Apache-2.0
import { safePath } from "@comis/core";
import * as fs from "node:fs/promises";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATE_FILENAME = ".workspace-state.json";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const WorkspaceStateSchema = z.object({
  /** Schema version for forward compatibility. */
  version: z.literal(1).default(1),
  /** Epoch ms when BOOTSTRAP.md was first written by ensureWorkspace. */
  bootstrapSeededAt: z.number().optional(),
  /** Epoch ms when onboarding completion was first detected. */
  onboardingCompletedAt: z.number().optional(),
  /** Number of messages sent during onboarding (for attempt cap). */
  onboardingMessageCount: z.number().optional(),
});

export type WorkspaceState = z.output<typeof WorkspaceStateSchema>;

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read `.workspace-state.json` from a workspace directory.
 *
 * Returns safe defaults on ANY failure (missing file, corrupt JSON,
 * schema validation error). This function never throws.
 */
export async function readWorkspaceState(workspaceDir: string): Promise<WorkspaceState> {
  try {
    const statePath = safePath(workspaceDir, STATE_FILENAME);
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = WorkspaceStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    return { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/**
 * Merge updates into the workspace state file.
 *
 * Reads existing state (or defaults), merges the provided fields,
 * and writes back. Version is always pinned to 1.
 */
export async function writeWorkspaceState(
  workspaceDir: string,
  updates: Partial<Omit<WorkspaceState, "version">>,
): Promise<void> {
  const existing = await readWorkspaceState(workspaceDir);
  const merged = { ...existing, ...updates, version: 1 as const };
  const statePath = safePath(workspaceDir, STATE_FILENAME);
  await fs.writeFile(statePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Onboarding count
// ---------------------------------------------------------------------------

/**
 * Increment the onboarding message counter and return the new count.
 *
 * Reads the current state (defaulting to 0 if unset), increments by one,
 * persists the update, and returns the new count. Used by the onboarding
 * detector to enforce an attempt cap.
 */
export async function incrementOnboardingCount(workspaceDir: string): Promise<number> {
  const state = await readWorkspaceState(workspaceDir);
  const newCount = (state.onboardingMessageCount ?? 0) + 1;
  await writeWorkspaceState(workspaceDir, { onboardingMessageCount: newCount });
  return newCount;
}

// ---------------------------------------------------------------------------
// Identity detection
// ---------------------------------------------------------------------------

/**
 * Check whether IDENTITY.md has a filled-in Name field.
 *
 * Returns `true` when the Name field contains a real name (not a template
 * placeholder like `_(pick something you like)_`). Returns `false` on
 * any error, missing file, or placeholder content.
 */
export async function isIdentityFilled(identityPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(identityPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match "Name:", "**Name:**", "- **Name:**", etc.
      if (!/^\s*[-*]*\s*\*{0,2}Name:\*{0,2}/i.test(line)) continue;

      // Extract value after "Name:" on the same line
      const afterColon = line.replace(/^.*?Name:\*{0,2}\s*/i, "").trim();
      let value = afterColon;

      // If empty on this line, check the next non-empty line
      // (but stop if it's a new field, heading, or list item)
      if (!value) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next) continue;
          // New field/section: stop looking
          if (next.startsWith("-") || next.startsWith("#") || next.startsWith("**")) break;
          value = next;
          break;
        }
      }

      if (!value) return false;
      // Template placeholders start with _ or (
      if (value.startsWith("_") || value.startsWith("(")) return false;
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
