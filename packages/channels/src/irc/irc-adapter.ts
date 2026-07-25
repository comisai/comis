// SPDX-License-Identifier: Apache-2.0
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
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { Client } from "irc-framework";
import { mapIrcToNormalized } from "./message-mapper.js";
import { systemClearTimeout, systemNowMs, systemSetTimeout, runWithContext } from "@comis/core";
import { randomUUID } from "node:crypto";

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
  return new Promise((resolve) => systemSetTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// reconcileSend is intentionally NOT implemented — this transport cannot reliably query 'did the bot send X?' (AppleScript/fire-and-forget/SMTP). Recovery treats the absence as 'unresolved' → park+escalate (the honest fallback, never a blind replay).
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
    _lastMessageAt = systemNowMs();
    const normalized = mapIrcToNormalized({
      target: event.target,
      nick: event.nick,
      message: event.message,
      tags: event.tags,
    });

    // Mint traceId at ingress, stamp into metadata
    const traceId = randomUUID();
    normalized.metadata.traceId = traceId;

    deps.logger.info(
      { step: "channels-inbound", channelType: "irc" as const, messageId: normalized.id, chatId: event.target, previewLen: (normalized.text ?? "").length, traceId },
      "Inbound message",
    );

    void runWithContext(
      { traceId, startedAt: systemNowMs(), channelType: "irc", tenantId: "default", trustLevel: "user" },
      () => {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(normalized)).catch((handlerErr) => {
              deps.logger.error({ err: handlerErr, nick: event.nick, hint: "Check IRC message handler logic", errorKind: "internal" as const }, "IRC message handler error");
            });
          } catch (handlerErr) {
            deps.logger.error({ err: handlerErr, nick: event.nick, hint: "Check IRC message handler logic", errorKind: "internal" as const }, "IRC message handler error");
          }
        }
      },
    );
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
          const timer = systemSetTimeout(() => {
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
            systemClearTimeout(timer);
            _connected = true;
            _startedAt = systemNowMs();
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
        _lastMessageAt = systemNowMs();
        _lastError = undefined;
        deps.logger.info(
          { step: "channels-outbound", channelType: "irc" as const, messageId: "sent", chatId },
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
        uptime: _connected && _startedAt ? systemNowMs() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
