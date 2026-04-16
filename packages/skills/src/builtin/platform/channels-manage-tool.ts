/**
 * Channel management tool: multi-action tool for channel adapter lifecycle.
 *
 * Supports 6 actions: list, get, enable, disable, restart, configure.
 * Destructive actions (enable, disable, restart, configure) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to channels.* RPC handlers and config.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  readStringParam,
  readBooleanParam,
  throwToolError,
} from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ChannelsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("get"),
      Type.Literal("enable"),
      Type.Literal("disable"),
      Type.Literal("restart"),
      Type.Literal("configure"),
    ],
    { description: "Channel management action. Valid values: list (all adapters), get (single adapter details), enable (start adapter), disable (stop adapter), restart (stop then start), configure (toggle media setting)" },
  ),
  channel_type: Type.Optional(
    Type.String({
      description: "The channel type (e.g. telegram, discord, slack). Required for get/enable/disable/restart/configure.",
    }),
  ),
  setting: Type.Optional(
    Type.String({
      description: "Media processing setting to toggle: transcribeAudio, analyzeImages, describeVideos, extractDocuments, understandLinks. Required for configure action.",
    }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description: "Whether to enable (true) or disable (false) the setting. Required for configure action.",
    }),
  ),
});

type ChannelsManageToolParamsType = Static<typeof ChannelsManageToolParams>;

const VALID_ACTIONS = ["list", "get", "enable", "disable", "restart", "configure"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a channel management tool with 6 actions.
 *
 * Actions:
 * - **list** -- List all channel adapters with type, status, and channelId
 * - **get** -- Get detailed info for a single channel adapter by type
 * - **enable** -- Start a stopped channel adapter (requires approval)
 * - **disable** -- Stop a running channel adapter (requires approval)
 * - **restart** -- Restart a channel adapter (stop then start, requires approval)
 * - **configure** -- Toggle a media processing setting per channel (requires approval)
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for enable/disable/restart/configure actions
 * @returns AgentTool implementing the channel management interface
 */
export function createChannelsManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof ChannelsManageToolParams> {
  return createAdminManageTool(
    {
      name: "channels_manage",
      label: "Channel Management",
      description:
        "Manage channel adapters: list, get, enable, disable, restart, configure. Enable/disable/restart/configure require approval.",
      parameters: ChannelsManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "channels",
      gatedActions: ["enable", "disable", "restart"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("channels.list", { _trustLevel: ctx.trustLevel });
        },
        async get(p, rpcCall, ctx) {
          const channelType = readStringParam(p, "channel_type");
          return rpcCall("channels.get", { channel_type: channelType, _trustLevel: ctx.trustLevel });
        },
        async enable(p, rpcCall, ctx) {
          const channelType = readStringParam(p, "channel_type");
          return rpcCall("channels.enable", { channel_type: channelType, _trustLevel: ctx.trustLevel });
        },
        async disable(p, rpcCall, ctx) {
          const channelType = readStringParam(p, "channel_type");
          return rpcCall("channels.disable", { channel_type: channelType, _trustLevel: ctx.trustLevel });
        },
        async restart(p, rpcCall, ctx) {
          const channelType = readStringParam(p, "channel_type");
          return rpcCall("channels.restart", { channel_type: channelType, _trustLevel: ctx.trustLevel });
        },
        async configure(p, rpcCall, ctx) {
          const channelType = readStringParam(p, "channel_type");
          const setting = readStringParam(p, "setting");
          const enabled = readBooleanParam(p, "enabled");

          // Validate setting against allowed media processing options
          const validSettings = [
            "transcribeAudio",
            "analyzeImages",
            "describeVideos",
            "extractDocuments",
            "understandLinks",
          ];
          if (!validSettings.includes(setting!)) {
            throwToolError("invalid_value", `Invalid media processing setting: "${setting}".`, {
              validValues: validSettings,
              param: "setting",
              hint: "Use one of the listed media processing settings.",
            });
          }

          // Read current config to confirm channel exists
          const channelConfig = await rpcCall("config.read", { section: "channels", _trustLevel: ctx.trustLevel });
          if (!(channelConfig as Record<string, unknown>)[channelType!]) {
            throwToolError("not_found", `Channel not found in config: ${channelType}.`, {
              hint: "Check available channels with the list action.",
            });
          }

          // Approval gate for configure -- handled inline because validation must run before gate
          if (approvalGate) {
            const gateCtx = tryGetContext();
            const resolution = await approvalGate.requestApproval({
              toolName: "channels_manage",
              action: "channels.configure",
              params: { channel_type: channelType, setting, enabled },
              agentId: gateCtx?.userId ?? "unknown",
              sessionKey: gateCtx?.sessionKey ?? "unknown",
              trustLevel: (gateCtx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
              channelType: gateCtx?.channelType,
            });
            if (!resolution.approved) {
              throwToolError("permission_denied", `Action denied: configure was not approved`, {
                hint: resolution.reason ?? "Request approval before retrying.",
              });
            }
          }

          // Patch the media processing setting
          return rpcCall("config.patch", {
            section: "channels",
            key: `${channelType}.mediaProcessing.${setting}`,
            value: enabled,
            _trustLevel: ctx.trustLevel,
          });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
