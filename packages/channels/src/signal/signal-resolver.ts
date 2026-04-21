// SPDX-License-Identifier: Apache-2.0
/**
 * Signal MediaResolverPort adapter.
 *
 * Signal uses standard HTTPS URLs from the signal-cli API
 * ({baseUrl}/api/v1/attachments/{id}). This resolver is a thin wrapper
 * around the SSRF-guarded fetcher, adding pre-download size checks
 * and debug logging.
 *
 * Note: Like the Discord resolver, this is NOT registered as a generic
 * HTTPS handler in the CompositeResolver. HTTPS URLs go through the
 * CompositeResolver's SSRF fallback path. This resolver exists for
 * direct use when platform-specific pre-checks are desired.
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

export interface SignalResolverDeps {
  ssrfFetcher: SsrfFetcher;
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Signal media resolver implementing MediaResolverPort.
 *
 * Resolves Signal attachment HTTPS URLs by downloading via an
 * SSRF-guarded fetcher with pre-download size checks.
 */
export function createSignalResolver(deps: SignalResolverDeps): MediaResolverPort {
  return {
    schemes: ["http", "https"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Pre-download size check using Signal metadata
          if (attachment.sizeBytes != null && attachment.sizeBytes > deps.maxBytes) {
            throw new Error(
              `Signal file size ${attachment.sizeBytes} exceeds limit of ${deps.maxBytes} bytes`,
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
            { platform: "signal", url: attachment.url, sizeBytes, durationMs },
            "Signal media resolved",
          );

          return { buffer, mimeType, sizeBytes };
        })(),
      );
    },
  };
}
