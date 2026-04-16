/**
 * Git Watcher HeartbeatSourcePort implementation.
 * Monitors configured git repositories for uncommitted changes
 * and optionally unpushed commits. Aggregates alerts across
 * all repositories.
 * Git repository monitoring.
 */

import type { GitMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "@comis/scheduler";
import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SOURCE_ID = "monitor:git-watcher";
const SOURCE_NAME = "Git Repository Monitor";
const EXEC_TIMEOUT_MS = 10_000;

interface RepoStatus {
  path: string;
  uncommittedFiles: number;
  unpushedCommits: number;
  error?: string;
}

/**
 * Check a single git repository for uncommitted changes and unpushed commits.
 */
async function checkRepo(repoPath: string, checkRemote: boolean): Promise<RepoStatus> {
  try {
    // Check for uncommitted changes
    const { stdout: statusOutput } = await execFile(
      "git",
      ["-C", repoPath, "status", "--porcelain"],
      { timeout: EXEC_TIMEOUT_MS },
    );
    const uncommittedFiles = statusOutput
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    // Check for unpushed commits (if enabled)
    let unpushedCommits = 0;
    if (checkRemote) {
      try {
        const { stdout: revListOutput } = await execFile(
          "git",
          ["-C", repoPath, "rev-list", "--count", "HEAD...@{upstream}"],
          { timeout: EXEC_TIMEOUT_MS },
        );
        unpushedCommits = parseInt(revListOutput.trim(), 10) || 0;
      } catch {
        // No upstream configured or other error -- skip silently
      }
    }

    return { path: repoPath, uncommittedFiles, unpushedCommits };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: repoPath, uncommittedFiles: 0, unpushedCommits: 0, error: msg };
  }
}

/**
 * Create a git watcher heartbeat source.
 * Checks each configured repository for uncommitted changes
 * and optionally unpushed commits.
 */
export function createGitWatcherSource(config: GitMonitorConfig): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,

    async check(): Promise<HeartbeatCheckResult> {
      const now = Date.now();

      if (config.repositories.length === 0) {
        return {
          sourceId: SOURCE_ID,
          text: `${HEARTBEAT_OK_TOKEN} No git repositories configured`,
          timestamp: now,
          metadata: { repoCount: 0 },
        };
      }

      const statuses: RepoStatus[] = [];
      for (const repoPath of config.repositories) {
        statuses.push(await checkRepo(repoPath, config.checkRemote));
      }

      const errors = statuses.filter((s) => s.error);
      const dirty = statuses.filter((s) => !s.error && s.uncommittedFiles > 0);
      const unpushed = statuses.filter((s) => !s.error && s.unpushedCommits > 0);

      const alerts: string[] = [];

      if (errors.length > 0) {
        for (const e of errors) {
          alerts.push(`${e.path}: error - ${e.error}`);
        }
      }

      if (dirty.length > 0) {
        for (const d of dirty) {
          alerts.push(`${d.path}: ${d.uncommittedFiles} uncommitted file(s)`);
        }
      }

      if (unpushed.length > 0) {
        for (const u of unpushed) {
          alerts.push(`${u.path}: ${u.unpushedCommits} unpushed commit(s)`);
        }
      }

      if (alerts.length > 0) {
        return {
          sourceId: SOURCE_ID,
          text: `Git repos need attention: ${alerts.join("; ")}`,
          timestamp: now,
          metadata: { statuses },
        };
      }

      return {
        sourceId: SOURCE_ID,
        text: `${HEARTBEAT_OK_TOKEN} All ${config.repositories.length} git repos clean`,
        timestamp: now,
        metadata: { statuses },
      };
    },
  };
}
