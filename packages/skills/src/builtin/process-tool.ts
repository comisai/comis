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

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import {
  jsonResult,
  throwToolError,
  readEnumParam,
  readStringParam,
  readNumberParam,
} from "./platform/tool-helpers.js";
import type { ProcessRegistry } from "./process-registry.js";

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

/**
 * Create a process management tool that delegates to a ProcessRegistry.
 *
 * @param registry - ProcessRegistry for session CRUD operations
 * @param logger - Optional structured logger for DEBUG-level operation logging
 * @returns AgentTool implementing the process management interface
 */
export function createProcessTool(
  registry: ProcessRegistry,
  logger?: ToolLogger,
): AgentTool<typeof ProcessParams> {
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
