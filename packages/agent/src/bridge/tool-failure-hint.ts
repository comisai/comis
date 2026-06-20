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
 * Surfacing that code in the hint names the failure CATEGORY (the §2.7
 * "name which knob" rule) instead of the generic "check errorText" — which, in
 * the 2026-06-20 live run (UC-C2), pointed a tmux/macOS dependency diagnosis at
 * what was actually a command-allowlist policy block. `errorKind` is left
 * unchanged (this is an advisory hint enrichment — no obs-classifier ripple).
 *
 * @module
 */

/** First bracketed snake_case code (≥ one underscore → avoids matching `[i]`/`[abc]`/array indices). */
const BRACKETED_ERROR_CODE = /\[([a-z]+(?:_[a-z]+)+)\]/;

/** The generic fallback when no recognizable error code is present. */
export const GENERIC_TOOL_FAILURE_HINT =
  "Tool execution failed; check errorText and toolArgs for root cause";

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
      return `Tool failed (${code}) — see errorText for the message; check toolArgs + the policy/config for "${code}" (e.g. command allowlist for permission_denied, the named param for invalid_value)`;
    }
  }
  return GENERIC_TOOL_FAILURE_HINT;
}
