// SPDX-License-Identifier: Apache-2.0
/**
 * Process management tool: CRUD operations over background processes.
 *
 * Provides four actions:
 * - list: show all sessions with status, pid, command, tail output
 * - kill: terminate a running process (SIGTERM then SIGKILL)
 * - status: inspect a single process session
 * - log: read paginated output from a process
 *
 * All operations delegate to the injected ProcessRegistry.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  jsonResult,
  throwToolError,
  readEnumParam,
  readStringParam,
  readNumberParam,
} from "../../platform-tools/tool-helpers.js";
import type { ProcessRegistry } from "./process-registry.js";
import type { ToolCapabilityPort } from "@comis/core";
import { registerActivityLabelSpec } from "@comis/core";
import { buildInstallDetourHint } from "./exec-tool/index.js";
// `InstallDetourDecision` is imported transitively via
// ProcessSession.installDetourDecision (process-registry.ts type-only import);
// no direct import here — never re-derive at status-query time.

// Activity label spec. Descriptor name ==
// emitted name (process-tool.ts:111 → `name: "process"`). No detailKeys: the
// process tool is action-discriminated (start/stop/status/...) and the
// per-action labels can be added later via the `actions` map — the static
// fallback keeps the channel render from showing the bare `"process"`
// humanized form.
registerActivityLabelSpec("process", {
  semanticPhase: "tool",
  label: "managing process",
});

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ProcessParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("kill"),
      Type.Literal("status"),
      Type.Literal("log"),
    ],
    { description: "The process management action to perform" },
  ),
  sessionId: Type.Optional(
    Type.String({
      description: "Process session ID (required for kill/status/log)",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({ description: "Line offset for log pagination (0-indexed)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max lines to return for log (default 200)" }),
  ),
});

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for structured tool logging. */
interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

/**
 * Dependencies for the process tool factory. Backward compatibility is NOT
 * preserved.
 *
 * `toolCapabilityPort` is REQUIRED — read inside the `case "status":` branch
 * to decide whether to augment the result envelope with the retroactive
 * install-detour hint (read the spawn-time `session.installDetourDecision`
 * rather than re-deriving from current connected-server state, since the
 * connected set may have drifted since spawn). Daemon wiring injects
 * `createNoOpCapabilityPort()` until the real adapter is available.
 */
export interface ProcessToolDeps {
  readonly registry: ProcessRegistry;
  readonly logger?: ToolLogger;
  /** REQUIRED for the capability layer — used by `process.status` augmentation. */
  readonly toolCapabilityPort: ToolCapabilityPort;
}

/**
 * Create a process management tool that delegates to a ProcessRegistry.
 *
 * Uses a deps-object signature; backward compat with the prior positional
 * `(registry, logger?)` shape is NOT preserved.
 *
 * @param deps - Dependencies bundle. See `ProcessToolDeps` for field semantics.
 * @returns AgentTool implementing the process management interface.
 */
export function createProcessTool(deps: ProcessToolDeps): AgentTool<typeof ProcessParams> {
  const {
    registry,
    logger,
    // toolCapabilityPort is read inside execute(...) below
  } = deps;
  return {
    name: "process",
    label: "Process",
    description:
      "Manage background processes. Actions: list (show all), kill (terminate), status (inspect), log (read output).",
    parameters: ProcessParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        const VALID_ACTIONS = ["list", "kill", "status", "log"] as const;
        const action = readEnumParam(p, "action", VALID_ACTIONS);

        switch (action) {
          case "list": {
            logger?.debug({ toolName: "process", action: "list" }, "Process list queried");
            const sessions = registry.list();
            return jsonResult(sessions);
          }

          case "kill": {
            const sessionId = readStringParam(p, "sessionId");
            if (!sessionId) {
              throwToolError("missing_param", "Missing required parameter: sessionId");
            }
            const result = await registry.kill(sessionId);
            logger?.debug({ toolName: "process", action: "kill", sessionId, status: "killed" }, "Process killed");
            return jsonResult(result);
          }

          case "status": {
            const sessionId = readStringParam(p, "sessionId");
            if (!sessionId) {
              throwToolError("missing_param", "Missing required parameter: sessionId");
            }
            logger?.debug({ toolName: "process", action: "status", sessionId }, "Process status queried");
            const details = registry.status(sessionId);
            if (!details) {
              throwToolError("not_found", `Process session not found: ${sessionId}`);
            }

            // Retroactive advise-mode hint augmentation. Read the spawn-time
            // decision back from the session rather than re-deriving from current
            // connected-server state (the connected set may have drifted since
            // spawn, producing an inconsistent hint vs the spawn-time event).
            // No current-mode check — operators can switch modes mid-session via
            // daemon restart; advise-spawned sessions keep their hint.
            const session = registry.get(sessionId);
            if (
              session?.installDetourDecision &&
              session.installDetourDecision.overlaps.length > 0
            ) {
              const hint = buildInstallDetourHint(session.installDetourDecision);
              return jsonResult({ ...details, installDetourHint: hint.installDetourHint });
            }

            return jsonResult(details);
          }

          case "log": {
            const sessionId = readStringParam(p, "sessionId");
            if (!sessionId) {
              throwToolError("missing_param", "Missing required parameter: sessionId");
            }
            logger?.debug({ toolName: "process", action: "log", sessionId }, "Process log read");
            const offset = readNumberParam(p, "offset", false);
            const limit = readNumberParam(p, "limit", false);
            const logData = registry.getLog(sessionId, offset, limit);
            if (!logData) {
              throwToolError("not_found", `Process session not found: ${sessionId}`);
            }
            return jsonResult(logData);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
