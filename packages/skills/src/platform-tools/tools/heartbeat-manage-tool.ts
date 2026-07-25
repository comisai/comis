// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat management tool: multi-action tool for heartbeat configuration.
 *
 * Supports 4 actions: get, update, status, trigger.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to heartbeat.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { readStringParam } from "../tool-helpers.js";
import { createAdminManageTool } from "../admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec. Descriptor name == emitted name.
// Per-action overrides use the tool's REAL action enum.
registerActivityLabelSpec("heartbeat_manage", {
  semanticPhase: "tool",
  label: "managing heartbeat",
  actions: {
    get: { label: "reading heartbeat config" },
    update: { label: "updating heartbeat config" },
    status: { label: "checking heartbeat status" },
    trigger: { label: "triggering heartbeat" },
  },
});

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const HeartbeatManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("get"),
      Type.Literal("update"),
      Type.Literal("status"),
      Type.Literal("trigger"),
    ],
    { description: "Heartbeat management action. Valid values: get (view config), update (modify config fields), status (runtime state for all agents), trigger (run heartbeat now)" },
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Agent ID to manage (defaults to calling agent)" }),
  ),
  // Update fields (all optional -- only included in update action)
  enabled: Type.Optional(Type.Boolean({ description: "Enable/disable heartbeat for this agent" })),
  interval_ms: Type.Optional(Type.Integer({ description: "Heartbeat interval in milliseconds (e.g. 300000 for 5 min)" })),
  prompt: Type.Optional(Type.String({ description: "Custom heartbeat prompt text" })),
  target: Type.Optional(Type.Object({
    channel_type: Type.String({ description: "Channel type (e.g. telegram, discord)" }),
    channel_instance_id: Type.String({ description: "Registered channel adapter instance ID" }),
    conversation_id: Type.String({ description: "Platform conversation ID" }),
    thread_id: Type.Optional(Type.String({ description: "Platform thread or topic ID" })),
    conversation_kind: Type.Union([Type.Literal("direct"), Type.Literal("shared")]),
  }, { additionalProperties: false, description: "Complete exact heartbeat delivery endpoint" })),
  light_context: Type.Optional(Type.Boolean({ description: "Use lightweight bootstrap context (HEARTBEAT.md only)" })),
  show_ok: Type.Optional(Type.Boolean({ description: "Show OK status notifications" })),
  show_alerts: Type.Optional(Type.Boolean({ description: "Show alert notifications" })),
  allow_dm: Type.Optional(Type.Boolean({ description: "Allow DM delivery of heartbeat alerts" })),
  ack_max_chars: Type.Optional(Type.Integer({ description: "Max chars for soft acknowledgment (default 300)" })),
  response_prefix: Type.Optional(Type.String({ description: "Prefix to strip from LLM responses before delivery" })),
  alert_threshold: Type.Optional(Type.Integer({ description: "Consecutive failures before alerting" })),
  alert_cooldown_ms: Type.Optional(Type.Integer({ description: "Minimum ms between alerts" })),
  stale_ms: Type.Optional(Type.Integer({ description: "Max ms before stuck detection triggers" })),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a heartbeat management tool with 4 actions.
 *
 * Actions:
 * - **get** -- View per-agent and effective heartbeat config
 * - **update** -- Update heartbeat configuration fields
 * - **status** -- View runtime heartbeat state for all agents
 * - **trigger** -- Run heartbeat immediately for an agent
 *
 * Admin trust level required for all actions.
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the heartbeat management interface
 */
const VALID_ACTIONS = ["get", "update", "status", "trigger"] as const;

export function createHeartbeatManageTool(
  rpcCall: RpcCall,
): AgentTool<typeof HeartbeatManageToolParams> {
  return createAdminManageTool(
    {
      name: "heartbeat_manage",
      label: "Heartbeat Configuration",
      description:
        "Manage agent heartbeat: enable, disable, get status, update interval.",
      parameters: HeartbeatManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "heartbeat",
      actionOverrides: {
        async get(p, rpcCall, ctx) {
          const rpcParams: Record<string, unknown> = { _trustLevel: ctx.trustLevel };
          const agentId = readStringParam(p, "agent_id", false);
          if (agentId) rpcParams.agentId = agentId;
          return rpcCall("heartbeat.get", rpcParams);
        },
        async update(p, rpcCall, ctx) {
          const rpcParams: Record<string, unknown> = { _trustLevel: ctx.trustLevel };
          const agentId = readStringParam(p, "agent_id", false);
          const target = p.target as {
            channel_type: string;
            channel_instance_id: string;
            conversation_id: string;
            thread_id?: string;
            conversation_kind: "direct" | "shared";
          } | undefined;
          if (agentId) rpcParams.agentId = agentId;

          // Map flat snake_case tool params to camelCase RPC fields
          if (p.enabled !== undefined) rpcParams.enabled = p.enabled;
          if (p.interval_ms !== undefined) rpcParams.intervalMs = p.interval_ms;
          if (p.prompt !== undefined) rpcParams.prompt = p.prompt;
          if (target !== undefined) {
            rpcParams.target = {
              channelType: target.channel_type,
              channelInstanceId: target.channel_instance_id,
              conversationId: target.conversation_id,
              ...(target.thread_id !== undefined ? { threadId: target.thread_id } : {}),
              conversationKind: target.conversation_kind,
            };
          }
          if (p.light_context !== undefined) rpcParams.lightContext = p.light_context;
          if (p.show_ok !== undefined) rpcParams.showOk = p.show_ok;
          if (p.show_alerts !== undefined) rpcParams.showAlerts = p.show_alerts;
          if (p.allow_dm !== undefined) rpcParams.allowDm = p.allow_dm;
          if (p.ack_max_chars !== undefined) rpcParams.ackMaxChars = p.ack_max_chars;
          if (p.response_prefix !== undefined) rpcParams.responsePrefix = p.response_prefix;
          if (p.alert_threshold !== undefined) rpcParams.alertThreshold = p.alert_threshold;
          if (p.alert_cooldown_ms !== undefined) rpcParams.alertCooldownMs = p.alert_cooldown_ms;
          if (p.stale_ms !== undefined) rpcParams.staleMs = p.stale_ms;

          return rpcCall("heartbeat.update", rpcParams);
        },
        async status(_p, rpcCall, ctx) {
          // "status" maps to heartbeat.states, not heartbeat.status
          return rpcCall("heartbeat.states", { _trustLevel: ctx.trustLevel });
        },
        async trigger(p, rpcCall, ctx) {
          const rpcParams: Record<string, unknown> = { _trustLevel: ctx.trustLevel };
          const agentId = readStringParam(p, "agent_id", false);
          if (agentId) rpcParams.agentId = agentId;
          return rpcCall("heartbeat.trigger", rpcParams);
        },
      },
    },
    rpcCall,
  );
}
