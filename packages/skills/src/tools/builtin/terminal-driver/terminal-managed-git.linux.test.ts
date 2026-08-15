// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BwrapProvider } from "../sandbox/bwrap-provider.js";
import { buildSpawnPlan, DEDICATED_UID, resolveManagedWorkspaceGitMounts } from "./terminal-spawn-plan.js";
import { SYSTEM_RO_PATHS } from "./terminal-scope-args.js";

function canRunManagedGitJail(): boolean {
  return process.platform === "linux" && new BwrapProvider().available();
}

describe.skipIf(!canRunManagedGitJail())("managed linked-worktree Git jail", () => {
  it("commits with a dedicated uid without mutating shared Git administration", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-git-jail-"));
    try {
      chmodSync(root, 0o755);
      const repository = join(root, "repository");
      const workspace = join(root, "worktrees", "task-a");
      mkdirSync(repository, { recursive: true });
      execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
      execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      writeFileSync(join(repository, "tracked.txt"), "base\n", "utf8");
      execFileSync("git", ["-C", repository, "add", "tracked.txt"]);
      execFileSync("git", ["-C", repository, "-c", "commit.gpgsign=false", "commit", "-m", "base"], { stdio: "ignore" });
      execFileSync("git", ["-C", repository, "worktree", "add", "-b", "task-a", workspace], { stdio: "ignore" });
      chmodSync(workspace, 0o777);
      chmodSync(join(workspace, "tracked.txt"), 0o666);

      const commonDir = join(repository, ".git");
      const gitDir = join(commonDir, "worktrees", "task-a");
      const sharedRef = join(commonDir, "refs", "heads", "task-a");
      const sharedRefBefore = readFileSync(sharedRef, "utf8");
      const sharedConfigBefore = readFileSync(join(commonDir, "config"), "utf8");
      const sharedIndexBefore = readFileSync(join(gitDir, "index"));
      const siblingSentinel = join(commonDir, "worktrees", "sibling-sentinel");
      writeFileSync(siblingSentinel, "shared sibling state\n", "utf8");
      const hookPath = join(commonDir, "hooks", "pre-commit");
      writeFileSync(hookPath, `#!/bin/sh\ntouch ${join(workspace, "shared-hook-ran")}\n`, "utf8");
      chmodSync(hookPath, 0o755);
      const mounts = resolveManagedWorkspaceGitMounts(workspace);
      if (!mounts.ok || mounts.value === undefined) throw new Error("managed Git mounts unavailable");
      writeFileSync(join(workspace, "tracked.txt"), "isolated commit\n", "utf8");

      const plan = await buildSpawnPlan({
        scope: {
          filesystem: "workspace",
          network: "none",
          credentialPaths: [],
          ephemeralWritablePaths: [],
          uid: "dedicated",
        },
        bin: "/bin/sh",
        argv: [
          "-c",
          "git add tracked.txt && git -c user.name='Test User' -c user.email=test@example.com -c commit.gpgsign=false commit -m isolated && test -z \"$(git status --porcelain)\"",
        ],
        workspace,
        workspaceGitMounts: mounts.value,
        cwd: workspace,
        home: root,
        dataDir: join(root, ".comis"),
        systemRoPaths: SYSTEM_RO_PATHS.filter((path) => existsSync(path)),
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      }, {
        bwrapPath: execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim(),
      });
      const committed = spawnSync(plan.bin, plan.argv, {
        encoding: "utf8",
        env: plan.env,
        timeout: 30_000,
      });

      expect(committed.status, committed.stderr).toBe(0);
      expect(execFileSync("git", ["--git-dir", mounts.value.privateCommon.sourcePath, "rev-parse", "refs/heads/task-a"], { encoding: "utf8" }).trim()).not.toBe(sharedRefBefore.trim());
      expect(readFileSync(sharedRef, "utf8")).toBe(sharedRefBefore);
      expect(readFileSync(join(commonDir, "config"), "utf8")).toBe(sharedConfigBefore);
      expect(readFileSync(join(gitDir, "index"))).toEqual(sharedIndexBefore);
      expect(readFileSync(siblingSentinel, "utf8")).toBe("shared sibling state\n");
      expect(existsSync(join(workspace, "shared-hook-ran"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
