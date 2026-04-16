/**
 * WhatsApp MediaResolverPort adapter.
 *
 * Resolves wa-file:// URIs by looking up the raw Baileys message from a
 * TTL-based cache and using Baileys downloadContentFromMessage to decrypt
 * and download the media.
 *
 * Post-download size check (WhatsApp does not expose file size before download).
 * Emits a DEBUG log with platform, messageId, sizeBytes, and durationMs.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import type { BaileysMessage } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface WhatsAppResolverDeps {
  /** Callback to look up a raw Baileys message by its message ID from the cache. */
  getRawMessage: (id: string) => BaileysMessage | undefined;
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Media type keys in a Baileys message content, mapped to downloadContentFromMessage type param. */
const MEDIA_KEYS = [
  { key: "imageMessage", type: "image" },
  { key: "audioMessage", type: "audio" },
  { key: "videoMessage", type: "video" },
  { key: "documentMessage", type: "document" },
] as const;

/**
 * Detect the media content object and its type from a Baileys message.
 */
function detectMediaContent(
  message: BaileysMessage["message"],
): { content: Record<string, unknown>; mediaType: string; mimeType: string } | undefined {
  if (!message) return undefined;

  for (const { key, type } of MEDIA_KEYS) {
    const content = (message as Record<string, unknown>)[key];
    if (content && typeof content === "object") {
      const mimeType =
        (content as Record<string, unknown>).mimetype as string | undefined;
      return {
        content: content as Record<string, unknown>,
        mediaType: type,
        mimeType: mimeType ?? "application/octet-stream",
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WhatsApp media resolver implementing MediaResolverPort.
 *
 * Resolves wa-file://{messageId} URIs by looking up the raw Baileys message
 * from a TTL-based cache, detecting the media type, and downloading the
 * encrypted media via Baileys' downloadContentFromMessage.
 */
export function createWhatsAppResolver(deps: WhatsAppResolverDeps): MediaResolverPort {
  return {
    schemes: ["wa-file"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Extract message ID from wa-file://{messageId}
          const messageId = attachment.url.replace(/^wa-file:\/\//, "");
          if (!messageId) {
            throw new Error("Invalid wa-file:// URL: missing messageId");
          }

          // Look up raw Baileys message from cache
          const rawMessage = deps.getRawMessage(messageId);
          if (!rawMessage) {
            throw new Error("Raw Baileys message not found in cache");
          }

          // Detect media type from message content
          const media = detectMediaContent(rawMessage.message);
          if (!media) {
            throw new Error("No downloadable media content found in Baileys message");
          }

          // Download media via Baileys (handles E2EE decryption)
          const startMs = Date.now();
          const stream = await downloadContentFromMessage(
            media.content as Parameters<typeof downloadContentFromMessage>[0],
            media.mediaType as Parameters<typeof downloadContentFromMessage>[1],
          );

          // Collect stream chunks into a Buffer
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks);
          const durationMs = Date.now() - startMs;

          // Reject downloads exceeding size limit
          if (buffer.length > deps.maxBytes) {
            throw new Error(
              `WhatsApp media size ${buffer.length} exceeds limit of ${deps.maxBytes} bytes`,
            );
          }

          // Debug log for media pipeline visibility
          deps.logger.debug(
            { platform: "whatsapp", messageId, sizeBytes: buffer.length, durationMs },
            "WhatsApp media resolved",
          );

          return {
            buffer,
            mimeType: media.mimeType,
            sizeBytes: buffer.length,
          };
        })(),
      );
    },
  };
}
