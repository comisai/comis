// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-worktree-sweep` — the worktree-orphan-sweep subsystem wiring.
 *
 * `spawn --worktree` runs a child in an ISOLATED git worktree created off
 * the child's jailed workspace. The happy path creates + auto-cleans-if-unchanged
 * inside one `executeSubAgent` call. But a CRASHED run (the daemon dies mid-child)
 * leaves the worktree + its `.git/worktrees/<name>` admin state orphaned. The sweep
 * reclaims those: a registry tracks every created worktree, and a boot (+ periodic)
 * sweep runs the lifecycle's CONSERVATIVE {@link sweepOrphans} — which removes ONLY
 * gone-from-disk or completed-AND-pristine entries and PRESERVES any dirty/ahead/
 * in-progress worktree (the agent's work survives).
 *
 * This module owns three pieces (mirroring the two-phase shape of
 * `setup-durable-resume.ts`):
 *   1. {@link createWorktreeRegistry} — the in-memory registry of created worktrees.
 *   2. {@link toLifecycleGitExec}     — the `ExecGitFn` (Result-returning, the
 *      daemon's `createExecGit`) → lifecycle `GitExec` (`{ stdout, exitCode }`)
 *      adapter, so the composition root binds ONE real git wrapper.
 *   3. {@link setupWorktreeSweep}     — boot `sweepNow()` + a periodic interval
 *      (the injected TimerPort, `.unref()`'d, cancelled on `shutdown()`).
 *
 * Observability (§2.7): content-free — the sweep logs counts (removed/preserved)
 * only; the lifecycle itself logs dir BASENAMES + reasons, never a path or a diff.
 *
 * @module
 */
import type { ClockPort, TimerPort, TimerHandle, ExecGitFn } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  sweepOrphans,
  type GitExec,
  type WorktreeEntry,
  type SweepSummary,
} from "@comis/skills/tools";

// ---------------------------------------------------------------------------
// WorktreeRegistry
// ---------------------------------------------------------------------------

/** Options for {@link WorktreeRegistry.register}. */
export interface RegisterWorktreeInput {
  dir: string;
  baseRef: string;
  branch: string;
  runId?: string;
}

/**
 * The in-memory registry of worktrees the daemon created. Tracks each entry so a
 * boot/periodic sweep can reclaim orphans from crashed runs. NOT persisted —
 * a registry lost to a crash is reconstructed by the sweep's gone-from-disk +
 * `git worktree prune` reclaim (the on-disk `.git/worktrees/*` admin state is the
 * durable record; this registry is the live-process index over it).
 */
export interface WorktreeRegistry {
  /** Record a just-created worktree (completed:false until its child settles). */
  register(input: RegisterWorktreeInput): void;
  /** Mark the worktree at `dir` as completed (its child settled) so the sweep may reclaim it once pristine. */
  markCompleted(dir: string): void;
  /** Drop the entry at `dir` (after a successful clean) so the registry stays bounded. */
  remove(dir: string): void;
  /** A snapshot copy of the current entries (safe to iterate during a sweep). */
  snapshot(): WorktreeEntry[];
}

/** Build an empty {@link WorktreeRegistry}. */
export function createWorktreeRegistry(): WorktreeRegistry {
  // Keyed by dir (the worktree's working-tree path is unique).
  const entries = new Map<string, WorktreeEntry>();
  return {
    register(input: RegisterWorktreeInput): void {
      entries.set(input.dir, {
        dir: input.dir,
        baseRef: input.baseRef,
        branch: input.branch,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        completed: false,
      });
    },
    markCompleted(dir: string): void {
      const entry = entries.get(dir);
      if (entry) entry.completed = true;
    },
    remove(dir: string): void {
      entries.delete(dir);
    },
    snapshot(): WorktreeEntry[] {
      return [...entries.values()].map((e) => ({ ...e }));
    },
  };
}

// ---------------------------------------------------------------------------
// discoverWorktreeOrphans — boot recovery across a restart
// ---------------------------------------------------------------------------

/** The path segment that marks a dir as a comis-managed per-run worktree. */
const COMIS_WORKTREE_MARKER = `/.worktrees/wt-`;

/** Deps for {@link discoverWorktreeOrphans}. */
export interface DiscoverWorktreeOrphansDeps {
  /** The daemon's real git executor. */
  execGit: ExecGitFn;
  /** The registry to seed with discovered orphans (as completed entries). */
  registry: WorktreeRegistry;
  /** The agent workspace dirs — only worktrees under `<dir>/.worktrees/wt-*` are OURS to seed. */
  workspaceDirs: string[];
  logger: ComisLogger;
}

/**
 * Discover comis-managed worktrees left on disk by a CRASHED prior daemon process
 * (the in-memory registry is empty after a restart, but `.git/worktrees/*` admin
 * state survives) and seed them into the registry as COMPLETED entries so the boot
 * sweep may reclaim the pristine ones. Authoritative source: `git worktree list
 * --porcelain`. ONLY paths under an agent workspace's `.worktrees/wt-*` are seeded
 * — the operator's OWN worktrees (and the main worktree) are NEVER touched. The
 * base ref is unknown post-crash, so it is recorded as `HEAD` (the conservative
 * predicate then compares the worktree HEAD to the workspace HEAD — a committed-
 * ahead orphan is preserved, a pristine one is reclaimed). Returns the count seeded.
 */
export async function discoverWorktreeOrphans(
  deps: DiscoverWorktreeOrphansDeps,
): Promise<number> {
  const { execGit, registry, workspaceDirs, logger } = deps;
  if (workspaceDirs.length === 0) return 0;
  const log = logger.child({ submodule: "worktree-sweep" });
  // Run from the first workspace dir (any dir inside the repo enumerates the whole
  // worktree set — `git worktree list` is repo-global, not cwd-scoped).
  const res = await execGit(["worktree", "list", "--porcelain"], workspaceDirs[0]!);
  if (!res.ok) {
    log.debug(
      {
        err: res.error,
        hint: "git worktree list failed at boot; orphan discovery skipped — the periodic sweep retries",
        errorKind: "dependency" as const,
      },
      "Worktree orphan discovery: list failed",
    );
    return 0;
  }
  let seeded = 0;
  for (const line of res.value.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length).trim();
    // Only OUR worktrees: a dir under some agent workspace's `.worktrees/wt-`.
    const isComisWorktree = workspaceDirs.some((ws) =>
      dir.startsWith(`${ws}${COMIS_WORKTREE_MARKER}`),
    );
    if (!isComisWorktree) continue;
    // Already tracked (a live entry from this process) ⇒ skip (don't clobber).
    if (registry.snapshot().some((e) => e.dir === dir)) continue;
    const branch = dir.slice(dir.lastIndexOf("/") + 1);
    registry.register({ dir, baseRef: "HEAD", branch });
    // Seed as completed: the owning process is gone, so the sweep may reclaim it
    // once it proves pristine (never an in-progress entry it must preserve).
    registry.markCompleted(dir);
    seeded += 1;
  }
  if (seeded > 0) {
    log.info({ seededCount: seeded }, "Worktree orphan discovery: seeded prior-crash worktrees for sweep");
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// ExecGitFn → lifecycle GitExec adapter
// ---------------------------------------------------------------------------

/**
 * Adapt the daemon's `ExecGitFn` (returns `Result<string,string>`, never throws —
 * `config/exec-git.ts`) to the worktree-lifecycle's `GitExec` shape
 * (`{ stdout, exitCode }`). An `ok` Result maps to exit 0 carrying the stdout
 * value; an `err` Result maps to a non-zero exit carrying the error message AS
 * stdout, so the lifecycle's `classifyGitFailure` (which reads the text for the
 * not-a-repo / git-absent signals) classifies it correctly. This lets the
 * composition root bind ONE real git wrapper for both config-git and worktrees.
 */
export function toLifecycleGitExec(execGit: ExecGitFn): GitExec {
  return async (args: string[], cwd: string) => {
    const res = await execGit(args, cwd);
    if (res.ok) return { stdout: res.value, exitCode: 0 };
    // Non-zero exit carrying the message as stdout (classifyGitFailure reads it).
    return { stdout: res.error, exitCode: 1 };
  };
}

// ---------------------------------------------------------------------------
// setupWorktreeSweep — boot + periodic orphan sweep
// ---------------------------------------------------------------------------

/** Deps for {@link setupWorktreeSweep}. */
export interface SetupWorktreeSweepDeps {
  /** The daemon's real git executor (composition root binds `createExecGit()`). */
  execGit: ExecGitFn;
  /** The shared registry executeSubAgent writes into and the sweep reads. */
  registry: WorktreeRegistry;
  /** True if a worktree dir is still present on disk (injected — never touches fs in tests). */
  exists: (dir: string) => boolean;
  timers: TimerPort;
  clock: ClockPort;
  logger: ComisLogger;
  /** Periodic sweep cadence (ms). Defaults to 30 minutes. */
  sweepIntervalMs?: number;
}

/** Handle returned by {@link setupWorktreeSweep}. */
export interface WorktreeSweepHandle {
  /** Run ONE conservative orphan-sweep now (the boot pass). Returns the summary. */
  sweepNow(): Promise<SweepSummary>;
  /** Start the daemon-wide periodic sweep interval (`.unref()`'d). Idempotent. */
  startPeriodicSweep(): void;
  /** Cancel the periodic interval — no leaked timer. */
  shutdown(): void;
}

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60_000;

/**
 * Wire the orphan sweep. `sweepNow()` runs the lifecycle's conservative
 * {@link sweepOrphans} over the registry snapshot (so a removal during the pass
 * cannot mutate the iteration), and PRUNES reclaimed entries from the registry.
 * `startPeriodicSweep()` registers ONE `.unref()`'d interval; `shutdown()` cancels
 * it. A swept (removed) entry is dropped from the registry; a preserved one stays
 * (so a later sweep retries it once its child commits or the tree is cleaned).
 */
export function setupWorktreeSweep(deps: SetupWorktreeSweepDeps): WorktreeSweepHandle {
  const { execGit, registry, exists, timers, clock, logger } = deps;
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const gitExec = toLifecycleGitExec(execGit);
  const log = logger.child({ submodule: "worktree-sweep" });

  let interval: TimerHandle | undefined;

  const sweepNow = async (): Promise<SweepSummary> => {
    const startMs = clock.now();
    const snapshot = registry.snapshot();
    if (snapshot.length === 0) {
      return { removed: [], preserved: [] };
    }
    const summary = await sweepOrphans(gitExec, snapshot, { exists }, log);
    // Prune reclaimed entries from the live registry (preserved entries stay so a
    // later pass retries them once the child commits or the tree is cleaned).
    for (const dir of summary.removed) registry.remove(dir);
    log.info(
      {
        removedCount: summary.removed.length,
        preservedCount: summary.preserved.length,
        durationMs: clock.now() - startMs,
      },
      "Worktree orphan sweep complete",
    );
    return summary;
  };

  const startPeriodicSweep = (): void => {
    if (interval) return;
    interval = timers.setInterval(() => {
      void sweepNow().catch((err: unknown) => {
        log.warn(
          {
            err,
            hint: "periodic worktree sweep failed; the next tick retries — no worktree was removed this pass",
            errorKind: "internal" as const,
          },
          "Worktree sweep: periodic pass failed",
        );
      });
    }, sweepIntervalMs);
    interval.unref();
  };

  const shutdown = (): void => {
    interval?.cancel();
    interval = undefined;
  };

  return { sweepNow, startPeriodicSweep, shutdown };
}
