// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * JAIL-03 bind-mount validator — a PURE denylist backstop on top of the
 * allow-list jail binds (v8 invariant 10: the validator does NOT decide what to
 * bind, it only refuses dangerous binds).
 *
 * It rejects three classic jail-escape shapes (escapes are symlink/parent-mount,
 * not kernel bugs):
 *   1. Direct hit  — `hostPath` IS or is UNDER a denylisted dir.
 *   2. Parent-cover — `hostPath` is a coarse ancestor that COVERS a blocked
 *      descendant (binding `/` or `~` would expose `~/.ssh`).
 *   3. Symlink-escape — a leaf (or any ancestor segment) is a symlink whose
 *      realpath resolves INTO a denylisted path. Resolved THROUGH ancestors via
 *      per-segment `realpathSync` (the `safe-path.ts` checkSymlinks primitive),
 *      NEVER a string-prefix check on the unresolved path.
 *
 * Purity: `home` is a PARAMETER (never read from the ambient environment),
 * mirroring `getUserRoPaths(home)` in bwrap-provider.ts. The only I/O is
 * `fs.realpathSync` for symlink resolution — no environment reads, no writes.
 */

/** System directories never safe to bind into the jail (`/` itself + any path under them). */
const DENYLIST_SYSTEM_DIRS = ["/etc", "/proc", "/sys", "/dev", "/root", "/run"] as const;

/** Credential directories under the daemon HOME — `~` resolved to the `home` param. */
function denylistedHomeDirs(home: string): string[] {
  // eslint-disable-next-line no-restricted-syntax -- this is a path VALIDATOR (the inverse of safePath); it builds the BLOCKED set from constant credential-dir basenames under HOME. safePath would confine to a base and throw on the system paths this validator must also inspect.
  return [".ssh", ".aws", ".gnupg", ".config", ".npm", ".netrc"].map((d) => path.join(home, d));
}

/**
 * Resolve `abs` to a fully symlink-resolved absolute path, tolerating a
 * not-yet-created leaf. Walk from the filesystem root, `realpathSync` the
 * longest existing prefix (which follows any symlinked ancestor), then re-append
 * the remaining non-existent tail. A leaf symlink pointing at `/etc` therefore
 * resolves to `/etc`; a bind path whose parents exist but leaf does not still
 * validates by its real ancestors. Mirrors the existence-tolerant loop in
 * `safe-path.ts` checkSymlinks.
 */
function resolveThroughAncestors(abs: string): string {
  // Fast path: the whole path exists — realpath resolves every symlink segment.
  try {
    return fs.realpathSync(abs);
  } catch {
    // Leaf (or deeper) does not exist yet — resolve the longest existing prefix.
  }

  const parts = abs.split(path.sep).filter((p) => p.length > 0);
  let resolvedPrefix: string = path.sep; // POSIX root (widened from the path.sep literal)
  let tailIndex = 0;

  for (let i = 0; i < parts.length; i++) {
    // eslint-disable-next-line no-restricted-syntax -- resolve-through-ancestors needs raw path.join to rebuild each absolute segment from the kernel-resolved prefix; safePath's base-confinement would reject the symlink-to-blocked-target cases this loop exists to DETECT.
    const candidate = path.join(resolvedPrefix, parts[i]!);
    try {
      // realpathSync resolves a symlinked segment to its real target.
      resolvedPrefix = fs.realpathSync(candidate);
      tailIndex = i + 1;
    } catch {
      // This segment does not exist — stop; everything from here is literal tail.
      break;
    }
  }

  const tail = parts.slice(tailIndex);
  // eslint-disable-next-line no-restricted-syntax -- re-append the not-yet-created tail to the resolved prefix; this is absolute-path reconstruction inside a validator, not a base-confined join.
  return tail.length > 0 ? path.join(resolvedPrefix, ...tail) : resolvedPrefix;
}

/** True when `child` IS `parent` or sits strictly UNDER it (boundary-safe, not a bare prefix). */
function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const normalizedParent = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(normalizedParent);
}

/**
 * Validate a host path requested as a bwrap bind source.
 *
 * @param hostPath - The host path the jail would `--bind`.
 * @param home - The daemon user's HOME (the credential-dir base). PASSED IN for purity.
 * @returns `{ ok: true }` when the bind is safe, else `{ ok: false, reason }`.
 */
export function validateBindMount(
  hostPath: string,
  home: string,
): { ok: true } | { ok: false; reason: string } {
  // 1. Canonical absolute path, then resolve symlinks through ancestors so a
  //    symlinked leaf cannot smuggle a blocked path past the compare below.
  const abs = path.resolve(hostPath);
  const resolved = resolveThroughAncestors(abs);

  // 2. The blocked set: system dirs + the HOME credential dirs (resolved too, so
  //    a symlinked HOME or credential dir is compared by its real location).
  const blocked = [
    ...DENYLIST_SYSTEM_DIRS.map((b) => resolveThroughAncestors(b)),
    ...denylistedHomeDirs(home).map((b) => resolveThroughAncestors(b)),
  ];

  // 3. Direct/under check: the resolved bind IS or is UNDER a blocked dir.
  for (const b of blocked) {
    if (isAtOrUnder(resolved, b)) {
      return { ok: false, reason: `bind path resolves into blocked dir ${b}` };
    }
  }

  // 4. Parent-cover check: the resolved bind is an ancestor that COVERS a
  //    blocked descendant (a coarse `/` or `~` bind must not smuggle `~/.ssh`).
  for (const b of blocked) {
    if (isAtOrUnder(b, resolved)) {
      return { ok: false, reason: `bind path is a parent covering blocked descendant ${b}` };
    }
  }

  return { ok: true };
}
