// SPDX-License-Identifier: Apache-2.0
/**
 * Operator-actionable hint for a failed tool call, derived from the tool's
 * `errorText`.
 *
 * Tool failures carry a leading bracketed error CODE inside the result text
 * (e.g. `[permission_denied] command not allowlisted: expr`,
 * `[invalid_value] Invalid schedule_kind: "in"`, `[path_traversal] …`). The
 * `errorText` we log is the JSON-stringified tool result, so the code sits
 * inside `.content[].text` rather than at the very start — search anywhere for
 * the first snake_case bracketed token.
 *
 * Surfacing that code in the hint names the failure category and the policy
 * or configuration surface an operator should inspect. `errorKind` is left
 * unchanged because this helper only enriches the operator guidance.
 *
 * @module
 */

import { isMcpValidationError } from "./bridge-event-handlers.js";

/** First bracketed snake_case code (≥ one underscore → avoids matching `[i]`/`[abc]`/array indices). */
const BRACKETED_ERROR_CODE = /\[([a-z]+(?:_[a-z]+)+)\]/;

/**
 * Raw Node wrong-path-TYPE errno (`EISDIR`/`ENOTDIR`) — the model gave a directory
 * to a file op (or a file where a dir was expected). Surfaced with a path-shaped
 * hint instead of the generic one (matches the `validation` reclassification in
 * `classifyToolError`). The `:` anchors the errno format and avoids matching prose.
 */
const NODE_PATH_TYPE_ERRNO = /\b(EISDIR|ENOTDIR):/;

/** The generic fallback when no recognizable error code is present. */
export const GENERIC_TOOL_FAILURE_HINT =
  "Tool execution failed; inspect the protected trajectory using the trace ID and result digest";

/**
 * Build the WARN-log hint for a failed tool call. When `errorText` carries a
 * recognizable `[snake_case]` code, name it (the actionable category); else
 * fall back to {@link GENERIC_TOOL_FAILURE_HINT}.
 */
export function toolFailureHint(errorText?: string): string {
  if (errorText) {
    const m = BRACKETED_ERROR_CODE.exec(errorText);
    if (m) {
      const code = m[1];
      return `Tool failed (${code}) — check the policy or configuration for "${code}" using the protected trajectory`;
    }
    const errno = NODE_PATH_TYPE_ERRNO.exec(errorText);
    if (errno) {
      const code = errno[1];
      return `Tool failed (${code}) — inspect the protected trajectory for the input path, then pass a file path or use a directory-listing tool`;
    }
    if (isMcpValidationError(errorText)) {
      return "Tool arguments were rejected by validation; inspect argsPreview in the protected trajectory and correct the rejected fields before retrying";
    }
  }
  return GENERIC_TOOL_FAILURE_HINT;
}
