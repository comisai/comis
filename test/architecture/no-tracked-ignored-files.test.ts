// SPDX-License-Identifier: Apache-2.0
/**
 * Invariant: no tracked file is excluded by `.gitignore`.
 *
 * `.gitignore` only stops UNTRACKED files from being added — a file that was
 * force-added (`git add -f`) or committed before its ignore rule existed stays
 * tracked forever and is invisible to a normal `git status`. That is exactly
 * how internal handoff docs (#135) and daemon-generated
 * `test/config/*.last-good.yaml` snapshots (#125) leaked into the repo.
 *
 * `git ls-files -i -c --exclude-standard` lists tracked-but-ignored files;
 * the set must be empty. To fix a failure: `git rm --cached <file>` (keeps the
 * local copy), then commit.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";

describe("no tracked-but-ignored files", () => {
  it("every tracked file is allowed by .gitignore (no force-added / pre-ignore leaks)", () => {
    const out = execFileSync(
      "git",
      ["ls-files", "-i", "-c", "--exclude-standard"],
      { encoding: "utf8" },
    ).trim();
    const trackedButIgnored = out ? out.split("\n") : [];
    expect(
      trackedButIgnored,
      `These files are tracked despite matching .gitignore — untrack with ` +
        `\`git rm --cached <file>\` (keeps the local copy):\n${out}`,
    ).toEqual([]);
  });
});
