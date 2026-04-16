/**
 * Production ExecGitFn factory wrapping child_process.execFile.
 * Returns an ExecGitFn that runs git commands with a 10-second timeout
 * and returns Result<string, string> — never throws.
 * Follows the same child_process pattern used in
 * packages/daemon/src/monitoring/git-watcher-source.ts.
 * @module
 */

import type { ExecGitFn } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const EXEC_TIMEOUT_MS = 10_000;

/**
 * Create a production ExecGitFn wrapping child_process.execFile.
 * Git failures are returned as err() Results — never thrown.
 */
export function createExecGit(): ExecGitFn {
  return async (args: string[], cwd: string): Promise<Result<string, string>> => {
    try {
      const { stdout } = await execFile("git", args, { cwd, timeout: EXEC_TIMEOUT_MS });
      return ok(stdout.trimEnd());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  };
}
