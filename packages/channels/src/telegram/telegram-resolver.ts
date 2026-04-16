/**
 * Telegram MediaResolverPort adapter.
 *
 * Resolves tg-file:// URIs to downloaded media buffers using the Grammy Bot API.
 * The fileId is extracted from the URI, then getFile + SSRF-guarded fetch retrieves
 * the actual bytes from the Telegram file server.
 *
 * Pre-download size check using file_size from getFile.
 * Emits a DEBUG log with platform, fileId, sizeBytes, and durationMs.
 * All HTTP fetches routed through SsrfGuardedFetcher.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import { sanitizeLogString } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { Bot } from "grammy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural interface for SSRF-guarded fetcher (avoids circular dep on @comis/skills). */
interface SsrfFetcher {
  fetch(url: string): Promise<Result<{ buffer: Buffer; mimeType: string; sizeBytes: number }, Error>>;
}

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TelegramResolverDeps {
  bot: Bot;
  botToken: string;
  maxBytes: number;
  ssrfFetcher: SsrfFetcher;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Telegram media resolver implementing MediaResolverPort.
 *
 * Resolves tg-file://{fileId} URIs by calling the Telegram Bot API getFile,
 * then downloading the file content via an SSRF-guarded fetcher.
 */
export function createTelegramResolver(deps: TelegramResolverDeps): MediaResolverPort {
  /** Strip the bot token from error messages then apply general sanitization. */
  function sanitizeError(msg: string): string {
    // Direct replacement first (handles bot token embedded in URLs where regex \b fails)
    const stripped = deps.botToken ? msg.replaceAll(deps.botToken, "[REDACTED_BOT_TOKEN]") : msg;
    return sanitizeLogString(stripped);
  }

  return {
    schemes: ["tg-file"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      try {
        // Extract fileId from tg-file://{fileId}
        const fileId = attachment.url.replace(/^tg-file:\/\//, "");
        if (!fileId) {
          return err(new Error("Invalid tg-file:// URL: missing fileId"));
        }

        // Get file metadata from Telegram API
        const file = await deps.bot.api.getFile(fileId);

        // Pre-download size check
        if (file.file_size != null && file.file_size > deps.maxBytes) {
          return err(new Error(
            `Telegram file size ${file.file_size} exceeds limit of ${deps.maxBytes} bytes`,
          ));
        }

        // Log getFile result for media pipeline visibility
        deps.logger.debug(
          { fileId, filePath: file.file_path ?? null, fileSize: file.file_size ?? null },
          "Telegram getFile result",
        );

        if (!file.file_path) {
          return err(new Error("Telegram getFile returned no file_path"));
        }

        // Construct download URL
        const downloadUrl = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;

        // Download via SSRF-guarded fetcher
        const startMs = Date.now();
        const fetchResult = await deps.ssrfFetcher.fetch(downloadUrl);
        const durationMs = Date.now() - startMs;

        if (!fetchResult.ok) {
          deps.logger.warn(
            {
              fileId,
              downloadDomain: "api.telegram.org",
              durationMs,
              errorKind: "platform" as const,
              hint: "Telegram file download failed — check bot token validity and Telegram API availability",
            },
            "Telegram media fetch failed",
          );
          // Sanitize error message to prevent bot token leakage from download URL
          const msg = fetchResult.error instanceof Error ? fetchResult.error.message : String(fetchResult.error);
          return err(new Error(sanitizeError(msg)));
        }

        const { buffer, mimeType, sizeBytes } = fetchResult.value;

        // Debug log for media pipeline visibility
        deps.logger.debug(
          { platform: "telegram", fileId, filePath: file.file_path, sizeBytes, durationMs },
          "Telegram media resolved",
        );

        return ok({ buffer, mimeType, sizeBytes });
      } catch (error: unknown) {
        // Sanitize all error messages to prevent bot token leakage
        const msg = error instanceof Error ? error.message : String(error);
        return err(new Error(sanitizeError(msg)));
      }
    },
  };
}
