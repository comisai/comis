// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Error thrown when a path traversal attempt is detected.
 * Includes the base directory and the attempted path for diagnostics.
 */
export class PathTraversalError extends Error {
  public readonly name = "PathTraversalError" as const;
  public readonly base: string;
  public readonly attempted: string;

  constructor(base: string, attempted: string) {
    super(`Path traversal blocked: "${attempted}" escapes base "${base}"`);
    this.base = base;
    this.attempted = attempted;
  }
}

/**
 * Safely resolve a path within a base directory, preventing traversal attacks.
 *
 * Defends against:
 * - Basic traversal (../ sequences)
 * - URL-encoded traversal (%2e%2e%2f)
 * - Prefix attacks (/uploads vs /uploads-evil)
 * - Null byte injection
 * - Symlink-based escapes
 *
 * @param base - The trusted base directory (must be absolute)
 * @param segments - Path segments to join under base
 * @returns The resolved, validated absolute path
 * @throws PathTraversalError if the resolved path escapes base
 */
export function safePath(base: string, ...segments: string[]): string {
  // 1. Reject null bytes in any segment
  for (const segment of segments) {
    if (segment.includes("\0")) {
      throw new PathTraversalError(base, segment);
    }
  }

  // 2. Decode URL-encoded sequences before resolving
  const decodedSegments = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      // If decoding fails (malformed %), use the raw segment
      return s;
    }
  });

  // 3. Resolve to canonical absolute path
  const resolved = path.resolve(base, ...decodedSegments);

  // 4. Normalize base with trailing separator for prefix check
  const normalizedBase = base.endsWith(path.sep) ? base : base + path.sep;

  // 5. Prefix check: resolved must be base itself OR start with base + sep
  if (resolved !== base && !resolved.startsWith(normalizedBase)) {
    throw new PathTraversalError(base, resolved);
  }

  // 6. Symlink detection: walk each intermediate path segment and check for symlinks
  //    that resolve outside the base directory
  if (segments.length > 0) {
    checkSymlinks(base, resolved);
  }

  return resolved;
}

/**
 * Walk the resolved path from base downward, checking each component for
 * symlinks that escape the base directory.
 */
function checkSymlinks(base: string, resolved: string): void {
  const relative = path.relative(base, resolved);
  if (!relative) return;

  const parts = relative.split(path.sep);
  let current = base;

  for (const part of parts) {
    // eslint-disable-next-line no-restricted-syntax -- safePath implementation needs raw path.join
    current = path.join(current, part);

    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        // Resolve the symlink target and check if it escapes base
        const realTarget = fs.realpathSync(current);
        const normalizedBase = base.endsWith(path.sep) ? base : base + path.sep;

        if (realTarget !== base && !realTarget.startsWith(normalizedBase)) {
          throw new PathTraversalError(base, resolved);
        }
      }
    } catch (error) {
      // Re-throw PathTraversalError
      if (error instanceof PathTraversalError) {
        throw error;
      }
      // Path doesn't exist yet -- that's fine, no symlink to check
    }
  }
}
