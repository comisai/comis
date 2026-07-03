// SPDX-License-Identifier: Apache-2.0
// @allow-throw: createWorktree + the clean-if-unchanged probes throw
// WorktreeGitError (carrying a closed-union `errorKind`) so a git failure / a
// `git`-absent host fails LOUD — a worktree op MUST never silently become a
// non-worktree spawn or silently treat a failed status-probe as "clean" (that
// would risk deleting agent work). createWorktree's throw is caught at
// the runner/spawn boundary; sweepOrphans CATCHES the predicate's throw and
// PRESERVES the entry (never aborts the whole sweep) so the conservative-sweep
// invariant holds.
/**
 * `worktree-lifecycle` — the net-new git-worktree lifecycle for
 * `comis-agent spawn --worktree`.
 *
 * A spawned child can run in an ISOLATED git worktree (its own working tree on a
 * fresh branch) so parallel children never clobber each other's files. A worktree
 * is host filesystem + `.git/worktrees/<name>` admin state the daemon must track
 * and reclaim. This module owns four operations over an INJECTED git-exec seam
 * (no direct `child_process` here — AGENTS §2.4/§2.5; the daemon composition root
 * binds the real `execFile` wrapper, the unit tests inject a deterministic fake):
 *
 *   1. {@link createWorktree}            — `git worktree add -b <branch> <dir> <baseRef>`
 *   2. {@link isWorktreeCleanIfUnchanged} — the PRECISE clean-if-unchanged predicate
 *   3. {@link cleanIfUnchanged}          — remove ONLY a pristine worktree (else preserve+report)
 *   4. {@link sweepOrphans}              — conservative orphan-sweep + `git worktree prune`
 *
 * ## The keystone: the clean-if-unchanged predicate is EXACT
 *
 * "Unchanged" means BOTH:
 *   - `git -C <dir> status --porcelain` produces ZERO lines — no staged, no
 *     unstaged, AND no untracked (`??`) entry. An empty-diff-but-has-untracked
 *     worktree is NOT clean.
 *   - HEAD equals the branch point the worktree was created from (`git rev-parse
 *     HEAD` === `git rev-parse <baseRef>`) — a committed-but-unmerged worktree is
 *     NOT clean.
 *
 * If EITHER fails the worktree is NOT clean → it is PRESERVED and a content-free
 * WARN is logged (the agent's work survives). The orphan-sweep is conservative:
 * it removes ONLY entries that are gone-from-disk or completed-AND-clean; it NEVER
 * removes a dirty/ahead/in-progress worktree, and a `git worktree remove` failure
 * WARN-logs and leaves the entry — never a silent loss.
 *
 * ## Observability (§2.7)
 *
 * Content-free: log dir BASENAMES (`worktreeDir`), counts, and status booleans —
 * never a full path, a diff, a file's content, or the task text. Every failure
 * branch carries `hint` + a closed-union `errorKind` (`internal` for an
 * unexpected git failure; `precondition` for a preserved-because-dirty/ahead
 * guard, mirroring the orchestrate honest-degrade WARN at
 * `orchestrate-tool.ts:337`).
 *
 * @module
 */
import { basename } from "node:path";
import type { ComisLogger } from "@comis/core";

// ---------------------------------------------------------------------------
// Seam + types
// ---------------------------------------------------------------------------

/**
 * The injected git-exec seam. Mirrors the daemon's `execGit` precedent
 * (`workspace-handlers.ts`) but in a `{ stdout, exitCode }` shape so the
 * lifecycle never imports `child_process`. The daemon composition root binds a
 * real `execFile("git", args, { cwd })` wrapper; unit tests inject a fake that
 * returns scripted replies per `args`.
 *
 * @param args - The git argv AFTER `git` (e.g. `["worktree", "add", …]`). For a
 *   status/rev-parse probe the wrapper runs git WITH `cwd` set to the worktree
 *   dir (equivalent to `git -C <cwd> …`), so callers pass the bare subcommand.
 * @param cwd - The directory git runs in (the worktree dir for probes).
 */
export type GitExec = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number }>;

/** A registered worktree the lifecycle creates, tracks, and reclaims. */
export interface WorktreeEntry {
  /** Absolute path to the worktree's working-tree directory. */
  dir: string;
  /** The ref the worktree was created from (the branch point for the ahead-check). */
  baseRef: string;
  /** The fresh branch checked out in the worktree. */
  branch: string;
  /** The spawned child's runId, if known (for correlation; never logged raw). */
  runId?: string;
  /**
   * Whether the child that owns this worktree has COMPLETED. The sweep only
   * considers a present-on-disk worktree for removal once its child is done — an
   * in-progress worktree is always preserved (its tree is being written).
   */
  completed?: boolean;
}

