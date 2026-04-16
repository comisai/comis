/**
 * CompositeResolver: Routes media resolution to per-platform resolvers by URI scheme.
 *
 * Acts as the single entry point for resolving any attachment URL. It builds
 * a scheme-to-resolver lookup map at construction time and delegates to the
 * correct per-platform resolver based on the URI scheme.
 *
 * For HTTPS/HTTP URLs without a registered platform resolver, the CompositeResolver
 * falls back to the SsrfGuardedFetcher for generic SSRF-safe downloads. This
 * handles Discord CDN and Signal API URLs transparently.
 *
 * Performs a global pre-check on attachment.sizeBytes before any resolution
 * and logs the routing decision (scheme + resolver found) at DEBUG level.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { err, fromPromise } from "@comis/shared";
import type { SsrfGuardedFetcher } from "./ssrf-fetcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for composite resolver. */
interface CompositeLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CompositeResolverDeps {
  /** Per-platform resolvers to register by their declared schemes. */
  resolvers: MediaResolverPort[];
  /** SSRF-guarded fetcher for generic HTTP/HTTPS fallback. */
  ssrfFetcher: SsrfGuardedFetcher;
  /** Maximum file size in bytes for the global size pre-check. */
  maxBytes: number;
  logger: CompositeLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CompositeResolver implementing MediaResolverPort.
 *
 * Routes attachment resolution to the correct per-platform resolver based on
 * URI scheme. Falls back to SsrfGuardedFetcher for HTTP/HTTPS URLs without
 * a registered resolver.
 */
export function createCompositeResolver(deps: CompositeResolverDeps): MediaResolverPort {
  // Build scheme -> resolver lookup map at construction time
  const schemeMap = new Map<string, MediaResolverPort>();
  for (const resolver of deps.resolvers) {
    for (const scheme of resolver.schemes) {
      schemeMap.set(scheme, resolver);
    }
  }

  // Collect all unique schemes including http/https for the SSRF fallback
  const allSchemes = new Set<string>(schemeMap.keys());
  allSchemes.add("http");
  allSchemes.add("https");

  return {
    schemes: Array.from(allSchemes),

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      // Reject attachments exceeding the configured size limit before any download
      if (attachment.sizeBytes != null && attachment.sizeBytes > deps.maxBytes) {
        return err(
          new Error(
            `Attachment size ${attachment.sizeBytes} exceeds limit of ${deps.maxBytes} bytes`,
          ),
        );
      }

      // Extract scheme — do NOT use new URL() which throws on custom schemes
      const schemeEnd = attachment.url.indexOf("://");
      if (schemeEnd === -1) {
        return err(new Error(`Invalid attachment URL: no scheme found in "${attachment.url}"`));
      }
      const scheme = attachment.url.slice(0, schemeEnd);

      // Look up per-platform resolver
      const resolver = schemeMap.get(scheme);

      // Log routing decision for observability
      deps.logger.debug(
        { scheme, resolverFound: !!resolver, attachmentType: attachment.type, attachmentSizeBytes: attachment.sizeBytes ?? null },
        "CompositeResolver routing",
      );

      // Route to per-platform resolver if registered
      if (resolver) {
        return resolver.resolve(attachment);
      }

      // Fallback: SSRF-guarded fetch for http/https URLs
      if (scheme === "http" || scheme === "https") {
        return fromPromise(
          (async (): Promise<ResolvedMedia> => {
            const fetchResult = await deps.ssrfFetcher.fetch(attachment.url);
            if (!fetchResult.ok) {
              throw fetchResult.error;
            }
            const { buffer, mimeType, sizeBytes } = fetchResult.value;
            deps.logger.debug(
              { scheme, sizeBytes, mimeType },
              "CompositeResolver SSRF fallback complete",
            );
            return { buffer, mimeType, sizeBytes };
          })(),
        );
      }

      // No resolver for this scheme
      return err(new Error(`No resolver for URI scheme: ${scheme}`));
    },
  };
}
