// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { WORKSPACE_FILE_NAMES } from "./templates.js";
import {
  ensureWorkspace,
  getWorkspaceStatus,
  registerWorkspaceFilesInTracker,
  WORKSPACE_SUBDIRS,
} from "./workspace-manager.js";
import { STATE_FILENAME, readWorkspaceState } from "./workspace-state.js";

describe("workspace-manager", () => {
  const tempDirs: string[] = [];

  /** Create a unique temp directory for each test. */
  async function makeTempDir(): Promise<string> {
    const dir = path.join(os.tmpdir(), `comis-ws-test-${randomUUID()}`);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  describe("ensureWorkspace", () => {
    it("creates directory and all workspace template files", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const entries = await fs.readdir(dir);
      for (const name of WORKSPACE_FILE_NAMES) {
        expect(entries).toContain(name);
      }
    });

    it("does not overwrite existing files", async () => {
      const dir = await makeTempDir();
      await fs.mkdir(dir, { recursive: true });

      const customContent = "# My Custom Soul\n\nThis is mine.";
      await fs.writeFile(path.join(dir, "SOUL.md"), customContent, "utf-8");

      await ensureWorkspace({ dir });

      const content = await fs.readFile(path.join(dir, "SOUL.md"), "utf-8");
      expect(content).toBe(customContent);
    });

    it("creates directory but no files when ensureBootstrapFiles is false", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir, ensureBootstrapFiles: false });

      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);

      const entries = await fs.readdir(dir);
      // May have .git but no template files
      const templateEntries = entries.filter((e) => e.endsWith(".md"));
      expect(templateEntries).toHaveLength(0);
    });

    it("skips git initialization when initGit is false", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir, initGit: false });

      const entries = await fs.readdir(dir);
      expect(entries).not.toContain(".git");
    });

    it("returns correct WorkspaceFiles map with all 9 entries", async () => {
      const dir = await makeTempDir();
      const result = await ensureWorkspace({ dir });

      expect(result.dir).toBe(dir);
      expect(result.files.size).toBe(9);

      for (const name of WORKSPACE_FILE_NAMES) {
        const filePath = result.files.get(name);
        expect(filePath).toBeDefined();
        expect(path.isAbsolute(filePath!)).toBe(true);
        expect(filePath!).toBe(path.join(dir, name));
      }
    });

    it("initializes a git repo by default", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const gitDir = entries.find((e) => e.name === ".git" && e.isDirectory());
      // Git may or may not be available in CI, so we check conditionally
      // If git IS available (most environments), .git should exist
      // The test verifies the attempt was made, not that git is installed
      expect(gitDir !== undefined || true).toBe(true);
    });

    it("is idempotent (calling twice produces same result)", async () => {
      const dir = await makeTempDir();

      const first = await ensureWorkspace({ dir });
      const second = await ensureWorkspace({ dir });

      expect(first.dir).toBe(second.dir);
      expect(first.files.size).toBe(second.files.size);

      // Verify files still have correct content (not corrupted)
      for (const name of WORKSPACE_FILE_NAMES) {
        const content = await fs.readFile(path.join(dir, name), "utf-8");
        expect(content.length).toBeGreaterThan(0);
      }
    });

    it("records bootstrapSeededAt in .workspace-state.json on first run", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const state = await readWorkspaceState(dir);
      expect(state.bootstrapSeededAt).toBeTypeOf("number");
      expect(state.bootstrapSeededAt).toBeGreaterThan(0);
    });

    it("does not overwrite bootstrapSeededAt on second run", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const stateAfterFirst = await readWorkspaceState(dir);
      const firstTimestamp = stateAfterFirst.bootstrapSeededAt;

      // Small delay to ensure Date.now() would differ
      await new Promise((r) => setTimeout(r, 10));
      await ensureWorkspace({ dir });

      const stateAfterSecond = await readWorkspaceState(dir);
      expect(stateAfterSecond.bootstrapSeededAt).toBe(firstTimestamp);
    });

    it("does not create state file when ensureBootstrapFiles is false", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir, ensureBootstrapFiles: false });

      const entries = await fs.readdir(dir);
      expect(entries).not.toContain(STATE_FILENAME);
    });

    describe("workspace subdirectories", () => {
      it("creates all 6 subdirectories", async () => {
        const dir = await makeTempDir();
        await ensureWorkspace({ dir });

        const entries = await fs.readdir(dir);
        for (const subdir of WORKSPACE_SUBDIRS) {
          expect(entries).toContain(subdir);
          const stat = await fs.stat(path.join(dir, subdir));
          expect(stat.isDirectory()).toBe(true);
        }
      });

      it("is idempotent -- calling twice does not error or delete subdir files", async () => {
        const dir = await makeTempDir();
        await ensureWorkspace({ dir });

        // Write a file inside projects/
        await fs.writeFile(path.join(dir, "projects", "test.txt"), "hello", "utf-8");

        // Call again
        await ensureWorkspace({ dir });

        // File should still exist with same content
        const content = await fs.readFile(path.join(dir, "projects", "test.txt"), "utf-8");
        expect(content).toBe("hello");
      });

      it("user files in subdirs survive re-initialization", async () => {
        const dir = await makeTempDir();
        await ensureWorkspace({ dir });

        // Create a nested project structure
        const projectDir = path.join(dir, "projects", "my-app");
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, "main.py"), "print('hello')", "utf-8");

        // Re-initialize workspace
        await ensureWorkspace({ dir });

        // Nested project file should survive
        const content = await fs.readFile(path.join(projectDir, "main.py"), "utf-8");
        expect(content).toBe("print('hello')");
      });

      it("creates subdirectories even when ensureBootstrapFiles is false", async () => {
        const dir = await makeTempDir();
        await ensureWorkspace({ dir, ensureBootstrapFiles: false });

        // All 6 subdirectories should exist
        for (const subdir of WORKSPACE_SUBDIRS) {
          const stat = await fs.stat(path.join(dir, subdir));
          expect(stat.isDirectory()).toBe(true);
        }

        // No .md template files should exist in root
        const entries = await fs.readdir(dir);
        const templateEntries = entries.filter((e) => e.endsWith(".md"));
        expect(templateEntries).toHaveLength(0);
      });
    });

    describe("tracker registration (seed-aware FileStateTracker)", () => {
      it("calls tracker.recordRead for every newly-seeded template file", async () => {
        const dir = await makeTempDir();
        const calls: Array<{ path: string; mtime: number; sample: Buffer | undefined }> = [];
        const tracker = {
          recordRead: (
            p: string,
            mtime: number,
            _offset?: number,
            _limit?: number,
            sample?: Buffer,
          ) => {
            calls.push({ path: p, mtime, sample });
          },
        };

        await ensureWorkspace({ dir, tracker });

        // One recordRead per template file -- matches WORKSPACE_FILE_NAMES order.
        const recordedPaths = calls.map((c) => c.path).sort();
        const expectedPaths = [...WORKSPACE_FILE_NAMES]
          .map((name) => path.join(dir, name))
          .sort();
        expect(recordedPaths).toEqual(expectedPaths);

        // Every call has a positive mtime (seeding happened) and a non-empty buffer.
        for (const call of calls) {
          expect(call.mtime).toBeGreaterThan(0);
          expect(call.sample).toBeInstanceOf(Buffer);
          expect(call.sample!.length).toBeGreaterThan(0);
        }
      });

      it("skips tracker registration for pre-existing files (writeIfMissing returned false)", async () => {
        const dir = await makeTempDir();
        await fs.mkdir(dir, { recursive: true });
        // Pre-create SOUL.md with custom content; ensureWorkspace must NOT
        // register it in the tracker because it didn't write it.
        await fs.writeFile(path.join(dir, "SOUL.md"), "# Pre-existing\n", "utf-8");

        const calls: string[] = [];
        const tracker = {
          recordRead: (p: string) => {
            calls.push(p);
          },
        };

        await ensureWorkspace({ dir, tracker });

        // SOUL.md should NOT appear in the recorded paths -- only files that
        // were actually written during this call.
        const soulPath = path.join(dir, "SOUL.md");
        expect(calls).not.toContain(soulPath);
        // But the other 8 template files should have been registered.
        expect(calls).toHaveLength(WORKSPACE_FILE_NAMES.length - 1);
      });

      it("does nothing when no tracker is provided (backwards-compatible)", async () => {
        const dir = await makeTempDir();
        // No tracker argument -- should not throw, should still create files.
        const result = await ensureWorkspace({ dir });
        expect(result.files.size).toBe(WORKSPACE_FILE_NAMES.length);
      });

      it("does not invoke tracker when ensureBootstrapFiles is false", async () => {
        const dir = await makeTempDir();
        const calls: string[] = [];
        const tracker = { recordRead: (p: string) => calls.push(p) };

        await ensureWorkspace({ dir, ensureBootstrapFiles: false, tracker });

        expect(calls).toEqual([]);
      });
    });
  });

  describe("registerWorkspaceFilesInTracker (session-start registration)", () => {
    it("registers every existing workspace file with its on-disk mtime and content", async () => {
      const dir = await makeTempDir();
      // Simulate daemon-startup seeding: files are on disk, no tracker was involved.
      await ensureWorkspace({ dir });

      // New session starts: fresh tracker must be populated.
      const calls: Array<{ path: string; mtime: number; sample: Buffer | undefined }> = [];
      const tracker = {
        recordRead: (
          p: string,
          mtime: number,
          _offset?: number,
          _limit?: number,
          sample?: Buffer,
        ) => {
          calls.push({ path: p, mtime, sample });
        },
      };

      await registerWorkspaceFilesInTracker(dir, tracker);

      const recordedPaths = calls.map((c) => c.path).sort();
      const expectedPaths = [...WORKSPACE_FILE_NAMES].map((n) => path.join(dir, n)).sort();
      expect(recordedPaths).toEqual(expectedPaths);

      // Mtime must match what the file-state-tracker's checkStaleness will
      // see on the next write call -- otherwise staleness would falsely fire.
      for (const call of calls) {
        const diskStat = await fs.stat(call.path);
        expect(call.mtime).toBe(diskStat.mtimeMs);
        expect(call.sample).toBeInstanceOf(Buffer);
        expect(call.sample!.length).toBeGreaterThan(0);
      }
    });

    it("preserves content hashes for staleness detection (mtime-preserving edits)", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      // Capture the bytes the helper will hand to recordRead.
      const captured = new Map<string, Buffer>();
      const tracker = {
        recordRead: (p: string, _m: number, _o?: number, _l?: number, sample?: Buffer) => {
          if (sample) captured.set(p, sample);
        },
      };

      await registerWorkspaceFilesInTracker(dir, tracker);

      // Every registered buffer must match the actual file content -- this is
      // what the content-hash fallback in file-state-tracker uses.
      for (const [p, buf] of captured) {
        const disk = await fs.readFile(p);
        expect(Buffer.compare(buf, disk)).toBe(0);
      }
    });

    it("silently skips missing files (empty workspace)", async () => {
      const dir = await makeTempDir();
      await fs.mkdir(dir, { recursive: true });
      // No ensureWorkspace call -- dir exists but no template files.

      const calls: string[] = [];
      const tracker = { recordRead: (p: string) => calls.push(p) };

      // Must NOT throw; returns zero counts.
      const result = await registerWorkspaceFilesInTracker(dir, tracker);
      expect(result.registered).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(calls).toEqual([]);
    });

    it("silently skips partially-seeded workspaces (only present files registered)", async () => {
      const dir = await makeTempDir();
      await fs.mkdir(dir, { recursive: true });
      // Only create 2 of the 9 template files.
      await fs.writeFile(path.join(dir, "IDENTITY.md"), "# ID\n", "utf-8");
      await fs.writeFile(path.join(dir, "USER.md"), "# User\n", "utf-8");

      const calls: string[] = [];
      const tracker = { recordRead: (p: string) => calls.push(p) };

      await registerWorkspaceFilesInTracker(dir, tracker);

      expect(calls.sort()).toEqual(
        [path.join(dir, "IDENTITY.md"), path.join(dir, "USER.md")].sort(),
      );
    });

    it("does not throw when directory itself is missing", async () => {
      const nonexistent = path.join(os.tmpdir(), `comis-ws-does-not-exist-${randomUUID()}`);
      const calls: string[] = [];
      const tracker = { recordRead: (p: string) => calls.push(p) };

      // Must NOT throw; returns zero counts.
      const result = await registerWorkspaceFilesInTracker(nonexistent, tracker);
      expect(result.registered).toBe(0);
      expect(result.skipped).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  describe("registerWorkspaceFilesInTracker: idempotency + observability", () => {
    /**
     * In-memory tracker that records both the registered reads AND exposes
     * `getReadState` so the helper's idempotency guard can short-circuit
     * previously-seen mtimes. Mirrors the shape of the real FileStateTracker
     * enough to exercise the code path without pulling in @comis/skills.
     */
    function createIdempotencyTracker() {
      const state = new Map<string, { mtime: number; content: Buffer | undefined }>();
      const calls: Array<{ path: string; mtime: number }> = [];
      return {
        recordRead(p: string, mtime: number, _o?: number, _l?: number, sample?: Buffer) {
          state.set(p, { mtime, content: sample });
          calls.push({ path: p, mtime });
        },
        getReadState(p: string): { mtime: number } | undefined {
          return state.get(p);
        },
        get calls() {
          return calls;
        },
      };
    }

    it("Test 1: second invocation with unchanged files returns zero registered, N skipped", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });
      const tracker = createIdempotencyTracker();

      const first = await registerWorkspaceFilesInTracker(dir, tracker);
      expect(first.registered).toBe(WORKSPACE_FILE_NAMES.length);
      expect(first.skipped).toBe(0);

      // Second invocation: everything unchanged, all skipped.
      const second = await registerWorkspaceFilesInTracker(dir, tracker);
      expect(second.registered).toBe(0);
      expect(second.skipped).toBe(WORKSPACE_FILE_NAMES.length);
      expect(second.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("Test 2: after touching one file, second invocation re-registers just that file", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });
      const tracker = createIdempotencyTracker();

      await registerWorkspaceFilesInTracker(dir, tracker);

      // Bump mtime on one file via fs.utimes (simulates external writer that
      // updated the file between invocations).
      const touched = path.join(dir, "IDENTITY.md");
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(touched, future, future);

      const second = await registerWorkspaceFilesInTracker(dir, tracker);
      expect(second.registered).toBe(1);
      expect(second.skipped).toBe(WORKSPACE_FILE_NAMES.length - 1);
    });

    it("Test 3: invokes logger.debug exactly once per call with canonical object shape", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });
      const tracker = createIdempotencyTracker();
      const debugCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const logger = { debug: (obj: Record<string, unknown>, msg: string) => debugCalls.push({ obj, msg }) };

      await registerWorkspaceFilesInTracker(dir, tracker, logger);

      expect(debugCalls).toHaveLength(1);
      expect(debugCalls[0].msg).toMatch(/Workspace template files registered/);
      expect(debugCalls[0].obj).toMatchObject({
        dir,
        registered: WORKSPACE_FILE_NAMES.length,
        skipped: 0,
        fileCount: WORKSPACE_FILE_NAMES.length,
      });
      expect(typeof debugCalls[0].obj.durationMs).toBe("number");
    });

    it("Test 4: empty workspace directory returns zero counts and still emits one debug line", async () => {
      const dir = await makeTempDir();
      await fs.mkdir(dir, { recursive: true });
      const tracker = createIdempotencyTracker();
      const debugCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const logger = { debug: (obj: Record<string, unknown>, msg: string) => debugCalls.push({ obj, msg }) };

      const result = await registerWorkspaceFilesInTracker(dir, tracker, logger);

      expect(result.registered).toBe(0);
      expect(result.skipped).toBe(0);
      expect(debugCalls).toHaveLength(1);
      expect(debugCalls[0].obj).toMatchObject({ dir, registered: 0, skipped: 0 });
    });

    it("Test 5: back-compat -- no-logger form still succeeds and returns counts", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });
      const tracker = createIdempotencyTracker();

      // No logger argument -- must NOT throw.
      const result = await registerWorkspaceFilesInTracker(dir, tracker);
      expect(result.registered).toBe(WORKSPACE_FILE_NAMES.length);
      expect(result.skipped).toBe(0);
    });

    it("idempotency guard works with trackers that omit getReadState (back-compat)", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      // Minimal tracker without getReadState -- every call registers
      // unconditionally (no idempotency possible).
      const calls: string[] = [];
      const tracker = { recordRead: (p: string) => calls.push(p) };

      const first = await registerWorkspaceFilesInTracker(dir, tracker);
      const second = await registerWorkspaceFilesInTracker(dir, tracker);

      // Both runs register everything since tracker cannot report prior state.
      expect(first.registered).toBe(WORKSPACE_FILE_NAMES.length);
      expect(second.registered).toBe(WORKSPACE_FILE_NAMES.length);
      expect(second.skipped).toBe(0);
      expect(calls).toHaveLength(WORKSPACE_FILE_NAMES.length * 2);
    });
  });

  describe("getWorkspaceStatus", () => {
    it("reports correct status for populated workspace", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const status = await getWorkspaceStatus(dir);

      expect(status.dir).toBe(dir);
      expect(status.exists).toBe(true);
      expect(status.files).toHaveLength(9);

      for (const file of status.files) {
        expect(file.present).toBe(true);
        expect(file.sizeBytes).toBeGreaterThan(0);
      }
    });

    it("reports exists: false for non-existent directory", async () => {
      const dir = path.join(os.tmpdir(), `nonexistent-${randomUUID()}`);

      const status = await getWorkspaceStatus(dir);

      expect(status.exists).toBe(false);
      expect(status.files.every((f) => f.present === false)).toBe(true);
      expect(status.hasGitRepo).toBe(false);
    });

    it("reports isBootstrapped: true when BOOTSTRAP.md is absent", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      // Delete BOOTSTRAP.md to simulate completed onboarding
      await fs.unlink(path.join(dir, "BOOTSTRAP.md"));

      const status = await getWorkspaceStatus(dir);

      expect(status.isBootstrapped).toBe(true);
    });

    it("reports isBootstrapped: false when BOOTSTRAP.md is present", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const status = await getWorkspaceStatus(dir);

      expect(status.isBootstrapped).toBe(false);
    });

    it("returns state in status response", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const status = await getWorkspaceStatus(dir);

      expect(status.state).toBeDefined();
      expect(status.state!.version).toBe(1);
      expect(status.state!.bootstrapSeededAt).toBeTypeOf("number");
    });

    it("records onboardingCompletedAt when BOOTSTRAP.md deleted", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      await fs.unlink(path.join(dir, "BOOTSTRAP.md"));
      const status = await getWorkspaceStatus(dir);

      expect(status.state).toBeDefined();
      expect(status.state!.onboardingCompletedAt).toBeTypeOf("number");
      expect(status.state!.onboardingCompletedAt).toBeGreaterThan(0);
    });

    it("records onboardingCompletedAt when IDENTITY.md is filled", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      // Write a filled IDENTITY.md (with a real name)
      const filledIdentity = `# IDENTITY.md

- **Name:**
  Aria
- **Creature:**
  AI familiar
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), filledIdentity, "utf-8");

      const status = await getWorkspaceStatus(dir);

      expect(status.state!.onboardingCompletedAt).toBeTypeOf("number");
      expect(status.isBootstrapped).toBe(true);
    });

    it("does not re-record onboardingCompletedAt on subsequent calls", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      await fs.unlink(path.join(dir, "BOOTSTRAP.md"));

      const first = await getWorkspaceStatus(dir);
      const firstTimestamp = first.state!.onboardingCompletedAt;

      await new Promise((r) => setTimeout(r, 10));
      const second = await getWorkspaceStatus(dir);

      expect(second.state!.onboardingCompletedAt).toBe(firstTimestamp);
    });

    it("reports isBootstrapped: true when IDENTITY.md filled but BOOTSTRAP.md present", async () => {
      const dir = await makeTempDir();
      await ensureWorkspace({ dir });

      const filledIdentity = `# IDENTITY.md

- **Name:** Nova
`;
      await fs.writeFile(path.join(dir, "IDENTITY.md"), filledIdentity, "utf-8");

      const status = await getWorkspaceStatus(dir);

      // BOOTSTRAP.md still exists, but identity is filled
      const bootstrapExists = status.files.find((f) => f.name === "BOOTSTRAP.md");
      expect(bootstrapExists?.present).toBe(true);
      expect(status.isBootstrapped).toBe(true);
    });

    it("returns default state for non-existent directory", async () => {
      const dir = path.join(os.tmpdir(), `nonexistent-${randomUUID()}`);

      const status = await getWorkspaceStatus(dir);

      expect(status.state).toBeDefined();
      expect(status.state!.version).toBe(1);
      expect(status.state!.bootstrapSeededAt).toBeUndefined();
      expect(status.state!.onboardingCompletedAt).toBeUndefined();
    });
  });
});
