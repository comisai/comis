// SPDX-License-Identifier: Apache-2.0
/**
 * Path suggestion utility with Levenshtein fuzzy matching.
 *
 * Provides "Did you mean: X?" suggestions when an LLM provides a
 * non-existent file path. Uses capped directory scanning to avoid
 * blocking the event loop on large directories, and validates all
 * suggestions through safePath to prevent traversal escapes.
 *
 * Two-level strategy:
 * 1. Directory exists, filename not found -> suggest similar filenames
 * 2. Directory does not exist -> suggest similar directory names from parent
 *
 * @module
 */

import { existsSync, opendirSync, statSync } from "node:fs";
import { dirname, basename } from "node:path";
import { safePath, PathTraversalError } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SUGGESTIONS = 3;
export const MIN_SIMILARITY = 0.4;
export const MAX_DIR_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try safePath, returning undefined on PathTraversalError.
 * Re-throws all other errors.
 */
function trySafePath(base: string, ...segments: string[]): string | undefined {
  try {
    return safePath(base, ...segments);
  } catch (error) {
    if (error instanceof PathTraversalError) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Levenshtein distance and similarity
// ---------------------------------------------------------------------------

/**
 * Classic Levenshtein edit distance using O(n) space two-row optimization.
 *
 * Returns the minimum number of single-character insertions, deletions,
 * or substitutions required to transform string `a` into string `b`.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Similarity score derived from Levenshtein distance.
 *
 * Returns a value between 0 (completely different) and 1 (identical).
 * Two empty strings are considered identical (returns 1).
 *
 * Formula: `1 - levenshteinDistance(a, b) / max(a.length, b.length)`
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Capped directory reading
// ---------------------------------------------------------------------------

/**
 * Read directory entries with an entry cap to prevent scanning large directories.
 *
 * Uses `opendirSync()` + `readSync()` (NOT `readdirSync()`) for early
 * termination without materializing the full directory listing.
 *
 * Returns an empty array on any filesystem error (ENOENT, EACCES, etc.).
 * Always closes the directory handle in a finally block.
 */
export function readDirCapped(
  dirPath: string,
  cap: number = MAX_DIR_ENTRIES,
): string[] {
  const entries: string[] = [];
  let dir;
  try {
    dir = opendirSync(dirPath);
    let entry = dir.readSync();
    while (entry !== null && entries.length < cap) {
      entries.push(entry.name);
      entry = dir.readSync();
    }
    return entries;
  } catch {
    return [];
  } finally {
    dir?.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Path suggestion
// ---------------------------------------------------------------------------

/**
 * Suggest similar paths for a non-existent target path.
 *
 * Two-level strategy:
 * - **Case 1 (directory exists, file not found):** Scan the directory for
 *   filenames similar to the target basename. Filter by MIN_SIMILARITY,
 *   sort descending by score, return top MAX_SUGGESTIONS as absolute paths.
 * - **Case 2 (directory does not exist):** Scan the parent directory for
 *   similar directory names. If the original filename exists within a
 *   matching directory, return that full path. Otherwise return the
 *   matching directory paths.
 *
 * All suggested paths are validated through `safePath()` to prevent
 * traversal escapes. Directories exceeding MAX_DIR_ENTRIES return no
 * suggestions (too large to scan efficiently).
 *
 * @param targetPath - Absolute path that was not found (already resolved via safePath)
 * @param workspacePath - Workspace root for traversal validation
 * @returns Array of suggested absolute paths (max MAX_SUGGESTIONS), or empty
 */
export function suggestSimilarPaths(
  targetPath: string,
  workspacePath: string,
): string[] {
  const dir = dirname(targetPath);
  const name = basename(targetPath);

  // Case 1: Directory exists, filename doesn't match
  if (existsSync(dir)) {
    try {
      if (!statSync(dir).isDirectory()) return [];
    } catch {
      return [];
    }

    const entries = readDirCapped(dir);
    if (entries.length >= MAX_DIR_ENTRIES) return []; // too large to scan

    return entries
      .map((entry) => {
        const resolved = trySafePath(workspacePath, dir, entry);
        return resolved
          ? {
              path: resolved,
              score: levenshteinSimilarity(
                name.toLowerCase(),
                entry.toLowerCase(),
              ),
            }
          : undefined;
      })
      .filter(
        (e): e is { path: string; score: number } =>
          e !== undefined && e.score >= MIN_SIMILARITY,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
      .map((e) => e.path);
  }

  // Case 2: Directory doesn't exist -- match directory name in parent
  const parentDir = dirname(dir);
  const dirName = basename(dir);

  if (!existsSync(parentDir)) return [];
  try {
    if (!statSync(parentDir).isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = readDirCapped(parentDir);
  if (entries.length >= MAX_DIR_ENTRIES) return [];

  const dirMatches = entries
    .filter((e) => {
      const resolved = trySafePath(workspacePath, parentDir, e);
      if (!resolved) return false;
      try {
        return statSync(resolved).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      dir: trySafePath(workspacePath, parentDir, entry)!,
      score: levenshteinSimilarity(dirName.toLowerCase(), entry.toLowerCase()),
    }))
    .filter((e) => e.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (dirMatches.length > 0) {
    // Suggest corrected directory + original filename if that file exists
    const corrected = trySafePath(workspacePath, dirMatches[0].dir, name);
    if (corrected && existsSync(corrected)) return [corrected];
    // Otherwise suggest matching directory paths
    return dirMatches.slice(0, MAX_SUGGESTIONS).map((m) => m.dir);
  }

  return [];
}
