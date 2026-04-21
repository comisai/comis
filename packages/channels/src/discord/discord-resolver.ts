// SPDX-License-Identifier: Apache-2.0
/**
 * Discord MediaResolverPort adapter.
 *
 * Discord uses public HTTPS CDN URLs for attachments. This resolver is a thin
 * wrapper around the SSRF-guarded fetcher, adding pre-download size checks
 * using Discord's attachment metadata and debug logging.
 *
 * Note: This resolver uses ["https"] as its scheme but is NOT registered as
 * a generic HTTPS handler in the CompositeResolver. Instead, the
 * CompositeResolver handles all HTTPS URLs via its SSRF fallback path.
 * This resolver exists for direct use when platform-specific pre-checks
 * are desired.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";

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

export interface DiscordResolverDeps {
  ssrfFetcher: SsrfFetcher;
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Discord media resolver implementing MediaResolverPort.
 *
 * Resolves Discord CDN HTTPS URLs by downloading via an SSRF-guarded fetcher.
 * Performs a pre-download size check using Discord attachment metadata.
 */
export function createDiscordResolver(deps: DiscordResolverDeps): MediaResolverPort {
  return {
    schemes: ["https"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Pre-download size check using Discord metadata
          if (attachment.sizeBytes != null && attachment.sizeBytes > deps.maxBytes) {
            throw new Error(
              `Discord file size ${attachment.sizeBytes} exceeds limit of ${deps.maxBytes} bytes`,
            );
          }

          // Download via SSRF-guarded fetcher
          const startMs = Date.now();
          const fetchResult = await deps.ssrfFetcher.fetch(attachment.url);
          const durationMs = Date.now() - startMs;

          if (!fetchResult.ok) {
            throw fetchResult.error;
          }

          const { buffer, mimeType, sizeBytes } = fetchResult.value;

          // Debug log for media pipeline visibility
          deps.logger.debug(
            { platform: "discord", url: attachment.url, sizeBytes, durationMs },
            "Discord media resolved",
          );

          return { buffer, mimeType, sizeBytes };
        })(),
      );
    },
  };
}
