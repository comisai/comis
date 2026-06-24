// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the runId path-traversal guard (assertSafeRunId) throws a
// PathTraversalError so a worktree dir can NEVER escape the agent's jailed
// workspace (T-219-11) — a security assertion that MUST fail LOUD, not degrade.
// createWorktree (the lifecycle, @comis/skills/tools) also throws WorktreeGitError
// on a git failure; both surface at the executeSubAgent boundary which fails the
// spawn rather than silently running a non-worktree / escaped-path child.
/**
 * `worktree-spawn-run` — the WT-01 create/run/clean seam for executeSubAgent.
 *
 * When a `spawn --worktree` child runs (its session metadata carries
 * `worktree:true`), executeSubAgent runs it in an ISOLATED git worktree instead
 * of the agent's shared jailed workspace. This module owns the two pieces that
 * keeps executeSubAgent itself small (the 800-line file-size cap):
 *
 *   1. {@link resolveWorktreeDir} — the worktree dir, CONFINED under the child's
 *      jailed workspace via `safePath` (T-219-11 — a worktree NEVER escapes the
 *      jail; the child stays attenuated + jailed, just on its own working tree).
 *   2. {@link prepareWorktree}    — create the worktree (the lifecycle's
 *      createWorktree over the injected GitExec), register it (WT-02 orphan
 *      tracking), and return `{ dir, cleanup }`. `cleanup()` runs the lifecycle's
 *      PRECISE cleanIfUnchanged: a pristine worktree is removed + dropped from the
 *      registry; a dirty/ahead one is PRESERVED (the entry is marked completed and
 *      LEFT so the boot sweep retries once the child's work is committed).
 *
 * The happy path is fully self-contained inside ONE executeSubAgent call
 * (create → run → clean). The registry + the boot/periodic {@link setupWorktreeSweep}
 * exist ONLY to reclaim worktrees orphaned by a CRASH mid-child.
 *
 * @module
 */
import { safePath, PathTraversalError } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  createWorktree,
  cleanIfUnchanged,
  type GitExec,
  type CleanIfUnchangedResult,
} from "@comis/skills/tools";
import type { WorktreeRegistry } from "../setup-worktree-sweep.js";

/** The subdirectory (under the child's jailed workspace) that holds per-run worktrees. */
const WORKTREES_SUBDIR = ".worktrees";

/**
 * A runId is daemon-minted (`root-…` / a randomUUID-derived `sub-agent-<id>`), so
 * it is never attacker-controlled in production — but a path separator / traversal
 * token in it would let the worktree dir drift, so we reject it explicitly
 * (defense in depth, T-219-11). The `wt-<runId>` prefix already anchors the first
 * path component (so `safePath`'s prefix check stays inside the workspace), but a
 * separator inside the runId could still split it into a deeper dir — fail LOUD.
 */
function assertSafeRunId(runId: string): void {
  if (runId.length === 0 || /[/\\]/.test(runId) || runId.includes("..") || runId.includes("\0")) {
    throw new PathTraversalError("worktree runId", runId);
  }
}

/**
 * Resolve the worktree dir for a run, CONFINED under the child's jailed workspace
 * (`<workspaceDir>/.worktrees/wt-<runId>`). The runId is validated (no separators /
 * `..` / null) AND `safePath` rejects any resolved path that escapes the workspace
 * — a worktree can never escape the jail (T-219-11). Throws on either guard (fail
 * LOUD, never a silent escape).
 */
export function resolveWorktreeDir(workspaceDir: string, runId: string): string {
  assertSafeRunId(runId);
  return safePath(workspaceDir, WORKTREES_SUBDIR, `wt-${runId}`);
}

/** Deps for {@link prepareWorktree}. */
export interface PrepareWorktreeDeps {
  /** The lifecycle GitExec (the daemon binds the real execFile wrapper; tests inject a fake). */
  gitExec: GitExec;
  /** The shared registry the boot/periodic sweep reads (WT-02). */
  registry: WorktreeRegistry;
  /** The child's jailed workspace dir — the worktree is confined under it. */
  workspaceDir: string;
  /** The ref the worktree branches from (its branch point for the ahead-check). */
  baseRef: string;
  /** The child's runId — names the worktree dir + the fresh branch, correlates the registry entry. */
  runId: string;
  /** Optional structured logger; the lifecycle's own content-free WARNs ride it. */
  logger?: ComisLogger;
}

