// SPDX-License-Identifier: Apache-2.0
/**
 * The executeSubAgent worktree create/run/clean seam.
 *
 * These cases assert the END-TO-END wiring executeSubAgent uses when
 * `meta.worktree === true`:
 *   (a) resolveWorktreeDir confines the worktree UNDER the child's jailed
 *       workspace (never an escape);
 *   (b) prepareWorktree ACTUALLY calls the lifecycle's createWorktree (honest
 *       wiring, not dead code) and registers the entry, returning the worktree dir
 *       the child must run IN;
 *   (c) on a CLEAN child, cleanup() auto-removes the worktree (clean-if-unchanged)
 *       and drops the registry entry;
 *   (d) the DANGEROUS case: on a DIRTY child, cleanup() PRESERVES the worktree
 *       (worktree-remove never attempted) so the agent's work survives — the
 *       registry keeps the entry so the boot sweep can retry once it commits.
 *
 * The git seam is a deterministic GitExec fake (no real git).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/infra";
import type { GitExec } from "@comis/skills/tools";
import { createWorktreeRegistry } from "../setup-worktree-sweep.js";
import { resolveWorktreeDir, prepareWorktree } from "./worktree-spawn-run.js";

const silentLogger: ComisLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
} as unknown as ComisLogger;

/** A GitExec fake driven by a status reply (drives clean vs dirty). */
function makeGit(opts: {
  statusPorcelain?: string;
  headSha?: string;
  baseSha?: string;
}): { git: GitExec; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const head = opts.headSha ?? "sha-base";
  const base = opts.baseSha ?? "sha-base";
  const git: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "worktree" && args[1] === "add") return { stdout: "", exitCode: 0 };
    if (args[0] === "status" && args[1] === "--porcelain")
      return { stdout: opts.statusPorcelain ?? "", exitCode: 0 };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: head, exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: base, exitCode: 0 };
    if (args[0] === "worktree" && args[1] === "remove") return { stdout: "", exitCode: 0 };
    if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  return { git, calls };
}

describe("resolveWorktreeDir", () => {
  it("confines the worktree dir UNDER the child's jailed workspace", () => {
    const dir = resolveWorktreeDir("/data/workspace-researcher", "run-abc");
    expect(dir.startsWith("/data/workspace-researcher/")).toBe(true);
    expect(dir).toContain("run-abc");
  });

  it("rejects a runId that would escape the workspace (path traversal)", () => {
    expect(() => resolveWorktreeDir("/data/workspace-researcher", "../../etc")).toThrow();
  });
});

describe("prepareWorktree", () => {
  it("ACTUALLY creates the worktree and registers it, returning the dir the child runs IN (honest wiring)", async () => {
    const reg = createWorktreeRegistry();
    const { git, calls } = makeGit({});
    const handle = await prepareWorktree({
      gitExec: git,
      registry: reg,
      workspaceDir: "/data/workspace-researcher",
      baseRef: "main",
      runId: "run-abc",
      logger: silentLogger,
    });
    // createWorktree was actually called (git worktree add ...).
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
    // The returned dir is confined + registered.
    expect(handle.dir.startsWith("/data/workspace-researcher/")).toBe(true);
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.dir).toBe(handle.dir);
    expect(snap[0]!.completed).toBe(false);
  });

  it("cleanup() auto-removes a CLEAN worktree (clean-if-unchanged) and drops the registry entry", async () => {
    const reg = createWorktreeRegistry();
    // Clean: empty status + HEAD == base.
    const { git, calls } = makeGit({ statusPorcelain: "", headSha: "x", baseSha: "x" });
    const handle = await prepareWorktree({
      gitExec: git,
      registry: reg,
      workspaceDir: "/data/workspace-researcher",
      baseRef: "main",
      runId: "run-clean",
      logger: silentLogger,
    });
    const result = await handle.cleanup();
    expect(result.removed).toBe(true);
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
    // Registry entry dropped after a successful clean.
    expect(reg.snapshot()).toHaveLength(0);
  });

  it("DANGEROUS case: cleanup() PRESERVES a DIRTY worktree (remove never attempted); registry keeps the entry for the sweep", async () => {
    const reg = createWorktreeRegistry();
    // Dirty: status reports an untracked file.
    const { git, calls } = makeGit({ statusPorcelain: "?? new-file.txt" });
    const handle = await prepareWorktree({
      gitExec: git,
      registry: reg,
      workspaceDir: "/data/workspace-researcher",
      baseRef: "main",
      runId: "run-dirty",
      logger: silentLogger,
    });
    const result = await handle.cleanup();
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("dirty");
    // The dangerous op was NEVER attempted.
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    // The entry stays (marked completed) so the boot sweep retries once it commits.
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.completed).toBe(true);
  });
});
