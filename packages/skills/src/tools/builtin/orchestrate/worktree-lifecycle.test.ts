// SPDX-License-Identifier: Apache-2.0
/**
 * worktree-lifecycle (WT-01/WT-02) unit tests — RED-first.
 *
 * Exercises the net-new git-worktree lifecycle over an INJECTED GitExec seam
 * (no real git, fully deterministic): createWorktree, the PRECISE
 * clean-if-unchanged predicate, cleanIfUnchanged, and the conservative
 * orphan-sweep. The keystone (T-219-09): the predicate is exact — an untracked
 * file OR a commit ahead of the base means NOT clean, so the agent's work is
 * preserved. Tests assert the DANGEROUS case: a dirty/ahead worktree is NEVER
 * removed.
 *
 * The GitExec shape mirrors the plan's contract:
 *   (args, cwd) => Promise<{ stdout: string; exitCode: number }>
 * a fake returns scripted { stdout, exitCode } per args[0]/args[1].
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import {
  createWorktree,
  isWorktreeCleanIfUnchanged,
  cleanIfUnchanged,
  sweepOrphans,
  type GitExec,
  type WorktreeEntry,
} from "./worktree-lifecycle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A no-op logger that records WARN calls for the content-free assertions. */
function makeRecordingLogger(): { logger: ComisLogger; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((...args: unknown[]) => {
      warns.push(args);
    }),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as ComisLogger;
  return { logger, warns };
}

/**
 * Build a fake GitExec whose reply is chosen by a matcher over (args, cwd).
 * Returns the first matching scripted reply; an unmatched call throws so the
 * test fails loudly rather than silently passing on a wrong call shape.
 */
function makeFakeGit(
  routes: Array<{
    when: (args: string[], cwd: string) => boolean;
    reply: { stdout: string; exitCode: number };
  }>,
): { git: GitExec; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const git: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    const route = routes.find((r) => r.when(args, cwd));
    if (!route) {
      throw new Error(`fake git: no route for [${args.join(" ")}] @ ${cwd}`);
    }
    return route.reply;
  };
  return { git, calls };
}

const argEq =
  (...expected: string[]) =>
  (args: string[]): boolean =>
    expected.every((e, i) => args[i] === e);

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe("createWorktree", () => {
  it("invokes git worktree add and returns the registry entry", async () => {
    const { git, calls } = makeFakeGit([
      { when: argEq("worktree", "add"), reply: { stdout: "", exitCode: 0 } },
    ]);

    const entry = await createWorktree(git, {
      dir: "/ws/.worktrees/child-1",
      baseRef: "feature/v2.30",
      branch: "wt/child-1",
    });

    expect(entry).toEqual({
      dir: "/ws/.worktrees/child-1",
      baseRef: "feature/v2.30",
      branch: "wt/child-1",
    });
    // The args must contain `worktree add`, the target dir, the base ref,
    // and the fresh-branch flag.
    const addCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(addCall).toBeDefined();
    expect(addCall!.args).toContain("/ws/.worktrees/child-1");
    expect(addCall!.args).toContain("feature/v2.30");
    expect(addCall!.args).toContain("-b");
    expect(addCall!.args).toContain("wt/child-1");
  });

  it("threads runId onto the entry when provided", async () => {
    const { git } = makeFakeGit([
      { when: argEq("worktree", "add"), reply: { stdout: "", exitCode: 0 } },
    ]);
    const entry = await createWorktree(git, {
      dir: "/ws/.worktrees/child-2",
      baseRef: "main",
      branch: "wt/child-2",
      runId: "orch-abc",
    });
    expect(entry.runId).toBe("orch-abc");
  });

  it("throws a clear errorKind:internal Error when git worktree add exits non-zero", async () => {
    const { git } = makeFakeGit([
      { when: argEq("worktree", "add"), reply: { stdout: "fatal: bad", exitCode: 128 } },
    ]);
    await expect(
      createWorktree(git, { dir: "/ws/.worktrees/x", baseRef: "main", branch: "wt/x" }),
    ).rejects.toMatchObject({ errorKind: "internal" });
  });
});

// ---------------------------------------------------------------------------
// isWorktreeCleanIfUnchanged — THE PRECISE PREDICATE
// ---------------------------------------------------------------------------

