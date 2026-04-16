import { describe, it, expect } from "vitest";
import { createExecGit } from "./exec-git.js";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

describe("createExecGit", () => {
  it("returns ok with stdout for successful git commands", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "exec-git-test-"));
    try {
      const execGit = createExecGit();
      const initResult = await execGit(["init"], dir);
      expect(initResult.ok).toBe(true);

      const statusResult = await execGit(["status", "--porcelain"], dir);
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(typeof statusResult.value).toBe("string");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns err for invalid git commands", async () => {
    const execGit = createExecGit();
    const result = await execGit(["not-a-real-command"], "/tmp");
    expect(result.ok).toBe(false);
  });

  it("returns err for non-existent working directory", async () => {
    const execGit = createExecGit();
    const result = await execGit(["status"], "/nonexistent/path/that/does/not/exist");
    expect(result.ok).toBe(false);
  });

  it("trims trailing newlines from stdout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "exec-git-trim-"));
    try {
      const execGit = createExecGit();
      await execGit(["init"], dir);
      const result = await execGit(["rev-parse", "--git-dir"], dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // git rev-parse --git-dir returns ".git\n" — our wrapper should trim it
        expect(result.value).toBe(".git");
        expect(result.value.endsWith("\n")).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
