/**
 * IRC Channel Adapter: ChannelPort implementation using irc-framework.
 *
 * Provides the bridge between IRC protocol and Comis's channel-agnostic
 * ChannelPort interface. Uses:
 * - irc-framework Client for persistent TCP/TLS socket connection
 * - NickServ IDENTIFY for authentication
 * - 512-char line splitting with flood protection delays
 *
 * Lifecycle: start() connects to IRC server -> registers -> joins channels.
 * Messages are translated via mapIrcToNormalized and dispatched to handlers.
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
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { Client } from "irc-framework";
import { mapIrcToNormalized } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IrcAdapterDeps {
  /** IRC server hostname (e.g. "irc.libera.chat") */
  host: string;
  /** IRC server port (defaults to 6697 with TLS, 6667 without) */
  port?: number;
  /** Bot's IRC nickname */
  nick: string;
  /** Use TLS (default: true) */
  tls?: boolean;
  /** Channels to auto-join on connect (e.g. ["#comis"]) */
  channels?: string[];
  /** NickServ password for IDENTIFY after registration */
  nickservPassword?: string;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum IRC message length (RFC 2812). Actual content limit is lower
 *  after accounting for protocol overhead, but 450 chars is a safe limit
 *  for the text portion of PRIVMSG. */
const IRC_MAX_LINE_CHARS = 450;

/** Delay between multi-line messages for flood protection (ms). */
const FLOOD_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a long message into IRC-safe chunks at word boundaries.
 * Each chunk is at most `maxChars` characters.
 */
