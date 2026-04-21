// SPDX-License-Identifier: Apache-2.0
import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIdentityUpdater,
  type IdentityUpdater,
  type IdentityFileType,
} from "./identity-updater.js";

const execFile = util.promisify(childProcess.execFile);

describe("identity-updater", () => {
  let workspaceDir: string;
  let updater: IdentityUpdater;

  beforeEach(async () => {
    workspaceDir = path.join(os.tmpdir(), `comis-test-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    updater = createIdentityUpdater(workspaceDir);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe("propose", () => {
    it("stores pending update and returns it", async () => {
      const update = await updater.propose(
        "soul",
        "I am thoughtful and curious.",
        "Refining personality traits",
      );

      expect(update.fileType).toBe("soul");
      expect(update.proposedContent).toBe("I am thoughtful and curious.");
      expect(update.reason).toBe("Refining personality traits");
      expect(update.currentContent).toBeUndefined(); // No existing file
      expect(update.proposedAt).toBeGreaterThan(0);
    });

    it("reads current content from disk when file exists", async () => {
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Original soul content.");

      const update = await updater.propose("soul", "Updated soul content.", "Evolving");

      expect(update.currentContent).toBe("Original soul content.");
      expect(update.proposedContent).toBe("Updated soul content.");
    });

    it("overwrites existing pending for same fileType", async () => {
      await updater.propose("soul", "First proposal", "Reason 1");
      await updater.propose("soul", "Second proposal", "Reason 2");

      const pending = updater.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].proposedContent).toBe("Second proposal");
      expect(pending[0].reason).toBe("Reason 2");
    });
  });

  describe("getPending", () => {
    it("returns all current pending updates", async () => {
      await updater.propose("soul", "Soul update", "Reason 1");
      await updater.propose("identity", "Identity update", "Reason 2");
      await updater.propose("user", "User update", "Reason 3");

      const pending = updater.getPending();
      expect(pending).toHaveLength(3);

      const types = pending.map((p) => p.fileType).sort();
      expect(types).toEqual(["identity", "soul", "user"]);
    });

    it("returns empty array when no pending updates", () => {
      const pending = updater.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe("approve", () => {
    it("writes file to disk with correct content", async () => {
      await updater.propose("soul", "New soul content.", "Testing");

      const result = await updater.approve("soul");

      expect(result.ok).toBe(true);
      const content = await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf-8");
      expect(content).toBe("New soul content.");
    });

    it("initializes git repo if not present", async () => {
      await updater.propose("identity", "I am Comis.", "Init identity");

      const result = await updater.approve("identity");

      expect(result.ok).toBe(true);
      // Verify .git directory was created
      const stat = await fs.stat(path.join(workspaceDir, ".git"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates a git commit with descriptive message", async () => {
      await updater.propose("user", "User likes TypeScript.", "Learned user preference");

      const result = await updater.approve("user");

      expect(result.ok).toBe(true);

      // Verify the git commit exists
      const { stdout } = await execFile("git", ["log", "--oneline", "-1"], {
        cwd: workspaceDir,
      });
      expect(stdout).toContain("identity: update USER.md - Learned user preference");
    });

    it("returns error for non-existent pending update", async () => {
      const result = await updater.approve("soul");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No pending update");
        expect(result.error.message).toContain("soul");
      }
    });

    it("removes pending update after successful approval", async () => {
      await updater.propose("soul", "Content", "Reason");

      await updater.approve("soul");

      const pending = updater.getPending();
      expect(pending).toHaveLength(0);
    });

    it("uses existing git repo if already initialized", async () => {
      // Pre-initialize git
      await execFile("git", ["init"], { cwd: workspaceDir });

      await updater.propose("soul", "Content", "Reason");
      const result = await updater.approve("soul");

      expect(result.ok).toBe(true);

      // Verify commit in the existing repo
      const { stdout } = await execFile("git", ["log", "--oneline"], {
        cwd: workspaceDir,
      });
      expect(stdout.trim().split("\n")).toHaveLength(1);
    });

    it("maps file types to correct filenames", async () => {
      const mappings: Array<{ type: IdentityFileType; file: string }> = [
        { type: "soul", file: "SOUL.md" },
        { type: "identity", file: "IDENTITY.md" },
        { type: "user", file: "USER.md" },
      ];

      for (const { type, file } of mappings) {
        // Create a fresh updater for each to avoid git issues
        const freshDir = path.join(os.tmpdir(), `comis-test-${randomUUID()}`);
        await fs.mkdir(freshDir, { recursive: true });
        const freshUpdater = createIdentityUpdater(freshDir);

        await freshUpdater.propose(type, `Content for ${type}`, "Testing");
        await freshUpdater.approve(type);

        const content = await fs.readFile(path.join(freshDir, file), "utf-8");
        expect(content).toBe(`Content for ${type}`);

        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("reject", () => {
    it("removes pending update", async () => {
      await updater.propose("soul", "Proposed content", "Reason");

      updater.reject("soul");

      const pending = updater.getPending();
      expect(pending).toHaveLength(0);
    });

    it("does not throw for non-existent pending", () => {
      // Should not throw
      updater.reject("soul");
    });
  });

  describe("clearPending", () => {
    it("removes all pending updates", async () => {
      await updater.propose("soul", "Soul", "R1");
      await updater.propose("identity", "Identity", "R2");
      await updater.propose("user", "User", "R3");

      updater.clearPending();

      const pending = updater.getPending();
      expect(pending).toHaveLength(0);
    });
  });
});
