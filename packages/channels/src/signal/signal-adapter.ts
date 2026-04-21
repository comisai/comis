// SPDX-License-Identifier: Apache-2.0
/**
 * Signal Channel Adapter: ChannelPort implementation using signal-cli daemon.
 *
 * Provides the bridge between Signal (via signal-cli JSON-RPC + SSE) and
 * Comis's channel-agnostic ChannelPort interface.
 *
 * Lifecycle:
 * - start() validates connection -> starts SSE event stream
 * - Messages are received via SSE, normalized, and dispatched to handlers
 * - sendMessage() uses JSON-RPC with optional byte-offset text styles from IR
 * - stop() aborts the SSE stream via AbortController
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
import { ok, err } from "@comis/shared";
import {
  signalRpcRequest,
  signalHealthCheck,
  createSignalEventStream,
  type SignalEnvelope,
} from "./signal-client.js";
import { mapSignalToNormalized } from "./message-mapper.js";
import { convertIrToSignalTextStyles } from "./signal-format.js";
import type { MarkdownIR } from "../shared/markdown-ir.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalAdapterDeps {
  baseUrl: string;
  account?: string;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Signal adapter implementing the ChannelPort interface.
 *
 * Uses signal-cli daemon's JSON-RPC API for sending and SSE for receiving.
 * When IR is provided in sendMessage options, converts to Signal text styles.
 */