function splitMessage(text: string, maxChars: number = IRC_MAX_LINE_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find last space before limit
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt <= 0) {
      // No space found -- hard split at limit
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Delay utility for flood protection between multi-line sends.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IRC adapter implementing the ChannelPort interface.
 *
 * Uses irc-framework for persistent TCP/TLS socket communication.
 * Handles NickServ authentication, channel management, and flood-safe
 * message sending with automatic line splitting.
 */
export function createIrcAdapter(deps: IrcAdapterDeps): ChannelPort {
  const bot = new Client();
  const handlers: MessageHandler[] = [];
  const useTls = deps.tls ?? true;
  let _channelId = `irc-${deps.host}`;

  // Health tracking
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  function dispatchMessage(event: { target: string; nick: string; message: string; tags?: Record<string, string> }): void {
    _lastMessageAt = Date.now();
    const normalized = mapIrcToNormalized({
      target: event.target,
      nick: event.nick,
      message: event.message,
      tags: event.tags,
    });

    deps.logger.info(
      { channelType: "irc" as const, messageId: normalized.id, chatId: event.target, previewLen: (normalized.text ?? "").length },
      "Inbound message",
    );

    for (const handler of handlers) {
      try {
        Promise.resolve(handler(normalized)).catch((handlerErr) => {
          deps.logger.error({ err: handlerErr, nick: event.nick, hint: "Check IRC message handler logic", errorKind: "internal" as const }, "IRC message handler error");
        });
      } catch (handlerErr) {
        deps.logger.error({ err: handlerErr, nick: event.nick, hint: "Check IRC message handler logic", errorKind: "internal" as const }, "IRC message handler error");
      }
    }
  }

  const adapter: ChannelPort = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "irc";
    },

    async start(): Promise<Result<void, Error>> {
      return fromPromise(
        new Promise<void>((resolve, reject) => {
          let settled = false;

          const settleOnce = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
          };

          // Timeout: if we don't register within 30 seconds, fail
          const timer = setTimeout(() => {
            const timeoutErr = new Error(`IRC connection to ${deps.host} timed out`);
            deps.logger.error(
              {
                channelType: "irc" as const,
                err: timeoutErr,
                hint: "Check IRC server hostname, port, TLS setting, and NickServ credentials",
                errorKind: "network" as const,
              },
              "Adapter start failed",
            );
            settleOnce(() => reject(timeoutErr));
          }, 30_000);

          bot.on("registered", () => {
            clearTimeout(timer);
            _connected = true;
            _startedAt = Date.now();
            _channelId = `irc-${bot.user.nick}@${deps.host}`;

            // NickServ authentication
            if (deps.nickservPassword) {
              bot.say("NickServ", `IDENTIFY ${deps.nickservPassword}`);
              deps.logger.debug("Sent NickServ IDENTIFY");
            }

            // Join configured channels
            if (deps.channels) {
              for (const channel of deps.channels) {
                bot.join(channel);
                deps.logger.debug({ channel }, "Joining IRC channel");
              }
            }

            deps.logger.info(
              { channelType: "irc" as const },
              "Adapter started",
            );

            settleOnce(() => resolve());
          });

          // Listen for messages (channel + DM)
          bot.on("privmsg", (event: { target: string; nick: string; message: string; tags?: Record<string, string> }) => {
            dispatchMessage(event);
          });

          bot.on("error", (event: { message: string }) => {
            const ircErr = new Error(`IRC error: ${event.message}`);
            deps.logger.error(
              {
                channelType: "irc" as const,
                err: ircErr,
                hint: "Check IRC server hostname, port, TLS setting, and NickServ credentials",
                errorKind: "network" as const,
              },
              "Adapter start failed",
            );
            settleOnce(() => reject(ircErr));
          });

          bot.on("reconnecting", (event: { attempt: number }) => {
            deps.logger.warn(
              {
                channelType: "irc" as const,
                attempt: event.attempt,
                hint: "IRC connection lost, irc-framework auto-reconnecting",
                errorKind: "network" as const,
              },
              "Reconnection attempt",
            );
          });

          bot.connect({
            host: deps.host,
            port: deps.port ?? (useTls ? 6697 : 6667),
            nick: deps.nick,
            tls: useTls,
          });
        }),
      );
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        bot.quit("Comis shutting down");
        _connected = false;
        deps.logger.info({ channelType: "irc" as const }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop IRC adapter: ${message}`));
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      try {
        const chunks = splitMessage(text);

        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) {
            await delay(FLOOD_DELAY_MS);
          }
          bot.say(chatId, chunks[i]);
        }

        // IRC has no standard message IDs; use IRCv3 msgid if echoed back,
        // otherwise return a synthetic identifier
        _lastMessageAt = Date.now();
        _lastError = undefined;
        deps.logger.debug(
          { channelType: "irc" as const, messageId: "sent", chatId, preview: text.slice(0, 1500) },
          "Outbound message",
        );

        return ok("sent");
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "irc",
            chatId,
            err: sendErr,
            hint: "Check IRC server connection and channel join status",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send IRC message: ${sendErr.message}`));
      }
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async editMessage(_channelId: string, _messageId: string, _text: string): Promise<Result<void, Error>> {
      return err(new Error("IRC does not support message editing"));
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async reactToMessage(_channelId: string, _messageId: string, _emoji: string): Promise<Result<void, Error>> {
      return err(new Error("IRC does not support reactions"));
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async removeReaction(_channelId: string, _messageId: string, _emoji: string): Promise<Result<void, Error>> {
      return err(new Error("Reactions are not supported on IRC"));
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async deleteMessage(_channelId: string, _messageId: string): Promise<Result<void, Error>> {
      return err(new Error("IRC does not support message deletion"));
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async fetchMessages(_channelId: string, _options?: FetchMessagesOptions): Promise<Result<FetchedMessage[], Error>> {
      return err(new Error("IRC does not support fetching message history"));
    },

    async sendAttachment(
      channelId: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _attachment: AttachmentPayload,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const attachErr = new Error("IRC does not support attachments (text-only protocol)");
      deps.logger.warn(
        {
          channelType: "irc",
          chatId: channelId,
          err: attachErr,
          hint: "IRC is a text-only protocol and does not support attachments",
          errorKind: "validation" as const,
        },
        "Send attachment failed",
      );
      return err(attachErr);
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      try {
        switch (action) {
          case "join": {
            const channel = String(params.channel);
            bot.join(channel);
            return ok({ joined: true, channel });
          }
          case "part": {
            const channel = String(params.channel);
            bot.part(channel);
            return ok({ parted: true, channel });
          }
          case "topic": {
            const channel = String(params.channel);
            const topic = String(params.topic);
            bot.setTopic(channel, topic);
            return ok({ topicSet: true, channel });
          }
          case "sendTyping": {
            // IRC has no typing indicator -- no-op
            return ok(undefined);
          }
          default: {
            const unsupportedErr = new Error(`Unsupported action: ${action} on irc`);
            deps.logger.warn(
              {
                channelType: "irc",
                err: unsupportedErr,
                hint: `Action '${action}' is not supported by the IRC adapter`,
                errorKind: "validation" as const,
              },
              "Unsupported platform action",
            );
            return err(unsupportedErr);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`IRC action '${action}' failed: ${message}`));
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "irc",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
