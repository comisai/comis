/**
 * Slack Channel Adapter: ChannelPort implementation using @slack/bolt.
 *
 * Provides the bridge between Slack's API and Comis's channel-agnostic
 * ChannelPort interface. Supports two modes:
 * - Socket Mode: Real-time connection via WebSocket (requires appToken)
 * - HTTP Mode: Event subscription via HTTP endpoints (requires signingSecret)
 *
 * Lifecycle: start() validates credentials -> registers event handlers -> starts Bolt.
 * Messages are translated via mapSlackToNormalized and dispatched to handlers.
 * Outbound messages arrive pre-formatted as mrkdwn from the delivery pipeline.
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
import { randomUUID } from "node:crypto";
import type { SlackMessageEvent } from "./message-mapper.js";
import { validateSlackCredentials } from "./credential-validator.js";
import { mapSlackToNormalized } from "./message-mapper.js";
import { renderSlackButtons, renderSlackCards } from "./rich-renderer.js";
import { executeSlackAction } from "./slack-actions.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SlackAdapterDeps {
  botToken: string;
  mode: "socket" | "http";
  appToken?: string;
  signingSecret?: string;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Slack adapter implementing the ChannelPort interface.
 *
 * Uses @slack/bolt App for Slack API communication, with support for
 * both Socket Mode (WebSocket) and HTTP Mode (event subscriptions).
 */