describe("isWorktreeCleanIfUnchanged", () => {
  const DIR = "/ws/.worktrees/child";
  const BASE = "feature/v2.30";
  const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("returns true when status --porcelain is EMPTY and HEAD equals the base sha", async () => {
    const { git } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === BASE, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);
    await expect(isWorktreeCleanIfUnchanged(git, DIR, BASE)).resolves.toBe(true);
  });

  it("returns FALSE when status reports an untracked '?? newfile' line (Pitfall 5 — even with no tracked diff)", async () => {
    const { git } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "?? newfile.ts\n", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === BASE, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);
    await expect(isWorktreeCleanIfUnchanged(git, DIR, BASE)).resolves.toBe(false);
  });

  it("returns FALSE when status reports a staged change (' M tracked.ts')", async () => {
    const { git } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: " M tracked.ts\n", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === BASE, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);
    await expect(isWorktreeCleanIfUnchanged(git, DIR, BASE)).resolves.toBe(false);
  });

  it("returns FALSE when status is empty BUT HEAD is ahead of the base (a committed-but-unmerged worktree — work preserved)", async () => {
    const AHEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { git } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${AHEAD_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === BASE, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);
    await expect(isWorktreeCleanIfUnchanged(git, DIR, BASE)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanIfUnchanged — remove ONLY when clean; preserve-and-report otherwise
// ---------------------------------------------------------------------------

describe("cleanIfUnchanged", () => {
  const ENTRY: WorktreeEntry = {
    dir: "/ws/.worktrees/child",
    baseRef: "feature/v2.30",
    branch: "wt/child",
  };
  const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("removes the worktree (git worktree remove) ONLY when the predicate is true", async () => {
    const { git, calls } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === ENTRY.baseRef, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: argEq("worktree", "remove"), reply: { stdout: "", exitCode: 0 } },
    ]);

    const result = await cleanIfUnchanged(git, ENTRY);
    expect(result.removed).toBe(true);
    const removeCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toContain(ENTRY.dir);
  });

  it("does NOT remove and reports reason='dirty' when an untracked file is present (DANGEROUS-CASE: work survives)", async () => {
    const { git, calls } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "?? scratch.txt\n", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === ENTRY.baseRef, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      // NOTE: NO `worktree remove` route — if cleanIfUnchanged tries to remove,
      // the fake throws and this test fails. That is the safety assertion.
    ]);

    const result = await cleanIfUnchanged(git, ENTRY);
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("dirty");
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });

  it("does NOT remove and reports reason='ahead' when HEAD is ahead of base (committed work survives)", async () => {
    const AHEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { git, calls } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${AHEAD_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === ENTRY.baseRef, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);

    const result = await cleanIfUnchanged(git, ENTRY);
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("ahead");
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });

  it("WARN-logs content-free (dir basename + reason, NOT the path or task) when preserving a dirty worktree", async () => {
    const { git } = makeFakeGit([
      { when: argEq("status", "--porcelain"), reply: { stdout: "?? a.txt\n", exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === "HEAD", reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("rev-parse")(a) && a[1] === ENTRY.baseRef, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
    ]);
    const { logger, warns } = makeRecordingLogger();

    await cleanIfUnchanged(git, ENTRY, logger);

    expect(warns.length).toBeGreaterThan(0);
    const [fields] = warns[0]! as [Record<string, unknown>, string];
    expect(fields.errorKind).toBe("precondition");
    expect(typeof fields.hint).toBe("string");
    // Content-free: a full absolute path must NOT be logged (only the basename).
    expect(fields.dir).toBeUndefined();
    expect(fields.worktreeDir).toBe("child");
    expect(fields.reason).toBe("dirty");
  });
});

// ---------------------------------------------------------------------------
// sweepOrphans — CONSERVATIVE (Task 2)
// ---------------------------------------------------------------------------

