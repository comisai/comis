// SPDX-License-Identifier: Apache-2.0
/**
 * Re-export surface for the classifier-backed, owner-scoped terminal status tool.
 * Its implementation lives in a separate module to keep `terminal-tools.ts`
 * within the production file-size limit.
 *
 * @module
 */

export { createTerminalSessionStatusTool, StatusParams } from "./terminal-status-tool.js";
