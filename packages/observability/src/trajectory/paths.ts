// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory file-path resolution helpers (Plan 45-03).
 *
 * Three concerns kept as separate functions:
 *
 *   1. `resolveTrajectoryFilePath(input)` — picks the absolute file path
 *      to write the per-session trajectory JSONL to. Precedence:
 *        1. explicit `trajectoryDir`
 *        2. `COMIS_TRAJECTORY_DIR` env var
 *        3. co-location with `sessionFile` (`<sessionFile>.trajectory.jsonl`)
 *        4. `workspaceDir`
 *        5. `process.cwd()` (last resort — keeps the writer deterministic)
 *
 *   2. `resolveTrajectoryPointerFilePath(sessionFile)` — the pointer
 *      file path: `<sessionFile>.trajectory-path.json`. Operators that
 *      tail `~/.comis/sessions/<id>.jsonl` use this pointer to discover
 *      where the trajectory lives when `COMIS_TRAJECTORY_DIR` is set
 *      to a non-default location.
 *
 *   3. `resolveTrajectoryPointerOpenFlags()` — proxy to
 *      `resolveSafeOpenFlags()` from 45-01 (same `O_CREAT | O_TRUNC |
 *      O_WRONLY | O_NOFOLLOW` on POSIX). Re-exported under a
 *      trajectory-named symbol so call-site reads cleanly.
 *
 * The session ID is always passed through `safeTrajectorySessionFileName`
 * (45-01) before being used as a filename component — defense-in-depth
 * even when the runtime path resolves through a sessionFile or
 * workspaceDir. `resolveContainedPath` enforces the parent-dir bound.
 *
 * @module
 */

import {
  resolveContainedPath,
  resolveSafeOpenFlags,
  safeTrajectorySessionFileName,
} from "../shared/path-guards.js";

const TRAJECTORY_SUFFIX = ".trajectory.jsonl";
const TRAJECTORY_POINTER_SUFFIX = ".trajectory-path.json";

/**
 * Input to `resolveTrajectoryFilePath`. All path inputs are optional —
 * the helper picks the first available source per the documented
 * precedence above and falls back to `process.cwd()` as last resort
 * so the writer always has a deterministic file.
 */
export interface ResolveTrajectoryFilePathInput {
  /** Session identifier — gets normalized via `safeTrajectorySessionFileName`. */
  readonly sessionId: string;
  /** Explicit trajectory base directory; overrides env var when present. */
  readonly trajectoryDir?: string;
  /** Path to the per-session JSONL writer's output file. */
  readonly sessionFile?: string;
  /** Agent workspace directory; used as fourth-precedence base. */
  readonly workspaceDir?: string;
}

/**
 * Resolve the absolute on-disk path of the per-session trajectory JSONL.
 *
 * Precedence (first matching source wins):
 *
 *   1. `input.trajectoryDir` is set → `<dir>/<safeId>.trajectory.jsonl`
 *   2. `process.env.COMIS_TRAJECTORY_DIR` is set → same shape as (1)
 *   3. `input.sessionFile` is set → `<sessionFile>.trajectory.jsonl`
 *   4. `input.workspaceDir` is set → `<workspaceDir>/<safeId>.trajectory.jsonl`
 *   5. `process.cwd()` → `<cwd>/<safeId>.trajectory.jsonl`
 *
 * Path-escape protection: when the chosen base is a directory (not the
 * sessionFile co-location case), the sessionId is collapsed via
 * `safeTrajectorySessionFileName` AND the resolved path is verified
 * inside the base via `resolveContainedPath`. The fail-closed contract
 * is that any escape falls back to `<base>/session.trajectory.jsonl`.
 */
export function resolveTrajectoryFilePath(
  input: ResolveTrajectoryFilePathInput,
): string {
  const explicit = input.trajectoryDir;
  if (typeof explicit === "string" && explicit.length > 0) {
    return resolveInsideDir(explicit, input.sessionId);
  }

  const fromEnv = readEnvDir();
  if (fromEnv !== undefined) {
    return resolveInsideDir(fromEnv, input.sessionId);
  }

  const sessionFile = input.sessionFile;
  if (typeof sessionFile === "string" && sessionFile.length > 0) {
    return `${sessionFile}${TRAJECTORY_SUFFIX}`;
  }

  const workspaceDir = input.workspaceDir;
  if (typeof workspaceDir === "string" && workspaceDir.length > 0) {
    return resolveInsideDir(workspaceDir, input.sessionId);
  }

  return resolveInsideDir(process.cwd(), input.sessionId);
}

/**
 * Resolve the pointer-file path (`<sessionFile>.trajectory-path.json`).
 * Operators that tail the session JSONL use this pointer to discover
 * where the trajectory lives when `COMIS_TRAJECTORY_DIR` redirects it.
 *
 * @param sessionFile - absolute path to the per-session JSONL writer's output
 * @returns absolute path to the pointer file
 */
export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return `${sessionFile}${TRAJECTORY_POINTER_SUFFIX}`;
}

/**
 * Canonical fs.open flag set for the pointer-file write:
 * `O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW` on POSIX. Re-exports the
 * 45-01 helper under a trajectory-specific name so call sites read
 * cleanly without leaking the shared helper's name.
 */
export function resolveTrajectoryPointerOpenFlags(): number {
  return resolveSafeOpenFlags();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEnvDir(): string | undefined {
  // Direct env-read inside the sanctioned observability substrate is
  // allowed for this top-level boundary helper (the writer is invoked
  // from non-DI paths like the per-session lifecycle hook). The
  // architecture allow-list lives in test/architecture/globals.test.ts.
  const raw = process.env.COMIS_TRAJECTORY_DIR;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function resolveInsideDir(baseDir: string, sessionId: string): string {
  const filename = `${safeTrajectorySessionFileName(sessionId)}${TRAJECTORY_SUFFIX}`;
  const contained = resolveContainedPath(baseDir, filename);
  if (contained.ok) return contained.value;
  // Fail-closed: collapse to a deterministic fallback inside the base.
  // The safeTrajectorySessionFileName collapse already prevents traversal
  // in practice, so this branch is defense-in-depth.
  return `${baseDir}/session${TRAJECTORY_SUFFIX}`;
}
