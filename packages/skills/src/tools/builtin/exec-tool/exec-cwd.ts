// SPDX-License-Identifier: Apache-2.0
// @allow-throw: builtin tool boundary; throws caught by AgentTool wrapper.
/** Workspace-bounded cwd resolution for the exec tool. */

import { existsSync } from "node:fs";
import { PathTraversalError, safePath } from "@comis/core";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";

/**
 * Resolve a user-supplied `cwd` against the workspace root via safePath.
 * Throws via throwToolError when the path escapes workspace bounds.
 */
export function resolveCwd(workspacePath: string, cwdParam: string): string {
  try {
    const resolved = safePath(workspacePath, cwdParam);
    if (!existsSync(resolved)) {
      throwToolError(
        "not_found",
        `Working directory does not exist: ${cwdParam}`,
        { hint: "List the workspace and retry with an existing directory" },
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof PathTraversalError) {
      throwToolError(
        "invalid_value",
        `Working directory outside workspace bounds: ${cwdParam}`,
      );
    }
    throw error;
  }
  return workspacePath;
}
