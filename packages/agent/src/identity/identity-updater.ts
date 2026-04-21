// SPDX-License-Identifier: Apache-2.0
import { safePath, PathTraversalError } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as util from "node:util";

const execFile = util.promisify(childProcess.execFile);

/**
 * Valid identity file types that can be updated.
 */
export type IdentityFileType = "soul" | "identity" | "user";

/**
 * A proposed update to an identity file, awaiting user approval.
 */
export interface PendingUpdate {
  fileType: IdentityFileType;
  currentContent: string | undefined;
  proposedContent: string;
  reason: string;
  proposedAt: number;
}

/**
 * Interface for proposing and applying identity file updates
 * with git version control.
 */
export interface IdentityUpdater {
  propose(fileType: IdentityFileType, content: string, reason: string): Promise<PendingUpdate>;
  getPending(): PendingUpdate[];
  approve(fileType: IdentityFileType): Promise<Result<void, Error>>;
  reject(fileType: IdentityFileType): void;
  clearPending(): void;
}

/** Maps identity file type to the on-disk filename. */
const FILE_TYPE_TO_NAME: Record<IdentityFileType, string> = {
  soul: "SOUL.md",
  identity: "IDENTITY.md",
  user: "USER.md",
};

/**
 * Create an identity updater bound to a workspace directory.
 *
 * The updater allows the agent to propose changes to identity files.
 * Proposals are stored in memory until approved or rejected.
 * Approved changes are written to disk and committed to git.
 *
 * @param workspaceDir - Absolute path to the agent workspace directory
 * @returns IdentityUpdater instance
 */
export function createIdentityUpdater(workspaceDir: string): IdentityUpdater {
  const pending = new Map<IdentityFileType, PendingUpdate>();

  return {
    async propose(
      fileType: IdentityFileType,
      content: string,
      reason: string,
    ): Promise<PendingUpdate> {
      // Read current file content directly for diff context
      const fileName = FILE_TYPE_TO_NAME[fileType];
      let currentContent: string | undefined;
      try {
        const filePath = safePath(workspaceDir, fileName);
        currentContent = await fs.readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist or path traversal -- currentContent stays undefined
      }

      const update: PendingUpdate = {
        fileType,
        currentContent,
        proposedContent: content,
        reason,
        proposedAt: Date.now(),
      };

      // Replace any existing pending update for this fileType
      pending.set(fileType, update);
      return update;
    },

    getPending(): PendingUpdate[] {
      return Array.from(pending.values());
    },

    async approve(fileType: IdentityFileType): Promise<Result<void, Error>> {
      const update = pending.get(fileType);
      if (!update) {
        return err(new Error(`No pending update for file type: ${fileType}`));
      }

      const fileName = FILE_TYPE_TO_NAME[fileType];

      // Validate path with safePath to prevent writing outside workspace
      let filePath: string;
      try {
        filePath = safePath(workspaceDir, fileName);
      } catch (error) {
        if (error instanceof PathTraversalError) {
          return err(new Error(`Path traversal blocked for ${fileName}: ${error.message}`));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }

      try {
        // Write proposed content to disk
        await fs.writeFile(filePath, update.proposedContent, "utf-8");

        // Initialize git repo if not already present
        try {
          await fs.access(`${workspaceDir}/.git`);
        } catch {
          await execFile("git", ["init"], { cwd: workspaceDir });
        }

        // Ensure git user config exists (required for commits in managed identity repos)
        await execFile("git", ["config", "user.name", "comis-agent"], { cwd: workspaceDir });
        await execFile("git", ["config", "user.email", "agent@comis.dev"], { cwd: workspaceDir });

        // Stage the file
        await execFile("git", ["add", fileName], { cwd: workspaceDir });

        // Commit with descriptive message using execFile (no shell injection)
        const commitMessage = `identity: update ${fileName} - ${update.reason}`;
        await execFile("git", ["commit", "-m", commitMessage], {
          cwd: workspaceDir,
        });

        // Remove from pending after successful commit
        pending.delete(fileType);

        return ok(undefined);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    reject(fileType: IdentityFileType): void {
      pending.delete(fileType);
    },

    clearPending(): void {
      pending.clear();
    },
  };
}
