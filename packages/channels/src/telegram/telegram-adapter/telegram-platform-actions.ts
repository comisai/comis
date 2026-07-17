// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Telegram SDK boundary throws; translated to Result at the adapter boundary.
/** Telegram-specific platform actions. */

import { err, ok, type Result } from "@comis/shared";
import { toSafeErrorLogString } from "@comis/core";
import { buildTypingThreadParams } from "../thread-context.js";
import { getActiveBot } from "./telegram-active-bot.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";

export async function platformAction(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  action: string,
  params: Record<string, unknown>,
): Promise<Result<unknown, Error>> {
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
  try {
    const resolveChatId = (raw: unknown): number | string => {
      const value = String(raw);
      return /^-?\d+$/.test(value) ? Number(value) : value;
    };

    switch (action) {
      case "pin": {
        const chatId = resolveChatId(params.chat_id);
        const messageId = Number(params.message_id);
        await bot.api.pinChatMessage(chatId, messageId);
        return ok({ pinned: true });
      }
      case "unpin": {
        const chatId = resolveChatId(params.chat_id);
        const messageId = params.message_id ? Number(params.message_id) : undefined;
        await bot.api.unpinChatMessage(chatId, messageId);
        return ok({ unpinned: true });
      }
      case "poll": {
        const chatId = resolveChatId(params.chat_id);
        const question = String(params.question);
        const options = params.options as string[];
        const result = await bot.api.sendPoll(chatId, question, options);
        return ok({ pollSent: true, chatId, messageId: result.message_id });
      }
      case "sticker": {
        const chatId = resolveChatId(params.chat_id);
        const stickerId = String(params.sticker_id);
        await bot.api.sendSticker(chatId, stickerId);
        return ok({ stickerSent: true, chatId });
      }
      case "chat_info": {
        const chatId = resolveChatId(params.chat_id);
        const chat = await bot.api.getChat(chatId);
        return ok(chat);
      }
      case "member_count": {
        const chatId = resolveChatId(params.chat_id);
        const count = await bot.api.getChatMemberCount(chatId);
        return ok({ count });
      }
      case "get_admins": {
        const chatId = resolveChatId(params.chat_id);
        const admins = await bot.api.getChatAdministrators(chatId);
        return ok({
          admins: admins.map((admin) => ({
            userId: admin.user.id,
            firstName: admin.user.first_name,
            isBot: admin.user.is_bot,
            status: admin.status,
          })),
        });
      }
      case "sendTyping": {
        const chatId = resolveChatId(params.chatId ?? params.chat_id);
        const threadId = params.threadId != null ? Number(params.threadId) : undefined;
        const typingParams = buildTypingThreadParams(threadId);
        await bot.api.sendChatAction(chatId, "typing", typingParams ?? {});
        return ok({ typing: true });
      }
      case "set_title": {
        const chatId = resolveChatId(params.chat_id);
        const title = String(params.title);
        await bot.api.setChatTitle(chatId, title);
        return ok({ titleSet: true });
      }
      case "set_description": {
        const chatId = resolveChatId(params.chat_id);
        const description = String(params.description);
        await bot.api.setChatDescription(chatId, description);
        return ok({ descriptionSet: true });
      }
      case "ban": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        await bot.api.banChatMember(chatId, userId);
        return ok({ banned: true, chatId, userId });
      }
      case "unban": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
        return ok({ unbanned: true });
      }
      case "promote": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        const rights = (params.rights as object | undefined) ?? {};
        await bot.api.promoteChatMember(chatId, userId, rights);
        return ok({ promoted: true });
      }
      case "createForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const name = String(params.name);
        const iconColor = params.icon_color != null ? Number(params.icon_color) : undefined;
        const iconCustomEmojiId = params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined;
        const result = await bot.api.createForumTopic(chatId, name, {
          icon_color: iconColor as 0x6FB9F0 | 0xFFD67E | 0xCB86DB | 0x8EEE98 | 0xFF93B2 | 0xFB6F5F | undefined,
          icon_custom_emoji_id: iconCustomEmojiId,
        });
        return ok({ topicId: result.message_thread_id, name: result.name });
      }
      case "editForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await bot.api.editForumTopic(chatId, threadId, {
          name: params.name ? String(params.name) : undefined,
          icon_custom_emoji_id: params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined,
        });
        return ok({ edited: true });
      }
      case "closeForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await bot.api.closeForumTopic(chatId, threadId);
        return ok({ closed: true });
      }
      case "reopenForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await bot.api.reopenForumTopic(chatId, threadId);
        return ok({ reopened: true });
      }
      default: {
        const unsupportedError = new Error(`Unsupported action: ${action} on telegram`);
        deps.logger.warn(
          {
            channelType: "telegram",
            err: toSafeErrorLogString(unsupportedError),
            hint: "Use one of the Telegram adapter actions declared by the channel capability contract",
            errorKind: "validation" as const,
          },
          "Unsupported platform action",
        );
        return err(unsupportedError);
      }
    }
  } catch (error) {
    const message = toSafeErrorLogString(error);
    return err(new Error(`Telegram action '${action}' failed: ${message}`));
  }
}
