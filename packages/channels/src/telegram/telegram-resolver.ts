// SPDX-License-Identifier: Apache-2.0
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
import { sanitizeLogString, systemNowMs } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { fileTypeFromBuffer } from "file-type";
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
  /**
   * Bot API root override (production: undefined → real Telegram). When set (a self-hosted local
   * Bot API server, or the test emulator), the file-DOWNLOAD URL must use this base too — `getFile`
   * already honors it via the grammy client, but the byte download is a manual fetch. Without this
   * the download would hardcode `https://api.telegram.org/file/…` and 404 against real Telegram
   * while getFile pointed at the override.
   */
  apiRoot?: string;
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

        // Construct download URL. The file-server base mirrors the Bot API root: real Telegram uses
        // `https://api.telegram.org/file/bot…`; a local Bot API server / the emulator uses the same
        // host as `apiRoot`. getFile (above) already honors apiRoot via the grammy client, so the
        // download MUST too — else getFile resolves on the override but the bytes 404 on real Telegram.
        const apiBase = deps.apiRoot ?? "https://api.telegram.org";
        const downloadUrl = `${apiBase}/file/bot${deps.botToken}/${file.file_path}`;

        // Download via SSRF-guarded fetcher
        const startMs = systemNowMs();
        const fetchResult = await deps.ssrfFetcher.fetch(downloadUrl);
        const durationMs = systemNowMs() - startMs;

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

        const { buffer, mimeType: fetchedMime, sizeBytes } = fetchResult.value;

        // The MediaResolverPort contract specifies a VERIFIED
        // (sniffed, not declared) MIME type. Telegram's getFile `file_path` / the file-server
        // content-type can mislabel the bytes (e.g. a `.jpg` path / `image/jpeg` header for PNG
        // bytes), and the model vision API rejects a declared type that mismatches the actual bytes
        // (Anthropic 400: "specified image/jpeg, but the image appears to be image/png"). Sniff the
        // downloaded bytes; the sniffed type is authoritative when recognized, else fall back to the
        // fetched header type.
        const sniffed = await fileTypeFromBuffer(buffer);
        const mimeType = sniffed?.mime ?? fetchedMime;
        if (sniffed && sniffed.mime !== fetchedMime) {
          deps.logger.debug(
            { fileId, declaredMime: fetchedMime, sniffedMime: sniffed.mime },
            "Telegram media MIME corrected from sniffed bytes (declared type mismatched)",
          );
        }

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
