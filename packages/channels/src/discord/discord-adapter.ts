// SPDX-License-Identifier: Apache-2.0
/**
 * Discord Channel Adapter: ChannelPort implementation using discord.js.
 *
 * Provides the bridge between Discord's Bot API and Comis's
 * channel-agnostic ChannelPort interface. Uses:
 * - discord.js Client with gateway intents for real-time messaging
 * - Built-in auto-reconnection (discord.js handles this internally)
 * - chunkDiscordText for 2000-char message limit
 *
 * Lifecycle: start() validates token -> registers event handlers -> logs in.
 * Messages are translated via mapDiscordToNormalized and dispatched to handlers.
 *
 * @module
 */

import type {
  AttachmentPayload,
  ChannelPort,
  ChannelStatus,
  FetchedMessage,
  FetchMessagesOptions,
  MessageHandler,
  NormalizedMessage,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";
import { executeDiscordAction } from "./discord-actions.js";
import { randomUUID } from "node:crypto";
import { validateDiscordToken } from "./credential-validator.js";
import { chunkDiscordText } from "./format-discord.js";
import { mapDiscordToNormalized } from "./message-mapper.js";
import { renderDiscordButtons, renderDiscordCards } from "./rich-renderer.js";
import { createDiscordVoiceSender } from "./voice-sender.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscordAdapterDeps {
  botToken: string;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Discord adapter implementing the ChannelPort interface.
 *
 * Uses discord.js Client for Discord Bot API communication. MessageContent
 * is a privileged intent -- the bot must have it enabled in the Discord
 * Developer Portal.
 */
export function createDiscordAdapter(deps: DiscordAdapterDeps): ChannelPort {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
  });

  const handlers: MessageHandler[] = [];
  let _channelId = "discord-pending";
  let reconnectAttempt = 0;

  // Health tracking
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  const adapter: ChannelPort = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "discord";
    },

    async start(): Promise<Result<void, Error>> {
      // Fail fast on invalid token
      const tokenResult = await validateDiscordToken(deps.botToken);
      if (!tokenResult.ok) {
        deps.logger.error(
          {
            channelType: "discord",
            err: tokenResult.error,
            hint: "Verify DISCORD_TOKEN in developer portal and ensure bot has Message Content intent enabled",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(tokenResult.error);
      }

      const botInfo = tokenResult.value;
      _channelId = `discord-${botInfo.id}`;

      // TODO: Wire poll result normalization when Discord poll events are implemented.
      // Use normalizeDiscordPollResult() from ../shared/poll-normalizer.js
      // Discord.js supports Events.MessagePollVoteAdd/VoteRemove for individual votes.

      // Register message handler
      client.on(Events.MessageCreate, (msg) => {
        // Filter out bot's own messages and other bots
        if (msg.author.bot) {
          return;
        }

        _lastMessageAt = Date.now();
        const normalized = mapDiscordToNormalized(msg);
        deps.logger.info(
          { channelType: "discord", messageId: normalized.id, chatId: msg.channelId, previewLen: (normalized.text ?? "").length },
          "Inbound message",
        );

        // Fire-and-forget: don't block the event loop
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(normalized)).catch((handlerErr) => {
              deps.logger.error(
                {
                  err: handlerErr,
                  channelId: msg.channelId,
                  hint: "Check Discord bot permissions and message handler logic",
                  errorKind: "internal" as const,
                },
                "Message handler error",
              );
            });
          } catch (handlerErr) {
            deps.logger.error(
              {
                err: handlerErr,
                channelId: msg.channelId,
                hint: "Check Discord bot permissions and message handler logic",
                errorKind: "internal" as const,
              },
              "Message handler error",
            );
          }
        }
      });

      // Shard lifecycle event handlers for reconnection visibility
      client.on("shardDisconnect", (event, shardId) => {
        _connected = false;
        reconnectAttempt++;
        deps.logger.warn(
          {
            channelType: "discord",
            attempt: reconnectAttempt,
            shardId,
            code: event.code,
            hint: "Discord gateway disconnected, discord.js will auto-reconnect",
            errorKind: "network" as const,
          },
          "Reconnection attempt",
        );
      });

      client.on("shardResume", (_replayed, shardId) => {
        _connected = true;
        reconnectAttempt = 0;
        deps.logger.info(
          { channelType: "discord", shardId },
          "Connection resumed",
        );
      });

      // Button interaction callback listener
      client.on(Events.InteractionCreate, async (interaction) => {
        // Only handle button interactions
        if (!interaction.isButton()) return;

        try {
          // Immediate ack -- MUST respond within 3 seconds
          await interaction.deferUpdate();

          // Normalize button callback into NormalizedMessage
          const normalized: NormalizedMessage = {
            id: randomUUID(),
            channelType: "discord",
            channelId: interaction.channelId,
            senderId: interaction.user.id,
            text: interaction.customId,
            timestamp: Date.now(),
            attachments: [],
            metadata: {
              isButtonCallback: true,
              callbackData: interaction.customId,
              messageId: interaction.message?.id,
              senderName: interaction.user.username,
            },
          };

          for (const handler of handlers) {
            try {
              Promise.resolve(handler(normalized)).catch((handlerErr) => {
                deps.logger.error(
                  {
                    err: handlerErr,
                    channelId: interaction.channelId,
                    hint: "Check message callback handler for unhandled errors",
                    errorKind: "internal" as const,
                  },
                  "Interaction handler error",
                );
              });
            } catch (handlerErr) {
              deps.logger.error(
                {
                  err: handlerErr,
                  channelId: interaction.channelId,
                  hint: "Check message callback handler for unhandled errors",
                  errorKind: "internal" as const,
                },
                "Interaction handler error",
              );
            }
          }
        } catch (error) {
          deps.logger.warn(
            {
              channelType: "discord",
              err: error instanceof Error ? error : new Error(String(error)),
              hint: "Button interaction acknowledgement or forwarding failed",
              errorKind: "platform" as const,
            },
            "Interaction callback failed",
          );
        }
      });

      // Log in to Discord gateway
      // discord.js handles auto-reconnection internally
      await client.login(deps.botToken);

      _connected = true;
      _startedAt = Date.now();

      deps.logger.info(
        { channelType: "discord", botId: botInfo.id, username: botInfo.username },
        "Adapter started",
      );

      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        client.destroy();
        _connected = false;
        deps.logger.info({ channelType: "discord" }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop Discord adapter: ${message}`));
      }
    },

    async sendMessage(
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          const channelErr = new Error(`Channel ${channelId} is not a text-based channel`);
          deps.logger.warn(
            {
              channelType: "discord",
              chatId: channelId,
              err: channelErr,
              hint: "Verify bot has Send Messages permission in the target channel",
              errorKind: "validation" as const,
            },
            "Send message failed",
          );
          return err(channelErr);
        }

        // Use chunkDiscordText to split if text exceeds 2000 chars
        const chunks = chunkDiscordText(text);
        if (chunks.length === 0) {
          const emptyErr = new Error("Cannot send empty message");
          deps.logger.warn(
            {
              channelType: "discord",
              chatId: channelId,
              err: emptyErr,
              hint: "Message content is empty after processing; check input text",
              errorKind: "validation" as const,
            },
            "Send message failed",
          );
          return err(emptyErr);
        }

        // Build send payload for first chunk
        const sendable = channel as {
          send: (opts: Record<string, unknown>) => Promise<{ id: string }>;
        };
        const payload: Record<string, unknown> = {
          content: chunks[0],
          ...(options?.replyTo
            ? { reply: { messageReference: { messageId: options.replyTo } } }
            : {}),
        };

        // Add buttons if present
        if (options?.buttons && options.buttons.length > 0) {
          payload.components = renderDiscordButtons(options.buttons);
          deps.logger.debug({ channelType: "discord", buttonsRendered: options.buttons.length }, "Rich buttons rendered");
        }

        // Add cards as embeds if present
        if (options?.cards && options.cards.length > 0) {
          payload.embeds = renderDiscordCards(options.cards);
          deps.logger.debug({ channelType: "discord", cardsRendered: options.cards.length }, "Rich cards rendered as embeds");
        }

        // Effects (spoiler/silent) are not natively supported by Discord text API -- silently ignore
        if (options?.effects && options.effects.length > 0) {
          deps.logger.debug({ channelType: "discord", effectsIgnored: options.effects }, "Rich effects silently ignored");
        }

        const firstMessage = await sendable.send(payload);

        // threadReply: create a public thread from the sent message
        if (options?.threadReply && firstMessage.id) {
          const threadChannel = channel as {
            threads?: { create: (opts: Record<string, unknown>) => Promise<unknown> };
          };
          if (threadChannel.threads?.create) {
            await threadChannel.threads.create({
              startMessage: firstMessage.id,
              name: text.slice(0, 100) || "Thread",
              autoArchiveDuration: 1440,
            });
          }
        }

        // Send remaining chunks as follow-up messages (plain text only)
        for (let i = 1; i < chunks.length; i++) {
          await sendable.send({ content: chunks[i] });
        }

        _lastMessageAt = Date.now();
        _lastError = undefined;
        deps.logger.debug(
          { channelType: "discord", messageId: firstMessage.id, chatId: channelId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(firstMessage.id);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "discord",
            chatId: channelId,
            err: sendErr,
            hint: "Verify bot has Send Messages permission in the target channel",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send message: ${sendErr.message}`));
      }
    },

    async editMessage(
      channelId: string,
      messageId: string,
      text: string,
    ): Promise<Result<void, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // Truncate to 2000 chars as a defensive check
        const truncatedText = text.length > 2000 ? text.slice(0, 2000) : text;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textChannel = channel as any;
        const msg = await textChannel.messages.fetch(messageId);
        await msg.edit(truncatedText);

        deps.logger.debug(
          { channelType: "discord", messageId, chatId: channelId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to edit message: ${message}`));
      }
    },

    async reactToMessage(
      channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textChannel = channel as any;
        const msg = await textChannel.messages.fetch(messageId);
        await msg.react(emoji);
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to react to message: ${message}`));
      }
    },

    async removeReaction(
      channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textChannel = channel as any;
        const msg = await textChannel.messages.fetch(messageId);
        const reaction = msg.reactions.cache.get(emoji);
        if (reaction) {
          await reaction.users.remove(client.user!.id);
        }
        // If reaction not found, return ok (idempotent)
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to remove reaction: ${message}`));
      }
    },

    async deleteMessage(
      channelId: string,
      messageId: string,
    ): Promise<Result<void, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textChannel = channel as any;
        const msg = await textChannel.messages.fetch(messageId);
        await msg.delete();
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to delete message: ${message}`));
      }
    },

    async fetchMessages(
      channelId: string,
      options?: FetchMessagesOptions,
    ): Promise<Result<FetchedMessage[], Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textChannel = channel as any;
        const fetchOptions: Record<string, unknown> = {
          limit: options?.limit ?? 20,
        };
        if (options?.before) {
          fetchOptions.before = options.before;
        }

        const messages = await textChannel.messages.fetch(fetchOptions);
        const mapped: FetchedMessage[] = [];
        for (const [, m] of messages) {
          mapped.push({
            id: m.id,
            senderId: m.author.id,
            text: m.content ?? "",
            timestamp: m.createdTimestamp,
          });
        }

        return ok(mapped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to fetch messages: ${message}`));
      }
    },

    async sendAttachment(
      channelId: string,
      attachment: AttachmentPayload,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Voice note dispatch: use 3-step upload protocol for native voice bubbles
      if (attachment.isVoiceNote && attachment.type === "audio") {
        const voiceSender = createDiscordVoiceSender({ botToken: deps.botToken, logger: deps.logger });
        return voiceSender.sendVoice(
          channelId,
          attachment.url,
          attachment.durationSecs ?? 0,
          attachment.waveform ?? "",
        );
      }

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          const channelErr = new Error(`Channel ${channelId} is not a text-based channel`);
          deps.logger.warn(
            {
              channelType: "discord",
              chatId: channelId,
              err: channelErr,
              hint: "Verify bot has Attach Files permission in the target channel",
              errorKind: "validation" as const,
            },
            "Send attachment failed",
          );
          return err(channelErr);
        }

        const sendable = channel as {
          send: (opts: Record<string, unknown>) => Promise<{ id: string }>;
        };

        const msg = await sendable.send({
          content: attachment.caption ?? "",
          files: [{ attachment: attachment.url, name: attachment.fileName ?? "file" }],
          ...(options?.replyTo
            ? { reply: { messageReference: { messageId: options.replyTo } } }
            : {}),
        });

        deps.logger.debug(
          { channelType: "discord", messageId: msg.id, chatId: channelId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
          "Outbound attachment",
        );
        return ok(msg.id);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        deps.logger.warn(
          {
            channelType: "discord",
            chatId: channelId,
            err: sendErr,
            hint: "Verify bot has Attach Files permission in the target channel",
            errorKind: "platform" as const,
          },
          "Send attachment failed",
        );
        return err(new Error(`Failed to send attachment: ${sendErr.message}`));
      }
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      return executeDiscordAction(client, action, params, deps.logger);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "discord",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
