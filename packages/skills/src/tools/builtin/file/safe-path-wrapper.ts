// SPDX-License-Identifier: Apache-2.0
/**
 * Shared types and constants for Comis file tools.
 *
 * Previously contained SafePath/PathSuggestion/FileStateGuards wrappers;
 * those were deleted when all file tools became Comis-native.
 *
 * @module
 */

/**
 * Paths that can be resolved lazily (callback) or eagerly (static array).
 * Lazy resolution allows hot-added agent workspaces to be visible without
 * re-assembling the tool pipeline.
 */
export type LazyPaths = string[] | (() => string[]);

/**
 * Resolve a LazyPaths value to a concrete string array.
 * Returns empty array for undefined/null inputs.
 */
export function resolvePaths(paths: LazyPaths | undefined): string[] {
  if (!paths) return [];
  return typeof paths === "function" ? paths() : paths;
}

/** Minimal pino-compatible logger interface (skills doesn't import @comis/infra). */
export interface SafePathLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Workspace root files that agents cannot overwrite via file tools. */
export const PROTECTED_WORKSPACE_FILES: ReadonlyMap<string, string> = new Map([
  ["AGENTS.md", "ROLE.md"],
  ["SOUL.md", "ROLE.md"],
]);
