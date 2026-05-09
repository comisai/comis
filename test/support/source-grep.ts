// SPDX-License-Identifier: Apache-2.0
/**
 * Source-grep helper for cross-package architecture invariants.
 *
 * Recursively walks a directory tree (default `.ts` files; configurable),
 * skipping standard exclude directories (`__tests__`, `__snapshots__`,
 * `dist`, `node_modules`) plus any caller-supplied excludes, and returns
 * file paths whose contents match a string or RegExp needle.
 *
 * Used by `packages/<pkg>/src/__tests__/architecture.test.ts` files to
 * enforce production/test boundary invariants.
 *
 * Implementation: plain `node:fs.readdirSync` recursion (no glob transitive
 * dep) -- keeps the helper dependency-free and matches AGENTS.md §2.3
 * KISS/YAGNI.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SourceGrepOptions {
  /** Absolute path to the root directory to walk. */
  readonly rootDir: string;
  /** String or RegExp to search for in each file's contents. */
  readonly needle: string | RegExp;
  /**
   * Directory NAMES (not paths) to skip during walk.
   * Default: ["__tests__", "__snapshots__", "dist", "node_modules"].
   */
  readonly excludeDirs?: readonly string[];
  /** File extensions to scan. Default: [".ts"]. */
  readonly extensions?: readonly string[];
  /**
   * File-name suffixes/substrings to skip during scan (matched against the
   * basename, not the full path). Useful for filtering out `.test.ts` files
   * so production-only source-grep tests do not trip on test-file string
   * literals. Empty by default (no extra filtering).
   *
   * @example
   * findInSourceFiles({ rootDir, needle, excludeFileSuffixes: [".test.ts"] })
   */
  readonly excludeFileSuffixes?: readonly string[];
}

export interface SourceGrepResult {
  /** Absolute paths of files whose contents matched the needle. */
  readonly matches: readonly string[];
  /** Total number of files actually opened and checked (sanity). */
  readonly checkedFiles: number;
}

const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  "__tests__",
  "__snapshots__",
  "dist",
  "node_modules",
];
const DEFAULT_EXTENSIONS: readonly string[] = [".ts"];

/**
 * Walk `rootDir` and return file paths containing `needle`.
 *
 * Symlinks are NOT followed (`readdirSync` with `withFileTypes` reports
 * symlinks via `isSymbolicLink()` and they are skipped here), so symlink
 * loops cannot hang the walk.
 *
 * @example
 * const result = findInSourceFiles({
 *   rootDir: "/abs/path/packages/core/src",
 *   needle: "createCapabilityPortStub",
 *   excludeDirs: ["__test-helpers"],  // skip the test stub's own dir
 * });
 * expect(result.matches).toEqual([]);
 * expect(result.checkedFiles).toBeGreaterThan(0);
 */
export function findInSourceFiles(opts: SourceGrepOptions): SourceGrepResult {
  const exclude = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const excludeSuffixes = opts.excludeFileSuffixes ?? [];
  const matches: string[] = [];
  let checkedFiles = 0;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Directory missing or inaccessible; skip silently.
    }
    for (const entry of entries) {
      // Skip hidden files/dirs (`.git`, `.DS_Store`, etc.).
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // Do not follow symlinks (loop guard).
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
        if (excludeSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
          continue;
        }
        checkedFiles++;
        const content = readFileSync(full, "utf8");
        const isMatch =
          typeof opts.needle === "string"
            ? content.includes(opts.needle)
            : opts.needle.test(content);
        if (isMatch) matches.push(full);
      }
    }
  }

  walk(opts.rootDir);
  return { matches: Object.freeze(matches.slice()), checkedFiles };
}
