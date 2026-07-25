// SPDX-License-Identifier: Apache-2.0
/** Content-free repository-state monitoring adapter. */
import type { ClockPort, GitMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort } from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { envWithoutSystemdNotify } from "./exec-helpers.js";

const execFile = promisify(execFileCb);
const SOURCE_ID = "monitor_git_repositories";
const EXEC_TIMEOUT_MS = 10_000;

type RepoStatus =
  | { ok: true; uncommittedFiles: number; unpushedCommits: number }
  | { ok: false };

async function checkRepo(
  repoPath: string,
  checkRemote: boolean,
  signal: AbortSignal,
): Promise<RepoStatus> {
  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "status", "--porcelain"], {
      timeout: EXEC_TIMEOUT_MS,
      env: envWithoutSystemdNotify(),
      signal,
    });
    const uncommittedFiles = stdout.trim().split("\n").filter((line) => line.trim().length > 0).length;
    let unpushedCommits = 0;
    if (checkRemote && !signal.aborted) {
      try {
        const remote = await execFile("git", ["-C", repoPath, "rev-list", "--count", "HEAD...@{upstream}"], {
          timeout: EXEC_TIMEOUT_MS,
          env: envWithoutSystemdNotify(),
          signal,
        });
        unpushedCommits = Number.parseInt(remote.stdout.trim(), 10) || 0;
      } catch {
        if (signal.aborted) return { ok: false };
      }
    }
    return { ok: true, uncommittedFiles, unpushedCommits };
  } catch {
    return { ok: false };
  }
}

export function createGitWatcherSource(
  config: GitMonitorConfig,
  clock: ClockPort,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    async check(signal) {
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      const statuses: RepoStatus[] = [];
      for (const repository of config.repositories) {
        if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
        statuses.push(await checkRepo(repository, config.checkRemote, signal));
      }
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      const failures = statuses.filter((status) => !status.ok).length;
      if (failures > 0) return err({ code: "git_query_failed", errorKind: "dependency" });
      const successful = statuses.filter((status): status is Extract<RepoStatus, { ok: true }> => status.ok);
      const uncommittedFiles = successful.reduce((total, status) => total + status.uncommittedFiles, 0);
      const unpushedCommits = successful.reduce((total, status) => total + status.unpushedCommits, 0);
      const needsAttention = uncommittedFiles > 0 || unpushedCommits > 0;
      return ok({
        level: needsAttention ? "alert" : "ok",
        observedAtMs: clock.now(),
        code: needsAttention ? "git_attention_required" : "git_repositories_clean",
        counters: [
          { name: "repositories_checked", value: successful.length },
          { name: "repositories_failed", value: 0 },
          { name: "uncommitted_files", value: uncommittedFiles },
          { name: "unpushed_commits", value: unpushedCommits },
        ],
      });
    },
  };
}
