// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-trace file-path resolution helper.
 *
 * Verbatim sibling of `cache-trace/paths.ts` (only `DEFAULT_FILENAME`
 * differs). The recall-trace artifact is one fixed file path
 * (`~/.comis/logs/recall-trace.jsonl` by default) — daemon-wide, not
 * per-session.
 *
 * Precedence:
 *
 *   1. Explicit `filePath` (with `~` tilde expansion) — operator override.
 *   2. `confinedBaseDir/logs/recall-trace.jsonl` — when the daemon has
 *      pre-resolved its containment base (typically `~/.comis`).
 *   3. `${homedir}/.comis/logs/recall-trace.jsonl` — last-resort default.
 *
 * `~`-expansion uses `os.homedir()` at call-time (not import-time) so test
 * environments that override `HOME` see the override applied.
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_FILENAME = "recall-trace.jsonl";
const DEFAULT_SUBDIR = "logs";
const DEFAULT_DATA_DIR = ".comis";

/**
 * Inputs to `resolveRecallTraceFilePath`. `confinedBaseDir` (when set) roots
 * the default path inside the caller's containment base; without it the
 * resolver falls back to `~/.comis/logs/`.
 */
export interface ResolveRecallTraceFilePathInput {
  /** Explicit override path. Tilde (`~`) at start is expanded to homedir. */
  readonly filePath?: string;
  /** Pre-resolved containment base (typically `~/.comis`). */
  readonly confinedBaseDir?: string;
}

/**
 * Resolve the absolute on-disk path for the recall-trace JSONL artifact.
 *
 * @param init - explicit `filePath` and / or `confinedBaseDir` inputs
 * @returns absolute file path (does not create directories)
 */
export function resolveRecallTraceFilePath(
  init: ResolveRecallTraceFilePathInput,
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
