/**
 * Telegram action tool: platform-specific actions for Telegram chats.
 *
 * Supports 12 actions: pin, unpin, poll, sticker, chat_info, member_count,
 * get_admins, set_title, set_description, ban, unban, promote.
 * Destructive actions (ban, promote) require confirmation via action gates.
 * All actions delegate to the Telegram backend via rpcCall("telegram.action").
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import { createPlatformActionTool, type PlatformActionDescriptor } from "./platform-action-tool.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const TelegramActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("pin"),
      Type.Literal("unpin"),
      Type.Literal("poll"),
      Type.Literal("sticker"),
      Type.Literal("chat_info"),
      Type.Literal("member_count"),
      Type.Literal("get_admins"),
      Type.Literal("set_title"),
      Type.Literal("set_description"),
      Type.Literal("ban"),
      Type.Literal("unban"),
      Type.Literal("promote"),
    ],
    { description: "Telegram-specific action. Valid values: pin (pin message), unpin (unpin message), poll (send poll), sticker (send sticker), chat_info (get chat details), member_count (get member total), get_admins (list admins), set_title (change chat title), set_description (change chat description), ban (ban user), unban (unban user), promote (grant admin rights)" },
  ),
  chat_id: Type.Optional(
    Type.String({ description: "Chat/group ID (for all actions)" }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Message ID (for pin/unpin)" }),
  ),
  user_id: Type.Optional(
    Type.String({ description: "Target user ID (for ban/unban/promote)" }),
  ),
  question: Type.Optional(
    Type.String({ description: "Poll question text (for poll)" }),
  ),
  options: Type.Optional(
    Type.Array(Type.String(), { description: "Poll answer options (for poll)" }),
  ),
  sticker_id: Type.Optional(
    Type.String({ description: "Sticker file_id (for sticker)" }),
  ),
  title: Type.Optional(
    Type.String({ description: "New chat title (for set_title)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "New chat description (for set_description)" }),
  ),
  rights: Type.Optional(
    Type.Object({}, { description: "Admin rights object (for promote)" }),
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

const telegramDescriptor: PlatformActionDescriptor = {
  name: "telegram_action",
  label: "Telegram Actions",
  description:
    "Perform Telegram-specific actions: pin/unpin messages, send polls/stickers, get chat info/member count/admins, set chat title/description, ban/unban/promote members. Bot must be admin for moderation actions.",
  parameters: TelegramActionParams,
  rpcMethod: "telegram.action",
  gatedActions: [
    { action: "ban", gateKey: "telegram.ban", hint: "Ask the user to confirm this ban action, then call again with _confirmed: true." },
    { action: "promote", gateKey: "telegram.promote", hint: "Ask the user to confirm this promotion action, then call again with _confirmed: true." },
  ],
};

/**
 * Create a Telegram action tool with 12 actions.
 *
 * Destructive actions (ban, promote) are gated via createActionGate and
 * return requiresConfirmation:true when the action is classified as destructive.
 *
 * @param rpcCall - RPC call function for delegating to the Telegram backend
 * @returns AgentTool implementing the Telegram actions interface
 */
export function createTelegramActionTool(rpcCall: RpcCall) {
  return createPlatformActionTool(telegramDescriptor, rpcCall);
}
