// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace file-path resolution helper.
 *
 * Single-function resolver — mirrors `trajectory/paths.ts` but simpler
 * because the cache-trace artifact is one fixed file path
 * (`~/.comis/logs/cache-trace.jsonl` by default) rather than a
 * per-session JSONL.
 *
 * Precedence:
 *
 *   1. Explicit `filePath` (with `~` tilde expansion) — operator override.
 *   2. `confinedBaseDir/logs/cache-trace.jsonl` — when the daemon has
 *      pre-resolved its containment base (typically `~/.comis`).
 *   3. `${homedir}/.comis/logs/cache-trace.jsonl` — last-resort default.
 *
 * `~`-expansion uses `os.homedir()` at call-time (not import-time) so
 * test environments that override `HOME` see the override applied.
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_FILENAME = "cache-trace.jsonl";
const DEFAULT_SUBDIR = "logs";
const DEFAULT_DATA_DIR = ".comis";

/**
 * Inputs to `resolveCacheTraceFilePath`. `confinedBaseDir` (when set)
 * roots the default path inside the caller's containment base; without
 * it the resolver falls back to `~/.comis/logs/`.
 */
export interface ResolveCacheTraceFilePathInput {
  /** Explicit override path. Tilde (`~`) at start is expanded to homedir. */
  readonly filePath?: string;
  /** Pre-resolved containment base (typically `~/.comis`). */
  readonly confinedBaseDir?: string;
}

/**
 * Resolve the absolute on-disk path for the cache-trace JSONL artifact.
 *
 * @param init - explicit `filePath` and / or `confinedBaseDir` inputs
 * @returns absolute file path (does not create directories)
 */
export function resolveCacheTraceFilePath(
  init: ResolveCacheTraceFilePathInput,
): string {
  const explicit = init.filePath;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit.startsWith("~")
      ? explicit.replace(/^~/, homedir())
      : explicit;
  }

  const baseDir = init.confinedBaseDir ?? join(homedir(), DEFAULT_DATA_DIR);
  return join(baseDir, DEFAULT_SUBDIR, DEFAULT_FILENAME);
}
