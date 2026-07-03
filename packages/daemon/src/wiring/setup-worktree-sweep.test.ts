// SPDX-License-Identifier: Apache-2.0
/**
 * The worktree-orphan-sweep subsystem wiring.
 *
 * These cases assert:
 *   (a) the WorktreeRegistry tracks created entries + marks them completed;
 *   (b) the ExecGitFn → lifecycle-GitExec adapter maps a Result<string,string>
 *       onto the lifecycle's `{ stdout, exitCode }` shape (ok ⇒ exit 0, err ⇒
 *       exit 1 carrying the message as stdout so classifyGitFailure can read it);
 *   (c) the BOOT sweep ACTUALLY calls sweepOrphans (honest wiring, not dead code)
 *       — a gone-from-disk orphan from a crashed run is reclaimed;
 *   (d) the DANGEROUS case: a completed-but-DIRTY worktree is PRESERVED, never
 *       removed (the conservative-sweep invariant — the agent's work survives);
 *   (e) a periodic sweep interval is registered + cancelled on shutdown (no leaked
 *       timer — asserted via the fake-timers handle's `cancelled` flag).
 *
 * The git seam is a deterministic ExecGitFn fake (no real git); the on-disk
 * existence check is an injected `exists` predicate.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClockPort, TimerPort, TimerHandle, ExecGitFn } from "@comis/core";
import { ok, err } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";
import {
  createWorktreeRegistry,
  toLifecycleGitExec,
  setupWorktreeSweep,
  discoverWorktreeOrphans,
} from "./setup-worktree-sweep.js";

// ---------------------------------------------------------------------------
// Port wrappers + handle registry so the test can assert interval
// registration + cancellation. Each created TimerHandle is recorded.
// ---------------------------------------------------------------------------

const createdHandles: TimerHandle[] = [];

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  const handle: TimerHandle = {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearInterval(t);
    },
    unref() {
      if (!cancelled) t.unref();
    },
  };
  createdHandles.push(handle);
  return handle;
}

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };
const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

const silentLogger: ComisLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
} as unknown as ComisLogger;

beforeEach(() => {
  createdHandles.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createWorktreeRegistry
// ---------------------------------------------------------------------------

describe("createWorktreeRegistry", () => {
  it("registers a created worktree and exposes it via snapshot", () => {
    const reg = createWorktreeRegistry();
    reg.register({ dir: "/ws/wt-run1", baseRef: "main", branch: "wt-run1", runId: "run1" });
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.dir).toBe("/ws/wt-run1");
    expect(snap[0]!.completed).toBe(false);
  });

  it("marks an entry completed by dir (so the sweep may reclaim it once pristine)", () => {
    const reg = createWorktreeRegistry();
    reg.register({ dir: "/ws/wt-run1", baseRef: "main", branch: "wt-run1", runId: "run1" });
    reg.markCompleted("/ws/wt-run1");
    expect(reg.snapshot()[0]!.completed).toBe(true);
  });

  it("removes an entry by dir (called after a successful clean so the registry stays bounded)", () => {
    const reg = createWorktreeRegistry();
    reg.register({ dir: "/ws/wt-run1", baseRef: "main", branch: "wt-run1", runId: "run1" });
    reg.remove("/ws/wt-run1");
    expect(reg.snapshot()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toLifecycleGitExec — the ExecGitFn → lifecycle-GitExec adapter
// ---------------------------------------------------------------------------

describe("toLifecycleGitExec", () => {
  it("maps an ok Result to exit 0 carrying the stdout value", async () => {
    const execGit: ExecGitFn = async () => ok("deadbeef");
    const gitExec = toLifecycleGitExec(execGit);
    const res = await gitExec(["rev-parse", "HEAD"], "/ws/wt");
    expect(res).toEqual({ stdout: "deadbeef", exitCode: 0 });
  });

  it("maps an err Result to a non-zero exit carrying the message as stdout (so classifyGitFailure can read it)", async () => {
    const execGit: ExecGitFn = async () => err("fatal: not a git repository");
    const gitExec = toLifecycleGitExec(execGit);
    const res = await gitExec(["status", "--porcelain"], "/ws/wt");
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toContain("not a git repository");
  });

  it("forwards args + cwd to the wrapped ExecGitFn", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const execGit: ExecGitFn = async (args, cwd) => {
      calls.push({ args, cwd });
      return ok("");
    };
    const gitExec = toLifecycleGitExec(execGit);
    await gitExec(["worktree", "prune"], "/ws/wt");
    expect(calls).toEqual([{ args: ["worktree", "prune"], cwd: "/ws/wt" }]);
  });
});

// ---------------------------------------------------------------------------
// setupWorktreeSweep — boot + periodic orphan sweep (honest wiring)
// ---------------------------------------------------------------------------

describe("setupWorktreeSweep", () => {
  it("boot sweep ACTUALLY calls sweepOrphans and reclaims a gone-from-disk orphan", async () => {
    const reg = createWorktreeRegistry();
    // A crashed run left a registry entry whose dir is gone from disk.
    reg.register({ dir: "/ws/wt-crashed", baseRef: "main", branch: "wt-crashed", runId: "crashed" });
    const pruneCalls: string[][] = [];
    const execGit: ExecGitFn = async (args) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        pruneCalls.push(args);
        return ok("");
      }
      return ok("");
    };
    const handle = setupWorktreeSweep({
      execGit,
      registry: reg,
      // Injected existence predicate: the crashed dir is GONE.
      exists: () => false,
      timers: testTimers,
      clock: testClock,
      logger: silentLogger,
      sweepIntervalMs: 60_000,
    });

    const summary = await handle.sweepNow();
    // Honest wiring proof: the orphan was reclaimed (sweepOrphans was actually
    // invoked) and prune ran.
    expect(summary.removed).toContain("/ws/wt-crashed");
    expect(pruneCalls.length).toBeGreaterThan(0);
    handle.shutdown();
  });

  it("DANGEROUS case: a completed-but-DIRTY worktree is PRESERVED, never removed (conservative sweep)", async () => {
    const reg = createWorktreeRegistry();
    reg.register({ dir: "/ws/wt-dirty", baseRef: "main", branch: "wt-dirty", runId: "dirty" });
    reg.markCompleted("/ws/wt-dirty");
    const removeCalls: string[][] = [];
    const execGit: ExecGitFn = async (args) => {
      // status --porcelain reports an uncommitted change ⇒ dirty.
      if (args[0] === "status" && args[1] === "--porcelain") return ok(" M src/changed.ts");
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCalls.push(args);
        return ok("");
      }
      if (args[0] === "worktree" && args[1] === "prune") return ok("");
      return ok("");
    };
    const handle = setupWorktreeSweep({
      execGit,
      registry: reg,
      exists: () => true, // present on disk
      timers: testTimers,
      clock: testClock,
      logger: silentLogger,
      sweepIntervalMs: 60_000,
    });

    const summary = await handle.sweepNow();
    expect(summary.preserved).toContain("/ws/wt-dirty");
    expect(summary.removed).not.toContain("/ws/wt-dirty");
    // The dangerous op (worktree remove) was NEVER attempted on the dirty tree.
    expect(removeCalls).toHaveLength(0);
    handle.shutdown();
  });

  it("discovers prior-crash orphans from `git worktree list` and seeds the registry (boot recovery across a restart)", async () => {
    const reg = createWorktreeRegistry();
    // After a daemon restart the in-memory registry is empty, but the on-disk
    // .git/worktrees admin state survives. `git worktree list --porcelain` lists
    // both the main worktree (a NON-comis dir) and a leftover comis worktree under
    // the agent workspace's .worktrees/ — only the latter is OUR orphan to seed.
    const listOutput = [
      "worktree /data/workspace-researcher",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /data/workspace-researcher/.worktrees/wt-old-run",
      "HEAD bbbb",
      "branch refs/heads/wt-old-run",
      "",
    ].join("\n");
    const execGit: ExecGitFn = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(listOutput);
      return ok("");
    };
    const count = await discoverWorktreeOrphans({
      execGit,
      registry: reg,
      workspaceDirs: ["/data/workspace-researcher"],
      logger: silentLogger,
    });
    expect(count).toBe(1);
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.dir).toBe("/data/workspace-researcher/.worktrees/wt-old-run");
    // Seeded as completed so the sweep MAY reclaim it once it proves pristine
    // (never an in-progress entry the conservative sweep would always preserve).
    expect(snap[0]!.completed).toBe(true);
  });

  it("does NOT seed the operator's own worktrees (only dirs under an agent workspace's .worktrees/)", async () => {
    const reg = createWorktreeRegistry();
    const listOutput = [
      "worktree /home/user/some-project",
      "HEAD aaaa",
      "",
      "worktree /home/user/some-project-feature",
      "HEAD bbbb",
      "",
    ].join("\n");
    const execGit: ExecGitFn = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(listOutput);
      return ok("");
    };
    const count = await discoverWorktreeOrphans({
      execGit,
      registry: reg,
      workspaceDirs: ["/data/workspace-researcher"],
      logger: silentLogger,
    });
    expect(count).toBe(0);
    expect(reg.snapshot()).toHaveLength(0);
  });

  it("registers exactly one periodic sweep interval and cancels it on shutdown (no leaked timer)", () => {
    const reg = createWorktreeRegistry();
    const execGit: ExecGitFn = async () => ok("");
    const handle = setupWorktreeSweep({
      execGit,
      registry: reg,
      exists: () => true,
      timers: testTimers,
      clock: testClock,
      logger: silentLogger,
      sweepIntervalMs: 60_000,
    });
    handle.startPeriodicSweep();
    const intervals = createdHandles.filter((h) => !h.cancelled);
    expect(intervals.length).toBe(1);
    handle.shutdown();
    expect(createdHandles.every((h) => h.cancelled)).toBe(true);
  });
});
