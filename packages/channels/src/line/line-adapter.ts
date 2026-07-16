// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Channel Adapter: ChannelPort implementation using @line/bot-sdk v9+.
 *
 * Provides the bridge between LINE's Messaging API and Comis's
 * channel-agnostic ChannelPort interface. Uses:
 * - MessagingApiClient for sending push messages
 * - MessagingApiBlobClient for media content retrieval
 * - Webhook events for receiving messages (gateway registers the route)
 *
 * Key design decisions:
 * - Uses pushMessage exclusively (never replyMessage) to avoid replyToken
 *   expiration (tokens expire in 30 seconds, too short for agent processing)
 * - Webhook handler designed for immediate 200 response before processing
 * - LINE has no edit/delete/reaction APIs for bots
 *
 * @module
 */

import type {
  AttachmentPayload,
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { messagingApi, webhook } from "@line/bot-sdk";
import { buildFlexMessage, type FlexTemplate } from "./flex-builder.js";
import { mapLineToNormalized, isMessageEvent } from "./message-mapper.js";
import { systemNowMs, runWithContext } from "@comis/core";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LineAdapterDeps {
  channelAccessToken: string;
  channelSecret: string;
  webhookPath?: string;
  logger: ComisLogger;
  /**
   * Optional LINE Messaging API base URL override (e.g.
   * `http://127.0.0.1:54325`). When set, both the `MessagingApiClient`
   * and `MessagingApiBlobClient` are constructed with `baseURL=apiRoot`
   * so their HTTP requests hit the override instead of `api.line.me` /
   * `api-data.line.me`. Production callers leave this undefined.
   *
   * Production seam for the wire-level E2E mock chat-platform fixture
   * (test/e2e/mocks/line/).
   */
  apiRoot?: string;
}

export interface LineAdapterHandle extends ChannelPort {
  /** Process LINE webhook events. Called by the gateway webhook handler. */
  handleWebhookEvents(events: webhook.Event[]): void;
  /** Download message content via LINE BlobClient. Stream collected to Buffer. */
  getBlobContent(messageId: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LINE adapter implementing the ChannelPort interface.
 *
 * Uses @line/bot-sdk MessagingApiClient for all outgoing messages
 * (push-only, no replyToken dependency). Incoming messages arrive
 * via webhook events dispatched through handleWebhookEvents().
 */
export function createLineAdapter(deps: LineAdapterDeps): LineAdapterHandle {
  // E2E seam: when deps.apiRoot is set, point both LINE SDK clients at the
  // override base URL instead of api.line.me. Production omits the field
  // entirely, so the client config carries only the token key.
  const baseUrlOverride = deps.apiRoot ? { baseURL: deps.apiRoot } : {};
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: deps.channelAccessToken,
    ...baseUrlOverride,
  });

  const blobClient = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: deps.channelAccessToken,
    ...baseUrlOverride,
  });

  async function getBlobContent(messageId: string): Promise<Buffer> {
    const stream = await blobClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const handlers: MessageHandler[] = [];
  const _channelId = "line-pending";

  // Health tracking
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  /**
   * Process a single webhook event.
   * Dispatches message events to registered handlers.
   * Non-message events are logged but not dispatched.
   */
  function processEvent(event: webhook.Event): void {
    if (!isMessageEvent(event)) {
      deps.logger.debug({ channelType: "line" as const, eventType: event.type }, "Non-message event ignored");
      return;
    }

    const normalized = mapLineToNormalized(event);
    if (!normalized) {
      deps.logger.debug("LINE: message event produced null normalized message");
      return;
    }

    _lastMessageAt = systemNowMs();

    // Mint traceId at ingress, stamp into metadata.
    const traceId = randomUUID();
    normalized.metadata.traceId = traceId;

    deps.logger.info(
      { step: "channels-inbound", channelType: "line" as const, messageId: normalized.id, chatId: normalized.channelId, previewLen: (normalized.text ?? "").length, traceId },
      "Inbound message",
    );

    void runWithContext(
      { traceId, startedAt: systemNowMs(), channelType: "line", tenantId: "default", trustLevel: "admin" },
      () => {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(normalized)).catch((handlerErr) => {
              deps.logger.error({ err: handlerErr, hint: "Check LINE message handler logic", errorKind: "internal" as const }, "LINE message handler error");
            });
          } catch (handlerErr) {
            deps.logger.error({ err: handlerErr, hint: "Check LINE message handler logic", errorKind: "internal" as const }, "LINE message handler error");
          }
        }
      },
    );
  }

  /**
   * Map Comis attachment type to LINE message type and send via pushMessage.
   */
  async function sendAttachmentAsLineMessage(
    chatId: string,
    attachment: AttachmentPayload,
  ): Promise<Result<string, Error>> {
    try {
      let lineMessage: messagingApi.Message;

      switch (attachment.type) {
        case "image":
          lineMessage = {
            type: "image",
            originalContentUrl: attachment.url,
            previewImageUrl: attachment.url,
          };
          break;
        case "video":
          lineMessage = {
            type: "video",
            originalContentUrl: attachment.url,
            previewImageUrl: attachment.url,
          };
          break;
        case "audio":
          lineMessage = {
            type: "audio",
            originalContentUrl: attachment.url,
            duration: attachment.isVoiceNote && attachment.durationSecs
              ? attachment.durationSecs * 1000  // LINE requires milliseconds
              : 0,
          };
          break;
        default:
          // LINE has no generic "file" message type — send as text with URL
          lineMessage = {
            type: "text",
            text: attachment.caption
              ? `${attachment.caption}\n${attachment.url}`
              : attachment.url,
          };
          break;
      }

      // Voice send bookend logging
      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "line", chatId, durationMs: (attachment.durationSecs ?? 0) * 1000 },
          "Voice send started",
        );
      }

      const response = await client.pushMessage({
        to: chatId,
        messages: [lineMessage],
      });

      const messageId = response.sentMessages[0]?.id ?? "sent";

      if (attachment.isVoiceNote) {
        deps.logger.info(
          { channelType: "line", messageId, chatId },
          "Voice send complete",
        );
      }

      deps.logger.debug(
        {
          channelType: "line" as const,
          messageId,
          chatId,
          attachmentType: attachment.type,
          captionLength: attachment.caption?.length ?? 0,
          hasFileName: attachment.fileName !== undefined,
        },
        "Outbound attachment",
      );

      return ok(messageId);
    } catch (error) {
      const sendErr = error instanceof Error ? error : new Error(String(error));
      deps.logger.warn(
        {
          channelType: "line",
          chatId,
          err: sendErr,
          hint: "Verify LINE channel access token and media URL accessibility",
          errorKind: "platform" as const,
        },
        "Send attachment failed",
      );
      return err(new Error(`Failed to send LINE attachment: ${sendErr.message}`));
    }
  }

  const adapter: LineAdapterHandle = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "line";
    },

    async start(): Promise<Result<void, Error>> {
      // LINE is webhook-driven — the gateway must register the webhook route
      // externally. The adapter exposes handleWebhookEvents() for the gateway
      // to call when events arrive.

      // Basic credential validation
      if (!deps.channelAccessToken.trim() || !deps.channelSecret.trim()) {
        const credErr = new Error("LINE channel access token and secret must not be empty");
        deps.logger.error(
          {
            channelType: "line" as const,
            err: credErr,
            hint: "Verify LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET in LINE Developers console",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(credErr);
      }

      _connected = true;
      _startedAt = systemNowMs();
      deps.logger.info({ channelType: "line" as const, mode: "webhook" }, "Adapter started");
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      // No persistent connection to tear down
      _connected = false;
      deps.logger.info({ channelType: "line" as const }, "Adapter stopped");
      return ok(undefined);
    },

    async sendMessage(
      chatId: string,
      text: string,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      try {
        // Always use pushMessage — never replyMessage (replyTokens expire in 30s)
        const response = await client.pushMessage({
          to: chatId,
          messages: [{ type: "text", text }],
        });

        const messageId = response.sentMessages[0]?.id ?? "sent";

        _lastMessageAt = systemNowMs();
        _lastError = undefined;
        deps.logger.info(
          { step: "channels-outbound", channelType: "line" as const, messageId, chatId },
          "Outbound message",
        );

        return ok(messageId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "line",
            chatId,
            err: sendErr,
            hint: "Verify LINE channel access token and push message quota",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send LINE message: ${sendErr.message}`));
      }
    },

    async sendAttachment(
      chatId: string,
      attachment: AttachmentPayload,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      return sendAttachmentAsLineMessage(chatId, attachment);
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      try {
        switch (action) {
          case "sendFlex": {
            const chatId = String(params.chatId ?? params.to);
            const altText = String(params.altText ?? "Flex Message");
            const container = params.container as messagingApi.FlexContainer | undefined;
            const template = params.template as FlexTemplate | undefined;

            let flexContainer: messagingApi.FlexContainer;
            if (container) {
              flexContainer = container;
            } else if (template) {
              flexContainer = buildFlexMessage(template);
            } else {
              return err(new Error("sendFlex requires 'container' (FlexContainer) or 'template' (FlexTemplate)"));
            }

            const response = await client.pushMessage({
              to: chatId,
              messages: [{
                type: "flex",
                altText,
                contents: flexContainer,
              }],
            });

            const messageId = response.sentMessages[0]?.id ?? "sent";
            return ok({ sent: true, messageId });
          }

          case "sendTyping": {
            const chatId = String(params.chatId);
            try {
              await client.showLoadingAnimation({
                chatId,
                loadingSeconds: 20,
              });
              return ok({ typing: true });
            } catch {
              // Loading animation may fail for groups — non-fatal
              return ok({ typing: false, reason: "loading animation not supported for this chat" });
            }
          }

          case "richMenu": {
            // Delegate to rich-menu-manager (imported dynamically to avoid circular deps)
            return err(new Error("Rich menu operations should use createRichMenuManager() directly"));
          }

          default: {
            const unsupportedErr = new Error(`Unsupported action: ${action} on line`);
            deps.logger.warn(
              {
                channelType: "line",
                err: unsupportedErr,
                hint: `Action '${action}' is not supported by the LINE adapter`,
                errorKind: "validation" as const,
              },
              "Unsupported platform action",
            );
            return err(unsupportedErr);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`LINE action '${action}' failed: ${message}`));
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "line",
        uptime: _connected && _startedAt ? systemNowMs() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "webhook",
      };
    },

    /**
     * Process LINE webhook events.
     *
     * Called by the gateway webhook handler after signature verification
     * and immediate 200 response. Events are processed asynchronously.
     */
    handleWebhookEvents(events: webhook.Event[]): void {
      for (const event of events) {
        try {
          processEvent(event);
        } catch (eventErr) {
          deps.logger.error({ err: eventErr, hint: "Check LINE webhook event handler for unhandled errors", errorKind: "internal" as const }, "LINE: failed to process webhook event");
        }
      }
    },

    getBlobContent,
  };

  return adapter;
}
