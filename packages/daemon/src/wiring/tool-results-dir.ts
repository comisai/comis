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

import { dirname } from "node:path";
import { safePath } from "@comis/core";

/**
 * Map a session JSONL file path to its sibling `tool-results/` spill directory.
 *
 * Take the `dirname()` of the JSONL path — the session DIRECTORY
 * (`…/sessions/<tenant>/<channel>`) — and put `tool-results/` UNDER it, so the
 * spill dir's parent is a real directory and `mkdirSync` succeeds. The dynamic
 * `tool-results` segment still goes through `safePath` (no traversal).
 *
 * @param sessionJsonlPath - the absolute session JSONL FILE path from
 *   `sessionKeyToPath` (e.g. `…/sessions/<tenant>/<channel>/web-user.jsonl`).
 * @returns the absolute spill DIRECTORY whose parent is the session directory
 *   (e.g. `…/sessions/<tenant>/<channel>/tool-results`).
 */
export function toolResultsDirFromSessionPath(sessionJsonlPath: string): string {
  const sessionDir = dirname(sessionJsonlPath);
  return safePath(sessionDir, "tool-results");
}
