// SPDX-License-Identifier: Apache-2.0
/**
 * Derive the per-session `tool-results/` spill directory from a session JSONL
 * FILE path.
 *
 * The session-key resolver (`sessionKeyToPath`) returns the session JSONL FILE
 * path (`…/sessions/<tenant>/<channel>/<name>.jsonl`), NOT a directory. The
 * oversized-tool-result spill (ctx_expand + the shared exec-tool spill path)
 * needs a DIRECTORY to `mkdirSync` + write the file handle into.
 *
 * @module
 */

import { safePath } from "@comis/core";

/**
 * Map a session JSONL file path to its `tool-results/` spill directory.
 *
 * @param sessionJsonlPath - the absolute session JSONL FILE path from
 *   `sessionKeyToPath` (e.g. `…/sessions/<tenant>/<channel>/web-user.jsonl`).
 * @returns the absolute spill DIRECTORY.
 */
export function toolResultsDirFromSessionPath(sessionJsonlPath: string): string {
  // BUG (pre-patch): treats the JSONL FILE path as a directory and appends
  // `tool-results` onto it → `…/web-user.jsonl/tool-results`, whose parent is a
  // regular file, so `mkdirSync` throws ENOTDIR.
  return safePath(sessionJsonlPath, "tool-results");
}
