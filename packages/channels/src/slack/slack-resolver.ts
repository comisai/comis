/**
 * Slack MediaResolverPort adapter.
 *
 * Resolves slack-file:// URIs by calling the Slack files.info API to get
 * the download URL, then downloading via fetchWithSlackAuth (which handles
 * cross-origin CDN redirects safely).
 *
 * Pre-download size check using file.size from files.info.
 * Emits a DEBUG log with platform, fileId, sizeBytes, and durationMs.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import { fetchWithSlackAuth } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SlackResolverDeps {
  botToken: string;
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Response shape from Slack files.info API. */
interface SlackFileInfo {
  ok: boolean;
  file?: {
    url_private_download?: string;
    url_private?: string;
    size?: number;
    mimetype?: string;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Slack media resolver implementing MediaResolverPort.
 *
 * Resolves slack-file://{fileId} URIs by calling Slack's files.info API
 * to get the private download URL, then downloading with authentication.
 */
export function createSlackResolver(deps: SlackResolverDeps): MediaResolverPort {
  return {
    schemes: ["slack-file"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Extract file ID from slack-file://{fileId}
          const fileId = attachment.url.replace(/^slack-file:\/\//, "");
          if (!fileId) {
            throw new Error("Invalid slack-file:// URL: missing fileId");
          }

          // Call Slack files.info API to get download URL and metadata
          const infoRes = await fetch("https://slack.com/api/files.info", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${deps.botToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `file=${encodeURIComponent(fileId)}`,
          });

          if (!infoRes.ok) {
            throw new Error(`Slack files.info HTTP ${infoRes.status}`);
          }

          const info: SlackFileInfo = await infoRes.json() as SlackFileInfo;
          if (!info.ok || !info.file) {
            throw new Error(`Slack files.info failed: ${info.error ?? "unknown error"}`);
          }

          const downloadUrl = info.file.url_private_download ?? info.file.url_private;
          if (!downloadUrl) {
            throw new Error("Slack files.info returned no download URL");
          }

          // Pre-download size check using Slack file metadata
          const fileSize = info.file.size ?? attachment.sizeBytes;
          if (fileSize != null && fileSize > deps.maxBytes) {
            throw new Error(
              `Slack file size ${fileSize} exceeds limit of ${deps.maxBytes} bytes`,
            );
          }

          // Download with Slack auth + redirect handling
          const startMs = Date.now();
          const response = await fetchWithSlackAuth(downloadUrl, deps.botToken);
          const durationMs = Date.now() - startMs;

          if (!response.ok) {
            throw new Error(`Slack file download failed: HTTP ${response.status}`);
          }

          const buffer = Buffer.from(await response.arrayBuffer());

          // Use Slack's declared MIME type, then attachment mimeType, then default
          const mimeType =
            info.file.mimetype ??
            attachment.mimeType ??
            response.headers.get("content-type") ??
            "application/octet-stream";

          // Debug log for media pipeline visibility
          deps.logger.debug(
            { platform: "slack", fileId, sizeBytes: buffer.length, durationMs },
            "Slack media resolved",
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
