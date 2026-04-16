/**
 * Shared helper utilities for daemon RPC handlers and wiring modules.
 * Extracted from daemon.ts to enable independent imports during decomposition.
 * @module
 */

import type { ChannelPort } from "@comis/core";

/** Resolve a channel adapter by type, throwing if not found. */
export function resolveAdapter(channelType: string, registry: Map<string, ChannelPort>): ChannelPort {
  const adapter = registry.get(channelType);
  if (!adapter) {
    throw new Error(`No adapter found for channel type: ${channelType}. Available: ${Array.from(registry.keys()).join(", ") || "none"}`);
  }
  return adapter;
}

/**
 * Channel-scoped authorization: same-channel + admin bypass.
 * Admin users can access any channel. Non-admin users can only
 * operate on the channel they originated from.
 */
export function authorizeChannelAccess(
  originChannelId: string | undefined,
  targetChannelId: string,
  trustLevel: string | undefined,
): void {
  // Admin can always access any channel
  if (trustLevel === "admin") return;
  // Same-channel access is always allowed
  if (originChannelId === targetChannelId) return;
  // If no origin context, allow (daemon-initiated operations like cron delivery)
  if (!originChannelId) return;
  // Cross-channel access denied for non-admin
  throw new Error(
    `Channel access denied: cannot operate on channel ${targetChannelId} from ${originChannelId}. Admin access required for cross-channel operations.`,
  );
}

/**
 * Build a CronSchedule from rpcCall params.
 */
export function buildCronSchedule(kind: string, params: Record<string, unknown>):
  | { kind: "cron"; expr: string; tz: string | undefined }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; at: string } {
  switch (kind) {
    case "cron":
      return {
        kind: "cron" as const,
        expr: params.schedule_expr as string,
        tz: params.timezone as string | undefined,
      };
    case "every":
      return { kind: "every" as const, everyMs: params.schedule_every_ms as number };
    case "at":
      return { kind: "at" as const, at: params.schedule_at as string };
    default:
      throw new Error(`Unknown schedule kind: ${kind}`);
  }
}

/**
 * Guess MIME type from file extension (image files only).
 */
export function guessMimeFromExtension(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return map[ext ?? ""] ?? "image/jpeg";
}

/**
 * Detect MIME type from base64-decoded buffer magic bytes.
 */
export function detectMimeFromMagicBytes(buffer: Buffer): string | undefined {
  if (buffer.length < 4) return undefined;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "image/gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Map audio MIME type to file extension.
 */
export function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
  };
  return map[mimeType] ?? "mp3";
}
