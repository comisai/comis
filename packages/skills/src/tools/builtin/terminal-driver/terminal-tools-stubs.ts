// SPDX-License-Identifier: Apache-2.0
/**
 * Historically the terminal-driver "stub" surface. After Phase 120 the four
 * interaction tools (`send_text` / `send_key` / `wait` / `resize`) were promoted to
 * real factories in `terminal-tools.ts`, leaving `terminal_session_status` as the
 * lone deferred tool. Phase 124-06 promotes `status` too: its real, classifier-backed,
 * owner-scoped implementation lives in `terminal-status-tool.ts` (a new module, so the
 * body does not push `terminal-tools.ts` over the 800-line cap).
 *
 * This file now re-exports that real factory so the barrel's import path
 * (`./terminal-tools-stubs.js`) and the public surface are unchanged — the lone
 * deferred terminal-driver tool is now fully implemented (no deferred-reject body).
 *
 * @module
 */

export { createTerminalSessionStatusTool, StatusParams } from "./terminal-status-tool.js";
