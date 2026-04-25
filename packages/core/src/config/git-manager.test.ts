// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import {
  createConfigGitManager,
  encodeCommitMessage,
  GITIGNORE_CONTENT,
  parseCommitMessage,
} from "./git-manager.js";
import type {
  GitManagerDeps,
  ExecGitFn,
  GitCommitMetadata,
  ConfigGitManager,
} from "./git-manager.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockGitCall {
  args: string[];
  cwd: string;
}

/**
 * Simulated git repo state for deterministic testing.
 *
 * Tracks init state, staged files, commits, and provides a mock execGit
 * that returns predefined responses based on the command.
 */
interface MockGitRepo {
  initialized: boolean;
  commits: Array<{
    sha: string;
    message: string;
    timestamp: string;
    files: Map<string, string>;
  }>;
  workingTree: Map<string, string>;
  stagedFiles: Set<string>;
  dirty: boolean;
  /**
   * Override path returned by `git rev-parse --show-toplevel`.
   *
   * When set, the mock returns this regardless of `initialized` — used to
   * simulate the bug where `configDir` lives inside an unrelated parent
   * repo (e.g. a test config under a project working tree).
   */
  toplevel?: string;
}

function createSha(index: number): string {
  return `${"a".repeat(7)}${String(index).padStart(33, "0")}`;
}

/**
 * Create mock deps with a simulated in-memory git repo.
 *
 * Handles git init, add, commit, log, diff, status, rev-parse, cat-file,
 * and checkout commands with deterministic responses.
 */
