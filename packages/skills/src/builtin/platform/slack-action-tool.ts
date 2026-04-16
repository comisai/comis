/**
 * Slack action tool: platform-specific actions for Slack workspaces.
 *
 * Supports 12 actions: pin, unpin, set_topic, set_purpose, archive, unarchive,
 * create_channel, invite, kick, channel_info, members_list, bookmark_add.
 * Destructive actions (archive, create_channel, kick) require confirmation
 * via action gates.
 * All actions delegate to the Slack backend via rpcCall("slack.action").
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import { createPlatformActionTool, type PlatformActionDescriptor } from "./platform-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SlackActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("pin"),
      Type.Literal("unpin"),
      Type.Literal("set_topic"),
      Type.Literal("set_purpose"),
      Type.Literal("archive"),
      Type.Literal("unarchive"),
      Type.Literal("create_channel"),
      Type.Literal("invite"),
      Type.Literal("kick"),
      Type.Literal("channel_info"),
      Type.Literal("members_list"),
      Type.Literal("bookmark_add"),
    ],
    { description: "Slack-specific action. Valid values: pin (pin message), unpin (unpin message), set_topic (change channel topic), set_purpose (change channel purpose), archive (archive channel), unarchive (restore channel), create_channel (new channel), invite (add users), kick (remove user), channel_info (get channel details), members_list (list members), bookmark_add (add bookmark)" },
  ),
  channel_id: Type.Optional(
    Type.String({ description: "Channel ID (for most actions)" }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Message timestamp (for pin/unpin)" }),
  ),
  user_id: Type.Optional(
    Type.String({ description: "Target user ID (for kick)" }),
  ),
  user_ids: Type.Optional(
    Type.Array(Type.String(), { description: "User IDs to invite (for invite)" }),
  ),
  topic: Type.Optional(
    Type.String({ description: "Channel topic text (for set_topic)" }),
  ),
  purpose: Type.Optional(
    Type.String({ description: "Channel purpose text (for set_purpose)" }),
  ),
  name: Type.Optional(
    Type.String({ description: "Channel name (for create_channel)" }),
  ),
  is_private: Type.Optional(
    Type.Boolean({ description: "Whether channel is private (for create_channel)" }),
  ),
  title: Type.Optional(
    Type.String({ description: "Bookmark title (for bookmark_add)" }),
  ),
  link: Type.Optional(
    Type.String({ description: "Bookmark URL (for bookmark_add)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max members to return (for members_list)" }),
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
// Descriptor + factory wrapper
// ---------------------------------------------------------------------------

const slackDescriptor: PlatformActionDescriptor = {
  name: "slack_action",
  label: "Slack Actions",
  description:
    "Perform Slack-specific actions: pin/unpin messages, set channel topic/purpose, archive/unarchive channels, create channels, invite/kick users, get channel info/members, add bookmarks. Requires appropriate bot scopes.",
  parameters: SlackActionParams,
  rpcMethod: "slack.action",
  gatedActions: [
    { action: "archive", gateKey: "slack.archive", hint: "Ask the user to confirm this channel archive, then call again with _confirmed: true." },
    { action: "create_channel", gateKey: "slack.create_channel", hint: "Ask the user to confirm this channel creation, then call again with _confirmed: true." },
    { action: "kick", gateKey: "slack.kick", hint: "Ask the user to confirm this kick action, then call again with _confirmed: true." },
  ],
};

/**
 * Create a Slack action tool with 12 actions.
 *
 * Destructive actions (archive, create_channel, kick) are gated via
 * createActionGate and return requiresConfirmation:true when the action
 * is classified as destructive.
 *
 * @param rpcCall - RPC call function for delegating to the Slack backend
 * @returns AgentTool implementing the Slack actions interface
 */
export function createSlackActionTool(rpcCall: RpcCall) {
  return createPlatformActionTool(slackDescriptor, rpcCall);
}