/** Options for {@link createWorktree}. */
export interface CreateWorktreeOptions {
  dir: string;
  baseRef: string;
  branch: string;
  runId?: string;
}

/** Result of {@link cleanIfUnchanged}: removed, or preserved with a reason. */
export interface CleanIfUnchangedResult {
  removed: boolean;
  /** Why it was NOT removed (only set when `removed === false`). */
  reason?: "dirty" | "ahead" | "remove-failed";
}

/** Summary of a {@link sweepOrphans} pass. */
export interface SweepSummary {
  /** Dirs that were reclaimed (worktree removed, or gone-from-disk + pruned). */
  removed: string[];
  /** Dirs that were intentionally KEPT (dirty/ahead/in-progress/remove-failed). */
  preserved: string[];
}

/** Deps for {@link sweepOrphans} — an injected `exists` so it never touches fs. */
export interface SweepDeps {
  /** True if the worktree dir is still present on disk. */
  exists: (dir: string) => boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A git operation failed unexpectedly — carries a closed-union `errorKind`. */
class WorktreeGitError extends Error {
  readonly errorKind: "internal" | "precondition";
  readonly hint: string;
  constructor(
    message: string,
    errorKind: "internal" | "precondition",
    hint: string,
  ) {
    super(message);
    this.name = "WorktreeGitError";
    this.errorKind = errorKind;
    this.hint = hint;
  }
}

/**
 * Map a non-zero git exit to an `errorKind`: a missing repo / absent git is a
 * `precondition` (the caller must ensure a git repo + the `git` binary); anything
 * else is an unexpected `internal` failure. We classify on the stderr/stdout text
 * git emits for the not-a-repo / not-found cases.
 */
function classifyGitFailure(stdout: string): "internal" | "precondition" {
  const text = stdout.toLowerCase();
  if (
    text.includes("not a git repository") ||
    text.includes("command not found") ||
    text.includes("no such file or directory")
  ) {
    return "precondition";
  }
  return "internal";
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

/**
 * Create an isolated git worktree on a fresh branch:
 * `git worktree add -b <branch> <dir> <baseRef>`.
 *
 * The dir MUST be rooted under the agent's jailed workspace (T-219-11) — this
 * module does not resolve the path; the caller (the runner) passes a
 * workspace-confined dir.
 *
 * @throws WorktreeGitError (errorKind `internal`, or `precondition` for a
 *   not-a-repo / absent-git signal) when `git worktree add` exits non-zero — a
 *   `git`-absent host fails CLEARLY, never a silent non-worktree spawn.
 */
export async function createWorktree(
  gitExec: GitExec,
  opts: CreateWorktreeOptions,
): Promise<WorktreeEntry> {
  const { dir, baseRef, branch, runId } = opts;
  // The worktree's own cwd doesn't exist yet; run `worktree add` from the repo
  // root, which for the daemon-bound exec is the workspace repo (the wrapper's
  // default cwd). Passing `dir` as cwd here is harmless for the fake; the real
  // wrapper resolves the repo from its bound root.
  const res = await gitExec(["worktree", "add", "-b", branch, dir, baseRef], dir);
  if (res.exitCode !== 0) {
    const errorKind = classifyGitFailure(res.stdout);
    throw new WorktreeGitError(
      `git worktree add failed (exit ${res.exitCode})`,
      errorKind,
      errorKind === "precondition"
        ? "Ensure `git` is available in the jail PATH and the workspace is a git repo before `spawn --worktree`."
        : "git worktree add failed unexpectedly; inspect the workspace git state.",
    );
  }
  return { dir, baseRef, branch, ...(runId !== undefined ? { runId } : {}) };
}

// ---------------------------------------------------------------------------
// isWorktreeCleanIfUnchanged — THE PRECISE PREDICATE
// ---------------------------------------------------------------------------

/**
 * The EXACT clean-if-unchanged predicate. Returns `true` ONLY when:
 *   (a) `git -C <dir> status --porcelain` yields ZERO non-empty lines (no
 *       staged/unstaged/untracked entry — ANY `??` line counts as not-clean), AND
 *   (b) `git -C <dir> rev-parse HEAD` === `git -C <dir> rev-parse <baseRef>`
 *       (no commits ahead of the branch point).
 *
 * Any other state → `false` (the worktree holds work that must be preserved).
 *
 * @throws WorktreeGitError when a probe exits non-zero (a failed probe must NOT
 *   be silently treated as "clean" — that would risk deleting work).
 */
export async function isWorktreeCleanIfUnchanged(
  gitExec: GitExec,
  dir: string,
  baseRef: string,
): Promise<boolean> {
  // (a) Working-tree status. ANY non-empty line (incl. an untracked `??`) → dirty.
  const status = await gitExec(["status", "--porcelain"], dir);
  if (status.exitCode !== 0) {
    const errorKind = classifyGitFailure(status.stdout);
    throw new WorktreeGitError(
      `git status --porcelain failed (exit ${status.exitCode})`,
      errorKind,
      "Could not read the worktree status; preserving the worktree rather than risk data loss.",
    );
  }
  const hasChanges =
    status.stdout.split("\n").filter((line) => line.trim().length > 0).length > 0;
  if (hasChanges) return false;

  // (b) Ahead-check: HEAD vs the base ref's sha.
  const head = await gitExec(["rev-parse", "HEAD"], dir);
  if (head.exitCode !== 0) {
    const errorKind = classifyGitFailure(head.stdout);
    throw new WorktreeGitError(
      `git rev-parse HEAD failed (exit ${head.exitCode})`,
      errorKind,
      "Could not resolve the worktree HEAD; preserving the worktree.",
    );
  }
  const base = await gitExec(["rev-parse", baseRef], dir);
  if (base.exitCode !== 0) {
    const errorKind = classifyGitFailure(base.stdout);
    throw new WorktreeGitError(
      `git rev-parse ${baseRef} failed (exit ${base.exitCode})`,
      errorKind,
      "Could not resolve the worktree base ref; preserving the worktree.",
    );
  }
  return head.stdout.trim() === base.stdout.trim();
}

// ---------------------------------------------------------------------------
// cleanIfUnchanged — remove ONLY a pristine worktree
// ---------------------------------------------------------------------------

/**
 * Remove a worktree (`git worktree remove <dir>`) ONLY when
 * {@link isWorktreeCleanIfUnchanged} is `true`. When it is NOT clean the worktree
 * is PRESERVED and a content-free WARN (`worktreeDir` basename + `reason`) is
 * logged; the agent's work survives.
 *
 * The `--force` flag is passed only AFTER the predicate has proved the tree
 * pristine (so `--force` here can never discard work — it only overrides git's
 * own "worktree is dirty" refusal, which the predicate has already ruled out).
 */
export async function cleanIfUnchanged(
  gitExec: GitExec,
  entry: WorktreeEntry,
  logger?: ComisLogger,
): Promise<CleanIfUnchangedResult> {
  // Probe the working-tree first so we can name the precise reason.
  const status = await gitExec(["status", "--porcelain"], entry.dir);
  if (status.exitCode !== 0) {
    const errorKind = classifyGitFailure(status.stdout);
    throw new WorktreeGitError(
      `git status --porcelain failed (exit ${status.exitCode})`,
      errorKind,
      "Could not read the worktree status; preserving the worktree rather than risk data loss.",
    );
  }
  const dirty =
    status.stdout.split("\n").filter((line) => line.trim().length > 0).length > 0;
  if (dirty) {
    logPreserve(logger, entry, "dirty");
    return { removed: false, reason: "dirty" };
  }

  const head = await gitExec(["rev-parse", "HEAD"], entry.dir);
  const base = await gitExec(["rev-parse", entry.baseRef], entry.dir);
  if (head.exitCode !== 0 || base.exitCode !== 0) {
    const bad = head.exitCode !== 0 ? head : base;
    const errorKind = classifyGitFailure(bad.stdout);
    throw new WorktreeGitError(
      `git rev-parse failed (exit ${bad.exitCode})`,
      errorKind,
      "Could not resolve the worktree HEAD/base; preserving the worktree.",
    );
  }
  if (head.stdout.trim() !== base.stdout.trim()) {
    logPreserve(logger, entry, "ahead");
    return { removed: false, reason: "ahead" };
  }

  // Pristine → safe to remove. `--force` only overrides git's dirty-refusal,
  // which the predicate has already ruled out.
  const removed = await gitExec(["worktree", "remove", "--force", entry.dir], entry.dir);
  if (removed.exitCode !== 0) {
    const errorKind = classifyGitFailure(removed.stdout);
    logger?.warn(
      {
        worktreeDir: basename(entry.dir),
        reason: "remove-failed",
        errorKind: errorKind === "precondition" ? ("precondition" as const) : ("internal" as const),
        hint: "git worktree remove failed for a clean worktree; the worktree is left in place — reclaim manually.",
      },
      "worktree remove failed; preserving",
    );
    return { removed: false, reason: "remove-failed" };
  }
  return { removed: true };
}

/** Content-free WARN for a preserved (dirty/ahead) worktree (§2.7). */
function logPreserve(
  logger: ComisLogger | undefined,
  entry: WorktreeEntry,
  reason: "dirty" | "ahead",
): void {
  logger?.warn(
    {
      worktreeDir: basename(entry.dir),
      reason,
      errorKind: "precondition" as const,
      hint:
        reason === "dirty"
          ? "Worktree has uncommitted changes; preserved (not auto-cleaned) so the agent's work survives."
          : "Worktree has commits ahead of its base; preserved (not auto-cleaned) so the committed work survives.",
    },
    "worktree preserved — not clean-if-unchanged",
  );
}

// ---------------------------------------------------------------------------
// sweepOrphans — CONSERVATIVE orphan-sweep
// ---------------------------------------------------------------------------

/**
 * Sweep a registry of worktree entries, reclaiming ONLY:
 *   (a) entries whose dir is gone-from-disk (already removed — reclaimed by the
 *       single `git worktree prune` at the end; never a `worktree remove`), OR
 *   (b) entries whose child has COMPLETED and whose tree is pristine per
 *       {@link isWorktreeCleanIfUnchanged} (`git worktree remove`).
 *
 * It NEVER removes a dirty/ahead worktree, and NEVER removes an in-progress
 * (not-completed) worktree — those are PRESERVED. A `git worktree remove` failure
 * WARN-logs (hint + `errorKind`) and leaves the entry in `preserved` — there is
 * no silent drop and no whole-sweep abort (T-219-10). After the loop a single
 * `git worktree prune` clears stale `.git/worktrees/*` admin entries.
 *
 * @returns `{ removed, preserved }` — the dirs reclaimed vs. intentionally kept.
 */
export async function sweepOrphans(
  gitExec: GitExec,
  registry: WorktreeEntry[],
  deps: SweepDeps,
  logger?: ComisLogger,
): Promise<SweepSummary> {
  const removed: string[] = [];
  const preserved: string[] = [];

  for (const entry of registry) {
    // (a) Gone-from-disk: reclaimed by prune; never a `worktree remove`.
    if (!deps.exists(entry.dir)) {
      removed.push(entry.dir);
      continue;
    }
    // In-progress (not completed) → always preserved (the tree is being written).
    if (!entry.completed) {
      preserved.push(entry.dir);
      continue;
    }
    // (b) Completed + present: remove ONLY if pristine.
    let result: CleanIfUnchangedResult;
    try {
      result = await cleanIfUnchanged(gitExec, entry, logger);
    } catch (err) {
      // A probe failure must NOT abort the whole sweep or silently drop the
      // entry — preserve it and WARN content-free, then continue.
      const errorKind =
        err instanceof WorktreeGitError ? err.errorKind : ("internal" as const);
      logger?.warn(
        {
          worktreeDir: basename(entry.dir),
          reason: "probe-failed",
          errorKind,
          hint: "Could not evaluate the worktree for sweep; preserved — reclaim manually.",
        },
        "worktree sweep probe failed; preserving",
      );
      preserved.push(entry.dir);
      continue;
    }
    if (result.removed) {
      removed.push(entry.dir);
    } else {
      preserved.push(entry.dir);
    }
  }

  // A single prune to reclaim stale admin entries for the gone-from-disk dirs.
  const pruned = await gitExec(["worktree", "prune"], registry[0]?.dir ?? ".");
  if (pruned.exitCode !== 0) {
    logger?.warn(
      {
        prunedCount: removed.length,
        errorKind: classifyGitFailure(pruned.stdout),
        hint: "git worktree prune failed; stale .git/worktrees admin entries may remain — run `git worktree prune` manually.",
      },
      "worktree prune failed",
    );
  }

  return { removed, preserved };
}