function createMockDeps(opts?: {
  initialFiles?: Map<string, string>;
  preInitialized?: boolean;
  failCommands?: Map<string, string>;
  writtenFiles?: Map<string, string>;
  /** Override `git rev-parse --show-toplevel` result; see MockGitRepo.toplevel */
  toplevel?: string;
}): {
  deps: GitManagerDeps;
  calls: MockGitCall[];
  repo: MockGitRepo;
  writtenFiles: Map<string, string>;
} {
  const calls: MockGitCall[] = [];
  const writtenFiles = opts?.writtenFiles ?? new Map<string, string>();

  const repo: MockGitRepo = {
    initialized: opts?.preInitialized ?? false,
    commits: [],
    workingTree: new Map(opts?.initialFiles ?? []),
    stagedFiles: new Set(),
    dirty: false,
    toplevel: opts?.toplevel,
  };

  // If pre-initialized, create an initial commit
  if (opts?.preInitialized) {
    repo.commits.push({
      sha: createSha(0),
      message: "Initial config snapshot",
      timestamp: "2026-02-25T10:00:00+00:00",
      files: new Map(repo.workingTree),
    });
  }

  const execGit: ExecGitFn = async (
    args: string[],
    cwd: string,
  ): Promise<Result<string, string>> => {
    calls.push({ args, cwd });

    const command = args[0];

    // Check for forced failures
    const cmdKey = args.join(" ");
    if (opts?.failCommands) {
      for (const [pattern, errorMsg] of opts.failCommands) {
        if (cmdKey.includes(pattern)) {
          return err(errorMsg);
        }
      }
    }

    switch (command) {
      case "status": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        if (repo.dirty) {
          return ok(" M config.yaml\n");
        }
        return ok("");
      }

      case "init": {
        repo.initialized = true;
        return ok("Initialized empty Git repository");
      }

      case "add": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        // Track staged files
        for (let i = 1; i < args.length; i++) {
          const pattern = args[i]!;
          if (pattern === "--ignore-errors") continue;
          if (pattern.includes("*")) {
            // Glob — stage all matching files from working tree
            const ext = pattern.replace("*", "");
            for (const [name] of repo.workingTree) {
              if (name.endsWith(ext)) {
                repo.stagedFiles.add(name);
              }
            }
          } else {
            repo.stagedFiles.add(pattern);
          }
        }
        return ok("");
      }

      case "commit": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }

        // Extract message from -m flag
        const mIndex = args.indexOf("-m");
        const message = mIndex >= 0 ? args[mIndex + 1]! : "";

        // Check for --allow-empty
        const allowEmpty = args.includes("--allow-empty");

        if (!allowEmpty && repo.stagedFiles.size === 0 && !repo.dirty) {
          return err("nothing to commit, working tree clean");
        }

        const sha = createSha(repo.commits.length);
        const files = new Map(repo.workingTree);
        repo.commits.push({
          sha,
          message,
          timestamp: `2026-02-25T1${String(repo.commits.length).padStart(1, "0")}:00:00+00:00`,
          files,
        });
        repo.stagedFiles.clear();
        repo.dirty = false;

        return ok(`[main ${sha.slice(0, 7)}] ${message.split("\n")[0]}`);
      }

      case "rev-parse": {
        if (args[1] === "--show-toplevel") {
          // `git rev-parse --show-toplevel` walks ancestors looking for any
          // .git, so it succeeds even when configDir lives inside a parent
          // repo. Honor `repo.toplevel` (set by tests simulating the
          // ancestor-repo bug); otherwise return configDir when initialized,
          // and fail when not.
          if (repo.toplevel !== undefined) {
            return ok(repo.toplevel);
          }
          if (!repo.initialized) {
            return err("fatal: not a git repository");
          }
          return ok(cwd);
        }
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        if (args[1] === "HEAD") {
          if (repo.commits.length === 0) {
            return err("fatal: ambiguous argument 'HEAD'");
          }
          return ok(repo.commits[repo.commits.length - 1]!.sha);
        }
        if (args[1] === "--verify" && args[2] === "HEAD~1") {
          if (repo.commits.length < 2) {
            return err("fatal: ambiguous argument 'HEAD~1'");
          }
          return ok(repo.commits[repo.commits.length - 2]!.sha);
        }
        return err(`fatal: bad revision '${args[1]}'`);
      }

      case "log": {
        if (!repo.initialized || repo.commits.length === 0) {
          return err("fatal: your current branch 'main' does not have any commits yet");
        }

        // Parse --max-count
        const maxCountArg = args.find((a) => a.startsWith("--max-count="));
        const maxCount = maxCountArg
          ? parseInt(maxCountArg.split("=")[1]!, 10)
          : repo.commits.length;

        // Build log output matching the format %H%n%aI%n%B---END---
        const entries = [...repo.commits]
          .reverse()
          .slice(0, maxCount);

        const output = entries
          .map((c) => `${c.sha}\n${c.timestamp}\n${c.message}\n`)
          .join("---END---");

        return ok(output + "---END---");
      }

      case "diff": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        // Return a mock unified diff
        return ok(
          "--- a/config.yaml\n+++ b/config.yaml\n@@ -1,3 +1,3 @@\n setting: old\n-value: before\n+value: after\n other: same\n",
        );
      }

      case "cat-file": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        const targetSha = args[2];
        const found = repo.commits.find((c) => c.sha === targetSha);
        if (found) {
          return ok("commit");
        }
        return err(`fatal: Not a valid object name ${targetSha}`);
      }

      case "checkout": {
        if (!repo.initialized) {
          return err("fatal: not a git repository");
        }
        // Find the target commit and restore files
        const sha = args[1];
        const commit = repo.commits.find((c) => c.sha === sha);
        if (commit) {
          // Restore files from that commit
          for (const [name, content] of commit.files) {
            repo.workingTree.set(name, content);
          }
          repo.dirty = true;
          return ok("");
        }
        return err(`error: pathspec '${sha}' did not match any file(s) known to git`);
      }

      default:
        return ok("");
    }
  };

  const deps: GitManagerDeps = {
    configDir: "/test/config",
    execGit,
    writeFile: async (
      relativePath: string,
      content: string,
    ): Promise<Result<void, string>> => {
      writtenFiles.set(relativePath, content);
      return ok(undefined);
    },
  };

  return { deps, calls, repo, writtenFiles };
}

// ---------------------------------------------------------------------------
// Tests: Task 1 — init, commit, checkDirty, auto-reinit, best-effort
// ---------------------------------------------------------------------------

