// SPDX-License-Identifier: Apache-2.0
/**
 * The five not-yet-implemented terminal-driver stub tools (Open Q1):
 * `terminal_session_send_text` / `_send_key` / `_wait` / `_status` / `_resize`.
 *
 * These are REAL registered tools — they carry their final spec §5 TypeBox
 * schemas now (so the agent-visible surface + the never-export annotation from
 * 119-01 are correct), but their behavior is deferred: each `execute()` rejects
 * immediately with `[not_implemented]` naming the phase the tool lands in
 * (interaction tools → Phase 120; `status` → Phase 124). Rejecting with a typed
 * error — rather than returning a fake success — means an agent can never mistake
 * an unimplemented tool for a working one (T-119-17).
 *
 * The reject message names only the forward landing phase ("not available until
 * Phase N") — it carries no migration-flavoured wording, so the architecture
 * prohibition on compatibility-shim vocabulary stays satisfied.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";

import { throwToolError } from "../../../platform-tools/tool-helpers.js";

// ---------------------------------------------------------------------------
// Final spec §5 parameter schemas (the surface is final; only the body is deferred)
// ---------------------------------------------------------------------------

const SendTextParams = Type.Object({
  sessionId: Type.String({ description: "Session to send text to" }),
  text: Type.String({ description: "Text to type into the session" }),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after the text (default false)" })),
  bracketedPaste: Type.Optional(Type.Boolean({ description: "Wrap the text in a bracketed paste (default false)" })),
});

const SendKeyParams = Type.Object({
  sessionId: Type.String({ description: "Session to send keys to" }),
  keys: Type.Array(Type.String(), { description: 'Key chords, e.g. ["C-c"], ["Up","Enter"], ["S-Tab"]' }),
});

const WaitParams = Type.Object({
  sessionId: Type.String({ description: "Session to wait on" }),
  forIdleMs: Type.Optional(Type.Integer({ description: "Settle when idle for this many ms" })),
  forText: Type.Optional(Type.String({ description: "Settle when this text appears on screen" })),
  forExit: Type.Optional(Type.Boolean({ description: "Settle when the session exits" })),
  timeoutMs: Type.Optional(Type.Integer({ description: "Bounded in-turn settle timeout (default 15000, capped)" })),
});

const StatusParams = Type.Object({
  sessionId: Type.String({ description: "Session to inspect" }),
});

const ResizeParams = Type.Object({
  sessionId: Type.String({ description: "Session to resize" }),
  cols: Type.Integer({ description: "New column count" }),
  rows: Type.Integer({ description: "New row count" }),
});

// ---------------------------------------------------------------------------
// Stub factory helper
// ---------------------------------------------------------------------------

const PHASE_INTERACTION = 120; // send_text / send_key / wait / resize
const PHASE_ATTENTION = 124; // status (attention + autonomous tier)

/** Build a stub AgentTool whose execute rejects `[not_implemented]` naming `phase`. */
function stubTool<T extends TSchema>(
  name: string,
  label: string,
  parameters: T,
  phase: number,
): AgentTool<T> {
  return {
    name,
    label,
    description: `Deferred: ${name} is not available until Phase ${phase}.`,
    parameters,
    async execute(_id: string, _params: object): Promise<AgentToolResult<unknown>> {
      throwToolError("not_implemented", `${name} is not available until Phase ${phase}`);
    },
  };
}

// ---------------------------------------------------------------------------
// The five stub factories
// ---------------------------------------------------------------------------

/** `terminal_session_send_text` — deferred to Phase 120. */
export function createTerminalSessionSendTextTool(): AgentTool<typeof SendTextParams> {
  return stubTool("terminal_session_send_text", "Terminal: send text", SendTextParams, PHASE_INTERACTION);
}

/** `terminal_session_send_key` — deferred to Phase 120. */
export function createTerminalSessionSendKeyTool(): AgentTool<typeof SendKeyParams> {
  return stubTool("terminal_session_send_key", "Terminal: send key", SendKeyParams, PHASE_INTERACTION);
}

/** `terminal_session_wait` — deferred to Phase 120. */
export function createTerminalSessionWaitTool(): AgentTool<typeof WaitParams> {
  return stubTool("terminal_session_wait", "Terminal: wait", WaitParams, PHASE_INTERACTION);
}

/** `terminal_session_status` — deferred to Phase 124. */
export function createTerminalSessionStatusTool(): AgentTool<typeof StatusParams> {
  return stubTool("terminal_session_status", "Terminal: status", StatusParams, PHASE_ATTENTION);
}

/** `terminal_session_resize` — deferred to Phase 120. */
export function createTerminalSessionResizeTool(): AgentTool<typeof ResizeParams> {
  return stubTool("terminal_session_resize", "Terminal: resize", ResizeParams, PHASE_INTERACTION);
}
