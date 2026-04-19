/**
 * WhatsApp Channel Adapter: ChannelPort implementation using Baileys.
 *
 * Provides the bridge between WhatsApp Web (multi-device) and Comis's
 * channel-agnostic ChannelPort interface. Uses:
 * - @whiskeysockets/baileys for WhatsApp Web multi-device connectivity
 * - useMultiFileAuthState for persistent auth state
 * - Automatic reconnection on non-loggedOut disconnects
 *
 * Lifecycle: start() validates auth dir -> connects via Baileys -> listens.
 * Messages are translated via mapBaileysToNormalized and dispatched to handlers.
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
import { Boom } from "@hapi/boom";
import { ok, err } from "@comis/shared";
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { validateWhatsAppAuth } from "./credential-validator.js";
import { mapBaileysToNormalized, type BaileysMessage } from "./message-mapper.js";
import { createWhatsAppVoiceSender } from "./voice-sender.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WhatsAppAdapterDeps {
  authDir: string;
  printQR?: boolean; // Default: true
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WhatsApp adapter implementing the ChannelPort interface.
 *
 * Uses Baileys for WhatsApp Web multi-device communication, with automatic
 * reconnection on non-loggedOut disconnects and QR code pairing support.
 */
/** TTL in milliseconds for raw Baileys message cache entries. */
const RAW_MESSAGE_TTL_MS = 5 * 60 * 1000;

export interface WhatsAppAdapterHandle extends ChannelPort {
  /** Look up a raw Baileys message by its message ID from the TTL-based cache. */
  getRawMessage(id: string): BaileysMessage | undefined;
}

