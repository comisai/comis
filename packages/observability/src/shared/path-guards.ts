// @allow-throw: PathEscapeError + resolveContainedPathOrThrow are sanctioned boundary throws — observability artifact writers call the throwing variant at their narrow trust boundary and translate at the catch site. The non-throwing variant `resolveContainedPath` returns Result<string, PathEscapeError> for the standard early-return-chained call sites per AGENTS.md §2.1.
// SPDX-License-Identifier: Apache-2.0
/**
 * Path-containment + filename-normalization guards for observability
 * artifact writes.
 *
 * Three orthogonal concerns:
 *
 *   1. **`resolveContainedPath` / `resolveContainedPathOrThrow`** —
 *      `path.resolve(base, ...segments)` + a contained-prefix check.
 *      The non-throwing variant returns `Result<string, PathEscapeError>`
 *      (AGENTS.md §2.1 default); the throwing variant exists for the
 *      thin boundary callers that re-translate the throw to a `Result`
 *      one level up (see the file header `@allow-throw`).
 *
 *      NOTE: this is intentionally a lighter sibling of
 *      `@comis/core/security.safePath`. `safePath` also walks symlinks
 *      at intermediate path components. The observability writer pairs
 *      `resolveContainedPath` with `appendRegularFile` from
 *      `@comis/infra/fs-safe` which performs `lstat` + `O_NOFOLLOW`
 *      at the actual open() boundary — splitting the symlink check
 *      from the path-string check keeps each helper single-purpose.
 *
 *   2. **`safeTrajectorySessionFileName`** — collapse an arbitrary
 *      session id into a filesystem-safe filename. Any character
 *      outside `[a-zA-Z0-9_-]` becomes `_`; result is sliced to 120
 *      chars max. If the result is empty (input had no allowed chars,
 *      or was whitespace-only) the literal `"session"` is returned —
 *      the writer always has a deterministic file path even when the
 *      session-id source is unreliable.
 *
 *   3. **`resolveSafeOpenFlags`** — the canonical fs.open flag set for
 *      the diagnostics writers: `O_CREAT | O_TRUNC | O_WRONLY |
 *      O_NOFOLLOW` on POSIX. `O_NOFOLLOW` is conditionally ORed in
 *      when present on the host (`node:fs.constants.O_NOFOLLOW` is
 *      POSIX-only — Windows omits it). Research §7 confirmed this is
 *      the first `O_NOFOLLOW` use in the repo.
 *
 * @module
 */

import { constants as fsConstants } from "node:fs";
import { resolve, sep } from "node:path";

import { ok, err, type Result } from "@comis/shared";

/** Allowed-char regex for `safeTrajectorySessionFileName`. */
const SESSION_ALLOWED_CHAR = /[^a-zA-Z0-9_-]/g;
const SESSION_FILENAME_MAX = 120;

/**
 * Error thrown / returned when a path resolution escapes its base.
 */
export class PathEscapeError extends Error {
  public readonly name = "PathEscapeError" as const;
  public readonly code = "PATH_ESCAPE" as const;
  public readonly base: string;
  public readonly attempted: string;

  constructor(base: string, attempted: string) {
    super(`Path escape blocked: "${attempted}" escapes base "${base}"`);
    this.base = base;
    this.attempted = attempted;
  }
}

/**
 * Resolve `base + segments` and verify the result stays inside `base`.
 * Returns a `Result` — non-throwing variant suitable for the default
 * early-return-chained call sites per AGENTS.md §2.1.
 *
 * @param base - absolute base directory
 * @param segments - path segments to append under base
 * @returns Result with resolved path on success; `PathEscapeError` on
 *   containment violation.
 */
export function resolveContainedPath(
  base: string,
  ...segments: string[]
): Result<string, PathEscapeError> {
  const resolved = resolve(base, ...segments);
  const normalizedBase = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(normalizedBase)) {
    return err(new PathEscapeError(base, resolved));
  }
  return ok(resolved);
}

/**
 * Throwing variant for the narrow boundary callers that want a single
 * try/catch translation at their entry point. Delegates to the
 * non-throwing variant and throws on failure.
 *
 * @param base - absolute base directory
 * @param segments - path segments to append under base
 * @returns the resolved path
 * @throws PathEscapeError when the result escapes the base
 */
export function resolveContainedPathOrThrow(
  base: string,
  ...segments: string[]
): string {
  const result = resolveContainedPath(base, ...segments);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Collapse an arbitrary session id into a filesystem-safe filename.
 *
 * Replaces any character outside `[a-zA-Z0-9_-]` with `_`. Slices the
 * result to 120 chars. Falls back to the literal `"session"` when the
 * input has no allowed characters (so the writer always has a
 * deterministic file path).
 *
 * @param sessionId - raw session identifier (any string)
 * @returns a filesystem-safe filename, never empty, never longer than 120
 */
export function safeTrajectorySessionFileName(sessionId: string): string {
  const replaced = sessionId.replace(SESSION_ALLOWED_CHAR, "_");
  const sliced = replaced.slice(0, SESSION_FILENAME_MAX);
  // After replacement + slice, the result may be a sequence of underscores
  // (input was all-disallowed) or empty. Fall back to "session" so the writer
  // never produces an empty filename.
  if (sliced.length === 0 || /^_+$/.test(sliced)) return "session";
  return sliced;
}

/**
 * Resolve the canonical fs.open flag set for an observability artifact
 * write: `O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW`. `O_NOFOLLOW` is
 * conditionally ORed in when present on the host (POSIX-only).
 *
 * @returns the OR'd integer flag value to pass to `fs.open` / `fs.openSync`
 */
export function resolveSafeOpenFlags(): number {
  let flags = fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY;
  const nofollow = (fsConstants as Record<string, number | undefined>)[
    "O_NOFOLLOW"
  ];
  if (typeof nofollow === "number") flags |= nofollow;
  return flags;
}