describe("sweepOrphans", () => {
  const BASE = "feature/v2.30";
  const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const AHEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const GONE: WorktreeEntry = { dir: "/ws/.worktrees/gone", baseRef: BASE, branch: "wt/gone", completed: true };
  const CLEAN: WorktreeEntry = { dir: "/ws/.worktrees/clean", baseRef: BASE, branch: "wt/clean", completed: true };
  const DIRTY: WorktreeEntry = { dir: "/ws/.worktrees/dirty", baseRef: BASE, branch: "wt/dirty", completed: true };

  it("removes gone-from-disk + completed-clean entries, SKIPS dirty, and prunes once", async () => {
    const { git, calls } = makeFakeGit([
      // CLEAN: pristine predicate
      { when: (a, cwd) => argEq("status", "--porcelain")(a) && cwd === CLEAN.dir, reply: { stdout: "", exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === "HEAD" && cwd === CLEAN.dir, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === BASE && cwd === CLEAN.dir, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a) => argEq("worktree", "remove")(a) && a.includes(CLEAN.dir), reply: { stdout: "", exitCode: 0 } },
      // DIRTY: untracked → preserved (status routed; NO remove route for DIRTY)
      { when: (a, cwd) => argEq("status", "--porcelain")(a) && cwd === DIRTY.dir, reply: { stdout: "?? wip.ts\n", exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === "HEAD" && cwd === DIRTY.dir, reply: { stdout: `${AHEAD_SHA}\n`, exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === BASE && cwd === DIRTY.dir, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      // the single prune at the end
      { when: argEq("worktree", "prune"), reply: { stdout: "", exitCode: 0 } },
    ]);

    // exists() reports GONE as absent, the other two as present.
    const exists = (p: string): boolean => p !== GONE.dir;

    const summary = await sweepOrphans(git, [GONE, CLEAN, DIRTY], { exists });

    expect(summary.removed).toContain(GONE.dir);
    expect(summary.removed).toContain(CLEAN.dir);
    expect(summary.preserved).toContain(DIRTY.dir);
    expect(summary.removed).not.toContain(DIRTY.dir);

    // The DANGEROUS-CASE safety assertion: NO `worktree remove` was ever
    // issued for the dirty dir.
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove" && c.args.includes(DIRTY.dir))).toBe(false);
    // GONE is never `worktree remove`d (it's gone — only prune reclaims it).
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove" && c.args.includes(GONE.dir))).toBe(false);
    // prune runs exactly once.
    expect(calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "prune").length).toBe(1);
  });

  it("leaves an entry in preserved + WARN-logs (never a silent drop) when git worktree remove FAILS", async () => {
    const { git, calls } = makeFakeGit([
      { when: (a, cwd) => argEq("status", "--porcelain")(a) && cwd === CLEAN.dir, reply: { stdout: "", exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === "HEAD" && cwd === CLEAN.dir, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      { when: (a, cwd) => argEq("rev-parse")(a) && a[1] === BASE && cwd === CLEAN.dir, reply: { stdout: `${BASE_SHA}\n`, exitCode: 0 } },
      // remove FAILS for the clean entry.
      { when: (a) => argEq("worktree", "remove")(a) && a.includes(CLEAN.dir), reply: { stdout: "fatal: locked", exitCode: 1 } },
      { when: argEq("worktree", "prune"), reply: { stdout: "", exitCode: 0 } },
    ]);
    const { logger, warns } = makeRecordingLogger();
    const exists = (): boolean => true;

    const summary = await sweepOrphans(git, [CLEAN], { exists }, logger);

    // The clean entry could NOT be removed → it is preserved, not silently lost.
    expect(summary.removed).not.toContain(CLEAN.dir);
    expect(summary.preserved).toContain(CLEAN.dir);
    expect(warns.length).toBeGreaterThan(0);
    const [fields] = warns[warns.length - 1]! as [Record<string, unknown>, string];
    expect(fields.errorKind).toBe("internal");
    expect(typeof fields.hint).toBe("string");
    // content-free: basename only.
    expect(fields.worktreeDir).toBe("clean");
    // The attempted remove is in the call log (proves it tried, then preserved).
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove" && c.args.includes(CLEAN.dir))).toBe(true);
  });

  it("does NOT remove a completed entry whose dir is gone via `worktree remove` (prune reclaims it) and reports it removed", async () => {
    const { git, calls } = makeFakeGit([
      { when: argEq("worktree", "prune"), reply: { stdout: "", exitCode: 0 } },
    ]);
    const exists = (): boolean => false; // everything gone from disk

    const summary = await sweepOrphans(git, [GONE], { exists });

    expect(summary.removed).toContain(GONE.dir);
    // No `worktree remove` for a gone dir — only prune.
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    expect(calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "prune").length).toBe(1);
  });

  it("preserves an in-progress (not completed) entry even when its tree currently looks clean", async () => {
    const IN_PROGRESS: WorktreeEntry = {
      dir: "/ws/.worktrees/running",
      baseRef: BASE,
      branch: "wt/running",
      completed: false,
    };
    const { git, calls } = makeFakeGit([
      { when: argEq("worktree", "prune"), reply: { stdout: "", exitCode: 0 } },
      // If the sweep wrongly probed/removed an in-progress tree, these would be
      // hit; their ABSENCE from the route table means any such call throws.
    ]);
    const exists = (): boolean => true;

    const summary = await sweepOrphans(git, [IN_PROGRESS], { exists });

    expect(summary.preserved).toContain(IN_PROGRESS.dir);
    expect(summary.removed).not.toContain(IN_PROGRESS.dir);
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });
});
