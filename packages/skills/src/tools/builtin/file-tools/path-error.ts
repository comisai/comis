// SPDX-License-Identifier: Apache-2.0
/**
 * Shared "path outside workspace" error message for the builtin file tools
 * (read/write/edit/ls/grep/find/notebook).
 *
 * A model asked to "write report.md to your workspace" may emit an absolute
 * `~/Desktop/report.md` path, hit the bare
 * `[path_traversal] Path outside workspace bounds: …` error, could not infer the
 * fix from it, and gave up (delivering content inline instead of a file). The
 * error said WHAT was wrong but not WHERE to write — so the model never retried
 * with the workspace-relative path that would have worked. This message keeps the
 * stable `[path_traversal] Path outside workspace bounds: <path>` prefix (parsers/
 * classifiers key on it) and APPENDS a concrete remedy so the model self-corrects.
 *
 * @module
 */

/**
 * Build the path-traversal rejection message for a file path that resolved
 * outside the workspace (and any shared paths). The host workspace ROOT is
 * intentionally NOT echoed (it can reach logs/channels) — the remedy is the
 * relative-path shape, which is all the model needs.
 */
export function pathOutsideWorkspaceMessage(filePath: string): string {
  return (
    `[path_traversal] Path outside workspace bounds: ${filePath}. ` +
    `Use a path relative to your workspace (e.g. "report.md" or "notes/report.md"); ` +
    `absolute paths, "~", and ".." are not allowed.`
  );
}