export function createWhatsAppAdapter(deps: WhatsAppAdapterDeps): WhatsAppAdapterHandle {
  const handlers: MessageHandler[] = [];
  let _channelId = "whatsapp-pending";
  let connected = false;
  let sock: WASocket | null = null;
  let reconnectAttempt = 0;

  // Health tracking
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  // TTL-based raw message cache for media resolution (used by WhatsApp resolver)
  const rawMessageCache = new Map<string, BaileysMessage>();

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(deps.authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: deps.printQR ?? true,
    });

    // Handle connection state changes (auto-reconnection)
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open") {
        connected = true;
        reconnectAttempt = 0;
        if (!_startedAt) _startedAt = Date.now();
        _channelId = `whatsapp-${sock?.user?.id ?? "unknown"}`;
        deps.logger.info({ channelType: "whatsapp" }, "Adapter started");
      }

      if (connection === "close") {
        connected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          reconnectAttempt++;
          deps.logger.warn(
            {
              channelType: "whatsapp",
              attempt: reconnectAttempt,
              statusCode,
              hint: "Connection lost, attempting automatic reconnection",
              errorKind: "network" as const,
            },
            "Reconnection attempt",
          );
          void connect(); // Automatic reconnection
        } else {
          deps.logger.error(
            {
              channelType: "whatsapp",
              err: lastDisconnect?.error,
              hint: "WhatsApp logged out, re-scan QR code to re-authenticate",
              errorKind: "auth" as const,
            },
            "Adapter connection lost permanently",
          );
        }
      }

      if (qr) {
        deps.logger.info("WhatsApp QR code generated -- scan with your phone");
      }
    });

    // TODO: Wire poll result normalization when WhatsApp poll vote tracking is implemented.
    // Use normalizeWhatsAppPollResult() from ../shared/poll-normalizer.js
    // Baileys provides poll vote data via sock.ev.on("messages.update") with pollUpdateMessage.

    // Handle incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return; // Only process new messages, not history sync
      for (const m of messages) {
        if (m.key.fromMe) continue; // Skip own messages

        // Cache the raw Baileys message for media resolution
        const msgId = m.key.id;
        if (msgId) {
          rawMessageCache.set(msgId, m as BaileysMessage);
          const timer = setTimeout(() => rawMessageCache.delete(msgId), RAW_MESSAGE_TTL_MS);
          timer.unref();
        }

        _lastMessageAt = Date.now();
        const normalized = mapBaileysToNormalized(m as BaileysMessage);
        deps.logger.info(
          { channelType: "whatsapp", messageId: normalized.id, chatId: m.key.remoteJid ?? "", previewLen: (normalized.text ?? "").length },
          "Inbound message",
        );
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(normalized)).catch((e) =>
              deps.logger.error({ err: e, hint: "Check WhatsApp message handler logic", errorKind: "internal" as const }, "Handler error"),
            );
          } catch (e) {
            deps.logger.error({ err: e, hint: "Check WhatsApp message handler logic", errorKind: "internal" as const }, "Handler error");
          }
        }
      }
    });

    // Save credentials when they're updated
    sock.ev.on("creds.update", saveCreds);
  }

  const adapter: WhatsAppAdapterHandle = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "whatsapp";
    },

    async start(): Promise<Result<void, Error>> {
      // Validate auth directory first
      const authResult = await validateWhatsAppAuth({
        authDir: deps.authDir,
        printQR: deps.printQR,
      });
      if (!authResult.ok) {
        deps.logger.error(
          {
            channelType: "whatsapp",
            err: authResult.error,
            hint: "Check Baileys auth directory permissions and re-scan QR code if session expired",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(authResult.error);
      }

      if (authResult.value.isFirstRun) {
        deps.logger.info("WhatsApp first run -- QR code pairing will be required");
      }

      try {
        await connect();
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to start WhatsApp adapter: ${message}`));
      }
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        if (sock) {
          sock.end(undefined);
        }
        connected = false;
        deps.logger.info({ channelType: "whatsapp" }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop WhatsApp adapter: ${message}`));
      }
    },

    async sendMessage(
      channelId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (!sock || !connected) {
        const notConnectedErr = new Error("WhatsApp not connected");
        deps.logger.warn(
          {
            channelType: "whatsapp",
            chatId: channelId,
            err: notConnectedErr,
            hint: "WhatsApp connection not established; verify QR pairing and auth state",
            errorKind: "network" as const,
          },
          "Send message failed",
        );
        return err(notConnectedErr);
      }
      try {
        // Log rich messaging features: buttons rendered, cards/effects ignored
        if (options?.buttons && options.buttons.length > 0) {
          deps.logger.debug({ channelType: "whatsapp", buttonsRendered: options.buttons.length }, "Rich buttons rendered");
        }
        if ((options?.cards && options.cards.length > 0) || (options?.effects && options.effects.length > 0)) {
          deps.logger.debug({ channelType: "whatsapp", cardsIgnored: !!(options?.cards?.length), effectsIgnored: !!(options?.effects?.length) }, "Rich features not supported on WhatsApp");
        }

        const sent = await sock.sendMessage(channelId, { text });
        const messageId = sent?.key?.id ?? "";
        _lastMessageAt = Date.now();
        _lastError = undefined;
        deps.logger.debug(
          { channelType: "whatsapp", messageId, chatId: channelId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(messageId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "whatsapp",
            chatId: channelId,
            err: sendErr,
            hint: "Check WhatsApp connection status and recipient availability",
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
      if (!sock || !connected) {
        return err(new Error("WhatsApp not connected"));
      }
      try {
        await sock.sendMessage(channelId, {
          text,
          edit: { remoteJid: channelId, id: messageId, fromMe: true },
        } as Parameters<typeof sock.sendMessage>[1]);
        deps.logger.debug(
          { channelType: "whatsapp", messageId, chatId: channelId, preview: text.slice(0, 1500) },
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
      if (!sock || !connected) {
        return err(new Error("WhatsApp not connected"));
      }
      try {
        await sock.sendMessage(channelId, {
          react: {
            text: emoji,
            key: { remoteJid: channelId, id: messageId, fromMe: false },
          },
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
      _emoji: string,
    ): Promise<Result<void, Error>> {
      if (!sock || !connected) {
        return err(new Error("WhatsApp not connected"));
      }
      try {
        await sock.sendMessage(channelId, {
          react: {
            text: "",
            key: { remoteJid: channelId, id: messageId, fromMe: false },
          },
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
      if (!sock || !connected) {
        return err(new Error("WhatsApp not connected"));
      }
      try {
        await sock.sendMessage(channelId, {
          delete: { remoteJid: channelId, id: messageId, fromMe: true },
        });
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to delete message: ${message}`));
      }
    },

     
    async fetchMessages(_channelId: string, _options?: FetchMessagesOptions): Promise<Result<FetchedMessage[], Error>> {
      return err(new Error("Fetching message history is not supported on WhatsApp."));
    },

    async sendAttachment(
      channelId: string,
      attachment: AttachmentPayload,
       
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (!sock || !connected) {
        const notConnectedErr = new Error("WhatsApp not connected");
        deps.logger.warn(
          {
            channelType: "whatsapp",
            chatId: channelId,
            err: notConnectedErr,
            hint: "WhatsApp connection not established; verify QR pairing and auth state",
            errorKind: "network" as const,
          },
          "Send attachment failed",
        );
        return err(notConnectedErr);
      }

      // Voice note dispatch: use voice-specific API for native voice bubbles
      if (attachment.isVoiceNote && attachment.type === "audio") {
        const voiceSender = createWhatsAppVoiceSender({ sock: sock!, logger: deps.logger });
        return voiceSender.sendVoice(channelId, attachment.url, attachment.durationSecs);
      }

      try {
        let mediaPayload: Parameters<typeof sock.sendMessage>[1];

        switch (attachment.type) {
          case "image":
            mediaPayload = {
              image: { url: attachment.url },
              caption: attachment.caption,
            };
            break;
          case "audio":
            mediaPayload = {
              audio: { url: attachment.url },
              mimetype: attachment.mimeType ?? "audio/mp4",
            };
            break;
          case "video":
            mediaPayload = {
              video: { url: attachment.url },
              caption: attachment.caption,
            };
            break;
          default:
            mediaPayload = {
              document: { url: attachment.url },
              mimetype: attachment.mimeType ?? "application/octet-stream",
              fileName: attachment.fileName ?? "file",
            };
            break;
        }

        const sent = await sock.sendMessage(channelId, mediaPayload);
        const attachmentId = sent?.key?.id ?? "";
        deps.logger.debug(
          { channelType: "whatsapp", messageId: attachmentId, chatId: channelId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
          "Outbound attachment",
        );
        return ok(attachmentId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        deps.logger.warn(
          {
            channelType: "whatsapp",
            chatId: channelId,
            err: sendErr,
            hint: "Check WhatsApp connection status and media file accessibility",
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
      if (!sock || !connected) {
        return err(new Error("WhatsApp not connected"));
      }
      try {
        switch (action) {
          case "group_info": {
            const groupJid = String(params.group_jid);
            const metadata = await sock.groupMetadata(groupJid);
            return ok({
              subject: metadata.subject,
              description: metadata.desc,
              participantsCount: metadata.participants.length,
              owner: metadata.owner,
            });
          }
          case "group_update_subject": {
            const groupJid = String(params.group_jid);
            const subject = String(params.subject);
            await sock.groupUpdateSubject(groupJid, subject);
            return ok({ subjectUpdated: true });
          }
          case "group_update_description": {
            const groupJid = String(params.group_jid);
            const description = String(params.description);
            await sock.groupUpdateDescription(groupJid, description);
            return ok({ descriptionUpdated: true });
          }
          case "group_participants_add": {
            const groupJid = String(params.group_jid);
            const participantJids = params.participant_jids as string[];
            await sock.groupParticipantsUpdate(groupJid, participantJids, "add");
            return ok({ added: true, participants: participantJids });
          }
          case "group_participants_remove": {
            const groupJid = String(params.group_jid);
            const participantJids = params.participant_jids as string[];
            await sock.groupParticipantsUpdate(groupJid, participantJids, "remove");
            return ok({ removed: true, participants: participantJids });
          }
          case "group_promote": {
            const groupJid = String(params.group_jid);
            const participantJids = params.participant_jids as string[];
            await sock.groupParticipantsUpdate(groupJid, participantJids, "promote");
            return ok({ promoted: true });
          }
          case "group_demote": {
            const groupJid = String(params.group_jid);
            const participantJids = params.participant_jids as string[];
            await sock.groupParticipantsUpdate(groupJid, participantJids, "demote");
            return ok({ demoted: true });
          }
          case "group_settings": {
            const groupJid = String(params.group_jid);
            const setting = String(params.setting) as
              | "announcement"
              | "not_announcement"
              | "locked"
              | "unlocked";
            await sock.groupSettingUpdate(groupJid, setting);
            return ok({ settingUpdated: true, setting });
          }
          case "group_invite_code": {
            const groupJid = String(params.group_jid);
            const inviteCode = await sock.groupInviteCode(groupJid);
            return ok({ inviteCode });
          }
          case "profile_status": {
            const statusText = String(params.status);
            await sock.updateProfileStatus(statusText);
            return ok({ statusUpdated: true });
          }
          case "group_leave": {
            const groupJid = String(params.group_jid);
            await sock.groupLeave(groupJid);
            return ok({ left: true, groupJid });
          }
          case "poll": {
            const chatId = String(params.chat_id);
            const question = String(params.question);
            const options = params.options as string[];
            const maxSelections =
              typeof params.max_selections === "number" ? params.max_selections : 1;

            const result = await sock.sendMessage(chatId, {
              poll: {
                name: question,
                values: options,
                selectableCount: maxSelections,
              },
            });

            // Store pollCreationMessage key for later vote decryption
            return ok({ pollSent: true, messageId: result?.key?.id, chatId });
          }
          case "sendTyping": {
            const chatId = params.chatId as string;
            if (!chatId) return err(new Error("chatId required for sendTyping"));
            await sock.sendPresenceUpdate("composing", chatId);
            return ok({ success: true });
          }
          default: {
            const unsupportedErr = new Error(`Unsupported action: ${action} on whatsapp`);
            deps.logger.warn(
              {
                channelType: "whatsapp",
                err: unsupportedErr,
                hint: `Action '${action}' is not supported by the WhatsApp adapter`,
                errorKind: "validation" as const,
              },
              "Unsupported platform action",
            );
            return err(unsupportedErr);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`WhatsApp action '${action}' failed: ${message}`));
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected,
        channelId: _channelId,
        channelType: "whatsapp",
        uptime: connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "socket",
      };
    },

    getRawMessage(id: string): BaileysMessage | undefined {
      return rawMessageCache.get(id);
    },
  };

  return adapter;
}