export function createSlackAdapter(deps: SlackAdapterDeps): ChannelPort {
  const handlers: MessageHandler[] = [];
  let _channelId = "slack-pending";
  let _ownBotId = "";
  let _ownUserId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any = null;

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
      return "slack";
    },

    async start(): Promise<Result<void, Error>> {
      // Fail fast on invalid credentials
      const credResult = await validateSlackCredentials({
        botToken: deps.botToken,
        mode: deps.mode,
        appToken: deps.appToken,
        signingSecret: deps.signingSecret,
      });

      if (!credResult.ok) {
        const isAppTokenError =
          credResult.error.message.toLowerCase().includes("apptoken") ||
          credResult.error.message.toLowerCase().includes("app token") ||
          credResult.error.message.toLowerCase().includes("socket mode");
        deps.logger.error(
          {
            channelType: "slack",
            err: credResult.error,
            hint: isAppTokenError
              ? "Socket Mode requires SLACK_APP_TOKEN starting with xapp-"
              : "Verify SLACK_BOT_TOKEN starts with xoxb- and has required scopes",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(credResult.error);
      }

      const botInfo = credResult.value;
      _channelId = `slack-${botInfo.teamId}-${botInfo.userId}`;
      _ownBotId = botInfo.botId;
      _ownUserId = botInfo.userId;

      try {
        // Dynamic import to keep @slack/bolt optional at module level
        const { App } = await import("@slack/bolt");

        // Create Bolt App with mode-dependent config
        if (deps.mode === "socket") {
          app = new App({
            token: deps.botToken,
            appToken: deps.appToken,
            socketMode: true,
          });
        } else {
          app = new App({
            token: deps.botToken,
            signingSecret: deps.signingSecret,
          });
        }

        // Register message event handler
        app.event("message", async ({ event }: { event: SlackMessageEvent }) => {
          // Filter out bot's own messages
          if (event.bot_id && event.bot_id === _ownBotId) {
            deps.logger.debug({ bot_id: event.bot_id }, "Filtering own bot message");
            return;
          }

          // Filter bot_message subtype from our bot
          if (event.subtype === "bot_message" && event.bot_id === _ownBotId) {
            return;
          }

          // Filter messages from our own user ID
          if (event.user === _ownUserId) {
            deps.logger.debug({ user: event.user }, "Filtering own user message");
            return;
          }

          _lastMessageAt = Date.now();
          const normalized = mapSlackToNormalized(event);
          deps.logger.info(
            { channelType: "slack", messageId: normalized.id, chatId: event.channel, previewLen: (normalized.text ?? "").length },
            "Inbound message",
          );

          // Fire-and-forget dispatch to all registered handlers
          for (const handler of handlers) {
            try {
              Promise.resolve(handler(normalized)).catch((handlerErr) => {
                deps.logger.error(
                  {
                    err: handlerErr,
                    channel: event.channel,
                    hint: "Check Slack message handler logic",
                    errorKind: "internal" as const,
                  },
                  "Slack message handler error",
                );
              });
            } catch (handlerErr) {
              deps.logger.error(
                {
                  err: handlerErr,
                  channel: event.channel,
                  hint: "Check Slack message handler logic",
                  errorKind: "internal" as const,
                },
                "Slack message handler error",
              );
            }
          }
        });

        // Button callback (block_actions) listener
        app.action(/.*/, async ({ action, ack, body }: {
          action: Record<string, unknown>;
          ack: () => Promise<void>;
          body: Record<string, unknown>;
        }) => {
          try {
            await ack(); // Immediate acknowledgement

            const buttonAction = action as { action_id?: string; value?: string };
            const user = (body as { user?: { id?: string; name?: string } }).user;

            const normalized: NormalizedMessage = {
              id: randomUUID(),
              channelType: "slack",
              channelId:
                (body as { channel?: { id?: string } }).channel?.id ?? "",
              senderId: user?.id ?? "",
              text: buttonAction.action_id ?? "",
              timestamp: Date.now(),
              attachments: [],
              metadata: {
                isButtonCallback: true,
                callbackData: buttonAction.action_id,
                messageId: (body as { message?: { ts?: string } }).message?.ts,
                senderName: user?.name ?? "unknown",
              },
            };

            for (const handler of handlers) {
              try {
                Promise.resolve(handler(normalized)).catch((handlerErr) => {
                  deps.logger.error(
                    {
                      err: handlerErr,
                      channel: normalized.channelId,
                      hint: "Check Slack callback handler for unhandled errors",
                      errorKind: "internal" as const,
                    },
                    "Slack action handler error",
                  );
                });
              } catch (handlerErr) {
                deps.logger.error(
                  {
                    err: handlerErr,
                    channel: normalized.channelId,
                    hint: "Check Slack callback handler for unhandled errors",
                    errorKind: "internal" as const,
                  },
                  "Slack action handler error",
                );
              }
            }
          } catch (error) {
            deps.logger.warn(
              {
                channelType: "slack",
                err: error instanceof Error ? error : new Error(String(error)),
                hint: "Block action acknowledgement or forwarding failed",
                errorKind: "platform" as const,
              },
              "Block action callback failed",
            );
          }
        });

        // Start the Bolt app
        await app.start();

        _connected = true;
        _startedAt = Date.now();

        deps.logger.info(
          {
            channelType: "slack",
            mode: deps.mode,
            teamId: botInfo.teamId,
            userId: botInfo.userId,
          },
          "Adapter started",
        );

        return ok(undefined);
      } catch (error) {
        deps.logger.error(
          {
            channelType: "slack",
            err: error instanceof Error ? error : new Error(String(error)),
            hint: "Verify SLACK_BOT_TOKEN starts with xoxb- and has required scopes",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to start Slack adapter: ${message}`));
      }
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        if (app) {
          await app.stop();
        }
        _connected = false;
        deps.logger.info({ channelType: "slack" }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop Slack adapter: ${message}`));
      }
    },

    async sendMessage(
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      try {
        // Text arrives pre-formatted as mrkdwn from the delivery pipeline
        // (formatForChannel renders via IR). Adapter is a passthrough.

        // Build blocks from cards and buttons
        const blocks: Record<string, unknown>[] = [];
        if (options?.cards && options.cards.length > 0) {
          blocks.push(...renderSlackCards(options.cards));
          deps.logger.debug({ channelType: "slack", cardsRendered: options.cards.length }, "Rich cards rendered as blocks");
        }
        if (options?.buttons && options.buttons.length > 0) {
          blocks.push(...renderSlackButtons(options.buttons));
          deps.logger.debug({ channelType: "slack", buttonsRendered: options.buttons.length }, "Rich buttons rendered");
        }

        const result = await app.client.chat.postMessage({
          channel: channelId,
          text, // Pre-formatted mrkdwn from pipeline (notification/accessibility fallback)
          ...(blocks.length > 0 ? { blocks } : {}),
          ...(options?.replyTo ? { thread_ts: options.replyTo } : {}),
          ...(options?.threadReply && options?.replyTo ? { reply_broadcast: false } : {}),
        });
        const messageId = String(result.ts ?? "");
        _lastMessageAt = Date.now();
        _lastError = undefined;
        deps.logger.debug(
          { channelType: "slack", messageId, chatId: channelId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(messageId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "slack",
            chatId: channelId,
            err: sendErr,
            hint: "Verify Slack bot token scopes include chat:write for the target channel",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send Slack message: ${sendErr.message}`));
      }
    },

    async editMessage(
      channelId: string,
      messageId: string,
      text: string,
    ): Promise<Result<void, Error>> {
      try {
        // Text arrives pre-formatted as mrkdwn from the RPC handler
        // (formatForChannel call in message.edit). Adapter is a passthrough.
        await app.client.chat.update({
          channel: channelId,
          ts: messageId,
          text,
        });
        deps.logger.debug(
          { channelType: "slack", messageId, chatId: channelId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to edit Slack message: ${message}`));
      }
    },

    async reactToMessage(
      channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        // Strip colons from Slack emoji short names (e.g. ":thumbsup:" -> "thumbsup")
        const emojiName = emoji.replace(/^:+|:+$/g, "");
        await app.client.reactions.add({
          channel: channelId,
          timestamp: messageId,
          name: emojiName,
        });
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
        // Strip colons from Slack emoji short names (e.g. ":thumbsup:" -> "thumbsup")
        const emojiName = emoji.replace(/^:+|:+$/g, "");
        await app.client.reactions.remove({
          channel: channelId,
          timestamp: messageId,
          name: emojiName,
        });
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
        await app.client.chat.delete({
          channel: channelId,
          ts: messageId,
        });
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
        const result = await app.client.conversations.history({
          channel: channelId,
          limit: options?.limit ?? 20,
          ...(options?.before ? { latest: options.before } : {}),
        });

        const mapped: FetchedMessage[] = (result.messages ?? []).map(
          (m: { ts?: string; user?: string; bot_id?: string; text?: string }) => ({
            id: m.ts ?? "",
            senderId: m.user ?? m.bot_id ?? "",
            text: m.text ?? "",
            timestamp: Math.floor(parseFloat(m.ts ?? "0") * 1000),
          }),
        );

        return ok(mapped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to fetch messages: ${message}`));
      }
    },

    async sendAttachment(
      channelId: string,
      attachment: AttachmentPayload,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Voice send bookend logging
      const isVoice = !!attachment.isVoiceNote;
      if (isVoice) {
        deps.logger.info(
          { channelType: "slack", chatId: channelId, durationSecs: attachment.durationSecs },
          "Voice send started",
        );
      }

      try {
        const filename = isVoice
          ? (attachment.fileName ?? "voice-message.ogg")
          : (attachment.fileName ?? "file");

        const result = await app.client.files.uploadV2({
          channel_id: channelId,
          file: attachment.url,
          filename,
          initial_comment: attachment.caption,
        });
        const attachmentId = String(result.file?.id ?? "");

        if (isVoice) {
          deps.logger.info(
            { channelType: "slack", messageId: attachmentId, chatId: channelId },
            "Voice send complete",
          );
          deps.logger.debug(
            { channelType: "slack" },
            "Voice attachment uploaded (renders as inline audio player on Slack)",
          );
        }

        deps.logger.debug(
          { channelType: "slack", messageId: attachmentId, chatId: channelId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
          "Outbound attachment",
        );
        return ok(attachmentId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        deps.logger.warn(
          {
            channelType: "slack",
            chatId: channelId,
            err: sendErr,
            hint: "Verify Slack bot token scopes include files:write",
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
      return executeSlackAction(app, action, params, deps.logger);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "slack",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: deps.mode === "http" ? "webhook" : "socket",
      };
    },
  };

  return adapter;
}
