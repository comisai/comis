// SPDX-License-Identifier: Apache-2.0
/**
 * Subagents lifecycle management tool: multi-action tool for listing,
 * killing, and steering running sub-agents.
 *
 * Supports 3 actions: list (default), kill, steer.
 * Kill action is gated via action classifier.
 * All actions delegate to the subagent backend via rpcCall indirection.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  readNumberParam,
  throwToolError,
  createActionGate,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SubagentsParams = Type.Object({
  action: Type.Optional(
    Type.Union(
      [Type.Literal("list"), Type.Literal("kill"), Type.Literal("steer")],
      { description: "Subagent action (default: list). Valid values: list (show active runs), kill (terminate sub-agent), steer (redirect task with new message)" },
    ),
  ),
  target: Type.Optional(
    Type.String({ description: "Run ID of the target subagent (for kill/steer)" }),
  ),
  message: Type.Optional(
    Type.String({ description: "New task description for the subagent (for steer)" }),
  ),
  recent_minutes: Type.Optional(
    Type.Integer({ description: "Include runs from last N minutes (default: 30, for list)" }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
});

type SubagentsParamsType = Static<typeof SubagentsParams>;

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
 * Create a subagents lifecycle management tool with 3 actions.
 *
 * The kill action is gated via createActionGate. List is the default
 * action when no action is specified. Steer kills a running sub-agent
 * and respawns it with a new task.
 *
 * @param rpcCall - RPC call function for delegating to the subagent backend
 * @param logger - Optional structured logger for DEBUG-level operation logging
 * @returns AgentTool implementing the subagents management interface
 */
const VALID_ACTIONS = ["list", "kill", "steer"] as const;

export function createSubagentsTool(rpcCall: RpcCall, logger?: ToolLogger): AgentTool<typeof SubagentsParams> {
  const killGate = createActionGate("subagent.kill");

  return {
    name: "subagents",
    label: "Subagents",
    description:
      "List, kill, or steer running sub-agents. Use list to see active runs, kill to terminate one, steer to redirect a running sub-agent's task.",
    parameters: SubagentsParams,

    async execute(
      _toolCallId: string,
      params: SubagentsParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const rawAction = readStringParam(p, "action", false) ?? "list";
        // Validate action (handles optional default of "list")
        if (!VALID_ACTIONS.includes(rawAction as typeof VALID_ACTIONS[number])) {
          throwToolError("invalid_action", `Invalid action: "${rawAction}".`, {
            validValues: [...VALID_ACTIONS],
            param: "action",
            hint: "Use one of the listed values for action.",
          });
        }
        const action = rawAction as typeof VALID_ACTIONS[number];

        if (action === "list") {
          const recentMinutes = readNumberParam(p, "recent_minutes", false) ?? 30;
          logger?.debug({ toolName: "subagents", action: "list", recentMinutes }, "Subagents listed");
          const result = await rpcCall("subagent.list", {
            recentMinutes,
          });
          return jsonResult(result);
        }

        if (action === "kill") {
          const gate = killGate(p);
          if (gate.requiresConfirmation) {
            return jsonResult({
              requiresConfirmation: true,
              actionType: gate.actionType,
              hint: "Ask the user to confirm killing this sub-agent, then call again with _confirmed: true.",
            });
          }
          const target = readStringParam(p, "target");
          logger?.debug({ toolName: "subagents", action: "kill", target }, "Subagent killed");
          const result = await rpcCall("subagent.kill", { target });
          return jsonResult(result);
        }

        // action === "steer"
        const target = readStringParam(p, "target");
        const message = readStringParam(p, "message");
        logger?.debug({ toolName: "subagents", action: "steer", target }, "Subagent steered");
        const result = await rpcCall("subagent.steer", { target, message });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        // eslint-disable-next-line preserve-caught-error -- intentional: original error is contextual, not the thrown symptom
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