export function createSignalAdapter(deps: SignalAdapterDeps): ChannelPort {
  const handlers: MessageHandler[] = [];
  let abortController: AbortController | null = null;
  const channelId = `signal-${deps.account ?? "default"}`;

  // Health tracking
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  /** Parse chatId to determine if it's a group or DM target. */
  function parseTarget(chatId: string): Record<string, unknown> {
    if (chatId.startsWith("group:")) {
      return { groupId: chatId.slice("group:".length) };
    }
    return { recipient: [chatId] };
  }

  /** Start the SSE event loop in the background. */
  function startEventLoop(signal: AbortSignal): void {
    (async () => {
      try {
        for await (const event of createSignalEventStream(
          deps.baseUrl,
          signal,
          deps.account,
        )) {
          if (!event.data) continue;

          try {
            const envelope: SignalEnvelope = JSON.parse(event.data);
            const normalized = mapSignalToNormalized(envelope, deps.baseUrl);
            if (!normalized) continue;

            _lastMessageAt = Date.now();
            deps.logger.info(
              { channelType: "signal" as const, messageId: normalized.id, chatId: normalized.channelId, previewLen: (normalized.text ?? "").length },
              "Inbound message",
            );

            for (const handler of handlers) {
              try {
                Promise.resolve(handler(normalized)).catch((handlerErr) => {
                  deps.logger.error(
                    {
                      err: handlerErr,
                      channelId: normalized.channelId,
                      hint: "Check Signal message handler logic",
                      errorKind: "internal" as const,
                    },
                    "Message handler error",
                  );
                });
              } catch (handlerErr) {
                deps.logger.error(
                  {
                    err: handlerErr,
                    channelId: normalized.channelId,
                    hint: "Check Signal message handler logic",
                    errorKind: "internal" as const,
                  },
                  "Message handler error",
                );
              }
            }
          } catch (parseErr) {
            deps.logger.debug({ err: parseErr }, "Failed to parse Signal SSE event");
          }
        }
      } catch (loopErr) {
        if (!signal.aborted) {
          deps.logger.warn(
            {
              channelType: "signal" as const,
              err: loopErr,
              hint: "SSE connection lost, adapter must be restarted manually",
              errorKind: "network" as const,
            },
            "SSE connection lost",
          );
        }
      }
    })();
  }

  const adapter: ChannelPort = {
    get channelId(): string {
      return channelId;
    },

    get channelType(): string {
      return "signal";
    },

    async start(): Promise<Result<void, Error>> {
      // Health check first
      const healthResult = await signalHealthCheck(deps.baseUrl);
      if (!healthResult.ok) {
        deps.logger.error(
          {
            channelType: "signal" as const,
            err: healthResult.error,
            hint: "Verify signal-cli daemon is running and accessible at the configured baseUrl",
            errorKind: "network" as const,
          },
          "Adapter start failed",
        );
        return err(healthResult.error);
      }

      // Start SSE event stream
      abortController = new AbortController();
      startEventLoop(abortController.signal);

      _connected = true;
      _startedAt = Date.now();

      deps.logger.info(
        { channelType: "signal" as const },
        "Adapter started",
      );

      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        _connected = false;
        deps.logger.info({ channelType: "signal" as const }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop Signal adapter: ${message}`));
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const target = parseTarget(chatId);
      const params: Record<string, unknown> = {
        ...target,
        message: text,
      };

      // If IR is available in extra, convert to text styles
      const ir = options?.extra?.ir as MarkdownIR | undefined;
      if (ir) {
        const formatted = convertIrToSignalTextStyles(ir);
        params.message = formatted.text;
        if (formatted.textStyles.length > 0) {
          params["text-style"] = formatted.textStyles.map(
            (style) => `${style.start}:${style.length}:${style.style}`,
          );
        }
      }

      if (deps.account) {
        params.account = deps.account;
      }

      const result = await signalRpcRequest("send", params, {
        baseUrl: deps.baseUrl,
      });

      if (!result.ok) {
        _lastError = result.error.message;
        deps.logger.warn(
          {
            channelType: "signal",
            chatId,
            err: result.error,
            hint: "Check signal-cli daemon connectivity and account registration",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(result.error);
      }

      const timestamp = (result.value as { timestamp?: number })?.timestamp;
      const messageId = timestamp ? String(timestamp) : "unknown";

      _lastMessageAt = Date.now();
      _lastError = undefined;
      deps.logger.debug(
        { channelType: "signal" as const, messageId, chatId, preview: text.slice(0, 1500) },
        "Outbound message",
      );

      return ok(messageId);
    },

     
    async editMessage(_chatId: string, _messageId: string, _text: string): Promise<Result<void, Error>> {
      return err(
        new Error("Editing messages is not supported on Signal."),
      );
    },

    async reactToMessage(
      chatId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      const target = parseTarget(chatId);
      const params: Record<string, unknown> = {
        ...target,
        emoji,
        targetTimestamp: Number(messageId),
      };

      if (deps.account) {
        params.account = deps.account;
      }

      const result = await signalRpcRequest("sendReaction", params, {
        baseUrl: deps.baseUrl,
      });

      if (!result.ok) {
        return err(result.error);
      }

      return ok(undefined);
    },

    async removeReaction(
      chatId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      const target = parseTarget(chatId);
      const params: Record<string, unknown> = {
        ...target,
        emoji,
        targetTimestamp: Number(messageId),
        remove: true,
      };

      if (deps.account) {
        params.account = deps.account;
      }

      const result = await signalRpcRequest("sendReaction", params, {
        baseUrl: deps.baseUrl,
      });

      if (!result.ok) {
        return err(result.error);
      }

      return ok(undefined);
    },

    async deleteMessage(
      chatId: string,
      messageId: string,
    ): Promise<Result<void, Error>> {
      const target = parseTarget(chatId);
      const params: Record<string, unknown> = {
        ...target,
        targetTimestamp: Number(messageId),
      };

      if (deps.account) {
        params.account = deps.account;
      }

      const result = await signalRpcRequest("sendRemoteDeleteMessage", params, {
        baseUrl: deps.baseUrl,
      });

      if (!result.ok) {
        return err(result.error);
      }

      return ok(undefined);
    },

     
    async fetchMessages(_channelId: string, _options?: FetchMessagesOptions): Promise<Result<FetchedMessage[], Error>> {
      return err(
        new Error(
          "Fetching message history is not supported on Signal. " +
            "Messages can only be received in real-time via SSE.",
        ),
      );
    },

    async sendAttachment(
      chatId: string,
      attachment: AttachmentPayload,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Voice send bookend logging
      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "signal", chatId, durationSecs: attachment.durationSecs },
          "Voice send started",
        );
      }

      const target = parseTarget(chatId);
      const params: Record<string, unknown> = {
        ...target,
        message: attachment.caption ?? "",
        attachments: [attachment.url],
      };

      if (deps.account) {
        params.account = deps.account;
      }

      const result = await signalRpcRequest("send", params, {
        baseUrl: deps.baseUrl,
      });

      if (!result.ok) {
        deps.logger.warn(
          {
            channelType: "signal",
            chatId,
            err: result.error,
            hint: "Check signal-cli daemon connectivity and file path accessibility",
            errorKind: "platform" as const,
          },
          "Send attachment failed",
        );
        return err(result.error);
      }

      const timestamp = (result.value as { timestamp?: number })?.timestamp;
      const attachmentMessageId = timestamp ? String(timestamp) : "unknown";

      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "signal", messageId: attachmentMessageId, chatId },
          "Voice send complete",
        );
        deps.logger.debug(
          { channelType: "signal", format: "ogg/opus", durationSecs: attachment.durationSecs },
          "Voice attachment sent (renders as audio file on Signal)",
        );
      }

      deps.logger.debug(
        { channelType: "signal" as const, messageId: attachmentMessageId, chatId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
        "Outbound attachment",
      );

      return ok(attachmentMessageId);
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      switch (action) {
        case "sendTyping": {
          const chatId = String(params.chatId ?? params.chat_id ?? "");
          const target = parseTarget(chatId);
          const typingParams: Record<string, unknown> = { ...target };
          if (deps.account) {
            typingParams.account = deps.account;
          }
          const result = await signalRpcRequest("sendTyping", typingParams, {
            baseUrl: deps.baseUrl,
          });
          if (!result.ok) return err(result.error);
          return ok({ typing: true });
        }

        case "sendReaction": {
          const chatId = String(params.chatId ?? params.chat_id ?? "");
          const emoji = String(params.emoji ?? "");
          const messageId = String(params.messageId ?? params.message_id ?? "");
          const target = parseTarget(chatId);
          const reactionParams: Record<string, unknown> = {
            ...target,
            emoji,
            targetTimestamp: Number(messageId),
          };
          if (deps.account) {
            reactionParams.account = deps.account;
          }
          const result = await signalRpcRequest("sendReaction", reactionParams, {
            baseUrl: deps.baseUrl,
          });
          if (!result.ok) return err(result.error);
          return ok({ reacted: true });
        }

        default: {
          const unsupportedErr = new Error(`Unsupported action: ${action} on signal`);
          deps.logger.warn(
            {
              channelType: "signal",
              err: unsupportedErr,
              hint: `Action '${action}' is not supported by the Signal adapter`,
              errorKind: "validation" as const,
            },
            "Unsupported platform action",
          );
          return err(unsupportedErr);
        }
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId,
        channelType: "signal",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
