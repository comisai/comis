// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-status-tool -- the REAL `terminal_session_status` AgentTool. This was the
 * lone `not_implemented` stub, promoted to a classifier-backed, owner-scoped tool.
 *
 * It lives in its own module (NOT in `terminal-tools.ts`, which sits at the 800-line
 * cap) and is modeled VERBATIM on `createTerminalSessionReadTool`: a read-only,
 * owner-scoped factory that takes {@link TerminalToolDeps}, derives the calling origin
 * per-call via `resolveOwner(deps)`, forwards to `registry.status`, and returns a
 * `jsonResult`. `terminal-tools-stubs.ts` re-exports this so the public surface +
 * the import path are unchanged.
 *
 * Owner-scoping is INHERITED from `registry.status`'s contract: a
 * cross-owner / killed session returns the not-found minimal view (`exited`, not
 * parked) — never another owner's classifier state. The classifier stays
 * single-homed in the worker (the registry round-trips a `status` frame).
 *
 * never-export: `terminal_session_status` is registered
 * `mcpExportPolicy:"never-export"` in `tool-metadata-registry.ts` — inherited from
 * that registration; this factory adds NO export annotation of its own.
 *
 * INFRA-FREE: value-imports ONLY `@comis/core` (via the shared tool helpers + the
 * owner derivation) + the local sibling types — never the infra or observability
 * packages, never a raw clock (the daemon injects `deps.nowMs`).
 *
 * @module
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { jsonResult } from "../../../platform-tools/tool-helpers.js";
import { resolveOwner, type TerminalToolDeps } from "./terminal-tools.js";
import type { TerminalStatusView } from "./terminal-status-view.js";

/** The `status` parameter schema. */
export const StatusParams = Type.Object({
  sessionId: Type.String({ description: "Session to inspect" }),
});

/** Defensively read a string param (the worker reply is the source of truth; params are caller-supplied). */
function readSessionId(params: Record<string, unknown>): string {
  const v = params["sessionId"];
  return typeof v === "string" ? v : "";
}

/**
 * `terminal_session_status` — return the classifier-derived status view
 * `{state, lastActivity, interactions, cursorParked, screenDiffEmpty, exitCode?}` for
 * an OWNED session. Owner-scoped (inherited from `registry.status`): a
 * cross-owner / killed session returns the not-found minimal view, never a leak.
 * Read-only — it never mutates the session. The status view is structural (no screen
 * text), so unlike `read` it needs no redaction/wrap.
 */
export function createTerminalSessionStatusTool(deps: TerminalToolDeps): AgentTool<typeof StatusParams> {
  return {
    name: "terminal_session_status",
    label: "Terminal: status",
    description: "Report the current state of a terminal session (working / awaiting-input / stuck / exited) + a perception summary.",
    parameters: StatusParams,

    // 4-arg execute: status is read-only — it never kills; the turn signal is
    // observed but a status query has no long-running work to abort.
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const start = deps.nowMs();
      const sessionId = readSessionId(params);
      // Owner-scoped: a cross-owner / killed session degrades to the not-found view.
      const view: TerminalStatusView = await deps.registry.status(sessionId, resolveOwner(deps));
      deps.logger.debug(
        {
          toolName: "terminal_session_status",
          sessionId,
          state: view.state,
          durationMs: deps.nowMs() - start,
          step: "status",
        },
        "terminal session status",
      );
      return jsonResult(view);
    },
  };
}
