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

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

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
  model: Type.Optional(Type.String({ description: "Model override for heartbeat LLM calls" })),
  target_channel_type: Type.Optional(Type.String({ description: "Delivery target channel type (e.g. telegram, discord)" })),
  target_channel_id: Type.Optional(Type.String({ description: "Delivery target channel identifier" })),
  target_chat_id: Type.Optional(Type.String({ description: "Delivery target chat/conversation ID" })),
  target_is_dm: Type.Optional(Type.Boolean({ description: "Whether delivery target is a DM conversation" })),
  light_context: Type.Optional(Type.Boolean({ description: "Use lightweight bootstrap context (HEARTBEAT.md only)" })),
  show_ok: Type.Optional(Type.Boolean({ description: "Show OK status notifications" })),
  show_alerts: Type.Optional(Type.Boolean({ description: "Show alert notifications" })),
  allow_dm: Type.Optional(Type.Boolean({ description: "Allow DM delivery of heartbeat alerts" })),
  skip_heartbeat_only_delivery: Type.Optional(Type.Boolean({ description: "Suppress HEARTBEAT_OK-only delivery from cron triggers" })),
  ack_max_chars: Type.Optional(Type.Integer({ description: "Max chars for soft acknowledgment (default 300)" })),
  response_prefix: Type.Optional(Type.String({ description: "Prefix to strip from LLM responses before delivery" })),
  session: Type.Optional(Type.String({ description: "Session key for heartbeat conversation isolation" })),
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
          if (agentId) rpcParams.agentId = agentId;

          // Map flat snake_case tool params to camelCase RPC fields
          if (p.enabled !== undefined) rpcParams.enabled = p.enabled;
          if (p.interval_ms !== undefined) rpcParams.intervalMs = p.interval_ms;
          if (p.prompt !== undefined) rpcParams.prompt = p.prompt;
          if (p.model !== undefined) rpcParams.model = p.model;
          if (p.target_channel_type !== undefined) rpcParams.targetChannelType = p.target_channel_type;
          if (p.target_channel_id !== undefined) rpcParams.targetChannelId = p.target_channel_id;
          if (p.target_chat_id !== undefined) rpcParams.targetChatId = p.target_chat_id;
          if (p.target_is_dm !== undefined) rpcParams.targetIsDm = p.target_is_dm;
          if (p.light_context !== undefined) rpcParams.lightContext = p.light_context;
          if (p.show_ok !== undefined) rpcParams.showOk = p.show_ok;
          if (p.show_alerts !== undefined) rpcParams.showAlerts = p.show_alerts;
          if (p.allow_dm !== undefined) rpcParams.allowDm = p.allow_dm;
          if (p.skip_heartbeat_only_delivery !== undefined) rpcParams.skipHeartbeatOnlyDelivery = p.skip_heartbeat_only_delivery;
          if (p.ack_max_chars !== undefined) rpcParams.ackMaxChars = p.ack_max_chars;
          if (p.response_prefix !== undefined) rpcParams.responsePrefix = p.response_prefix;
          if (p.session !== undefined) rpcParams.session = p.session;
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
