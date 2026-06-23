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
  ReactionHandler,
  ReconcileSendQuery,
  ReconcileSendOutcome,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createHash } from "node:crypto";
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
import { bindDiscordReactions } from "./discord-reaction-binder.js";
import { renderDiscordButtons, renderDiscordCards } from "./rich-renderer.js";
import { createDiscordVoiceSender } from "./voice-sender.js";
// Adjacent untyped-cast sites in editMessage / reactToMessage / removeReaction
// / deleteMessage / fetchMessages all use asTextLike, the structural-subset
// narrowing helper that discord-actions.ts also uses.
import { asTextLike } from "./discord-adapter-types.js";
import { runWithContext, systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscordAdapterDeps {
  botToken: string;
  logger: ComisLogger;
  /**
   * Optional Discord REST API root URL override (e.g. `http://127.0.0.1:54321`).
   * When set, the discord.js Client is constructed with `rest.api = apiRoot`.
   * The WebSocket gateway URL is fetched FROM this REST endpoint
   * (`GET /api/v10/gateway/bot`), so redirecting `apiRoot` to a 127.0.0.1
   * mock automatically redirects gateway connections too (the mock returns
   * its own ws://127.0.0.1 URL).
   *
   * Production callers leave this undefined — discord.js uses its default
   * `https://discord.com/api`. This is the production seam for the
   * wire-level E2E mock chat-platform fixture (test/e2e/mocks/discord/).
   */
  apiRoot?: string;
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
  // E2E seam: when deps.apiRoot is set, redirect discord.js's REST traffic
  // (and, transitively via /gateway/bot, the WebSocket gateway) to that URL.
  // Production callers leave it unset and discord.js uses its default
  // (https://discord.com/api).
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    ...(deps.apiRoot ? { rest: { api: deps.apiRoot } } : {}),
  });

  const handlers: MessageHandler[] = [];
  // REACT-01: inbound reaction-add handlers (the binder logic is co-located in
  // discord-reaction-binder.ts to hold the 800-line cap).
  const reactionHandlers: ReactionHandler[] = [];
  let _channelId = "discord-pending";
  // The bot's own user id, captured at start() from validateDiscordToken. Used
  // by reconcileSend to match author=bot (Spoofing T-216-25); empty until start.
  let _botUserId = "";
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
      // Fail fast on invalid token. Pass apiRoot if set so adapter
      // self-validation hits the redirection mock instead of discord.com.
      const tokenResult = await validateDiscordToken(deps.botToken, deps.apiRoot);
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
      _botUserId = botInfo.id;

      // TODO: Wire poll result normalization when Discord poll events are implemented.
      // Use normalizeDiscordPollResult() from ../shared/poll-normalizer.js
      // Discord.js supports Events.MessagePollVoteAdd/VoteRemove for individual votes.

      // Register message handler
      client.on(Events.MessageCreate, (msg) => {
        // Filter out bot's own messages and other bots
        if (msg.author.bot) {
          return;
        }

        _lastMessageAt = systemNowMs();
        const normalized = mapDiscordToNormalized(msg);

        // Mint traceId at ingress, stamp into metadata
        const traceId = randomUUID();
        normalized.metadata.traceId = traceId;

        deps.logger.info(
          { step: "channels-inbound", channelType: "discord", messageId: normalized.id, chatId: msg.channelId, previewLen: (normalized.text ?? "").length, traceId },
          "Inbound message",
        );

        // Fire-and-forget: don't block the event loop
        runWithContext(
          {
            traceId,
            startedAt: systemNowMs(),
            channelType: "discord",
            tenantId: "default",
            trustLevel: "admin",
          },
          () => {
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
          },
        );
      });

      // REACT-01: bind the inbound reaction-add listener (intents already held
      // at :92-93). Co-located in discord-reaction-binder.ts (800-line cap).
      bindDiscordReactions(client, reactionHandlers, deps.logger);

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
            timestamp: systemNowMs(),
            attachments: [],
            metadata: {
              isButtonCallback: true,
              callbackData: interaction.customId,
              messageId: interaction.message?.id,
              senderName: interaction.user.username,
            },
          };

          // Mint traceId at ingress for interaction dispatch
          const traceId = randomUUID();
          normalized.metadata.traceId = traceId;
          runWithContext(
            {
              traceId,
              startedAt: systemNowMs(),
              channelType: "discord",
              tenantId: "default",
              trustLevel: "admin",
            },
            () => {
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
            },
          );
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
      _startedAt = systemNowMs();

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

        _lastMessageAt = systemNowMs();
        _lastError = undefined;
        deps.logger.info(
          { step: "channels-outbound", channelType: "discord", messageId: firstMessage.id, chatId: channelId },
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
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        // Truncate to 2000 chars as a defensive check
        const truncatedText = text.length > 2000 ? text.slice(0, 2000) : text;

        const msg = await tc.messages.fetch(messageId);
        await msg.edit(truncatedText);

        deps.logger.info(
          { step: "channels-outbound", channelType: "discord", messageId, chatId: channelId },
          "Outbound message",
        );
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Preserve the typed DiscordAPIError as `cause` for structural
        // classification (code 10008 → not_supported, 50013 → permission,
        // status 429/retryAfter → rate_limited). classifyDiscordError reads the
        // structural fields off `cause`, never this generic string.
        return err(new Error(`Failed to edit message: ${message}`, { cause: error }));
      }
    },

    async reactToMessage(
      channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        const msg = await tc.messages.fetch(messageId);
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
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        const msg = await tc.messages.fetch(messageId);
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
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        const msg = await tc.messages.fetch(messageId);
        await msg.delete();
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Preserve the typed DiscordAPIError as `cause` for structural
        // classification. classifyDiscordError reads code/status/retryAfter off
        // `cause`, never this generic string.
        return err(new Error(`Failed to delete message: ${message}`, { cause: error }));
      }
    },

    async fetchMessages(
      channelId: string,
      options?: FetchMessagesOptions,
    ): Promise<Result<FetchedMessage[], Error>> {
      try {
        const channel = await client.channels.fetch(channelId);
        const tc = asTextLike(channel);
        if (!tc) {
          return err(new Error(`Channel ${channelId} is not a text-based channel`));
        }

        const fetchOptions: Record<string, unknown> = {
          limit: options?.limit ?? 20,
        };
        if (options?.before) {
          fetchOptions.before = options.before;
        }

        const messages = await tc.messages.fetch(fetchOptions);
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

    onReaction(handler: ReactionHandler): void {
      reactionHandlers.push(handler);
    },

    async reconcileSend(query: ReconcileSendQuery): Promise<Result<ReconcileSendOutcome, Error>> {
      // We can only prove a bot send if we know who the bot is. If start() has
      // not captured the bot user id, we cannot tell -> unresolved (never a
      // guess, ONCE-03).
      if (!_botUserId) {
        deps.logger.debug(
          { channelType: "discord", hint: "reconcileSend called before start(): bot id unknown" },
          "reconcileSend unresolved",
        );
        return ok({ kind: "unresolved" });
      }

      let tc: ReturnType<typeof asTextLike>;
      try {
        const channel = await client.channels.fetch(query.channelId);
        tc = asTextLike(channel);
      } catch {
        // A failed channel resolution cannot prove absence -> unresolved.
        return ok({ kind: "unresolved" });
      }
      if (!tc) {
        // Not a text-like channel: we cannot read history -> unresolved.
        return ok({ kind: "unresolved" });
      }

      // discord.js throws on fetch failure / rate-limit. A failed or partial
      // fetch can NEVER prove the message is absent (Pitfall 2 / T-216-22) —
      // any throw is `unresolved`, never `not_sent`.
      let fetched: Awaited<ReturnType<typeof tc.messages.fetch>>;
      try {
        fetched = await tc.messages.fetch({ limit: 50 });
      } catch (error) {
        deps.logger.warn(
          {
            channelType: "discord",
            chatId: query.channelId,
            err: error instanceof Error ? error : new Error(String(error)),
            hint: "messages.fetch failed; reconcile cannot prove absence",
            errorKind: "platform" as const,
          },
          "reconcileSend unresolved",
        );
        return ok({ kind: "unresolved" });
      }

      // fetch({limit}) returns a Collection<Snowflake, Message> (Map-iterable).
      for (const [, m] of fetched) {
        if (m.author?.id !== _botUserId) continue; // author=bot required (T-216-25)
        if (m.createdTimestamp < query.sentAfterMs || m.createdTimestamp > query.sentBeforeMs) {
          continue;
        }
        const digest = createHash("sha256").update(m.content ?? "").digest("hex").slice(0, 16);
        if (digest === query.contentDigest) {
          return ok({ kind: "sent", platformMessageId: m.id });
        }
      }

      // Full successful fetch, no bot-authored digest match in the window:
      // definitively absent from the queried window.
      return ok({ kind: "not_sent" });
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "discord",
        uptime: _connected && _startedAt ? systemNowMs() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
