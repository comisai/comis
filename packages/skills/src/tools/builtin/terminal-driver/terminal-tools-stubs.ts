// SPDX-License-Identifier: Apache-2.0
/**
 * The LONE remaining terminal-driver stub tool (Open Q1): `terminal_session_status`.
 *
 * After Phase 120 the four interaction tools (`send_text` / `send_key` / `wait` /
 * `resize`) are REAL factories in `terminal-tools.ts` — they were promoted out of
 * this file when their behaviour landed, leaving `status` as the single deferred
 * tool. `status` is a REAL registered tool — it carries its final spec §5 TypeBox
 * schema now (so the agent-visible surface + the never-export annotation from
 * 119-01 are correct), but its behaviour is deferred to the attention + autonomous
 * tier (Phase 124): `execute()` rejects immediately with `[not_implemented]`
 * naming that phase. Rejecting with a typed error — rather than returning a fake
 * success — means an agent can never mistake an unimplemented tool for a working
 * one (T-119-17).
 *
 * The reject message names only the forward landing phase ("not available until
 * Phase 124") — it carries no migration-flavoured wording, so the architecture
 * prohibition on compatibility-shim vocabulary stays satisfied.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { throwToolError } from "../../../platform-tools/tool-helpers.js";

// ---------------------------------------------------------------------------
// Final spec §5 parameter schema (the surface is final; only the body is deferred)
// ---------------------------------------------------------------------------

const StatusParams = Type.Object({
  sessionId: Type.String({ description: "Session to inspect" }),
});

// ---------------------------------------------------------------------------
// The lone stub factory
// ---------------------------------------------------------------------------

const PHASE_ATTENTION = 124; // status (attention + autonomous tier)

/**
 * `terminal_session_status` — deferred to Phase 124. Carries its final spec §5
 * schema + the never-export registration; the body rejects `[not_implemented]`
 * naming the landing phase.
 */
export function createTerminalSessionStatusTool(): AgentTool<typeof StatusParams> {
  return {
    name: "terminal_session_status",
    label: "Terminal: status",
    description: `Deferred: terminal_session_status is not available until Phase ${PHASE_ATTENTION}.`,
    parameters: StatusParams,
    async execute(_id: string, _params: object): Promise<AgentToolResult<unknown>> {
      throwToolError("not_implemented", `terminal_session_status is not available until Phase ${PHASE_ATTENTION}`);
    },
  };
}
