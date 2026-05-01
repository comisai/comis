// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions Spawn Tool: spawn a sub-agent session for background work.
 *
 * Delegates to the daemon-side session.spawn RPC method. Supports sync
 * (blocks until done) and async (returns runId immediately) modes.
 * Spawn action is gated via createActionGate for action classification.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import {
  jsonResult,
  readStringParam,
  createActionGate,
} from "./tool-helpers.js";
import { createRpcDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const SessionsSpawnParams = Type.Object({
  task: Type.String({ description: "Task description for the sub-agent" }),
  async: Type.Optional(
    Type.Boolean({ description: "Spawn asynchronously, returns runId immediately (default: false)" }),
  ),
  agent: Type.Optional(
    Type.String({ description: "Target agent ID for cross-agent spawning" }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional model override for the sub-agent" }),
  ),
  announce_channel_type: Type.Optional(
    Type.String({ description: "Channel type for result announcement" }),
  ),
  announce_channel_id: Type.Optional(
    Type.String({ description: "Channel ID for result announcement" }),
  ),
  max_steps: Type.Optional(
    Type.Integer({
      description:
        "Maximum execution steps for this spawn. " +
        "Floor of 30 (boot sequence needs ~10-15 steps). " +
        "Typical values: 30 for quick lookups, 50 (default) for standard tasks, 80-100 for complex multi-step work. " +
        "Capped at config default.",
      minimum: 1,
    }),
  ),
  expected_outputs: Type.Optional(
    Type.Array(
      Type.String({ description: "Expected output file path" }),
      { description: "File paths to validate after sub-agent execution completes" },
    ),
  ),
  artifact_refs: Type.Optional(
    Type.Array(Type.String(), { description: "File paths for the sub-agent to reference (not inline content)" }),
  ),
  objective: Type.Optional(
    Type.String({ description: "Objective statement that survives context compaction" }),
  ),
  tool_groups: Type.Optional(
    Type.Array(Type.String(), { description: "Tool group names for sub-agent tool filtering (e.g., 'coding', 'web')" }),
  ),
  include_parent_history: Type.Optional(
    Type.String({ description: "Parent context inclusion: 'none' (default) or 'summary'" }),
  ),
  domain_knowledge: Type.Optional(
    Type.Array(Type.String(), { description: "Domain knowledge entries for the sub-agent" }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a sessions spawn tool for sub-agent session creation.
 *
 * Spawn action is gated via createActionGate. Currently classified as
 * "mutate" (auto-approved), since it's reversible and security-gated
 * by agentToAgent config.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing sessions_spawn
 */
export function createSessionsSpawnTool(rpcCall: RpcCall): AgentTool<typeof SessionsSpawnParams> {
  const spawnGate = createActionGate("session.spawn");

  return createRpcDispatchTool(
    {
      name: "sessions_spawn",
      label: "Sessions Spawn",
      description:
        "Spawn sub-agent session for background work. Supports sync and async modes.",
      parameters: SessionsSpawnParams,
      rpcMethod: "session.spawn",
      preExecute(p) {
        const gate = spawnGate(p);
        if (gate.requiresConfirmation) {
          return jsonResult({
            requiresConfirmation: true,
            actionType: gate.actionType,
          });
        }
        return undefined;
      },
      transformParams(p) {
        const task = readStringParam(p, "task");
        return {
          task,
          model: readStringParam(p, "model", false),
          agent: readStringParam(p, "agent", false),
          async: p.async === true,
          announce_channel_type: readStringParam(p, "announce_channel_type", false),
          announce_channel_id: readStringParam(p, "announce_channel_id", false),
          max_steps: typeof p.max_steps === "number" ? p.max_steps : undefined,
          expected_outputs: Array.isArray(p.expected_outputs) ? p.expected_outputs : undefined,
          artifact_refs: Array.isArray(p.artifact_refs) ? p.artifact_refs : undefined,
          objective: readStringParam(p, "objective", false),
          tool_groups: Array.isArray(p.tool_groups) ? p.tool_groups : undefined,
          include_parent_history: readStringParam(p, "include_parent_history", false),
          domain_knowledge: Array.isArray(p.domain_knowledge) ? p.domain_knowledge : undefined,
        };
      },
    },
    rpcCall,
  );
}
