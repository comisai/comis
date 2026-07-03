// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal-driver "stub" surface. The four interaction tools (`send_text` /
 * `send_key` / `wait` / `resize`) are real factories in `terminal-tools.ts`, and
 * `terminal_session_status` has a real, classifier-backed, owner-scoped implementation
 * in `terminal-status-tool.ts` (a separate module, so the body does not push
 * `terminal-tools.ts` over the 800-line cap).
 *
 * This file re-exports that real factory so the barrel's import path
 * (`./terminal-tools-stubs.js`) and the public surface are unchanged — every
 * terminal-driver tool is fully implemented (no deferred-reject body).
 *
 * @module
 */

export { createTerminalSessionStatusTool, StatusParams } from "./terminal-status-tool.js";
