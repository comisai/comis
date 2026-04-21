// SPDX-License-Identifier: Apache-2.0
/**
 * Outbound media download and delivery handler.
 *
 * Given a list of media URLs extracted from LLM output (via parseOutboundMedia),
 * this module downloads each URL through an SSRF-safe fetcher, determines the
 * MIME type and attachment category, writes the content to a temp file, and
 * delivers it via the channel adapter's sendAttachment().
 *
 * Failed downloads or sends are logged and skipped without blocking delivery
 * of remaining media items or text.
 *
 * All remote fetches go through the injected SSRF-safe fetchUrl.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import type { Result } from "@comis/shared";
import { suppressError } from "@comis/shared";
import { safePath } from "@comis/core";
import type { AttachmentPayload, ChannelPort, SendMessageOptions } from "@comis/core";
import { mimeToAttachmentType } from "./media-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for outbound media delivery (injected for testability). */
export interface OutboundMediaDeps {
  /** SSRF-safe fetcher for downloading media URLs. Returns mimeType matching SsrfGuardedFetcher.FetchedMedia field name. */
  fetchUrl: (url: string) => Promise<Result<{ buffer: Buffer; mimeType?: string }, Error>>;
  /** Channel adapter for sending attachments. */
  adapter: Pick<ChannelPort, "sendAttachment">;
  /** Target channel/chat ID. */
  channelId: string;
  /** Logger for warnings on failed downloads. */
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Thread context for routing attachments to forum topics. */
  sendOptions?: SendMessageOptions;
}

/** Result summary of outbound media delivery. */
export interface OutboundMediaResult {
  /** Number of successfully delivered media items. */
  delivered: number;
  /** Number of failed items (download or send errors). */
  failed: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Download and deliver outbound media to a channel.
 *
 * For each URL: download via SSRF-safe fetcher, detect MIME type, write to
 * temp file, send via adapter.sendAttachment(), clean up temp file.
 *
 * Failures at any stage are logged and skipped -- never block other deliveries.
 *
 * @param mediaUrls - URLs to download and deliver
 * @param deps - Injected dependencies
 * @returns Count of delivered and failed items
 */
export async function deliverOutboundMedia(
  mediaUrls: string[],
  deps: OutboundMediaDeps,
): Promise<OutboundMediaResult> {
  let delivered = 0;
  let failed = 0;

  for (let i = 0; i < mediaUrls.length; i++) {
    const url = mediaUrls[i];

    // 1. Download via SSRF-safe fetcher
    const fetchResult = await deps.fetchUrl(url);
    if (!fetchResult.ok) {
      deps.logger.warn(
        { url, hint: "Check URL accessibility and SSRF guard rules", errorKind: "network" },
        "Outbound media download failed",
      );
      failed++;
      continue;
    }

    const { buffer, mimeType: fetchedMime } = fetchResult.value;

    // 2. Determine MIME type
    const mime = await resolveMimeType(buffer, fetchedMime);

    // 3. Determine attachment type from MIME
    const attachType = mimeToAttachmentType(mime) as AttachmentPayload["type"];

    // 4. Extract filename from URL or generate one
    const fileName = extractFilename(url, i, mime);

    // 5. Write buffer to temp file
    const tempPath = safePath(tmpdir(), `comis-outbound-${randomUUID()}${extensionFromMime(mime)}`);
    try {
      await writeFile(tempPath, buffer);
    } catch (writeErr: unknown) {
      deps.logger.warn(
        {
          url,
          tempPath,
          err: writeErr,
          hint: "Check temp directory permissions",
          errorKind: "resource",
        },
        "Failed to write outbound media temp file",
      );
      failed++;
      continue;
    }

    // 6. Send attachment via channel adapter
    const payload: AttachmentPayload = {
      type: attachType,
      url: tempPath,
      mimeType: mime,
      fileName,
    };

    const sendResult = await deps.adapter.sendAttachment(deps.channelId, payload, deps.sendOptions);
    if (!sendResult.ok) {
      deps.logger.warn(
        {
          url,
          hint: "Check channel adapter sendAttachment implementation",
          errorKind: "network",
        },
        "Outbound media send failed",
      );
      failed++;
      // Clean up temp file even on send failure
      suppressError(unlink(tempPath), "outbound media temp cleanup after send failure");
      continue;
    }

    delivered++;

    // 7. Clean up temp file (fire-and-forget)
    suppressError(unlink(tempPath), "outbound media temp cleanup");
  }

  return { delivered, failed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve MIME type from fetched header or buffer sniffing.
 * Falls back to application/octet-stream.
 */
async function resolveMimeType(buffer: Buffer, fetchedMime?: string): Promise<string> {
  // Use fetched MIME if present and specific (not generic)
  if (fetchedMime && fetchedMime !== "application/octet-stream") {
    return fetchedMime;
  }

  // Attempt file-type sniffing from buffer
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) {
    return detected.mime;
  }

  return "application/octet-stream";
}

/** Extract filename from URL path or generate one. */
function extractFilename(url: string, index: number, mime: string): string {
  try {
    // Handle both URLs and filesystem paths
    const pathname = url.startsWith("/") ? url : new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.includes(".")) {
      return decodeURIComponent(last);
    }
  } catch {
    // URL parsing failed -- fall through to generated name
  }
  const ext = extensionFromMime(mime);
  return `media-${index}${ext}`;
}

/** Get file extension from MIME type. */
function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? "";
}
