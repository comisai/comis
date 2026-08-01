// SPDX-License-Identifier: Apache-2.0
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

describe("pre-push hook repository isolation", () => {
  it("removes Git's repository-local environment before running validation", async () => {
    const fakeBinDir = await mkdtemp(resolve(tmpdir(), "comis-pre-push-hook-"));
    const fakePnpm = resolve(fakeBinDir, "pnpm");

    try {
      await writeFile(
        fakePnpm,
        [
          "#!/bin/sh",
          'if [ "${GIT_DIR+x}" = x ] || [ "${GIT_WORK_TREE+x}" = x ]; then',
          "  exit 9",
          "fi",
          '[ "$1" = "validate" ]',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakePnpm, 0o755);

      const { stdout } = await execFile("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: REPO_ROOT,
      });

      await expect(
        execFile("/bin/sh", [resolve(REPO_ROOT, ".githooks/pre-push")], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            GIT_DIR: stdout.trim(),
            GIT_WORK_TREE: REPO_ROOT,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          },
        }),
      ).resolves.toMatchObject({ stderr: "" });
    } finally {
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