/** Handle returned by {@link prepareWorktree}: the dir to run in + the terminal cleanup. */
export interface WorktreeRunHandle {
  /** The worktree's working-tree dir — the child's cwd/workspace for this run. */
  dir: string;
  /**
   * Clean up on the child's terminal settle: the lifecycle's PRECISE
   * cleanIfUnchanged. A pristine worktree is removed + dropped from the registry;
   * a dirty/ahead one is PRESERVED (entry marked completed + LEFT so the boot
   * sweep retries). Never throws on the preserve path — the agent's work survives.
   */
  cleanup(): Promise<CleanIfUnchangedResult>;
}

/**
 * Create an isolated worktree for a `spawn --worktree` child and return the dir to
 * run in + the terminal cleanup. The fresh branch is `wt-<runId>` off `baseRef`.
 * The entry is registered (completed:false) so a crash mid-child leaves a record
 * the boot sweep can reclaim. `createWorktree` throws (WorktreeGitError) on a git
 * failure / git-absent host — the caller (executeSubAgent) catches it and fails
 * the spawn LOUD rather than silently degrading to a non-worktree run.
 */
export async function prepareWorktree(deps: PrepareWorktreeDeps): Promise<WorktreeRunHandle> {
  const { gitExec, registry, workspaceDir, baseRef, runId, logger } = deps;
  const dir = resolveWorktreeDir(workspaceDir, runId);
  const branch = `wt-${runId}`;

  const entry = await createWorktree(gitExec, { dir, baseRef, branch, runId });
  registry.register({ dir: entry.dir, baseRef: entry.baseRef, branch: entry.branch, runId });

  logger?.info(
    { runId, step: "worktree-create" },
    "Worktree created for spawn --worktree child",
  );

  const cleanup = async (): Promise<CleanIfUnchangedResult> => {
    // Mark completed FIRST so that even if the in-line clean is preempted (a crash
    // between here and the remove), the boot sweep sees a completed entry it may
    // reclaim once pristine — never an in-progress one it must preserve.
    registry.markCompleted(dir);
    const result = await cleanIfUnchanged(gitExec, entry, logger);
    if (result.removed) {
      // Pristine → reclaimed in-line; drop the registry entry (stays bounded).
      registry.remove(dir);
    }
    // Preserved (dirty/ahead/remove-failed) → LEAVE the entry so the boot sweep
    // retries once the work is committed/cleaned (cleanIfUnchanged already
    // content-free WARN-logged the preserve reason).
    return result;
  };

  return { dir, cleanup };
}

/** The seam executeSubAgent passes to {@link maybePrepareWorktreeForSpawn}. */
export interface SpawnWorktreeSeam {
  /** The lifecycle GitExec (composition root binds the real execFile wrapper). */
  worktreeGitExec?: GitExec;
  /** The shared registry the boot/periodic orphan sweep reads. */
  worktreeRegistry?: WorktreeRegistry;
  logger?: ComisLogger;
}

/**
 * The executeSubAgent decision: when the child session metadata requests a worktree
 * AND the git seam + registry are wired AND a runId is known, create an isolated
 * worktree under `baseWorkspaceDir` (off the workspace's current HEAD) and return
 * its run handle; otherwise return undefined. A request that cannot be honored
 * (seam unwired / no runId) is NOT silently dropped — it WARNs (config errorKind)
 * so the skip is visible, and the child falls back to its shared workspace.
 * `createWorktree` throws on a git failure / git-absent host (the caller fails the
 * spawn LOUD). Extracted from executeSubAgent to hold the graph file's size cap.
 */
export async function maybePrepareWorktreeForSpawn(opts: {
  wantsWorktree: boolean;
  runId: string | undefined;
  baseWorkspaceDir: string;
  agentId: string;
  seam: SpawnWorktreeSeam;
}): Promise<WorktreeRunHandle | undefined> {
  const { wantsWorktree, runId, baseWorkspaceDir, agentId, seam } = opts;
  if (!wantsWorktree) return undefined;
  if (seam.worktreeGitExec && seam.worktreeRegistry && runId) {
    return prepareWorktree({
      gitExec: seam.worktreeGitExec,
      registry: seam.worktreeRegistry,
      workspaceDir: baseWorkspaceDir,
      baseRef: "HEAD",
      runId,
      ...(seam.logger ? { logger: seam.logger.child({ submodule: "worktree-spawn" }) } : {}),
    });
  }
  seam.logger?.warn(
    {
      agentId,
      hasGitExec: !!seam.worktreeGitExec,
      hasRegistry: !!seam.worktreeRegistry,
      hasRunId: !!runId,
      hint: "spawn --worktree requested but the git-worktree seam is not wired (or no runId); the child runs in its shared workspace — wire worktreeGitExec + worktreeRegistry at the composition root",
      errorKind: "config" as const,
    },
    "Worktree requested but seam unavailable; running child in shared workspace",
  );
  return undefined;
}
