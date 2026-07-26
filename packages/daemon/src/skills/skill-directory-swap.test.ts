// SPDX-License-Identifier: Apache-2.0
/** Transactional live-directory replacement for confirmed skill re-imports. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkillDirectory } from "./skill-directory-swap.js";

describe("installSkillDirectory", () => {
  let root: string;
  let skillsBaseDir: string;
  let skillDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-directory-swap-"));
    skillsBaseDir = join(root, "skills");
    skillDir = join(skillsBaseDir, "summarize");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "old");
    writeFileSync(join(skillDir, "old-only.md"), "stale");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("atomically replaces the directory and removes stale members on finalize", () => {
    const installed = installSkillDirectory({
      skillsBaseDir,
      skillDir,
      files: [
        { path: "SKILL.md", content: "new" },
        { path: "references/guide.md", content: "guide" },
      ],
    });

    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("new");
    expect(() => readFileSync(join(skillDir, "old-only.md"))).toThrow();
    expect(installed.value.finalize().ok).toBe(true);
  });

  it("restores the complete incumbent directory when post-install work fails", () => {
    const installed = installSkillDirectory({
      skillsBaseDir,
      skillDir,
      files: [{ path: "SKILL.md", content: "new" }],
    });

    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.rollback().ok).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("old");
    expect(readFileSync(join(skillDir, "old-only.md"), "utf-8")).toBe("stale");
  });
});
