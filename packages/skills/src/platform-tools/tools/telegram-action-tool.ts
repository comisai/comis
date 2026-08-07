// SPDX-License-Identifier: Apache-2.0
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

import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { createPlatformActionTool, type PlatformActionDescriptor } from "../platform-action-tool.js";
import { readStringParam, throwToolError } from "../tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec (§17.6). Descriptor name == emitted name.
registerActivityLabelSpec("telegram_action", {
  semanticPhase: "tool",
  label: "running Telegram action",
});

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
    {
      description:
        "Telegram-specific action. Valid values: pin (pin message), unpin (unpin message), poll (send poll), " +
        "sticker (send sticker), chat_info (get chat details), member_count (get member total), get_admins " +
        "(list admins), set_title (change chat title), set_description (change chat description), ban (ban user), " +
        "unban (unban user), promote (promote a user in an explicitly named group/channel; never use for " +
        "Comis sender trust)",
    },
  ),
  chat_id: Type.Optional(
    Type.String({
      description:
        "Chat/group ID. For ban, unban, or promote, the user must explicitly supply a group/channel ID; " +
        "never substitute the current direct chat.",
    }),
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

const TELEGRAM_GROUP_ADMIN_ACTIONS = ["ban", "unban", "promote"] as const;

function assertTelegramGroupAdminTarget(action: string, chatId: unknown): void {
  if (!TELEGRAM_GROUP_ADMIN_ACTIONS.includes(action as typeof TELEGRAM_GROUP_ADMIN_ACTIONS[number])) {
    return;
  }
  if (typeof chatId !== "string" || chatId.trim().length === 0) {
    throwToolError("missing_param", `Telegram ${action} requires chat_id.`, {
      param: "chat_id",
      hint: "Provide the explicit group or channel chat_id",
    });
  }
  const normalizedChatId = chatId.trim();
  const isPositiveNumericId = /^\d+$/.test(normalizedChatId) && /[1-9]/.test(normalizedChatId);
  if (isPositiveNumericId) {
    throwToolError(
      "invalid_value",
      `Telegram ${action} requires an explicit group or channel chat_id; positive numeric IDs identify direct user chats.`,
      {
        param: "chat_id",
        hint:
          "Do not ask for a group ID unless the user explicitly requested Telegram group administration. " +
          "A bare sender-admin request concerns agents.<id>.elevatedReply.senderTrustMap; it is operator-only, " +
          "so edit operator config and restart the daemon",
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Descriptor + factory wrapper
// ---------------------------------------------------------------------------

const telegramDescriptor: PlatformActionDescriptor = {
  name: "telegram_action",
  label: "Telegram Actions",
  description:
    "Perform Telegram-specific actions: pin/unpin messages, send polls/stickers, get chat info/member count/admins, set chat title/description, and ban/unban/promote members. " +
    "Promote means Telegram membership administration in an explicitly identified group/channel, not Comis sender trust. " +
    "A bare 'make ID admin' request concerns agents.<id>.elevatedReply.senderTrustMap; never ask for a group. " +
    "Bot must be admin for moderation actions.",
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
  const tool = createPlatformActionTool(telegramDescriptor, rpcCall);
  return {
    ...tool,
    async execute(...args: Parameters<typeof tool.execute>) {
      const params = args[1] as Record<string, unknown>;
      const action = readStringParam(params, "action") ?? "";
      assertTelegramGroupAdminTarget(action, params.chat_id);
      return tool.execute(...args);
    },
  };
}
