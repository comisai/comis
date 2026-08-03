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

import { classifyRuntimeToolGuard, isMcpValidationError } from "./bridge-event-handlers.js";

/** First bracketed snake_case code (≥ one underscore → avoids matching `[i]`/`[abc]`/array indices). */
const BRACKETED_ERROR_CODE = /\[([a-z]+(?:_[a-z]+)+)\]/;

/**
 * Raw Node wrong-path-TYPE errno (`EISDIR`/`ENOTDIR`) — the model gave a directory
 * to a file op (or a file where a dir was expected). Surfaced with a path-shaped
 * hint instead of the generic one (matches the `validation` reclassification in
 * `classifyToolError`). The `:` anchors the errno format and avoids matching prose.
 */
const NODE_PATH_TYPE_ERRNO = /\b(EISDIR|ENOTDIR):/;
const BACKGROUND_CAPACITY_BINDING =
  /(agents\.[^\s";]+\.backgroundTasks\.(?:maxPerAgent|maxTotal)=\d+;\s*active=\d+)/;
const SPAWN_CEILING_BINDING =
  /((autonomy\.spawn\.(?:maxConcurrentSelfAgents|maxSpawnDepth|maxChildrenPerAgent))=\d+;\s*current=\d+)/;

/** The generic fallback when no recognizable error code is present. */
export const GENERIC_TOOL_FAILURE_HINT =
  "Tool execution failed; inspect the protected trajectory using the trace ID and result digest";

/** Field-level advice for an argument rejection — the one hint that lets a caller self-correct. */
const VALIDATION_FIELD_HINT =
  "Tool arguments were rejected by validation; inspect argsPreview in the protected trajectory and correct the rejected fields before retrying";

/**
 * Build the WARN-log hint for a failed tool call. When `errorText` carries a
 * recognizable `[snake_case]` code, name it (the actionable category); else
 * fall back to {@link GENERIC_TOOL_FAILURE_HINT}.
 *
 * @param errorText Raw tool error text.
 * @param errorKind The kind the classifier ALREADY assigned to this failure. Passing it lets a
 *   `validation` failure get field-level advice regardless of transport — see the branch below.
 */
export function toolFailureHint(errorText?: string, errorKind?: string): string {
  if (errorText) {
    if (errorText.toLowerCase().includes("deletion command had no observable effect")) {
      return (
        "The deletion target had no observable effect; confirm the target exists inside "
        + "the workspace write fence and inspect the exact command's approval before retrying"
      );
    }
    const runtimeGuard = classifyRuntimeToolGuard(errorText);
    if (runtimeGuard === "step_limit") {
      return "Execution step budget was exhausted; increase max_steps for the run or simplify the task before retrying";
    }
    if (runtimeGuard === "background_task_capacity") {
      const binding = BACKGROUND_CAPACITY_BINDING.exec(errorText)?.[1];
      return binding === undefined
        ? "Background task capacity was exhausted; inspect the owning agent's backgroundTasks limits before retrying"
        : `Background task capacity was exhausted at ${binding}; wait for a running task to finish before retrying`;
    }
    if (runtimeGuard === "spawn_ceiling") {
      const match = SPAWN_CEILING_BINDING.exec(errorText);
      const binding = match?.[1];
      const configKey = match?.[2];
      if (binding === undefined || configKey === undefined) {
        return "Sub-agent spawn capacity was exhausted; inspect the autonomy.spawn limits before retrying";
      }
      if (errorText.includes("reason=depth")) {
        return (
          `Sub-agent spawn depth was exhausted at ${binding}; increase ${configKey} `
          + "in the config file and restart the daemon, or continue without another nested spawn"
        );
      }
      return errorText.includes("reason=fanout")
        ? (
            `Sub-agent child fanout was exhausted at ${binding}; wait for one of this caller's `
            + `children to finish or stop one, or raise ${configKey}`
          )
        : (
            `Sub-agent spawn capacity was exhausted at ${binding}; wait for a running sub-agent `
            + `to finish or stop one, or raise ${configKey}`
          );
    }
    // The CLASSIFIER already decided this was a validation failure — trust it rather than
    // re-deriving the class from prose. `isMcpValidationError` below matches MCP transport shapes
    // only, so a PLATFORM tool's argument rejection fell through to the generic bracketed-code
    // branch and got `check the policy or configuration for "invalid_value"` — interpolating a
    // failure-CLASS code into the slot where a config key or rejected field belongs. The
    // runtime-guard branches above still win, because each names a specific knob.
    if (errorKind === "validation") {
      return VALIDATION_FIELD_HINT;
    }
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
      return VALIDATION_FIELD_HINT;
    }
  }
  return GENERIC_TOOL_FAILURE_HINT;
}
