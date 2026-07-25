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
import { fromPromise, suppressError } from "@comis/shared";
import { safePath } from "@comis/core";
import type {
  AttachmentPayload,
  AttachmentSendReceipt,
  ChannelPort,
  SendMessageOptions,
} from "@comis/core";
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
  /** Cancels remaining media work at queue/shutdown delivery boundaries. */
  signal?: AbortSignal;
}

/** Result summary of outbound media delivery. */
export interface OutboundMediaResult {
  /** Number of successfully delivered media items. */
  delivered: number;
  /** Number of failed items (download or send errors). */
  failed: number;
  /** Receipt from the final successful attachment send. */
  lastReceipt?: AttachmentSendReceipt;
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
  let lastReceipt: AttachmentSendReceipt | undefined;

  for (let i = 0; i < mediaUrls.length; i++) {
    if (deps.signal?.aborted) break;
    const url = mediaUrls[i];

    // 1. Download via SSRF-safe fetcher
    const fetched = await fromPromise((async () => {
      if (deps.signal?.aborted) return undefined;
      return deps.fetchUrl(url);
    })());
    if (!fetched.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Check URL accessibility and SSRF guard rules",
          errorKind: "network" as const,
        },
        "Outbound media download failed",
      );
      failed++;
      continue;
    }
    if (fetched.value === undefined || deps.signal?.aborted) break;
    const fetchResult = fetched.value;
    if (!fetchResult.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Check URL accessibility and SSRF guard rules",
          errorKind: "network" as const,
        },
        "Outbound media download failed",
      );
      failed++;
      continue;
    }

    const { buffer, mimeType: fetchedMime } = fetchResult.value;

    // 2. Determine MIME type
    const resolvedMime = await fromPromise(resolveMimeType(buffer, fetchedMime));
    if (deps.signal?.aborted) break;
    if (!resolvedMime.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Check the media type detector and verify the downloaded payload is readable",
          errorKind: "dependency" as const,
        },
        "Outbound media MIME detection failed",
      );
      failed++;
      continue;
    }
    const mime = resolvedMime.value;

    // 3. Determine attachment type from MIME
    const attachType = mimeToAttachmentType(mime) as AttachmentPayload["type"];

    // 4. Extract filename from URL or generate one
    const fileName = extractFilename(url, i, mime);

    // 5. Write buffer to temp file
    const tempPath = safePath(tmpdir(), `comis-outbound-${randomUUID()}${extensionFromMime(mime)}`);
    const written = await fromPromise(writeFile(tempPath, buffer));
    if (deps.signal?.aborted) {
      suppressError(unlink(tempPath), "outbound media temp cleanup after cancellation");
      break;
    }
    if (!written.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          tempPath,
          hint: "Check temp directory permissions",
          errorKind: "resource" as const,
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

    const sendAttachment = deps.adapter.sendAttachment;
    if (typeof sendAttachment !== "function") {
      // Defensive: sendAttachment is optional on ChannelPort.
      // Adapters whose platform lacks attachments (e.g. IRC) omit the method;
      // the capability gate (features.attachments) should normally have blocked
      // outbound-media earlier in the pipeline. If we reach here the gate was
      // bypassed — log and skip, do NOT crash.
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Channel adapter has no sendAttachment — capability gate (features.attachments) should have blocked this call",
          errorKind: "validation" as const,
        },
        "Outbound media skipped: adapter does not implement sendAttachment",
      );
      failed++;
      suppressError(unlink(tempPath), "outbound media temp cleanup after capability skip");
      continue;
    }
    const sent = await fromPromise((async () => {
      if (deps.signal?.aborted) return undefined;
      return sendAttachment(deps.channelId, payload, deps.sendOptions);
    })());
    if (!sent.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Check channel adapter sendAttachment implementation",
          errorKind: "platform" as const,
        },
        "Outbound media send failed",
      );
      failed++;
      suppressError(unlink(tempPath), "outbound media temp cleanup after rejected send");
      continue;
    }
    if (sent.value === undefined) {
      suppressError(unlink(tempPath), "outbound media temp cleanup after cancellation");
      break;
    }
    const sendResult = sent.value;
    if (!sendResult.ok) {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Check channel adapter sendAttachment implementation",
          errorKind: "platform" as const,
        },
        "Outbound media send failed",
      );
      failed++;
      // Clean up temp file even on send failure
      suppressError(unlink(tempPath), "outbound media temp cleanup after send failure");
      continue;
    }

    const receipt = sendResult.value;
    if (receipt.kind === "delivered_untracked") {
      deps.logger.warn(
        {
          mediaIndex: i,
          hint: "Media delivery completed without a platform message ID. Do not retry; ID-based reactions and attribution are unavailable",
          errorKind: "platform" as const,
        },
        "Outbound media delivered without platform tracking",
      );
    }

    delivered++;
    lastReceipt = receipt;

    // 7. Clean up temp file (fire-and-forget)
    suppressError(unlink(tempPath), "outbound media temp cleanup");
  }

  return {
    delivered,
    failed,
    ...(lastReceipt !== undefined ? { lastReceipt } : {}),
  };
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
