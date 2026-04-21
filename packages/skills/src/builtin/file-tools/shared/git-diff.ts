// SPDX-License-Identifier: Apache-2.0
/**
 * Non-blocking git diff --stat for a single file.
 * Returns null on any failure (not in repo, untracked, timeout, etc.).
 *
 * @module
 */

import { execFile } from "node:child_process";

const GIT_DIFF_TIMEOUT_MS = 500;

/**
 * Get `git diff --stat` output for a single file.
 *
 * Returns the stat summary string (e.g., "file.ts | 5 ++---") when the
 * file is tracked and has unstaged changes, or null when:
 * - The file is untracked
 * - The path is not inside a git repo
 * - The git command times out (>500ms)
 * - Any other error occurs
 *
 * @param filePath - Absolute or relative path to the file
 * @param cwd - Working directory for the git command
 */
export function getGitDiffStat(filePath: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["diff", "--stat", "--", filePath],
      { cwd, timeout: GIT_DIFF_TIMEOUT_MS },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.on("error", () => resolve(null));
  });
}
