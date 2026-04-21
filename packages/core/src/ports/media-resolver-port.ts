// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { Attachment } from "../domain/normalized-message.js";

// ─── Media Resolution ─────────────────────────────────────────────

/**
 * Result of resolving a media attachment to a buffer.
 */
export interface ResolvedMedia {
  /** Downloaded file content. */
  readonly buffer: Buffer;
  /** Verified MIME type (sniffed, not declared). */
  readonly mimeType: string;
  /** File size in bytes. */
  readonly sizeBytes: number;
}

/**
 * MediaResolverPort: Hexagonal boundary for media resolution.
 *
 * Per-platform adapters implement this interface to download attachments
 * from platform-specific URLs (e.g., tg-file:// for Telegram, https://
 * for public URLs). The resolver registry routes to the correct adapter
 * based on the URI scheme.
 */
export interface MediaResolverPort {
  /** URI schemes this resolver handles (e.g., ["tg-file", "https"]). */
  readonly schemes: ReadonlyArray<string>;

  /**
   * Resolve an attachment URL to a downloaded buffer.
   *
   * Implementations MUST validate URLs through validateUrl() from
   * @comis/core/security before any HTTP request to prevent SSRF.
   * Private, loopback, link-local, and cloud-metadata IPs are blocked.
   * DNS rebinding protection is mandatory: resolve hostname to IP,
   * check blocklist, then connect using pinned IP.
   *
   * Implementations MUST check Content-Length against the configured
   * maxRemoteFetchBytes limit and abort before streaming the body
   * if exceeded.
   *
   * @param attachment - The attachment to resolve
   * @returns Resolved media buffer with MIME type and size, or an error
   */
  resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>>;
}
