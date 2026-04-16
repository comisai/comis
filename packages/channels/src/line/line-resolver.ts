/**
 * LINE MediaResolverPort adapter.
 *
 * Resolves line-content:// URIs by extracting the message ID and calling
 * a getBlobContent callback that wraps blobClient.getMessageContent().
 *
 * Post-download size check (LINE does not expose file size before download).
 * Emits a DEBUG log with platform, messageId, sizeBytes, and durationMs.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LineResolverDeps {
  /** Callback that downloads message content via blobClient.getMessageContent(). */
  getBlobContent: (messageId: string) => Promise<Buffer>;
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LINE media resolver implementing MediaResolverPort.
 *
 * Resolves line-content://{messageId} URIs by downloading content via
 * the LINE Messaging API blob client.
 */
export function createLineResolver(deps: LineResolverDeps): MediaResolverPort {
  return {
    schemes: ["line-content"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Extract message ID from line-content://{messageId}
          const messageId = attachment.url.replace(/^line-content:\/\//, "");
          if (!messageId) {
            throw new Error("Invalid line-content:// URL: missing messageId");
          }

          // Download via LINE blob client
          const startMs = Date.now();
          let buffer: Buffer;
          try {
            buffer = await deps.getBlobContent(messageId);
          } catch (downloadErr) {
            // LINE content may expire (404/410)
            const errMsg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
            if (errMsg.includes("404") || errMsg.includes("410")) {
              deps.logger.warn(
                {
                  platform: "line",
                  messageId,
                  hint: "LINE message content may have expired",
                  errorKind: "platform" as const,
                },
                "LINE content download failed — content may have expired",
              );
            }
            throw downloadErr;
          }
          const durationMs = Date.now() - startMs;

          // Reject downloads exceeding size limit
          if (buffer.length > deps.maxBytes) {
            throw new Error(
              `LINE media size ${buffer.length} exceeds limit of ${deps.maxBytes} bytes`,
            );
          }

          // Use attachment mimeType if available, otherwise default
          const mimeType = attachment.mimeType ?? "application/octet-stream";

          // Debug log for media pipeline visibility
          deps.logger.debug(
            { platform: "line", messageId, sizeBytes: buffer.length, durationMs },
            "LINE media resolved",
          );

          return {
            buffer,
            mimeType,
            sizeBytes: buffer.length,
          };
        })(),
      );
    },
  };
}
