/**
 * iMessage Channel Adapter: ChannelPort implementation using imsg JSON-RPC
 * over stdin/stdout child process.
 *
 * Provides bidirectional messaging on macOS:
 * - Send path: client.request("send", { chatId, text }) via stdin
 * - Receive path: onNotification handler maps imsg events to NormalizedMessage
 *
 * Lifecycle: start() validates connection -> creates client -> registers
 * notification handler. Messages are translated via mapImsgToNormalized and
 * dispatched to handlers.
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
import { createImsgClient, type ImsgClient } from "./imessage-client.js";
import { validateIMessageConnection } from "./credential-validator.js";
import { mapImsgToNormalized, type ImsgMessageParams } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IMessageAdapterDeps {
  /** Path to the imsg binary (defaults to "imsg"). */
  binaryPath?: string;
  /** iMessage account identifier (phone or email). */
  account?: string;
  /** Logger interface. */
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an iMessage adapter implementing the ChannelPort interface.
 *
 * Uses the imsg CLI's JSON-RPC interface over stdin/stdout for
 * bidirectional communication with iMessage on macOS.
 */
export function createIMessageAdapter(deps: IMessageAdapterDeps): ChannelPort {
  const handlers: MessageHandler[] = [];
  let client: ImsgClient | null = null;
  let _channelId = "imessage-pending";

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
      return "imessage";
    },

    async start(): Promise<Result<void, Error>> {
      // Validate macOS platform and binary availability
      const validateResult = await validateIMessageConnection({
        binaryPath: deps.binaryPath,
      });
      if (!validateResult.ok) {
        deps.logger.error(
          {
            channelType: "imessage" as const,
            err: validateResult.error,
            hint: "Verify imsg binary is available on PATH and running on macOS",
            errorKind: "config" as const,
          },
          "Adapter start failed",
        );
        return err(validateResult.error);
      }

      _channelId = deps.account
        ? `imessage-${deps.account}`
        : "imessage-default";

      // Create and start imsg JSON-RPC client
      const imsgClient = createImsgClient({
        binaryPath: deps.binaryPath,
        logger: deps.logger,
      });

      const startResult = await imsgClient.start();
      if (!startResult.ok) {
        deps.logger.error(
          {
            channelType: "imessage" as const,
            err: startResult.error,
            hint: "Verify imsg binary is available on PATH and running on macOS",
            errorKind: "config" as const,
          },
          "Adapter start failed",
        );
        return err(startResult.error);
      }

      client = imsgClient;

      // Register notification handler for incoming messages (receive path)
      client.onNotification((notification) => {
        if (notification.method === "message") {
          const params = notification.params as
            | { message?: ImsgMessageParams }
            | undefined;
          const messageParams = params?.message;
          if (!messageParams) return;

          // Skip messages from self
          if (messageParams.isFromMe) return;

          _lastMessageAt = Date.now();
          const normalized = mapImsgToNormalized(messageParams);

          deps.logger.info(
            { channelType: "imessage" as const, messageId: normalized.id, chatId: normalized.channelId, previewLen: (normalized.text ?? "").length },
            "Inbound message",
          );

          for (const handler of handlers) {
            try {
              Promise.resolve(handler(normalized)).catch((handlerErr) => {
                deps.logger.error(
                  {
                    err: handlerErr,
                    chatId: normalized.channelId,
                    hint: "Check iMessage notification handler logic",
                    errorKind: "internal" as const,
                  },
                  "iMessage handler error",
                );
              });
            } catch (handlerErr) {
              deps.logger.error(
                {
                  err: handlerErr,
                  chatId: normalized.channelId,
                  hint: "Check iMessage notification handler logic",
                  errorKind: "internal" as const,
                },
                "iMessage handler error",
              );
            }
          }
        }
      });

      // Subscribe to incoming messages via watch.subscribe
      const subResult = await client.request("watch.subscribe", {
        attachments: true,
      });
      if (!subResult.ok) {
        deps.logger.warn(
          {
            channelType: "imessage" as const,
            err: subResult.error,
            hint: "watch.subscribe failed; incoming messages may not be received",
            errorKind: "config" as const,
          },
          "Subscription setup failed",
        );
      }

      _connected = true;
      _startedAt = Date.now();
      deps.logger.info(
        { channelType: "imessage" as const },
        "Adapter started",
      );
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      if (!client) {
        return ok(undefined);
      }

      const closeResult = await client.close();
      client = null;
      _connected = false;
      deps.logger.info({ channelType: "imessage" as const }, "Adapter stopped");
      return closeResult;
    },

    async sendMessage(
      chatId: string,
      text: string,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (!client) {
        const notStartedErr = new Error("iMessage adapter not started");
        deps.logger.warn(
          {
            channelType: "imessage",
            chatId,
            err: notStartedErr,
            hint: "iMessage adapter not started; call start() first",
            errorKind: "config" as const,
          },
          "Send message failed",
        );
        return err(notStartedErr);
      }

      // Send path: client.request("send", { chatId, text })
      const result = await client.request("send", {
        chat_id: chatId,
        text,
      });

      if (!result.ok) {
        _lastError = result.error.message;
        deps.logger.warn(
          {
            channelType: "imessage",
            chatId,
            err: result.error,
            hint: "Check imsg binary availability and iMessage account status",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send iMessage: ${result.error.message}`));
      }

      // Extract message ID from response
      const response = result.value as Record<string, unknown> | null;
      const messageId =
        (typeof response?.messageId === "string" && response.messageId) ||
        (typeof response?.message_id === "string" && response.message_id) ||
        (typeof response?.id === "string" && response.id) ||
        (typeof response?.guid === "string" && response.guid) ||
        "ok";

      _lastMessageAt = Date.now();
      _lastError = undefined;
      deps.logger.debug(
        { channelType: "imessage" as const, messageId, chatId, preview: text.slice(0, 1500) },
        "Outbound message",
      );

      return ok(messageId);
    },

     
    async editMessage(_channelId: string, _messageId: string, _text: string): Promise<Result<void, Error>> {
      return err(
        new Error("Editing messages is not supported on iMessage."),
      );
    },

     
    async reactToMessage(_channelId: string, _messageId: string, _emoji: string): Promise<Result<void, Error>> {
      return err(
        new Error(
          "Reactions are not supported via the imsg CLI interface.",
        ),
      );
    },

     
    async removeReaction(_channelId: string, _messageId: string, _emoji: string): Promise<Result<void, Error>> {
      return err(
        new Error("Reactions are not supported on iMessage"),
      );
    },

     
    async deleteMessage(_channelId: string, _messageId: string): Promise<Result<void, Error>> {
      return err(
        new Error("Deleting messages is not supported on iMessage."),
      );
    },

    async fetchMessages(
      chatId: string,
      options?: FetchMessagesOptions,
    ): Promise<Result<FetchedMessage[], Error>> {
      if (!client) {
        return err(new Error("iMessage adapter not started"));
      }

      // imsg supports fetching chat history via chats.messages
      const result = await client.request("chats.messages", {
        chat_id: chatId,
        limit: options?.limit ?? 20,
      });

      if (!result.ok) {
        return err(new Error(`Failed to fetch iMessage history: ${result.error.message}`));
      }

      const raw = result.value as { messages?: Array<Record<string, unknown>> } | null;
      const messages = (raw?.messages ?? []).map(
        (msg): FetchedMessage => ({
          id: String(msg.id ?? msg.guid ?? ""),
          senderId: String(msg.sender ?? "unknown"),
          text: String(msg.text ?? ""),
          timestamp:
            typeof msg.timestamp === "number"
              ? msg.timestamp
              : typeof msg.created_at === "string"
                ? Date.parse(msg.created_at) || Date.now()
                : Date.now(),
        }),
      );

      return ok(messages);
    },

    async sendAttachment(
      chatId: string,
      attachment: AttachmentPayload,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (!client) {
        const notStartedErr = new Error("iMessage adapter not started");
        deps.logger.warn(
          {
            channelType: "imessage",
            chatId,
            err: notStartedErr,
            hint: "iMessage adapter not started; call start() first",
            errorKind: "config" as const,
          },
          "Send attachment failed",
        );
        return err(notStartedErr);
      }

      // Voice send bookend logging
      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "imessage", chatId, durationSecs: attachment.durationSecs },
          "Voice send started",
        );
      }

      // Send attachment via imsg's send command with file parameter
      const result = await client.request("send", {
        chat_id: chatId,
        text: attachment.caption ?? "",
        file: attachment.url,
      });

      if (!result.ok) {
        deps.logger.warn(
          {
            channelType: "imessage",
            chatId,
            err: result.error,
            hint: "Check imsg binary availability and file path accessibility",
            errorKind: "platform" as const,
          },
          "Send attachment failed",
        );
        return err(new Error(`Failed to send iMessage attachment: ${result.error.message}`));
      }

      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "imessage", chatId },
          "Voice send complete",
        );
        deps.logger.debug(
          { channelType: "imessage", format: attachment.mimeType },
          "Voice attachment sent (renders as audio file on iMessage)",
        );
      }

      deps.logger.debug(
        { channelType: "imessage" as const, messageId: "ok", chatId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
        "Outbound attachment",
      );

      return ok("ok");
    },

    async platformAction(
      action: string,
       
      _params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      // iMessage has limited platform action support via imsg
      switch (action) {
        case "sendTyping":
          // No typing indicator API in imsg
          return ok({ sent: false, reason: "iMessage does not support typing indicators" });
        default: {
          const unsupportedErr = new Error(`Unsupported action: ${action} on imessage`);
          deps.logger.warn(
            {
              channelType: "imessage",
              err: unsupportedErr,
              hint: `Action '${action}' is not supported by the iMessage adapter`,
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
        channelId: _channelId,
        channelType: "imessage",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