describe("config/git-manager", () => {
  describe("init()", () => {
    it("creates .git directory by running git init", async () => {
      const { deps, calls, repo } = createMockDeps();

      const manager = createConfigGitManager(deps);
      const result = await manager.init();

      expect(result.ok).toBe(true);
      expect(repo.initialized).toBe(true);

      // Should have probed via rev-parse (no existing repo), then run git
      // init, git add, git commit
      const commands = calls.map((c) => c.args[0]);
      expect(commands).toContain("rev-parse");
      expect(commands).toContain("init");
      expect(commands).toContain("commit");
    });

    it("writes .gitignore with YAML whitelist pattern", async () => {
      const { deps, writtenFiles } = createMockDeps();

      const manager = createConfigGitManager(deps);
      await manager.init();

      expect(writtenFiles.has(".gitignore")).toBe(true);
      const content = writtenFiles.get(".gitignore")!;
      expect(content).toContain("!*.yaml");
      expect(content).toContain("!*.yml");
      expect(content).toContain("!.gitignore");
      expect(content).toBe(GITIGNORE_CONTENT);
    });

    it("creates initial commit with allow-empty", async () => {
      const { deps, calls } = createMockDeps();

      const manager = createConfigGitManager(deps);
      await manager.init();

      const commitCall = calls.find(
        (c) => c.args[0] === "commit" && c.args.includes("--allow-empty"),
      );
      expect(commitCall).toBeDefined();
      expect(commitCall!.args).toContain("Initial config snapshot");
    });

    it("returns ok() early if repo already exists", async () => {
      const { deps, calls } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.init();

      expect(result.ok).toBe(true);
      // rev-parse --show-toplevel returns configDir → no init needed
      const commands = calls.map((c) => c.args[0]);
      expect(commands).not.toContain("init");
    });

    it("creates its own nested repo when configDir lives inside an unrelated parent repo", async () => {
      // Regression: prior code probed with `git status`, which walks
      // ancestors and silently treated the parent project's .git as ours.
      // Result: agents.create / agents.delete during integration tests
      // committed to the project's main branch. configDir is /test/config;
      // simulate a parent repo at /test by reporting that as toplevel.
      const { deps, calls } = createMockDeps({ toplevel: "/test" });

      const manager = createConfigGitManager(deps);
      const result = await manager.init();

      expect(result.ok).toBe(true);
      const commands = calls.map((c) => c.args[0]);
      // Probed for an exact-match toplevel...
      expect(commands).toContain("rev-parse");
      // ...didn't match, so created a nested repo and seeded it.
      expect(commands).toContain("init");
      expect(commands).toContain("commit");
    });

    it("is idempotent — second call is a no-op", async () => {
      const { deps, calls } = createMockDeps();

      const manager = createConfigGitManager(deps);
      await manager.init();
      const callsAfterFirst = calls.length;

      const result = await manager.init();
      expect(result.ok).toBe(true);
      // Second call should not make any new git calls (cached initialized flag)
      expect(calls.length).toBe(callsAfterFirst);
    });

    it("returns err() on git init failure", async () => {
      const failCommands = new Map([["init", "fatal: permission denied"]]);
      const { deps } = createMockDeps({ failCommands });

      const manager = createConfigGitManager(deps);
      const result = await manager.init();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("git init failed");
      }
    });
  });

  describe("commit()", () => {
    it("stages YAML files and creates commit with structured metadata", async () => {
      const initialFiles = new Map([["config.yaml", "setting: value"]]);
      const { deps, calls, repo } = createMockDeps({
        preInitialized: true,
        initialFiles,
      });

      // Mark as dirty so commit succeeds
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      const result = await manager.commit({
        section: "agent",
        key: "agent.model",
        summary: "Changed model to claude-opus",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeTruthy();
        expect(result.value.length).toBeGreaterThan(0);
      }

      // Verify commit message contains structured metadata
      const commitCall = calls.find(
        (c) => c.args[0] === "commit" && !c.args.includes("--allow-empty"),
      );
      expect(commitCall).toBeDefined();
      const message = commitCall!.args[commitCall!.args.indexOf("-m") + 1]!;
      expect(message).toContain("config: Changed model to claude-opus");
      expect(message).toContain("[section] agent");
      expect(message).toContain("[key] agent.model");
    });

    it("returns commit SHA on success", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      const result = await manager.commit({
        section: "gateway",
        summary: "Updated rate limit",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // SHA should be non-empty
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.value).not.toBe("");
      }
    });

    it("triggers lazy init when repo is not initialized", async () => {
      const { deps, calls, repo } = createMockDeps();

      // After init, mark dirty so commit succeeds
      const originalExecGit = deps.execGit;
      deps.execGit = async (args, cwd) => {
        const result = await originalExecGit(args, cwd);
        // After init completes, make the repo dirty for the actual commit
        if (args[0] === "commit" && args.includes("--allow-empty")) {
          repo.dirty = true;
        }
        return result;
      };

      const manager = createConfigGitManager(deps);
      const result = await manager.commit({
        section: "agent",
        summary: "First change",
      });

      expect(result.ok).toBe(true);

      // Should have called init first
      const commands = calls.map((c) => c.args[0]);
      expect(commands).toContain("init");
    });

    it("returns ok('') when nothing to commit", async () => {
      const { deps } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.commit({
        section: "agent",
        summary: "No changes",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("");
      }
    });

    it("omits optional metadata fields when undefined", async () => {
      const { deps, calls, repo } = createMockDeps({ preInitialized: true });
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      await manager.commit({
        section: "daemon",
        summary: "Updated logging level",
      });

      const commitCall = calls.find(
        (c) => c.args[0] === "commit" && !c.args.includes("--allow-empty"),
      );
      expect(commitCall).toBeDefined();
      const message = commitCall!.args[commitCall!.args.indexOf("-m") + 1]!;
      expect(message).toContain("[section] daemon");
      expect(message).not.toContain("[key]");
      expect(message).not.toContain("[agent]");
      expect(message).not.toContain("[user]");
      expect(message).not.toContain("[trace]");
    });

    it("includes all optional metadata when provided", async () => {
      const { deps, calls, repo } = createMockDeps({ preInitialized: true });
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      await manager.commit({
        section: "agent",
        key: "agent.model",
        agent: "assistant-1",
        user: "admin",
        traceId: "trace-abc-123",
        summary: "Full metadata commit",
      });

      const commitCall = calls.find(
        (c) => c.args[0] === "commit" && !c.args.includes("--allow-empty"),
      );
      const message = commitCall!.args[commitCall!.args.indexOf("-m") + 1]!;
      expect(message).toContain("[section] agent");
      expect(message).toContain("[key] agent.model");
      expect(message).toContain("[agent] assistant-1");
      expect(message).toContain("[user] admin");
      expect(message).toContain("[trace] trace-abc-123");
    });
  });

  describe("checkDirty()", () => {
    it("returns true when YAML files have uncommitted changes", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      const result = await manager.checkDirty();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it("returns false when working tree is clean", async () => {
      const { deps } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.checkDirty();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it("calls init() first to ensure repo exists", async () => {
      const { deps, calls } = createMockDeps();

      const manager = createConfigGitManager(deps);
      await manager.checkDirty();

      // Should have init-related calls before status
      const commands = calls.map((c) => c.args[0]);
      expect(commands).toContain("init");
    });
  });

  describe("auto-reinitialize", () => {
    it("re-initializes when git command returns 'not a git repository'", async () => {
      let callCount = 0;
      const warnCalls: unknown[] = [];

      const writtenFiles = new Map<string, string>();
      const mockLogger = {
        debug: vi.fn(),
        warn: (...args: unknown[]) => {
          warnCalls.push(args);
        },
      };

      // Start initialized so init() succeeds, but then fail on first status
      // command from checkDirty with "not a git repository"
      let removeDirCalled = false;

      const execGit: ExecGitFn = async (args) => {
        callCount++;

        // First status check for init — succeed (pretend repo exists)
        if (args[0] === "status" && callCount === 1) {
          return ok("");
        }

        // Second status check from checkDirty via execWithReinit — fail
        if (args[0] === "status" && callCount === 2) {
          return err("fatal: not a git repository (or any of the parent directories): .git");
        }

        // After reinit: status check in initRepo — fail (since we "removed" .git)
        if (args[0] === "status" && callCount > 2 && !removeDirCalled) {
          return err("fatal: not a git repository");
        }

        // Handle init after reinit
        if (args[0] === "init") {
          return ok("Initialized empty Git repository");
        }

        // Handle add, commit, etc.
        if (args[0] === "add") return ok("");
        if (args[0] === "commit") return ok("[main abc1234] Initial config snapshot");

        // After reinit, status works
        if (args[0] === "status") {
          return ok("");
        }

        return ok("");
      };

      const deps: GitManagerDeps = {
        configDir: "/test/config",
        execGit,
        writeFile: async (rel, content) => {
          writtenFiles.set(rel, content);
          return ok(undefined);
        },
        removeDir: async () => {
          removeDirCalled = true;
          return ok(undefined);
        },
        logger: mockLogger,
      };

      const manager = createConfigGitManager(deps);

      // First call succeeds (init)
      const initResult = await manager.init();
      expect(initResult.ok).toBe(true);

      // checkDirty triggers the "not a git repository" error and auto-reinit
      const dirtyResult = await manager.checkDirty();

      // Should have logged warning
      expect(warnCalls.length).toBeGreaterThan(0);
      const warnObj = warnCalls[0] as unknown[];
      expect((warnObj[0] as Record<string, string>).hint).toContain("re-initialized");
    });
  });

  describe("best-effort (never throw)", () => {
    it("init() returns err() on git failure, never throws", async () => {
      const failCommands = new Map([["init", "fatal: permission denied"]]);
      const { deps } = createMockDeps({ failCommands });

      const manager = createConfigGitManager(deps);
      const result = await manager.init();

      expect(result.ok).toBe(false);
      // No exception thrown — we got here
    });

    it("commit() returns err() on git failure, never throws", async () => {
      const failCommands = new Map([
        ["commit -m", "fatal: unable to create commit"],
      ]);
      const { deps, repo } = createMockDeps({
        preInitialized: true,
        failCommands,
      });
      repo.dirty = true;

      const manager = createConfigGitManager(deps);
      const result = await manager.commit({
        section: "test",
        summary: "Should fail",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("unable to create commit");
      }
    });

    it("checkDirty() returns err() on git failure, never throws", async () => {
      const failCommands = new Map([
        ["status --porcelain", "fatal: bad config"],
      ]);
      const { deps } = createMockDeps({
        preInitialized: true,
        failCommands,
      });

      const manager = createConfigGitManager(deps);
      const result = await manager.checkDirty();

      expect(result.ok).toBe(false);
    });
  });

  describe("parseCommitMessage()", () => {
    it("extracts summary from 'config: ' prefix", () => {
      const body = "config: Updated model\n\n[section] agent";
      const meta = parseCommitMessage(body);
      expect(meta.summary).toBe("Updated model");
    });

    it("extracts all metadata tags", () => {
      const body = [
        "config: Full metadata",
        "",
        "[section] agent",
        "[key] agent.model",
        "[agent] assistant-1",
        "[user] admin",
        "[trace] trace-123",
      ].join("\n");

      const meta = parseCommitMessage(body);
      expect(meta.section).toBe("agent");
      expect(meta.key).toBe("agent.model");
      expect(meta.agent).toBe("assistant-1");
      expect(meta.user).toBe("admin");
      expect(meta.traceId).toBe("trace-123");
    });

    it("uses 'unknown' section when no [section] tag found", () => {
      const meta = parseCommitMessage("Initial config snapshot");
      expect(meta.section).toBe("unknown");
    });

    it("handles commit messages without 'config: ' prefix", () => {
      const meta = parseCommitMessage("Initial config snapshot");
      expect(meta.summary).toBe("Initial config snapshot");
    });
  });

  // -----------------------------------------------------------------------
  // Tests: Task 2 — history, diff, rollback
  // -----------------------------------------------------------------------

  describe("history()", () => {
    it("returns up to 10 entries by default, newest first", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      // Create several commits
      for (let i = 1; i <= 5; i++) {
        repo.commits.push({
          sha: createSha(i),
          message: `config: Change ${i}\n\n[section] agent`,
          timestamp: `2026-02-25T1${i}:00:00+00:00`,
          files: new Map(),
        });
      }

      const manager = createConfigGitManager(deps);
      const result = await manager.history();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should include the initial commit + 5 added = 6 total
        expect(result.value.length).toBe(6);
        // Newest first (reversed in our mock)
        expect(result.value[0]!.metadata.summary).toBe("Change 5");
      }
    });

    it("respects limit option", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      for (let i = 1; i <= 10; i++) {
        repo.commits.push({
          sha: createSha(i),
          message: `config: Change ${i}\n\n[section] agent`,
          timestamp: `2026-02-25T1${i}:00:00+00:00`,
          files: new Map(),
        });
      }

      const manager = createConfigGitManager(deps);
      const result = await manager.history({ limit: 5 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(5);
      }
    });

    it("filters by section when specified", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message: "config: Agent change\n\n[section] agent",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map(),
      });
      repo.commits.push({
        sha: createSha(2),
        message: "config: Gateway change\n\n[section] gateway",
        timestamp: "2026-02-25T12:00:00+00:00",
        files: new Map(),
      });
      repo.commits.push({
        sha: createSha(3),
        message: "config: Another agent change\n\n[section] agent",
        timestamp: "2026-02-25T13:00:00+00:00",
        files: new Map(),
      });

      const manager = createConfigGitManager(deps);
      const result = await manager.history({ section: "agent" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only agent entries (not gateway, not initial which has section "unknown")
        expect(result.value.every((e) => e.metadata.section === "agent")).toBe(
          true,
        );
        expect(result.value.length).toBe(2);
      }
    });

    it("returns ok([]) on empty repo (no commits besides initial)", async () => {
      // Create a mock where log returns "does not have any commits"
      const failCommands = new Map([
        [
          "log",
          "fatal: your current branch 'main' does not have any commits yet",
        ],
      ]);
      const { deps } = createMockDeps({
        preInitialized: true,
        failCommands,
      });

      const manager = createConfigGitManager(deps);
      const result = await manager.history();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("parses structured metadata from commit messages", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message:
          "config: Updated model\n\n[section] agent\n[key] agent.model\n[agent] assistant-1\n[user] admin\n[trace] trace-abc",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map(),
      });

      const manager = createConfigGitManager(deps);
      const result = await manager.history();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const entry = result.value[0]!;
        expect(entry.metadata.section).toBe("agent");
        expect(entry.metadata.key).toBe("agent.model");
        expect(entry.metadata.agent).toBe("assistant-1");
        expect(entry.metadata.user).toBe("admin");
        expect(entry.metadata.traceId).toBe("trace-abc");
        expect(entry.metadata.summary).toBe("Updated model");
      }
    });
  });

  describe("diff()", () => {
    it("returns unified diff of last commit vs previous when no SHA given", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      // Add a second commit so HEAD~1 exists
      repo.commits.push({
        sha: createSha(1),
        message: "config: Second commit",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map(),
      });

      const manager = createConfigGitManager(deps);
      const result = await manager.diff();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Mock returns a unified diff format
        expect(result.value).toContain("---");
        expect(result.value).toContain("+++");
        expect(result.value).toContain("@@");
      }
    });

    it("returns diff from specified SHA to HEAD", async () => {
      const { deps, repo, calls } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message: "config: Second commit",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map(),
      });

      const manager = createConfigGitManager(deps);
      const targetSha = createSha(0);
      const result = await manager.diff(targetSha);

      expect(result.ok).toBe(true);

      // Verify diff was called with the specified SHA
      const diffCall = calls.find(
        (c) => c.args[0] === "diff" && c.args.some((a) => a.includes(targetSha)),
      );
      expect(diffCall).toBeDefined();
    });

    it("returns ok('') on single-commit repo (no previous)", async () => {
      const { deps } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.diff();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("");
      }
    });

    it("uses -U3 for 3 context lines", async () => {
      const { deps, repo, calls } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message: "config: Second commit",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map(),
      });

      const manager = createConfigGitManager(deps);
      await manager.diff();

      const diffCall = calls.find((c) => c.args[0] === "diff");
      expect(diffCall).toBeDefined();
      expect(diffCall!.args).toContain("-U3");
    });
  });

  describe("rollback()", () => {
    it("restores files from target SHA and creates forward commit", async () => {
      const { deps, repo, calls } = createMockDeps({ preInitialized: true });

      // Add commits with different file states
      const filesV1 = new Map([["config.yaml", "version: 1"]]);
      repo.commits.push({
        sha: createSha(1),
        message: "config: Version 1\n\n[section] agent",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: filesV1,
      });

      const filesV2 = new Map([["config.yaml", "version: 2"]]);
      repo.commits.push({
        sha: createSha(2),
        message: "config: Version 2\n\n[section] agent",
        timestamp: "2026-02-25T12:00:00+00:00",
        files: filesV2,
      });

      // Also set working tree to v2
      repo.workingTree.set("config.yaml", "version: 2");

      const manager = createConfigGitManager(deps);
      const targetSha = createSha(1);
      const result = await manager.rollback(targetSha);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeTruthy();
      }

      // Verify checkout was called with the target SHA
      const checkoutCall = calls.find(
        (c) => c.args[0] === "checkout" && c.args[1] === targetSha,
      );
      expect(checkoutCall).toBeDefined();

      // Verify a forward commit was created (not a reset)
      const commitCalls = calls.filter(
        (c) => c.args[0] === "commit" && !c.args.includes("--allow-empty"),
      );
      expect(commitCalls.length).toBeGreaterThan(0);
      const rollbackCommit = commitCalls[commitCalls.length - 1]!;
      const message =
        rollbackCommit.args[rollbackCommit.args.indexOf("-m") + 1]!;
      expect(message).toContain("rollback to");
    });

    it("returns new commit SHA after rollback", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message: "config: V1\n\n[section] agent",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map([["config.yaml", "v1"]]),
      });

      repo.workingTree.set("config.yaml", "v2");

      const manager = createConfigGitManager(deps);
      const result = await manager.rollback(createSha(1));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should return a SHA (new forward commit)
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it("returns err() with invalid SHA", async () => {
      const { deps } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.rollback("invalid-sha-does-not-exist");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid SHA");
      }
    });

    it("preserves history after rollback (forward commit, not reset)", async () => {
      const { deps, repo } = createMockDeps({ preInitialized: true });

      const sha1 = createSha(1);
      repo.commits.push({
        sha: sha1,
        message: "config: V1\n\n[section] agent",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map([["config.yaml", "v1"]]),
      });

      const sha2 = createSha(2);
      repo.commits.push({
        sha: sha2,
        message: "config: V2\n\n[section] agent",
        timestamp: "2026-02-25T12:00:00+00:00",
        files: new Map([["config.yaml", "v2"]]),
      });

      repo.workingTree.set("config.yaml", "v2");

      const manager = createConfigGitManager(deps);
      await manager.rollback(sha1);

      // History should include all commits: initial + v1 + v2 + rollback
      const historyResult = await manager.history({ limit: 10 });
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        // At least 4 commits (initial + v1 + v2 + rollback)
        expect(historyResult.value.length).toBeGreaterThanOrEqual(4);
        // The rollback commit should contain "rollback" in its summary
        const rollbackEntry = historyResult.value.find((e) =>
          e.metadata.summary.includes("rollback"),
        );
        expect(rollbackEntry).toBeDefined();
      }
    });

    it("includes [section] * in rollback commit metadata", async () => {
      const { deps, repo, calls } = createMockDeps({ preInitialized: true });

      repo.commits.push({
        sha: createSha(1),
        message: "config: V1\n\n[section] agent",
        timestamp: "2026-02-25T11:00:00+00:00",
        files: new Map([["config.yaml", "v1"]]),
      });
      repo.workingTree.set("config.yaml", "v2");

      const manager = createConfigGitManager(deps);
      await manager.rollback(createSha(1));

      const commitCalls = calls.filter(
        (c) =>
          c.args[0] === "commit" &&
          !c.args.includes("--allow-empty"),
      );
      const rollbackCommit = commitCalls[commitCalls.length - 1]!;
      const message =
        rollbackCommit.args[rollbackCommit.args.indexOf("-m") + 1]!;
      expect(message).toContain("[section] *");
    });
  });

  // -----------------------------------------------------------------------
  // Tests: gc and squash
  // -----------------------------------------------------------------------

  describe("gc()", () => {
    it("runs git garbage collection", async () => {
      const { deps, calls } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.gc();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.prunedObjects).toBe(true);
      }

      // Verify gc was called with --aggressive --prune=now
      const gcCall = calls.find(
        (c) =>
          c.args[0] === "gc" &&
          c.args.includes("--aggressive") &&
          c.args.includes("--prune=now"),
      );
      expect(gcCall).toBeDefined();
    });

    it("returns err on git failure", async () => {
      const failCommands = new Map([["gc", "fatal: gc failed"]]);
      const { deps } = createMockDeps({ preInitialized: true, failCommands });

      const manager = createConfigGitManager(deps);
      const result = await manager.gc();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("git gc failed");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Tests: encodeCommitMessage sanitization
  // -----------------------------------------------------------------------

  describe("encodeCommitMessage", () => {
    it("strips newlines from metadata fields", () => {
      const message = encodeCommitMessage({
        section: "agent",
        summary: "line1\nline2\rline3",
      });
      expect(message).not.toContain("\nline2");
      expect(message).toContain("line1 line2 line3");
    });

    it("strips leading [ from metadata fields", () => {
      const message = encodeCommitMessage({
        section: "[injected] tag",
        summary: "normal summary",
      });
      expect(message).toContain("[section] injected] tag");
      expect(message).not.toContain("[section] [injected]");
    });

    it("round-trips clean metadata correctly", () => {
      const original = { section: "gateway", summary: "Updated host", key: "host", agent: "bot-1" };
      const encoded = encodeCommitMessage(original);
      const decoded = parseCommitMessage(encoded);
      expect(decoded.section).toBe("gateway");
      expect(decoded.summary).toBe("Updated host");
      expect(decoded.key).toBe("host");
      expect(decoded.agent).toBe("bot-1");
    });

    it("sanitizes all optional fields", () => {
      const message = encodeCommitMessage({
        section: "test",
        summary: "test",
        key: "line\none",
        agent: "[bad]agent",
        user: "user\r\ninjected",
        traceId: "[[trace",
      });
      expect(message).not.toMatch(/\[key\] line\n/);
      expect(message).toContain("[key] line one");
      expect(message).toContain("[agent] bad]agent");
      expect(message).toContain("[user] user  injected");
      expect(message).toContain("[trace] trace");
    });
  });

  describe("squash()", () => {
    it("returns squashedCount: 0 when fewer than 2 old commits", async () => {
      // Use a custom execGit that returns only 1 commit for log --reverse
      let initDone = false;
      const execGit: ExecGitFn = async (args) => {
        if (args[0] === "status" && !initDone) {
          initDone = true;
          return ok("");
        }
        if (args[0] === "log" && args.includes("--reverse")) {
          return ok("abc1234567890000000000000000000000000000 2026-01-01T00:00:00+00:00\n");
        }
        return ok("");
      };

      const deps: GitManagerDeps = {
        configDir: "/test/config",
        execGit,
        writeFile: async () => ok(undefined),
      };

      const manager = createConfigGitManager(deps);
      const result = await manager.squash("2099-01-01T00:00:00Z");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.squashedCount).toBe(0);
        expect(result.value.newRootSha).toBe("");
      }
    });

    it("squashes old commits and rebases newer ones", async () => {
      let initDone = false;
      const calls: Array<{ args: string[] }> = [];

      const execGit: ExecGitFn = async (args) => {
        calls.push({ args });

        if (args[0] === "status" && !initDone) {
          initDone = true;
          return ok("");
        }

        // Return 5 commits: 3 old (2025), 2 new (2026)
        if (args[0] === "log" && args.includes("--reverse")) {
          return ok([
            "aaa0000000000000000000000000000000000001 2025-01-01T00:00:00+00:00",
            "aaa0000000000000000000000000000000000002 2025-06-01T00:00:00+00:00",
            "aaa0000000000000000000000000000000000003 2025-12-01T00:00:00+00:00",
            "bbb0000000000000000000000000000000000004 2026-02-01T00:00:00+00:00",
            "bbb0000000000000000000000000000000000005 2026-02-15T00:00:00+00:00",
          ].join("\n"));
        }

        // rev-parse for tree
        if (args[0] === "rev-parse" && args[1]?.includes("^{tree}")) {
          return ok("treeSha123456");
        }

        // commit-tree
        if (args[0] === "commit-tree") {
          return ok("newRootSha789");
        }

        // symbolic-ref
        if (args[0] === "symbolic-ref") {
          return ok("main");
        }

        // rebase
        if (args[0] === "rebase") {
          return ok("Successfully rebased");
        }

        return ok("");
      };

      const deps: GitManagerDeps = {
        configDir: "/test/config",
        execGit,
        writeFile: async () => ok(undefined),
      };

      const manager = createConfigGitManager(deps);
      // Squash everything older than 2026-01-01
      const result = await manager.squash("2026-01-01T00:00:00Z");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.squashedCount).toBe(3);
        expect(result.value.newRootSha).toBe("newRootSha789");
      }

      // Verify rebase was called with correct args
      const rebaseCall = calls.find((c) => c.args[0] === "rebase");
      expect(rebaseCall).toBeDefined();
      expect(rebaseCall!.args).toContain("--onto");
      expect(rebaseCall!.args).toContain("newRootSha789");
    });

    it("returns err on invalid date", async () => {
      const { deps } = createMockDeps({ preInitialized: true });

      const manager = createConfigGitManager(deps);
      const result = await manager.squash("not-a-date");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid date");
      }
    });

    it("aborts rebase on failure and returns err", async () => {
      let initDone = false;
      const calls: Array<{ args: string[] }> = [];

      const execGit: ExecGitFn = async (args) => {
        calls.push({ args });

        if (args[0] === "status" && !initDone) {
          initDone = true;
          return ok("");
        }

        if (args[0] === "log" && args.includes("--reverse")) {
          return ok([
            "aaa0000000000000000000000000000000000001 2025-01-01T00:00:00+00:00",
            "aaa0000000000000000000000000000000000002 2025-06-01T00:00:00+00:00",
            "bbb0000000000000000000000000000000000003 2026-02-01T00:00:00+00:00",
          ].join("\n"));
        }

        if (args[0] === "rev-parse" && args[1]?.includes("^{tree}")) {
          return ok("treeSha123456");
        }

        if (args[0] === "commit-tree") {
          return ok("newRootSha789");
        }

        if (args[0] === "symbolic-ref") {
          return ok("main");
        }

        // Rebase fails
        if (args[0] === "rebase" && !args.includes("--abort")) {
          return err("CONFLICT: merge conflict in config.yaml");
        }

        // Rebase --abort succeeds
        if (args[0] === "rebase" && args.includes("--abort")) {
          return ok("Rebase aborted");
        }

        return ok("");
      };

      const deps: GitManagerDeps = {
        configDir: "/test/config",
        execGit,
        writeFile: async () => ok(undefined),
      };

      const manager = createConfigGitManager(deps);
      const result = await manager.squash("2026-01-01T00:00:00Z");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Squash rebase failed");
      }

      // Verify rebase --abort was called
      const abortCall = calls.find(
        (c) => c.args[0] === "rebase" && c.args.includes("--abort"),
      );
      expect(abortCall).toBeDefined();
    });
  });
});
