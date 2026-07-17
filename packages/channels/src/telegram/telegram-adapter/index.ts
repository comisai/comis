// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram Channel Adapter: ChannelPort implementation using Grammy.
 *
 * Provides the bridge between Telegram's Bot API and Comis's
 * channel-agnostic ChannelPort interface. Uses:
 *   - grammy sequential polling - acknowledgement after durable acceptance
 *   - @grammyjs/auto-retry - 429 rate-limit handling
 *   - @grammyjs/files     - file hydration
 *
 * Lifecycle: start() validates token, wires inbound handlers via
 * bindInboundHandlers, then boots one-update-at-a-time polling. Messages
 * translate through mapGrammyToNormalized in inbound
 * and dispatch to handlers registered via onMessage.
 *
 * State-first protocol: shared state lives on TelegramAdapterState and
 * every helper takes the state object via its first positional parameter.
 *
 * @module
 */

import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import { Bot } from "grammy";
import {
  type TelegramAdapterDeps,
  type TelegramAdapterHandle,
  type TelegramAdapterState,
} from "./telegram-adapter-types.js";
import {
  getStatusReport,
  startLifecycle,
  stopLifecycle,
} from "./telegram-lifecycle.js";
import { registerMessageHandler, registerReactionHandler } from "./telegram-inbound.js";
import {
  deleteMessage,
  editMessage,
  reactToMessage,
  removeReaction,
  sendAttachment,
  sendMessage,
} from "./telegram-outbound.js";
import { platformAction } from "./telegram-platform-actions.js";

// Re-export the public-API types (consumers import these from
// @comis/channels via packages/channels/src/index.ts which re-exports
// from this barrel).
export type {
  TelegramAdapterDeps,
  TelegramAdapterHandle,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";

/** Build one isolated polling generation with all API transformers installed. */
function createConfiguredBot(deps: TelegramAdapterDeps, botToken: string): Bot {
  const bot = deps.apiRoot
    ? new Bot(botToken, { client: { apiRoot: deps.apiRoot } })
    : new Bot(botToken);

  bot.api.config.use(autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 10,
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: true,
  }));
  bot.api.config.use(hydrateFiles(botToken));
  return bot;
}

/**
 * Create a Telegram adapter implementing the ChannelPort interface.
 *
 * Uses Grammy for Telegram Bot API communication, with auto-retry for
 * rate limiting and sequential update acknowledgement.
 */
export function createTelegramAdapter(deps: TelegramAdapterDeps): TelegramAdapterHandle {
  const createBot = (botToken: string): Bot => createConfiguredBot(deps, botToken);

  const state: TelegramAdapterState = {
    bot: createBot(deps.getBotToken()),
    createBot,
    handlers: [],
    reactionHandlers: [],
    channelId: "telegram-pending",
    pollingTask: null,
    pollingGeneration: 0,
    lifecycleTail: Promise.resolve(),
    inFlightUpdates: new Set(),
    acceptingUpdates: false,
    stopGateTriggered: false,
    inboundHandlersBound: false,
    botIdentity: undefined,
    connected: false,
    startedAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };

  const adapter: TelegramAdapterHandle = {
    get channelId(): string {
      return state.channelId;
    },

    get channelType(): string {
      return "telegram";
    },

    start: () => startLifecycle(state, deps),

    stop: () => stopLifecycle(state, deps),

    sendMessage: (chatId, text, options) =>
      sendMessage(state, deps, chatId, text, options),

    editMessage: (chatId, messageId, text) =>
      editMessage(state, deps, chatId, messageId, text),

    reactToMessage: (chatId, messageId, emoji) =>
      reactToMessage(state, deps, chatId, messageId, emoji),

    removeReaction: (chatId, messageId, emoji) =>
      removeReaction(state, deps, chatId, messageId, emoji),

    deleteMessage: (chatId, messageId) =>
      deleteMessage(state, deps, chatId, messageId),

    sendAttachment: (chatId, attachment, options) =>
      sendAttachment(state, deps, chatId, attachment, options),

    platformAction: (action, params) =>
      platformAction(state, deps, action, params),

    onMessage(handler) {
      registerMessageHandler(state, handler);
    },

    onReaction(handler) {
      registerReactionHandler(state, handler);
    },

    getStatus: () => getStatusReport(state),

    get bot(): Bot {
      return state.bot;
    },
  };

  return adapter;
}
