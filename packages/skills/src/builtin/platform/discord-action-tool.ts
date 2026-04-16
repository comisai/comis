/**
 * Discord action tool: platform-specific actions for Discord servers.
 *
 * Supports 19 actions: pin, unpin, kick, ban, unban, role_add, role_remove,
 * set_topic, set_slowmode, guild_info, channel_info, threadCreate, threadList,
 * threadReply, channelCreate, channelEdit, channelDelete, channelMove, setPresence.
 * Destructive actions (kick, ban, channelDelete) require confirmation via action gates.
 * All actions delegate to the Discord backend via rpcCall("discord.action").
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import { createPlatformActionTool, type PlatformActionDescriptor } from "./platform-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const DiscordActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("pin"),
      Type.Literal("unpin"),
      Type.Literal("kick"),
      Type.Literal("ban"),
      Type.Literal("unban"),
      Type.Literal("role_add"),
      Type.Literal("role_remove"),
      Type.Literal("set_topic"),
      Type.Literal("set_slowmode"),
      Type.Literal("guild_info"),
      Type.Literal("channel_info"),
      Type.Literal("threadCreate"),
      Type.Literal("threadList"),
      Type.Literal("threadReply"),
      Type.Literal("channelCreate"),
      Type.Literal("channelEdit"),
      Type.Literal("channelDelete"),
      Type.Literal("channelMove"),
      Type.Literal("setPresence"),
    ],
    { description: "Discord-specific action. Valid values: pin (pin message), unpin (unpin message), kick (remove member), ban (ban member), unban (unban member), role_add (assign role), role_remove (revoke role), set_topic (change channel topic), set_slowmode (set rate limit), guild_info (get server details), channel_info (get channel details), threadCreate (create thread), threadList (list threads), threadReply (reply in thread), channelCreate (new channel), channelEdit (modify channel), channelDelete (delete channel), channelMove (reorder channel), setPresence (update bot status)" },
  ),
  channel_id: Type.Optional(
    Type.String({ description: "Channel ID (for pin/unpin/set_topic/set_slowmode/channel_info/threadCreate/channelEdit/channelDelete/channelMove)" }),
  ),
  guild_id: Type.Optional(
    Type.String({ description: "Guild/server ID (for kick/ban/unban/role_add/role_remove/guild_info/channelCreate/threadList)" }),
  ),
  user_id: Type.Optional(
    Type.String({ description: "Target user ID (for kick/ban/unban/role_add/role_remove)" }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Message ID (for pin/unpin/threadCreate)" }),
  ),
  role_id: Type.Optional(
    Type.String({ description: "Role ID (for role_add/role_remove)" }),
  ),
  topic: Type.Optional(
    Type.String({ description: "Channel topic text (for set_topic)" }),
  ),
  seconds: Type.Optional(
    Type.Integer({ description: "Slowmode delay in seconds, 0-21600 (for set_slowmode)" }),
  ),
  reason: Type.Optional(
    Type.String({ description: "Moderation reason (for kick/ban)" }),
  ),
  delete_message_days: Type.Optional(
    Type.Integer({ description: "Days of messages to delete, 0-7 (for ban)" }),
  ),
  name: Type.Optional(
    Type.String({ description: "Name for thread or channel (for threadCreate/channelCreate)" }),
  ),
  thread_id: Type.Optional(
    Type.String({ description: "Thread ID (for threadReply)" }),
  ),
  auto_archive_duration: Type.Optional(
    Type.Integer({ description: "Thread auto-archive duration in minutes: 60, 1440, 4320, 10080 (for threadCreate)" }),
  ),
  type: Type.Optional(
    Type.String({ description: "Channel type: text, voice, category, announcement, forum, stage (for channelCreate)" }),
  ),
  parent_id: Type.Optional(
    Type.String({ description: "Parent category ID (for channelCreate)" }),
  ),
  position: Type.Optional(
    Type.Integer({ description: "Channel position in the list (for channelMove/channelEdit)" }),
  ),
  status_text: Type.Optional(
    Type.String({ description: "Bot status text (for setPresence)" }),
  ),
  activity_type: Type.Optional(
    Type.String({ description: "Bot activity type: playing, watching, listening, competing (for setPresence)" }),
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

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for structured tool logging. */
interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Descriptor + factory wrapper
// ---------------------------------------------------------------------------

const discordDescriptor: PlatformActionDescriptor = {
  name: "discord_action",
  label: "Discord Actions",
  description:
    "Perform Discord-specific actions: pin/unpin messages, kick/ban/unban members, add/remove roles, set channel topic/slowmode, get guild/channel info, create/list/reply to threads, create/edit/delete/move channels, set bot presence. Requires appropriate bot permissions.",
  parameters: DiscordActionParams,
  rpcMethod: "discord.action",
  gatedActions: [
    { action: "kick", gateKey: "discord.kick", hint: "Ask the user to confirm this kick action, then call again with _confirmed: true." },
    { action: "ban", gateKey: "discord.ban", hint: "Ask the user to confirm this ban action, then call again with _confirmed: true." },
    { action: "channelDelete", gateKey: "discord.channelDelete", hint: "Ask the user to confirm this channel deletion, then call again with _confirmed: true." },
  ],
};

/**
 * Create a Discord action tool with 19 actions.
 *
 * Destructive actions (kick, ban, channelDelete) are gated via createActionGate
 * and return requiresConfirmation:true when the action is classified as destructive.
 *
 * @param rpcCall - RPC call function for delegating to the Discord backend
 * @param logger - Optional structured logger for DEBUG-level operation logging
 * @returns AgentTool implementing the Discord actions interface
 */
export function createDiscordActionTool(rpcCall: RpcCall, logger?: ToolLogger) {
  return createPlatformActionTool({ ...discordDescriptor, logger }, rpcCall);
}
